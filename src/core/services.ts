import path from 'node:path';
import {
  createAgentAdapter,
  type AgentAdapter,
  type AgentDiagnostic,
} from '../adapters/agents/index.js';
import { createProductivityAdapter } from '../adapters/productivity/index.js';
import {
  AgentNameSchema,
  AurousPlanSchema,
  ExecutionResultSchema,
  PlanProposalSchema,
  ToolNameSchema,
  type AgentName,
  type AurousConfig,
  type AurousPlan,
  type DiagnosticEvent,
  type ExecutionResult,
  type RunRecord,
} from '../domain/schemas.js';
import { asAurousError, AurousCommandError, AurousError } from './errors.js';
import { ingestContext } from './context.js';
import {
  formatContextSummary,
  formatExecutionResult,
  formatPlan,
  formatRun,
  type Output,
} from './output.js';
import { createRunId } from './run-id.js';
import type { RunStore } from './run-store.js';

export interface ServiceDependencies {
  workspace: string;
  store: RunStore;
  output: Output;
  agentFactory?: (name: AgentName) => AgentAdapter;
  now?: () => Date;
}

export interface PlanOptions {
  agent?: string;
  tool?: string;
  contextPaths: string[];
  objective: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ApplyOptions {
  confirmed: boolean;
  confirm?: () => Promise<boolean>;
  signal?: AbortSignal;
}

export interface DoctorReport {
  node: { status: 'ready' | 'not-ready'; version: string; detail: string };
  state: { status: 'ready' | 'not-ready'; detail: string };
  agents: AgentDiagnostic[];
}

export class AurousServices {
  private readonly agentFactory: (name: AgentName) => AgentAdapter;
  private readonly now: () => Date;

  constructor(private readonly dependencies: ServiceDependencies) {
    this.agentFactory = dependencies.agentFactory ?? createAgentAdapter;
    this.now = dependencies.now ?? (() => new Date());
  }

  async init(config: Partial<AurousConfig> = {}): Promise<AurousConfig> {
    const saved = await this.dependencies.store.init(config);
    this.dependencies.output.log(
      `Initialized Aurous state at ${path.join(this.dependencies.workspace, '.aurous')}`,
    );
    this.dependencies.output.log(
      `Defaults: agent=${saved.defaultAgent}, tool=${saved.defaultTool}, timeout=${saved.timeoutMs}ms`,
    );
    return saved;
  }

  async doctor(verbose = false): Promise<DoctorReport> {
    const major = Number(process.versions.node.split('.')[0]);
    let state: DoctorReport['state'];
    try {
      await this.dependencies.store.loadConfig();
      state = { status: 'ready', detail: 'Local configuration is valid.' };
    } catch {
      state = { status: 'not-ready', detail: 'Run "aurous init" to create local state.' };
    }
    const agents = await Promise.all(
      (['codex', 'claude', 'mock'] as const).map((name) => this.agentFactory(name).diagnose()),
    );
    const report: DoctorReport = {
      node: {
        status: major >= 20 ? 'ready' : 'not-ready',
        version: process.version,
        detail:
          major >= 20 ? 'Node.js meets the >=20 requirement.' : 'Install Node.js 20 or newer.',
      },
      state,
      agents,
    };
    this.dependencies.output.log(
      `Node ${report.node.status}: ${report.node.version} — ${report.node.detail}`,
    );
    this.dependencies.output.log(`State ${state.status}: ${state.detail}`);
    for (const agent of agents) {
      this.dependencies.output.log(
        `${agent.name}: ${agent.installed ? 'installed' : 'missing'}, noninteractive=${agent.supportsNonInteractive ? 'ready' : 'not-ready'}, auth=${agent.authentication.status}`,
      );
      this.dependencies.output.log(
        `  MCP notion=${agent.mcp.notion.status}, linear=${agent.mcp.linear.status}`,
      );
      if (verbose) {
        if (agent.version) this.dependencies.output.log(`  Version: ${agent.version}`);
        this.dependencies.output.log(`  Auth: ${agent.authentication.detail}`);
        this.dependencies.output.log(`  Notion: ${agent.mcp.notion.detail}`);
        this.dependencies.output.log(`  Linear: ${agent.mcp.linear.detail}`);
        for (const warning of agent.warnings) this.dependencies.output.log(`  Warning: ${warning}`);
      }
    }
    return report;
  }

