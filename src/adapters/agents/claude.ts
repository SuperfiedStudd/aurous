import { execa } from 'execa';
import { AurousError } from '../../core/errors.js';
import { redactText } from '../../core/redact.js';
import { ExecutionResultSchema, PlanProposalSchema } from '../../domain/schemas.js';
import { buildExecutionPrompt, buildPlanningPrompt } from './prompts.js';
import { commandFailure, parseJsonPayload, writeManualPrompt } from './helpers.js';
import type {
  AgentAdapter,
  AgentDiagnostic,
  InvocationRecord,
  PlanExecutionInput,
  PlanGenerationInput,
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
      },
      warnings: supportsNonInteractive
        ? ['Authentication readiness will be confirmed by the first noninteractive invocation.']
        : ['Installed Claude Code does not advertise --print and --output-format.'],
    };
  }

  async generatePlan(input: PlanGenerationInput) {
    const prompt = buildPlanningPrompt(input.objective, input.context, input.productivity);
    await this.requireReady(input.runDirectory, 'plan', prompt);
    return this.invoke(input, 'plan', prompt, (value) => PlanProposalSchema.parse(value));
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
    return this.invoke(input, 'apply', prompt, (value) => ExecutionResultSchema.parse(value));
  }

  manualFallback(runDirectory: string, phase: 'plan' | 'apply', prompt: string): Promise<string> {
    return writeManualPrompt(runDirectory, phase, prompt);
  }

  private async requireReady(
    runDirectory: string,
    phase: 'plan' | 'apply',
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
    input: PlanGenerationInput | PlanExecutionInput,
    phase: 'plan' | 'apply',
    prompt: string,
    parse: (value: unknown) => T,
  ): Promise<InvocationRecord<T>> {
    const help = await execa('claude', ['--help'], { reject: false, timeout: 15_000 });
    const args = ['--print', '--output-format', 'json'];
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
          'plan' in input ? input.plan.runId : input.runId,
        );
      }
      throw error;
    }
    const durationMs = Date.now() - started;
    if (result.exitCode !== 0 || result.isCanceled) {
      throw commandFailure(
        'Claude Code',
        phase,
        ['claude', ...args],
        result.stdout,
        result.stderr,
        result.timedOut,
        result.isCanceled,
        durationMs,
        'plan' in input ? input.plan.runId : input.runId,
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

function claudeMcpReadiness(
  exitCode: number,
  output: string,
  name: 'notion' | 'linear',
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
