import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { AurousError } from '../../core/errors.js';
import { redactText } from '../../core/redact.js';
import { ExecutionResultResponseSchema, PlanProposalResponseSchema } from '../../domain/schemas.js';
import { executionResultJsonSchema, planProposalJsonSchema } from '../../domain/json-schemas.js';
import { RecoveryInspectionSchema } from '../../domain/recovery.js';
import { recoveryInspectionJsonSchema } from '../../domain/recovery-json-schemas.js';
import {
  buildExecutionPrompt,
  buildPlanningPrompt,
  buildRecoveryActionPrompt,
  buildRecoveryInspectionPrompt,
} from './prompts.js';
import {
  commandFailure,
  parseJsonPayload,
  structuredOutputFailure,
  writeManualPrompt,
  type AgentPhase,
} from './helpers.js';
import type {
  AgentAdapter,
  AgentDiagnostic,
  InvocationRecord,
  PlanExecutionInput,
  PlanGenerationInput,
  RecoveryActionExecutionInput,
  RecoveryInspectionInput,
} from './types.js';

export class CodexAgentAdapter implements AgentAdapter {
  readonly name = 'codex' as const;

  async diagnose(): Promise<AgentDiagnostic> {
    const version = await execa('codex', ['--version'], { reject: false }).catch(() => undefined);
    if (!version || version.exitCode !== 0) {
      return {
        name: this.name,
        installed: false,
        supportsNonInteractive: false,
        authentication: {
          status: 'not-ready',
          detail: 'Codex CLI is not installed or not on PATH.',
        },
        mcp: {
          notion: { status: 'unknown', detail: 'Codex is unavailable.' },
          linear: { status: 'unknown', detail: 'Codex is unavailable.' },
        },
        warnings: ['Install Codex CLI before selecting --agent codex.'],
      };
    }
    const [help, auth, mcp] = await Promise.all([
      execa('codex', ['exec', '--help'], { reject: false, timeout: 15_000 }),
      execa('codex', ['login', 'status'], { reject: false, timeout: 15_000 }),
      execa('codex', ['mcp', 'list'], { reject: false, timeout: 20_000 }),
    ]);
    const supportsNonInteractive = requiredCodexFlags.every((flag) => help.stdout.includes(flag));
    const mcpOutput = `${mcp.stdout}\n${mcp.stderr}`;
    return {
      name: this.name,
      installed: true,
      version: version.stdout.trim() || version.stderr.trim(),
      supportsNonInteractive,
      authentication: {
        status: auth.exitCode === 0 ? 'ready' : 'not-ready',
        detail:
          auth.exitCode === 0
            ? redactText(`${auth.stdout}\n${auth.stderr}`.trim()) ||
              'Codex reported an active login.'
            : 'Run "codex login".',
      },
      mcp: {
        notion: mcpReadiness(mcp.exitCode ?? -1, mcpOutput, 'notion'),
        linear: mcpReadiness(mcp.exitCode ?? -1, mcpOutput, 'linear'),
      },
      warnings: supportsNonInteractive
        ? []
        : ['Installed Codex does not advertise every noninteractive flag Aurous requires.'],
    };
  }

  async generatePlan(input: PlanGenerationInput) {
    const prompt = buildPlanningPrompt(input.objective, input.context, input.productivity);
    await this.requireReady(input.runDirectory, 'plan', prompt);
    return this.invoke(input, 'plan', prompt, planProposalJsonSchema, (value) =>
      PlanProposalResponseSchema.parse(value),
    );
  }

  async executePlan(input: PlanExecutionInput) {
    const prompt = buildExecutionPrompt(input.plan, input.productivity);
    const diagnostic = await this.requireReady(input.runDirectory, 'apply', prompt);
    if (input.plan.tool !== 'mock' && diagnostic.mcp[input.plan.tool].status !== 'ready') {
      const fallback = await this.manualFallback(input.runDirectory, 'apply', prompt);
      throw new AurousError({
        code: 'AUR-MCP-001',
        summary: `${input.plan.tool} MCP is not ready in Codex.`,
        probableCause: diagnostic.mcp[input.plan.tool].detail,
        nextAction: `Configure the official ${input.plan.tool} MCP in Codex, then retry. Manual prompt: ${fallback}`,
        runId: input.plan.runId,
      });
    }
    return this.invoke(input, 'apply', prompt, executionResultJsonSchema, (value) =>
      ExecutionResultResponseSchema.parse(value),
    );
  }

  async inspectRecovery(input: RecoveryInspectionInput) {
    const prompt = buildRecoveryInspectionPrompt(input.originalPlan, input.originalResult);
    await this.requireMcpReady(
      input.runDirectory,
      'recover-inspect',
      prompt,
      input.originalPlan.tool,
      input.recoveryRunId,
    );
    return this.invoke(input, 'recover-inspect', prompt, recoveryInspectionJsonSchema, (value) =>
      RecoveryInspectionSchema.parse(value),
    );
  }

  async executeRecoveryAction(input: RecoveryActionExecutionInput) {
    const prompt = buildRecoveryActionPrompt(
      input.recoveryPlan,
      input.action,
      input.knownObjects,
      input.productivity,
    );
    await this.requireMcpReady(
      input.runDirectory,
      'recover-apply',
      prompt,
      input.recoveryPlan.tool,
      input.recoveryPlan.recoveryRunId,
    );
    return this.invoke(input, 'recover-apply', prompt, executionResultJsonSchema, (value) =>
      ExecutionResultResponseSchema.parse(value),
    );
  }

