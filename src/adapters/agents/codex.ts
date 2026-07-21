import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { AurousError } from '../../core/errors.js';
import { redactText } from '../../core/redact.js';
import {
  PlanProposalResponseSchema,
  parseExecutionResultResponse,
  type ExecutionResult,
  type ParsedExecutionResult,
} from '../../domain/schemas.js';
import { executionResultJsonSchema, planProposalJsonSchema } from '../../domain/json-schemas.js';
import { RecoveryInspectionSchema } from '../../domain/recovery.js';
import { recoveryInspectionJsonSchema } from '../../domain/recovery-json-schemas.js';
import {
  DestinationDiscoverySchema,
  type SanitizedDiscoveryTrace,
} from '../../domain/destinations.js';
import { destinationDiscoveryJsonSchema } from '../../domain/destination-json-schema.js';
import {
  buildDestinationDiscoveryPrompt,
  buildExecutionPrompt,
  buildPlanningPrompt,
  buildRecoveryActionPrompt,
  buildRecoveryInspectionPrompt,
} from './prompts.js';
import {
  commandFailure,
  findMcpServerBlocks,
  parseJsonPayload,
  structuredOutputFailure,
  writeManualPrompt,
  type AgentPhase,
} from './helpers.js';
import { buildCodexDiscoveryTrace } from './discovery-trace.js';
import {
  codexCacheSchemaFailureError,
  isCodexModelsCacheSchemaError,
  runCodexPreflight,
  writeCodexCacheRepairDiagnostic,
  type CodexCacheRepairResult,
} from './codex-cache.js';
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

export class CodexAgentAdapter implements AgentAdapter {
  readonly name = 'codex' as const;
  private cacheRepairAttempted = false;