  async plan(options: PlanOptions): Promise<AurousPlan> {
    const config = await this.dependencies.store.loadConfig();
    const agentName = AgentNameSchema.parse(options.agent ?? config.defaultAgent);
    const toolName = ToolNameSchema.parse(options.tool ?? config.defaultTool);
    const objective = options.objective.trim();
    if (!objective) {
      throw new AurousError({
        code: 'AUR-PLAN-001',
        summary: 'The plan objective cannot be empty.',
        probableCause: 'The --prompt value was blank.',
        nextAction: 'Describe the outcome you want with --prompt.',
      });
    }
    const context = await ingestContext({
      cwd: this.dependencies.workspace,
      paths: options.contextPaths,
    });
    this.dependencies.output.log(formatContextSummary(context.summary));
    this.dependencies.output.log(
      '\nNo productivity tool has been changed. Generating a read-only plan...',
    );

    const runId = createRunId(this.now());
    const timestamp = this.now().toISOString();
    const record: RunRecord = {
      runId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'planning',
      agent: agentName,
      tool: toolName,
      objective,
      approvedContextPaths: context.summary.approvedPaths,
    };
    await this.dependencies.store.createRun(record, context);
    await this.event(runId, 'info', 'AUR-PLAN-100', 'Plan generation started.', {
      agent: agentName,
      tool: toolName,
      contextFileCount: context.summary.fileCount,
    });

    try {
      const adapter = this.agentFactory(agentName);
      const productivity = createProductivityAdapter(toolName);
      const invocation = await adapter.generatePlan({
        runId,
        workspace: this.dependencies.workspace,
        runDirectory: this.dependencies.store.runDirectory(runId),
        objective,
        context,
        productivity,
        timeoutMs: options.timeoutMs ?? config.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await this.dependencies.store.saveCommandLog(
        runId,
        'plan-agent',
        invocation.stdout,
        invocation.stderr,
      );
      const proposal = PlanProposalSchema.parse(invocation.value);
      validateProposalSemantics(proposal);
      const plan = AurousPlanSchema.parse({
        ...proposal,
        schemaVersion: 1,
        runId,
        createdAt: timestamp,
        agent: agentName,
        tool: toolName,
        objective,
        contextSummary: context.summary,
      });
      await this.dependencies.store.savePlan(plan);
      await this.dependencies.store.updateStatus(runId, 'planned');
      await this.event(runId, 'info', 'AUR-PLAN-101', 'Validated plan saved.', {
        command: invocation.command,
        durationMs: invocation.durationMs,
        actionCount: plan.plannedActions.length,
      });
      this.dependencies.output.log(`\n${formatPlan(plan)}`);
      this.dependencies.output.log(`\nSaved locally. Apply with: aurous apply ${runId}`);
      return plan;
    } catch (error) {
      const classified = asAurousError(error, runId);
      if (error instanceof AurousCommandError) {
        await this.dependencies.store.saveCommandLog(
          runId,
          'plan-agent-failed',
          error.stdout,
          error.stderr,
        );
      }
      await this.dependencies.store.updateStatus(
        runId,
        classified.code === 'AUR-AGENT-007' ? 'cancelled' : 'failed',
      );
      await this.event(runId, 'error', classified.code, classified.message, {
        severity: classified.severity,
        probableCause: classified.probableCause,
        nextAction: classified.nextAction,
        ...(error instanceof AurousCommandError
          ? { command: error.command, durationMs: error.durationMs }
          : {}),
      });
      throw classified;
    }
  }

  async apply(runId: string, options: ApplyOptions): Promise<ExecutionResult | undefined> {
    const [record, plan, config] = await Promise.all([
      this.dependencies.store.getRun(runId),
      this.dependencies.store.loadPlan(runId),
      this.dependencies.store.loadConfig(),
    ]);
    if (record.status === 'applying') {
      throw new AurousError({
        code: 'AUR-APPLY-001',
        summary: `Run ${runId} is already applying.`,
        probableCause: 'Another Aurous process may be executing this run.',
        nextAction: `Wait, then run "aurous diagnose ${runId}".`,
        runId,
      });
    }
    if (record.status === 'succeeded') {
      throw new AurousError({
        code: 'AUR-APPLY-002',
        summary: `Run ${runId} already succeeded.`,
        probableCause: 'Reapplying could create duplicate productivity objects.',
        nextAction: 'Create a new plan for any additional work.',
        runId,
      });
    }
    this.dependencies.output.log(formatPlan(plan));
    const confirmed = options.confirmed || (options.confirm ? await options.confirm() : false);
    if (!confirmed) {
      await this.event(
        runId,
        'warning',
        'AUR-APPLY-100',
        'Apply preview declined; no external writes attempted.',
      );
      this.dependencies.output.log('\nApply cancelled. No external writes were attempted.');
      return undefined;
    }

    await this.dependencies.store.updateStatus(runId, 'applying');
    await this.event(
      runId,
      'info',
      'AUR-APPLY-101',
      'Explicit confirmation received; apply started.',
      {
        actionIds: plan.plannedActions.map((action) => action.id),
        destructiveActionCount: plan.destructiveActions.length,
      },
    );
    try {
      const adapter = this.agentFactory(plan.agent);
      const productivity = createProductivityAdapter(plan.tool);
      const invocation = await adapter.executePlan({
        workspace: this.dependencies.workspace,
        runDirectory: this.dependencies.store.runDirectory(runId),
        plan,
        productivity,
        timeoutMs: config.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await this.dependencies.store.saveCommandLog(
        runId,
        'apply-agent',
        invocation.stdout,
        invocation.stderr,
      );
      const result = ExecutionResultSchema.parse(invocation.value);
      validateExecutionScope(plan, result);
      await this.dependencies.store.saveResult(runId, result);
      await this.dependencies.store.updateStatus(runId, result.status);
      await this.event(
        runId,
        result.status === 'failed' ? 'error' : 'info',
        'AUR-APPLY-102',
        'Apply finished.',
        {
          command: invocation.command,
          durationMs: invocation.durationMs,
          status: result.status,
          completedActionIds: result.completedActionIds,
        },
      );
      this.dependencies.output.log(formatExecutionResult(result));
      return result;
    } catch (error) {
      const classified = asAurousError(error, runId);
      const now = this.now().toISOString();
      if (error instanceof AurousCommandError) {
        await this.dependencies.store.saveCommandLog(
          runId,
          'apply-agent-failed',
          error.stdout,
          error.stderr,
        );
      }
      const finalStatus = classified.code === 'AUR-AGENT-007' ? 'cancelled' : 'failed';
      const failedResult: ExecutionResult = {
        status: finalStatus,
        summary: classified.message,
        createdObjects: [],
        completedActionIds: [],
        warnings: [],
        failures: [
          {
            code: classified.code,
            summary: classified.message,
            probableCause: classified.probableCause,
            nextAction: classified.nextAction,
            severity: classified.severity,
          },
        ],
        startedAt: now,
        finishedAt: now,
      };
      await this.dependencies.store.saveResult(runId, failedResult);
      await this.dependencies.store.updateStatus(runId, finalStatus);
      await this.event(runId, 'error', classified.code, classified.message, {
        severity: classified.severity,
        probableCause: classified.probableCause,
        nextAction: classified.nextAction,
        ...(error instanceof AurousCommandError
          ? { command: error.command, durationMs: error.durationMs }
          : {}),
      });
      throw classified;
    }
  }

  async runs(): Promise<RunRecord[]> {
    const runs = await this.dependencies.store.listRuns();
    if (runs.length === 0) this.dependencies.output.log('No Aurous runs found.');
    else runs.forEach((run) => this.dependencies.output.log(formatRun(run)));
    return runs;
  }

  async diagnoseRun(runId: string, verbose = false): Promise<void> {
    const [record, plan, result, events] = await Promise.all([
      this.dependencies.store.getRun(runId),
      this.dependencies.store.loadPlan(runId).catch(() => undefined),
      this.dependencies.store.loadResult(runId),
      this.dependencies.store.readEvents(runId),
    ]);
    this.dependencies.output.log(`Aurous diagnostic report — ${runId}`);
    this.dependencies.output.log(`Status: ${record.status}`);
    this.dependencies.output.log(`Agent/tool: ${record.agent} + ${record.tool}`);
    this.dependencies.output.log(`Created: ${record.createdAt}; updated: ${record.updatedAt}`);
    this.dependencies.output.log(`Objective: ${record.objective}`);
    if (plan) {
      this.dependencies.output.log(
        `Plan: ${plan.plannedActions.length} actions, ${plan.destructiveActions.length} destructive, ${plan.warnings.length} warnings`,
      );
    }
    if (result) this.dependencies.output.log(formatExecutionResult(result));
    this.dependencies.output.log('Events:');
    for (const event of events) {
      this.dependencies.output.log(
        `  ${event.timestamp} ${event.level.toUpperCase()} ${event.code}: ${event.summary}`,
      );
      if (verbose && Object.keys(event.metadata).length > 0)
        this.dependencies.output.log(`    ${JSON.stringify(event.metadata)}`);
    }
    if (verbose)
      this.dependencies.output.log(
        `Local run directory: ${this.dependencies.store.runDirectory(runId)}`,
      );
    this.dependencies.output.log(
      `Follow-up prompt: Investigate Aurous run ${runId} using this redacted report. Preserve the approved plan scope and address the first fatal or recoverable AUR-* event.`,
    );
  }

  private event(
    runId: string,
    level: DiagnosticEvent['level'],
    code: string,
    summary: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    return this.dependencies.store.appendEvent(runId, {
      timestamp: this.now().toISOString(),
      level,
      code,
      summary,
      metadata,
    });
  }
}

function validateProposalSemantics(proposal: ReturnType<typeof PlanProposalSchema.parse>): void {
  const ids = new Set(proposal.plannedActions.map((action) => action.id));
  proposal.plannedActions.forEach((action, index) => {
    const expected = `action-${String(index + 1).padStart(3, '0')}`;
    if (action.id !== expected || action.dependsOn.some((dependency) => !ids.has(dependency))) {
      throw new AurousError({
        code: 'AUR-PLAN-002',
        summary: 'The generated plan has invalid action sequencing or dependencies.',
        probableCause:
          'The agent returned action IDs or dependency references outside the plan contract.',
        nextAction: 'Retry plan generation; no productivity tool was changed.',
      });
    }
  });
  if (proposal.destructiveActions.some((action) => !ids.has(action.actionId))) {
    throw new AurousError({
      code: 'AUR-PLAN-003',
      summary: 'A destructive action references an unknown plan action.',
      probableCause: 'The agent returned an inconsistent destructive action disclosure.',
      nextAction: 'Retry plan generation; no productivity tool was changed.',
    });
  }
}

function validateExecutionScope(plan: AurousPlan, result: ExecutionResult): void {
  const approved = new Set(plan.plannedActions.map((action) => action.id));
  const referenced = [
    ...result.completedActionIds,
    ...result.createdObjects.map((object) => object.actionId),
    ...result.failures.flatMap((failure) => (failure.actionId ? [failure.actionId] : [])),
  ];
  if (referenced.some((actionId) => !approved.has(actionId))) {
    throw new AurousError({
      code: 'AUR-APPLY-003',
      summary: 'The agent reported work outside the approved action scope.',
      probableCause:
        'The execution response referenced an action ID that was not in the saved plan.',
      nextAction: `Run "aurous diagnose ${plan.runId} --verbose" and inspect the target tool for unexpected objects.`,
      runId: plan.runId,
    });
  }
}
