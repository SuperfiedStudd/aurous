import { execa } from 'execa';
import { AurousError } from '../../core/errors.js';
import { redactText } from '../../core/redact.js';
import {
  PlanProposalResponseSchema,
  parseExecutionResultResponse,
  type ExecutionResult,
  type ParsedExecutionResult,
} from '../../domain/schemas.js';
import { RecoveryInspectionSchema } from '../../domain/recovery.js';
import { DestinationDiscoverySchema } from '../../domain/destinations.js';
import {
  buildDestinationDiscoveryPrompt,
  buildExecutionPrompt,
  buildPlanningPrompt,
  buildRecoveryActionPrompt,
  buildRecoveryInspectionPrompt,
} from './prompts.js';
import { commandFailure, parseJsonPayload, writeManualPrompt, type AgentPhase } from './helpers.js';
import type {
  AgentAdapter,
  AgentDiagnostic,
  DestinationDiscoveryInput,
  InvocationRecord,
  PlanExecutionInput,
  PlanGenerationInput,
  RecoveryActionExecutionInput,
  RecoveryInspectionInput,
} from './types.js';

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly name = 'claude' as const;

  async diagnose(): Promise<AgentDiagnostic> {
    const version = await execa('claude', ['--version'], { reject: false }).catch(() => undefined);
    if (!version || version.exitCode !== 0) {
      return {
        name: this.name,
        installed: false,
        supportsNonInteractive: false,
        authentication: {
          status: 'not-ready',
          detail: 'Claude Code CLI is not installed or not on PATH.',
        },
        mcp: {
          notion: { status: 'unknown', detail: 'Claude Code is unavailable.' },
          linear: { status: 'unknown', detail: 'Claude Code is unavailable.' },
          airtable: { status: 'unknown', detail: 'Claude Code is unavailable.' },
          trello: { status: 'unknown', detail: 'Claude Code is unavailable.' },
        },
        warnings: ['Install Claude Code before selecting --agent claude.'],
      };
    }
    const help = await execa('claude', ['--help'], { reject: false, timeout: 15_000 });
    const supportsNonInteractive =
      help.stdout.includes('--print') && help.stdout.includes('--output-format');
    let mcpOutput = '';
    let mcpExitCode = -1;
    if (/\bmcp\b/i.test(help.stdout)) {
      const mcp = await execa('claude', ['mcp', 'list'], { reject: false, timeout: 20_000 });
      mcpOutput = `${mcp.stdout}\n${mcp.stderr}`;
      mcpExitCode = mcp.exitCode ?? -1;
    }
    return {
      name: this.name,
      installed: true,
      version: version.stdout.trim() || version.stderr.trim(),
      supportsNonInteractive,
      authentication: {
        status: 'unknown',
        detail:
          'Claude Code does not advertise a safe auth-status command; invocation will use existing local auth.',
      },
      mcp: {
        notion: claudeMcpReadiness(mcpExitCode, mcpOutput, 'notion'),
        linear: claudeMcpReadiness(mcpExitCode, mcpOutput, 'linear'),
        airtable: claudeMcpReadiness(mcpExitCode, mcpOutput, 'airtable'),
        trello: claudeMcpReadiness(mcpExitCode, mcpOutput, 'trello'),
      },
      warnings: supportsNonInteractive
        ? ['Authentication readiness will be confirmed by the first noninteractive invocation.']
        : ['Installed Claude Code does not advertise --print and --output-format.'],
    };
  }

  async generatePlan(input: PlanGenerationInput) {
    const prompt = buildPlanningPrompt(
      input.objective,
      input.context,
      input.contextPack,
      input.productivity,
      input.destination,
    );
    await this.requireReady(input.runDirectory, 'plan', prompt);
    return this.invoke(input, 'plan', prompt, (value) => PlanProposalResponseSchema.parse(value));
  }

  async discoverDestinations(input: DestinationDiscoveryInput) {
    const prompt = buildDestinationDiscoveryPrompt(input);
    await this.requireMcpReady(
      input.runDirectory,
      'destination-discover',
      prompt,
      input.productivity.name,
      input.discoveryId,
    );
    return this.invoke(input, 'destination-discover', prompt, (value) =>
      DestinationDiscoverySchema.parse(value),
    );
  }

  async executePlan(input: PlanExecutionInput) {
    const prompt = buildExecutionPrompt(input.plan, input.productivity);
    const diagnostic = await this.requireReady(input.runDirectory, 'apply', prompt);
    if (input.plan.tool !== 'mock' && diagnostic.mcp[input.plan.tool].status !== 'ready') {
      const fallback = await this.manualFallback(input.runDirectory, 'apply', prompt);
      throw new AurousError({
        code: 'AUR-MCP-001',
        summary: `${input.plan.tool} MCP is not ready in Claude Code.`,
        probableCause: diagnostic.mcp[input.plan.tool].detail,
        nextAction: `Configure the official ${input.plan.tool} MCP in Claude Code, then retry. Manual prompt: ${fallback}`,
        runId: input.plan.runId,
      });
    }
    const invocation = await this.invoke(input, 'apply', prompt, parseExecutionResultResponse);
    return normalizeExecutionInvocation(invocation);
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
    return this.invoke(input, 'recover-inspect', prompt, (value) =>
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
    const invocation = await this.invoke(
      input,
      'recover-apply',
      prompt,
      parseExecutionResultResponse,
    );
    return normalizeExecutionInvocation(invocation);
  }

  manualFallback(runDirectory: string, phase: AgentPhase, prompt: string): Promise<string> {
    return writeManualPrompt(runDirectory, phase, prompt);
  }

  private async requireMcpReady(
    runDirectory: string,
    phase: AgentPhase,
    prompt: string,
    tool: 'notion' | 'linear' | 'airtable' | 'trello' | 'mock',
    runId: string,
  ): Promise<void> {
    const diagnostic = await this.requireReady(runDirectory, phase, prompt);
    if (tool !== 'mock' && diagnostic.mcp[tool].status !== 'ready') {
      const fallback = await this.manualFallback(runDirectory, phase, prompt);
      if (phase === 'destination-discover') {
        throw new AurousError({
          code: 'AUR-DEST-008',
          summary: `${tool === 'notion' ? 'Notion' : tool === 'linear' ? 'Linear' : tool === 'trello' ? 'Trello' : 'Airtable'} is not connected to Claude Code yet.`,
          probableCause: 'The selected local agent cannot access this integration.',
          nextAction: `Connect ${tool === 'notion' ? 'Notion' : tool === 'linear' ? 'Linear' : tool === 'trello' ? 'Trello' : 'Airtable'} in Claude Code, then repeat the request.`,
          severity: 'recoverable',
          runId,
        });
      }
      throw new AurousError({
        code: 'AUR-MCP-001',
        summary: `${tool} MCP is not ready in Claude Code.`,
        probableCause: diagnostic.mcp[tool].detail,
        nextAction: `Configure the official ${tool} MCP in Claude Code, then retry. Manual prompt: ${fallback}`,
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
    if (!diagnostic.installed || !diagnostic.supportsNonInteractive) {
      const fallback = await this.manualFallback(runDirectory, phase, prompt);
      throw new AurousError({
        code: diagnostic.installed ? 'AUR-AGENT-002' : 'AUR-AGENT-001',
        summary: diagnostic.installed
          ? 'Claude Code cannot be run noninteractively by Aurous.'
          : 'Claude Code CLI is not installed.',
        probableCause: diagnostic.authentication.detail,
        nextAction: `Open Claude Code with "claude" and paste the prompt saved at ${fallback}.`,
      });
    }
    return diagnostic;
  }

  private async invoke<T>(
    input:
      | PlanGenerationInput
      | DestinationDiscoveryInput
      | PlanExecutionInput
      | RecoveryInspectionInput
      | RecoveryActionExecutionInput,
    phase: AgentPhase,
    prompt: string,
    parse: (value: unknown) => T,
  ): Promise<InvocationRecord<T>> {
    const help = await execa('claude', ['--help'], { reject: false, timeout: 15_000 });
    const args = ['--print', '--output-format', 'json'];
    const model = 'model' in input ? input.model : undefined;
    if (model) {
      if (!help.stdout.includes('--model')) {
        throw new AurousError({
          code: 'AUR-AGENT-008',
          summary: 'This Claude Code installation does not support model selection.',
          probableCause: 'The installed CLI does not advertise the --model option.',
          nextAction: 'Run "/model auto" in the Aurous shell or update Claude Code.',
          runId: invocationRunId(input),
        });
      }
      args.push('--model', model);
    }
    if (phase === 'plan' && help.stdout.includes('--tools')) args.push('--tools', '');
    const started = Date.now();
    let result;
    try {
      result = await execa('claude', args, {
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
          'Claude Code',
          phase,
          ['claude', ...args],
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
      const combined = `${result.stdout}\n${result.stderr}`;
      if (
        model &&
        !result.isCanceled &&
        !result.timedOut &&
        /unknown model|invalid model|model .* not (found|supported|available)|unrecognized model/i.test(
          combined,
        )
      ) {
        throw new AurousError({
          code: 'AUR-AGENT-004',
          summary: `Claude Code rejected requested model ${JSON.stringify(model)}.`,
          probableCause:
            redactText(result.stderr.trim() || result.stdout.trim()).slice(0, 500) ||
            'The local agent CLI rejected the exact model requested by Aurous.',
          nextAction:
            'Choose a locally advertised model from "aurous --help" / "/help", then retry with the same --model value. Aurous does not substitute models.',
          runId: invocationRunId(input),
        });
      }
      throw commandFailure(
        'Claude Code',
        phase,
        ['claude', ...args],
        result.stdout,
        result.stderr,
        result.timedOut,
        result.isCanceled,
        durationMs,
        invocationRunId(input),
      );
    }
    return {
      value: parse(parseJsonPayload(result.stdout)),
      command: ['claude', ...args],
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
    };
  }
}

function normalizeExecutionInvocation(
  invocation: InvocationRecord<ParsedExecutionResult>,
): InvocationRecord<ExecutionResult> {
  const { value, ...record } = invocation;
  return {
    ...record,
    value: value.result,
    ...(value.diagnostics.length > 0 ? { boundaryDiagnostics: value.diagnostics } : {}),
  };
}

function invocationRunId(
  input:
    | PlanGenerationInput
    | DestinationDiscoveryInput
    | PlanExecutionInput
    | RecoveryInspectionInput
    | RecoveryActionExecutionInput,
): string {
  if ('runId' in input) return input.runId;
  if ('discoveryId' in input) return input.discoveryId;
  if ('plan' in input) return input.plan.runId;
  if ('recoveryRunId' in input) return input.recoveryRunId;
  return input.recoveryPlan.recoveryRunId;
}

function claudeMcpReadiness(
  exitCode: number,
  output: string,
  name: 'notion' | 'linear' | 'airtable' | 'trello',
): AgentDiagnostic['mcp']['notion'] {
  if (exitCode !== 0)
    return { status: 'unknown', detail: 'Could not inspect Claude Code MCP configuration.' };
  const line = output
    .split('\n')
    .find((candidate) => new RegExp(`\\b${name}\\b`, 'i').test(candidate));
  if (!line) return { status: 'not-ready', detail: `${name} was not listed by "claude mcp list".` };
  if (/disabled|failed|error/i.test(line))
    return { status: 'not-ready', detail: redactText(line.trim()) };
  return { status: 'ready', detail: redactText(line.trim()) };
}