  manualFallback(runDirectory: string, phase: AgentPhase, prompt: string): Promise<string> {
    return writeManualPrompt(runDirectory, phase, prompt);
  }

  private async requireMcpReady(
    runDirectory: string,
    phase: AgentPhase,
    prompt: string,
    tool: 'notion' | 'linear' | 'mock',
    runId: string,
  ): Promise<void> {
    const diagnostic = await this.requireReady(runDirectory, phase, prompt);
    if (tool !== 'mock' && diagnostic.mcp[tool].status !== 'ready') {
      const fallback = await this.manualFallback(runDirectory, phase, prompt);
      throw new AurousError({
        code: 'AUR-MCP-001',
        summary: `${tool} MCP is not ready in Codex.`,
        probableCause: diagnostic.mcp[tool].detail,
        nextAction: `Configure the official ${tool} MCP in Codex, then retry. Manual prompt: ${fallback}`,
        runId,
      });
    }
  }

  private async requireReady(
    runDirectory: string,
    phase: AgentPhase,
    prompt: string,
  ): Promise<AgentDiagnostic> {
    const diagnostic = await this.diagnose();
    if (
      !diagnostic.installed ||
      !diagnostic.supportsNonInteractive ||
      diagnostic.authentication.status !== 'ready'
    ) {
      const fallback = await this.manualFallback(runDirectory, phase, prompt);
      throw new AurousError({
        code: diagnostic.installed ? 'AUR-AGENT-002' : 'AUR-AGENT-001',
        summary: diagnostic.installed
          ? 'Codex is not ready for noninteractive execution.'
          : 'Codex CLI is not installed.',
        probableCause: diagnostic.authentication.detail,
        nextAction: `Run "aurous doctor --verbose". A paste-ready prompt was saved to ${fallback}.`,
      });
    }
    return diagnostic;
  }

  private async invoke<T>(
    input:
      | PlanGenerationInput
      | PlanExecutionInput
      | RecoveryInspectionInput
      | RecoveryActionExecutionInput,
    phase: AgentPhase,
    prompt: string,
    schema: object,
    parse: (value: unknown) => T,
  ): Promise<InvocationRecord<T>> {
    const schemaPath = path.join(input.runDirectory, `${phase}-response-schema.json`);
    const outputPath = path.join(input.runDirectory, `${phase}-agent-response.json`);
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputPath,
      '-',
    ];
    const started = Date.now();
    let result;
    try {
      result = await execa('codex', args, {
        cwd: input.workspace,
        input: prompt,
        reject: false,
        timeout: input.timeoutMs,
        ...(input.signal ? { cancelSignal: input.signal } : {}),
      });
    } catch (error) {
      const durationMs = Date.now() - started;
      if (input.signal?.aborted) {
        throw commandFailure(
          'Codex',
          phase,
          ['codex', ...args],
          '',
          error instanceof Error ? error.message : String(error),
          false,
          true,
          durationMs,
          invocationRunId(input),
        );
      }
      throw error;
    }
    const durationMs = Date.now() - started;
    if (result.exitCode !== 0 || result.isCanceled) {
      throw commandFailure(
        'Codex',
        phase,
        ['codex', ...args],
        result.stdout,
        result.stderr,
        result.timedOut,
        result.isCanceled,
        durationMs,
        invocationRunId(input),
      );
    }
    const runId = invocationRunId(input);
    let output: string;
    try {
      output = await readFile(outputPath, 'utf8');
    } catch {
      if (result.stdout.trim()) output = result.stdout;
      else {
        const likelyTimedOut = result.timedOut || durationMs >= input.timeoutMs - 1_000;
        throw commandFailure(
          'Codex',
          phase,
          ['codex', ...args],
          result.stdout,
          result.stderr,
          likelyTimedOut,
          result.isCanceled,
          durationMs,
          runId,
        );
      }
    }
    try {
      return {
        value: parse(parseJsonPayload(output)),
        command: ['codex', ...args],
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
      };
    } catch (error) {
      throw structuredOutputFailure(
        'Codex',
        phase,
        ['codex', ...args],
        result.stdout,
        result.stderr,
        durationMs,
        error,
        runId,
      );
    }
  }
}

function invocationRunId(
  input:
    | PlanGenerationInput
    | PlanExecutionInput
    | RecoveryInspectionInput
    | RecoveryActionExecutionInput,
): string {
  if ('runId' in input) return input.runId;
  if ('plan' in input) return input.plan.runId;
  if ('recoveryRunId' in input) return input.recoveryRunId;
  return input.recoveryPlan.recoveryRunId;
}

const requiredCodexFlags = [
  '--output-schema',
  '--output-last-message',
  '--ephemeral',
  '--skip-git-repo-check',
  '--sandbox',
];

function mcpReadiness(
  exitCode: number,
  output: string,
  name: 'notion' | 'linear',
): AgentDiagnostic['mcp']['notion'] {
  if (exitCode !== 0)
    return { status: 'unknown', detail: 'Could not inspect Codex MCP configuration.' };
  const line = output
    .split('\n')
    .find((candidate) => new RegExp(`\\b${name}\\b`, 'i').test(candidate));
  if (!line) return { status: 'not-ready', detail: `${name} was not listed by "codex mcp list".` };
  if (/disabled|failed|error/i.test(line))
    return { status: 'not-ready', detail: redactText(line.trim()) };
  return { status: 'ready', detail: redactText(line.trim()) };
}