  async diagnose(options: { repair?: boolean } = {}): Promise<AgentDiagnostic> {
    const preflight = await runCodexPreflight({
      repair: Boolean(options.repair),
      runProbe: Boolean(options.repair),
    });
    if (!preflight.installed) {
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
          airtable: { status: 'unknown', detail: 'Codex is unavailable.' },
          trello: { status: 'unknown', detail: 'Codex is unavailable.' },
        },
        warnings: ['Install Codex CLI before selecting --agent codex.'],
        ...(preflight.repair ? { cacheRepair: sanitizeRepair(preflight.repair) } : {}),
      };
    }
    const [help, auth, mcp] = await Promise.all([
      execa('codex', ['exec', '--help'], { reject: false, timeout: 15_000 }),
      execa('codex', ['login', 'status'], { reject: false, timeout: 15_000 }),
      execa('codex', ['mcp', 'list'], { reject: false, timeout: 20_000 }),
    ]);
    const supportsNonInteractive = requiredCodexFlags.every((flag) => help.stdout.includes(flag));
    const mcpOutput = `${mcp.stdout}\n${mcp.stderr}`;
    const warnings: string[] = [];
    if (!supportsNonInteractive) {
      warnings.push(
        'Installed Codex does not advertise every noninteractive flag Aurous requires.',
      );
    }
    if (!preflight.cache.valid) {
      warnings.push(
        preflight.cache.issue ??
          'Codex models cache is schema-incompatible. Run "aurous doctor --agent codex --repair".',
      );
    }
    if (preflight.repair?.repaired && preflight.repair.backupPath) {
      warnings.push(`Repaired Codex models cache; backup at ${preflight.repair.backupPath}.`);
      this.cacheRepairAttempted = true;
    }
    return {
      name: this.name,
      installed: true,
      ...(preflight.version ? { version: preflight.version } : {}),
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
        airtable: mcpReadiness(mcp.exitCode ?? -1, mcpOutput, 'airtable'),
        trello: mcpReadiness(mcp.exitCode ?? -1, mcpOutput, 'trello'),
      },
      warnings,
      ...(preflight.repair ? { cacheRepair: sanitizeRepair(preflight.repair) } : {}),
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
    return this.invoke(input, 'plan', prompt, planProposalJsonSchema, (value) =>
      PlanProposalResponseSchema.parse(value),
    );
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
    return this.invoke(
      input,
      'destination-discover',
      prompt,
      destinationDiscoveryJsonSchema,
      (value) => DestinationDiscoverySchema.parse(value),
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
    const invocation = await this.invoke(
      input,
      'apply',
      prompt,
      executionResultJsonSchema,
      parseExecutionResultResponse,
    );
    return normalizeExecutionInvocation(invocation, input.runDirectory, 'apply');
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
    const invocation = await this.invoke(
      input,
      'recover-apply',
      prompt,
      executionResultJsonSchema,
      parseExecutionResultResponse,
    );
    return normalizeExecutionInvocation(invocation, input.runDirectory, 'recover-apply');
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
          summary: `${tool === 'notion' ? 'Notion' : tool === 'linear' ? 'Linear' : tool === 'trello' ? 'Trello' : 'Airtable'} is not connected to Codex yet.`,
          probableCause: 'The selected local agent cannot access this integration.',
          nextAction: `Connect ${tool === 'notion' ? 'Notion' : tool === 'linear' ? 'Linear' : tool === 'trello' ? 'Trello' : 'Airtable'} in Codex, then repeat the request.`,
          severity: 'recoverable',
          runId,
        });
      }
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
    await this.ensureModelsCacheReady(runDirectory);
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

  private async ensureModelsCacheReady(runDirectory: string): Promise<void> {
    const preflight = await runCodexPreflight({
      repair: !this.cacheRepairAttempted,
      runProbe: false,
    });
    if (preflight.repair?.attempted) {
      this.cacheRepairAttempted = true;
      await writeCodexCacheRepairDiagnostic(runDirectory, preflight.repair);
    }
    if (!preflight.cache.valid && !preflight.repair?.repaired) {
      throw codexCacheSchemaFailureError({
        detail: preflight.detail,
        ...(preflight.repair?.backupPath ? { backupPath: preflight.repair.backupPath } : {}),
      });
    }
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
    schema: object,
    parse: (value: unknown) => T,
  ): Promise<InvocationRecord<T>> {
    const schemaPath = path.join(input.runDirectory, `${phase}-response-schema.json`);
    const outputPath = path.join(input.runDirectory, `${phase}-agent-response.json`);
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const requestedModel = 'model' in input ? input.model : undefined;
    const args = buildCodexInvocationArgs(
      phase,
      schemaPath,
      outputPath,
      executionTool(input),
      requestedModel,
    );
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let result = await this.execCodex(args, input, prompt, phase);
    if (
      (result.exitCode !== 0 || result.isCanceled) &&
      isCodexModelsCacheSchemaError(result.stderr) &&
      !this.cacheRepairAttempted
    ) {
      const repairPreflight = await runCodexPreflight({ repair: true, runProbe: false });
      this.cacheRepairAttempted = true;
      if (repairPreflight.repair) {
        await writeCodexCacheRepairDiagnostic(input.runDirectory, repairPreflight.repair);
      }
      if (!repairPreflight.repair?.repaired && !repairPreflight.cache.valid) {
        throw codexCacheSchemaFailureError({
          detail: repairPreflight.detail,
          ...(repairPreflight.repair?.backupPath
            ? { backupPath: repairPreflight.repair.backupPath }
            : {}),
          runId: invocationRunId(input),
          ...(requestedModel ? { requestedModel } : {}),
        });
      }
      // Exactly one retry after a recognized cache-schema repair.
      result = await this.execCodex(args, input, prompt, phase);
      if (
        (result.exitCode !== 0 || result.isCanceled) &&
        isCodexModelsCacheSchemaError(result.stderr)
      ) {
        throw codexCacheSchemaFailureError({
          detail: redactText(`${result.stderr}\n${result.stdout}`.trim()).slice(0, 500),
          ...(repairPreflight.repair?.backupPath
            ? { backupPath: repairPreflight.repair.backupPath }
            : {}),
          runId: invocationRunId(input),
          ...(requestedModel ? { requestedModel } : {}),
        });
      }
    }
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - started;
    if (result.exitCode !== 0 || result.isCanceled) {
      throw classifyCodexCommandFailure(
        phase,
        args,
        result.stdout,
        result.stderr,
        result.timedOut,
        result.isCanceled,
        durationMs,
        invocationRunId(input),
        requestedModel,
      );
    }
    const runId = invocationRunId(input);
    let output: string;
    try {
      output = await readFile(outputPath, 'utf8');
    } catch {
      const eventMessage = extractCodexJsonLastMessage(result.stdout);
      if (eventMessage) output = eventMessage;
      else if (result.stdout.trim()) output = result.stdout;
      else {
        const likelyTimedOut = result.timedOut || durationMs >= input.timeoutMs - 1_000;
        throw classifyCodexCommandFailure(
          phase,
          args,
          result.stdout,
          result.stderr,
          likelyTimedOut,
          result.isCanceled,
          durationMs,
          runId,
          requestedModel,
        );
      }
    }
    let value: T;
    try {
      value = parse(parseJsonPayload(output));
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
    const integration = executionTool(input);
    const record: InvocationRecord<T> = {
      value,
      command: ['codex', ...args],
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
    };
    // Build the audit trace after the result is already valid; a trace failure must never
    // reclassify a valid discovery as invalid structured output.
    if (phase === 'destination-discover' && integration && integration !== 'mock') {
      record.discoveryTrace = safeCodexDiscoveryTrace({
        stdout: result.stdout,
        discoveryId: runId,
        integration,
        startedAt,
        completedAt,
      });
    }
    return record;
  }

  private async execCodex(
    args: string[],
    input:
      | PlanGenerationInput
      | DestinationDiscoveryInput
      | PlanExecutionInput
      | RecoveryInspectionInput
      | RecoveryActionExecutionInput,
    prompt: string,
    phase: AgentPhase,
  ) {
    const started = Date.now();
    try {
      return await execa('codex', args, {
        cwd: input.workspace,
        input: prompt,
        reject: false,
        timeout: input.timeoutMs,
        ...(input.signal ? { cancelSignal: input.signal } : {}),
      });
    } catch (error) {
      if (input.signal?.aborted) {
        throw commandFailure(
          'Codex',
          phase,
          ['codex', ...args],
          '',
          error instanceof Error ? error.message : String(error),
          false,
          true,
          Date.now() - started,
          invocationRunId(input),
        );
      }
      throw error;
    }
  }
}

export function extractCodexJsonLastMessage(stdout: string): string | undefined {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = isRecord(event.item) ? event.item : undefined;
      if (item?.type !== 'agent_message') continue;
      if (typeof item.text === 'string' && item.text.trim()) return item.text;
      if (typeof item.message === 'string' && item.message.trim()) return item.message;
      if (typeof item.content === 'string' && item.content.trim()) return item.content;
      if (Array.isArray(item.content)) {
        const text = item.content
          .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
          .join('')
          .trim();
        if (text) return text;
      }
    } catch {
      // Non-JSON stdout is handled by the caller's existing fallback.
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildCodexInvocationArgs(
  phase: AgentPhase,
  schemaPath: string,
  outputPath: string,
  executionTool?: 'notion' | 'linear' | 'airtable' | 'trello' | 'mock',
  model?: string,
): string[] {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only'];
  if (phase === 'destination-discover') args.push('--json');
  if (model) args.push('--model', model);
  if (
    (phase === 'apply' || phase === 'recover-apply') &&
    executionTool &&
    executionTool !== 'mock'
  ) {
    args.push(
      '--strict-config',
      '--config',
      `mcp_servers.${executionTool}.default_tools_approval_mode="approve"`,
    );
  }
  args.push('--output-schema', schemaPath, '--output-last-message', outputPath, '-');
  return args;
}

function executionTool(
  input:
    | PlanGenerationInput
    | DestinationDiscoveryInput
    | PlanExecutionInput
    | RecoveryInspectionInput
    | RecoveryActionExecutionInput,
): 'notion' | 'linear' | 'airtable' | 'trello' | 'mock' | undefined {
  if ('plan' in input) return input.plan.tool;
  if ('discoveryId' in input) return input.productivity.name;
  if ('recoveryPlan' in input) return input.recoveryPlan.tool;
  return undefined;
}

async function normalizeExecutionInvocation(
  invocation: InvocationRecord<ParsedExecutionResult>,
  runDirectory: string,
  phase: 'apply' | 'recover-apply',
): Promise<InvocationRecord<ExecutionResult>> {
  const { value, ...record } = invocation;
  if (value.diagnostics.length > 0) {
    await writeFile(
      path.join(runDirectory, `${phase}-agent-response.json`),
      `${JSON.stringify(value.result)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
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

const requiredCodexFlags = [
  '--config',
  '--output-schema',
  '--output-last-message',
  '--ephemeral',
  '--json',
  '--skip-git-repo-check',
  '--sandbox',
  '--strict-config',
];

export function mcpReadiness(
  exitCode: number,
  output: string,
  name: 'notion' | 'linear' | 'airtable' | 'trello',
): AgentDiagnostic['mcp']['notion'] {
  if (exitCode !== 0)
    return { status: 'unknown', detail: 'Could not inspect Codex MCP configuration.' };
  const blocks = findMcpServerBlocks(output, name);
  if (blocks.length === 0)
    return { status: 'not-ready', detail: `${name} was not listed by "codex mcp list".` };
  let readyDetail: string | undefined;
  for (const block of blocks) {
    if (readyDetail === undefined) readyDetail = block.entryLine.trim();
    const failing = block.lines.find((candidate) => /disabled|failed|error/i.test(candidate));
    if (failing) return { status: 'not-ready', detail: redactText(failing.trim()) };
  }
  return { status: 'ready', detail: redactText(readyDetail ?? '') };
}

export function safeCodexDiscoveryTrace(input: {
  stdout: string;
  discoveryId: string;
  integration: 'notion' | 'linear' | 'airtable' | 'trello';
  startedAt: string;
  completedAt: string;
}): SanitizedDiscoveryTrace {
  try {
    return buildCodexDiscoveryTrace(input);
  } catch {
    return {
      schemaVersion: 1,
      discoveryId: input.discoveryId,
      integration: input.integration,
      agent: 'codex',
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      success: false,
      sanitized: true,
      operations: [],
      warnings: [
        'Aurous could not construct the sanitized discovery trace from the Codex event stream; the discovery result is valid but its MCP read audit is unavailable.',
      ],
    };
  }
}

function sanitizeRepair(
  repair: CodexCacheRepairResult,
): NonNullable<AgentDiagnostic['cacheRepair']> {
  return {
    repaired: repair.repaired,
    attempted: repair.attempted,
    ...(repair.backupPath ? { backupPath: repair.backupPath } : {}),
    detail: repair.detail,
  };
}

function classifyCodexCommandFailure(
  phase: AgentPhase,
  args: string[],
  stdout: string,
  stderr: string,
  timedOut: boolean,
  cancelled: boolean,
  durationMs: number,
  runId?: string,
  requestedModel?: string,
) {
  const combined = `${stdout}\n${stderr}`;
  // Classify cache-schema failures from stderr only; agent-controlled stdout must not
  // relabel a genuine failure as AUR-AGENT-009 cache-repair advice.
  if (!cancelled && !timedOut && isCodexModelsCacheSchemaError(stderr)) {
    return codexCacheSchemaFailureError({
      detail: redactText(stderr.trim() || stdout.trim()).slice(0, 500),
      ...(runId ? { runId } : {}),
      ...(requestedModel ? { requestedModel } : {}),
    });
  }
  if (
    requestedModel &&
    !cancelled &&
    !timedOut &&
    /unknown model|invalid model|model .* not (found|supported|available)|unrecognized model/i.test(
      combined,
    )
  ) {
    return new AurousError({
      code: 'AUR-AGENT-004',
      summary: `Codex rejected requested model ${JSON.stringify(requestedModel)}.`,
      probableCause:
        redactText(stderr.trim() || stdout.trim()).slice(0, 500) ||
        'The local agent CLI rejected the exact model requested by Aurous.',
      nextAction:
        'Choose a locally advertised model from "aurous --help" / "/help", then retry with the same --model value. Aurous does not substitute models.',
      ...(runId ? { runId } : {}),
    });
  }
  return commandFailure(
    'Codex',
    phase,
    ['codex', ...args],
    stdout,
    stderr,
    timedOut,
    cancelled,
    durationMs,
    runId,
  );
}
