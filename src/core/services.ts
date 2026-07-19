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
  normalizeExecutionResultBoundary,
  PlanProposalSchema,
  ToolNameSchema,
  type AgentName,
  type AurousConfig,
  type AurousPlan,
  type DiagnosticEvent,
  type ExecutionBoundaryDiagnostic,
  type ExecutionResult,
  type RunRecord,
} from '../domain/schemas.js';
import { buildLinearDemoPlan, parseLinearDemoContext } from '../domain/linear-demo.js';
import {
  RecoveryInspectionSchema,
  buildRecoveryPlan,
  compareRecoverySemanticInspections,
  type RecoveryPlan,
} from '../domain/recovery.js';
import { asAurousError, AurousCommandError, AurousError } from './errors.js';
import { ingestContext } from './context.js';
import {
  formatContextSummary,
  formatExecutionResult,
  formatPlan,
  formatRecoveryPlan,
  formatRun,
  type Output,
} from './output.js';
import {
  formatApprovalReceipt,
  formatOpeningHeader,
  formatPlainNotice,
  formatProgress,
  type ProgressWord,
} from './presentation.js';
import { createRunId } from './run-id.js';
import { redactValue } from './redact.js';
import type { RunStore } from './run-store.js';

export interface ServiceDependencies {
  workspace: string;
  store: RunStore;
  output: Output;
  agentFactory?: (name: AgentName) => AgentAdapter;
  now?: () => Date;
  progressIntervalMs?: number;
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
  alreadyPreviewed?: boolean;
  signal?: AbortSignal;
}

export interface LinearDemoPlanOptions {
  agent?: string;
  team: string;
  contextPaths: string[];
}

export interface RecoverOptions {
  signal?: AbortSignal;
}

export interface ApplyRecoveryOptions {
  confirm: () => Promise<boolean>;
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
  private readonly progressIntervalMs: number;

  constructor(private readonly dependencies: ServiceDependencies) {
    this.agentFactory = dependencies.agentFactory ?? createAgentAdapter;
    this.now = dependencies.now ?? (() => new Date());
    this.progressIntervalMs = dependencies.progressIntervalMs ?? 10_000;
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
    const runId = createRunId(this.now());
    const timestamp = this.now().toISOString();
    this.dependencies.output.log(
      formatOpeningHeader({
        agent: agentName,
        target: toolName,
        mode: 'Planning',
        runId,
        ...(agentName === 'mock' ? { model: 'built-in deterministic adapter' } : {}),
      }),
    );
    const context = await ingestContext({
      cwd: this.dependencies.workspace,
      paths: options.contextPaths,
    });
    this.dependencies.output.log(`\n${formatContextSummary(context.summary)}`);

    const record: RunRecord = {
      runId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'planning',
      agent: agentName,
      tool: toolName,
      objective,
      approvedContextPaths: context.summary.approvedPaths,
      runKind: 'standard',
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
      const invocation = await this.withProgress('plan generation', options.signal, () =>
        adapter.generatePlan({
          runId,
          workspace: this.dependencies.workspace,
          runDirectory: this.dependencies.store.runDirectory(runId),
          objective,
          context,
          productivity,
          timeoutMs: options.timeoutMs ?? config.timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
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
      this.dependencies.output.log(
        `\n${formatPlainNotice('Next', [
          'No productivity tool has been changed.',
          `Apply this exact saved plan with: aurous apply ${runId}`,
        ])}`,
      );
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

  async planLinearDemo(options: LinearDemoPlanOptions): Promise<AurousPlan> {
    const config = await this.dependencies.store.loadConfig();
    const agentName = AgentNameSchema.parse(options.agent ?? config.defaultAgent);
    const team = options.team.trim();
    if (!team) {
      throw new AurousError({
        code: 'AUR-LINEAR-003',
        summary: 'The Linear demo team cannot be empty.',
        probableCause: 'The --team value was blank.',
        nextAction: 'Pass an existing Linear team name, key, or UUID with --team.',
      });
    }
    const runId = createRunId(this.now());
    const timestamp = this.now().toISOString();
    this.dependencies.output.log(
      formatOpeningHeader({
        agent: agentName,
        target: 'linear',
        mode: 'Demo',
        runId,
        ...(agentName === 'mock' ? { model: 'built-in deterministic adapter' } : {}),
      }),
    );
    const context = await ingestContext({
      cwd: this.dependencies.workspace,
      paths: options.contextPaths,
    });
    const preset = parseLinearDemoContext(context);
    this.dependencies.output.log(`\n${formatContextSummary(context.summary)}`);
    this.dependencies.output.log(
      `\n${formatPlainNotice('Destination', [
        `Preset  ${preset.preset}`,
        `Team    ${team}`,
        'Writes  none until explicit approval',
      ])}`,
    );
    this.dependencies.output.log(
      `\n${formatProgress('Assaying', 'Generating a deterministic Linear plan from approved context.')}`,
    );

    const generatedPlan = buildLinearDemoPlan({
      runId,
      createdAt: timestamp,
      agent: agentName,
      team,
      context,
      preset,
    });
    const plan = AurousPlanSchema.parse(
      await this.attachKnownLinearReferences(generatedPlan, team),
    );
    validateProposalSemantics(plan);
    const record: RunRecord = {
      runId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'planning',
      agent: agentName,
      tool: 'linear',
      objective: plan.objective,
      approvedContextPaths: context.summary.approvedPaths,
      runKind: 'standard',
    };
    await this.dependencies.store.createRun(record, context);
    await this.dependencies.store.savePlan(plan);
    await this.dependencies.store.updateStatus(runId, 'planned');
    await this.event(runId, 'info', 'AUR-LINEAR-100', 'Deterministic Linear demo plan saved.', {
      preset: preset.preset,
      team,
      actionCount: plan.plannedActions.length,
      milestoneCount: preset.milestones.length,
      issueCount: preset.knownTasks.length,
      knownReferenceCount: plan.plannedActions.filter((action) =>
        action.properties.some((property) => property.key === 'linear.dedupe.knownExternalId'),
      ).length,
    });
    this.dependencies.output.log(
      formatProgress('Hallmarking', 'Validated plan saved to local run history.'),
    );
    this.dependencies.output.log(`\n${formatPlan(plan)}`);
    return plan;
  }

  private async attachKnownLinearReferences(plan: AurousPlan, team: string): Promise<AurousPlan> {
    const references = new Map<string, { externalId: string; url?: string }>();
    const records = (await this.dependencies.store.listRuns()).reverse();
    for (const record of records) {
      if (
        record.tool !== 'linear' ||
        record.agent !== plan.agent ||
        record.status !== 'succeeded' ||
        record.objective !== plan.objective
      )
        continue;
      try {
        const [priorPlan, result] = await Promise.all([
          this.dependencies.store.loadPlan(record.runId),
          this.dependencies.store.loadResult(record.runId),
        ]);
        if (!result || linearPlanTeam(priorPlan) !== team) continue;
        for (const reference of [...result.createdObjects, ...(result.skippedActions ?? [])]) {
          if (!reference.externalId) continue;
          const priorAction = priorPlan.plannedActions.find(
            (action) => action.id === reference.actionId,
          );
          if (
            !priorAction ||
            priorAction.target !== reference.name ||
            priorAction.objectType !== reference.type
          )
            continue;
          const key = `${reference.type}\u0000${reference.name}`;
          if (!references.has(key))
            references.set(key, {
              externalId: reference.externalId,
              ...(reference.url ? { url: reference.url } : {}),
            });
        }
      } catch {
        // A malformed or incomplete historical run is not trusted as an identity source.
      }
    }
    if (references.size === 0) return plan;
    return {
      ...plan,
      plannedActions: plan.plannedActions.map((action) => {
        const reference = references.get(`${action.objectType}\u0000${action.target}`);
        if (!reference) return action;
        return {
          ...action,
          properties: [
            ...action.properties,
            { key: 'linear.dedupe.knownExternalId', value: reference.externalId },
            ...(reference.url ? [{ key: 'linear.dedupe.knownUrl', value: reference.url }] : []),
          ],
        };
      }),
      assumptions: [
        ...plan.assumptions,
        'Exact external IDs from the earliest compatible successful Aurous run will be fetched and verified before any fallback lookup.',
      ],
    };
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
    if (!options.alreadyPreviewed) {
      this.dependencies.output.log(
        formatOpeningHeader({
          agent: plan.agent,
          target: plan.tool,
          mode: 'Approval',
          runId,
          ...(plan.agent === 'mock' ? { model: 'built-in deterministic adapter' } : {}),
        }),
      );
      this.dependencies.output.log(`\n${formatPlan(plan)}`);
    }
    const confirmed = options.confirmed || (options.confirm ? await options.confirm() : false);
    if (!confirmed) {
      await this.event(
        runId,
        'warning',
        'AUR-APPLY-100',
        'Apply preview declined; no external writes attempted.',
      );
      this.dependencies.output.log(
        `\n${formatPlainNotice('Approval', [
          'Apply cancelled. No external writes were attempted.',
        ])}`,
      );
      return undefined;
    }
    this.dependencies.output.log(
      `\n${formatApprovalReceipt(
        options.confirmed ? 'Explicit --yes approval received.' : 'Typed approval received.',
      )}`,
    );

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
      const invocation = await this.withProgress('plan apply', options.signal, () =>
        adapter.executePlan({
          workspace: this.dependencies.workspace,
          runDirectory: this.dependencies.store.runDirectory(runId),
          plan,
          productivity,
          timeoutMs: config.timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
      await this.dependencies.store.saveCommandLog(
        runId,
        'apply-agent',
        invocation.stdout,
        invocation.stderr,
      );
      const result = normalizeExecutionCompatibility(
        plan,
        ExecutionResultSchema.parse(invocation.value),
      );
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
          createdObjectCount: result.createdObjects.length,
          skippedActionCount: result.skippedActions?.length ?? 0,
          compatibilityNoteCount: result.compatibilityNotes?.length ?? 0,
        },
      );
      this.dependencies.output.log(`\n${formatExecutionResult(result, { runId, plan })}`);
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
        skippedActions: [],
        completedActionIds: [],
        compatibilityNotes: [],
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

  async recover(originalRunId: string, options: RecoverOptions = {}): Promise<RecoveryPlan> {
    const [originalRecord, originalPlan, originalResult, originalContext, config] =
      await Promise.all([
        this.dependencies.store.getRun(originalRunId),
        this.dependencies.store.loadPlan(originalRunId),
        this.dependencies.store.loadResult(originalRunId),
        this.dependencies.store.loadContext(originalRunId),
        this.dependencies.store.loadConfig(),
      ]);
    if (
      !originalResult ||
      !['partial', 'failed'].includes(originalRecord.status) ||
      originalResult.createdObjects.length === 0
    ) {
      throw new AurousError({
        code: 'AUR-RECOVERY-001',
        summary: `Run ${originalRunId} is not eligible for partial-run recovery.`,
        probableCause:
          'Recovery requires a partial or failed run with a persisted result containing external objects.',
        nextAction: `Run "aurous diagnose ${originalRunId} --verbose" and do not retry writes blindly.`,
        runId: originalRunId,
      });
    }
    if (originalResult.createdObjects.some((object) => !object.externalId)) {
      throw new AurousError({
        code: 'AUR-RECOVERY-002',
        summary: 'A recorded partial object is missing its stable external ID.',
        probableCause: 'The interrupted apply did not persist enough identity data for safe reuse.',
        nextAction: 'Inspect the target manually. Aurous will not match or reuse objects by name.',
        runId: originalRunId,
      });
    }

    const recoveryRunId = createRunId(this.now());
    const timestamp = this.now().toISOString();
    const record: RunRecord = {
      runId: recoveryRunId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'reconciling',
      agent: originalPlan.agent,
      tool: originalPlan.tool,
      objective: `Recover partial run ${originalRunId} without duplicating verified objects.`,
      approvedContextPaths: originalContext.summary.approvedPaths,
      runKind: 'recovery',
      recoveryOf: originalRunId,
    };
    await this.dependencies.store.createRun(record, originalContext);
    await this.event(
      recoveryRunId,
      'info',
      'AUR-RECOVERY-100',
      'Read-only recovery reconciliation started.',
      { originalRunId },
    );

    try {
      const adapter = this.agentFactory(originalPlan.agent);
      const productivity = createProductivityAdapter(originalPlan.tool);
      const invocation = await this.withProgress(
        'read-only recovery inspection',
        options.signal,
        () =>
          adapter.inspectRecovery({
            recoveryRunId,
            workspace: this.dependencies.workspace,
            runDirectory: this.dependencies.store.runDirectory(recoveryRunId),
            originalPlan,
            originalResult,
            productivity,
            timeoutMs: config.timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
          }),
      );
      await this.dependencies.store.saveCommandLog(
        recoveryRunId,
        'recovery-inspection',
        invocation.stdout,
        invocation.stderr,
      );
      const inspection = RecoveryInspectionSchema.parse(invocation.value);
      validateInspectionScope(originalResult, inspection.objects);
      const recoveryPlan = buildRecoveryPlan({
        recoveryRunId,
        originalPlan,
        originalResult,
        inspection,
        createdAt: timestamp,
      });
      await this.dependencies.store.saveRecoveryPlan(recoveryPlan);
      if (recoveryPlan.plannedActions.length > 0) {
        await this.dependencies.store.savePlan({
          ...originalPlan,
          runId: recoveryRunId,
          createdAt: timestamp,
          objective: recoveryPlan.objective,
          proposedWorkspaceStructure: recoveryPlan.plannedActions.map((action) => ({
            kind: action.objectType,
            name: action.target,
            purpose: action.description,
          })),
          plannedActions: recoveryPlan.plannedActions,
          assumptions: [
            `This plan is the persisted execution scope for recovery of ${originalRunId}.`,
          ],
          warnings: recoveryPlan.warnings,
          destructiveActions: [],
          expectedResult: recoveryPlan.expectedResult,
        });
      }
      for (const object of recoveryPlan.verifiedObjects) {
        if (!object.externalId) continue;
        await this.dependencies.store.appendRecoveryCheckpoint(recoveryRunId, {
          timestamp: this.now().toISOString(),
          recoveryRunId,
          originalRunId,
          actionId: object.actionId,
          externalId: object.externalId,
          ...(object.url ? { url: object.url } : {}),
          type: object.type,
          name: object.name,
          source: 'inspection',
        });
      }
      await this.dependencies.store.updateStatus(recoveryRunId, 'recovery-planned');
      await this.event(
        recoveryRunId,
        recoveryPlan.isExecutable ? 'info' : 'warning',
        'AUR-RECOVERY-101',
        'Read-only recovery plan saved.',
        {
          originalRunId,
          command: invocation.command,
          durationMs: invocation.durationMs,
          plannedActionIds: recoveryPlan.plannedActions.map((action) => action.id),
          executable: recoveryPlan.isExecutable,
        },
      );
      this.dependencies.output.log(`\n${formatRecoveryPlan(recoveryPlan)}`);
      if (recoveryPlan.isExecutable) {
        this.dependencies.output.log(
          `\nNo recovery writes have been attempted. Review this plan, then run: aurous recover ${recoveryRunId} --apply`,
        );
      } else {
        this.dependencies.output.log(
          '\nRecovery is blocked. No external writes were attempted; resolve the reported drift or capability limitation first.',
        );
      }
      return recoveryPlan;
    } catch (error) {
      const classified = asAurousError(error, recoveryRunId);
      if (error instanceof AurousCommandError) {
        await this.dependencies.store.saveCommandLog(
          recoveryRunId,
          'recovery-inspection-failed',
          error.stdout,
          error.stderr,
        );
      }
      await this.dependencies.store.updateStatus(
        recoveryRunId,
        classified.code === 'AUR-AGENT-007' ? 'cancelled' : 'failed',
      );
      await this.event(recoveryRunId, 'error', classified.code, classified.message, {
        originalRunId,
        probableCause: classified.probableCause,
        nextAction: classified.nextAction,
      });
      throw classified;
    }
  }

  async applyRecovery(
    recoveryRunId: string,
    options: ApplyRecoveryOptions,
  ): Promise<ExecutionResult | undefined> {
    const [record, recoveryPlan, config] = await Promise.all([
      this.dependencies.store.getRun(recoveryRunId),
      this.dependencies.store.loadRecoveryPlan(recoveryRunId),
      this.dependencies.store.loadConfig(),
    ]);
    if (
      record.runKind !== 'recovery' ||
      record.recoveryOf !== recoveryPlan.originalRunId ||
      record.status !== 'recovery-planned'
    ) {
      throw new AurousError({
        code: 'AUR-RECOVERY-003',
        summary: `Recovery run ${recoveryRunId} is not awaiting approval.`,
        probableCause: 'It is not a saved recovery plan, or execution has already been attempted.',
        nextAction: `Run "aurous diagnose ${recoveryRunId} --verbose". Never retry recovery writes blindly.`,
        runId: recoveryRunId,
      });
    }
    if (!recoveryPlan.isExecutable) {
      throw new AurousError({
        code: 'AUR-RECOVERY-004',
        summary: `Recovery run ${recoveryRunId} is blocked and cannot execute.`,
        probableCause: 'The read-only reconciliation found drift or an unsupported capability.',
        nextAction: 'Review the recovery classifications; no external writes were attempted.',
        runId: recoveryRunId,
      });
    }

    this.dependencies.output.log(formatRecoveryPlan(recoveryPlan));
    const confirmed = await options.confirm();
    if (!confirmed) {
      await this.event(
        recoveryRunId,
        'warning',
        'AUR-RECOVERY-102',
        'Recovery preview declined; no external writes attempted.',
      );
      this.dependencies.output.log('\nRecovery cancelled. No external writes were attempted.');
      return undefined;
    }

    const [originalPlan, originalResult] = await Promise.all([
      this.dependencies.store.loadPlan(recoveryPlan.originalRunId),
      this.dependencies.store.loadResult(recoveryPlan.originalRunId),
    ]);
    if (!originalResult) {
      throw new AurousError({
        code: 'AUR-RECOVERY-005',
        summary: 'The original execution result disappeared before recovery.',
        probableCause: 'Local recovery evidence changed after the plan was reviewed.',
        nextAction: 'Do not proceed; restore or inspect the original run evidence.',
        runId: recoveryRunId,
      });
    }
    const existingCheckpoints =
      await this.dependencies.store.readRecoveryCheckpoints(recoveryRunId);
    if (existingCheckpoints.some((checkpoint) => checkpoint.source === 'action-result')) {
      throw new AurousError({
        code: 'AUR-RECOVERY-006',
        summary: 'This recovery run already contains write checkpoints.',
        probableCause: 'A prior execution attempt completed at least one external action.',
        nextAction: 'Create a fresh read-only recovery plan; this run will not be replayed.',
        runId: recoveryRunId,
      });
    }

    const adapter = this.agentFactory(recoveryPlan.agent);
    const productivity = createProductivityAdapter(recoveryPlan.tool);
    const verificationInvocation = await this.withProgress(
      'pre-write exact-ID verification',
      options.signal,
      () =>
        adapter.inspectRecovery({
          recoveryRunId,
          workspace: this.dependencies.workspace,
          runDirectory: this.dependencies.store.runDirectory(recoveryRunId),
          originalPlan,
          originalResult,
          productivity,
          timeoutMs: config.timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
    );
    await this.dependencies.store.saveCommandLog(
      recoveryRunId,
      'recovery-pre-execution-verification',
      verificationInvocation.stdout,
      verificationInvocation.stderr,
    );
    const freshInspection = RecoveryInspectionSchema.parse(verificationInvocation.value);
    validateInspectionScope(originalResult, freshInspection.objects);
    const semanticComparison = compareRecoverySemanticInspections(
      recoveryPlan.inspection,
      freshInspection,
    );
    const semanticDiff = redactValue(semanticComparison.differences);
    if (semanticDiff.length > 0) {
      const error = new AurousError({
        code: 'AUR-RECOVERY-011',
        summary: 'Live Notion state or recovery capabilities changed after plan review.',
        probableCause: 'The mandatory pre-write verification no longer matches the approved plan.',
        nextAction: `Generate and review a fresh recovery plan from ${recoveryPlan.originalRunId}. No recovery writes were attempted.`,
        runId: recoveryRunId,
      });
      const timestamp = this.now().toISOString();
      await this.dependencies.store.saveResult(recoveryRunId, {
        status: 'failed',
        summary: error.message,
        createdObjects: [],
        completedActionIds: [],
        warnings: [],
        failures: [
          {
            code: error.code,
            summary: error.message,
            probableCause: error.probableCause,
            nextAction: error.nextAction,
            severity: error.severity,
          },
        ],
        startedAt: timestamp,
        finishedAt: timestamp,
      });
      await this.dependencies.store.updateStatus(recoveryRunId, 'failed');
      await this.event(recoveryRunId, 'error', error.code, error.message, {
        originalRunId: recoveryPlan.originalRunId,
        semanticDiff,
      });
      throw error;
    }
    const stableUnknownFilterWarning =
      semanticComparison.stableUnknownFilterPaths.length > 0
        ? `Pre-write verification could not structurally inspect unchanged view filters at: ${semanticComparison.stableUnknownFilterPaths.join(', ')}.`
        : undefined;
    if (stableUnknownFilterWarning) {
      await this.event(
        recoveryRunId,
        'warning',
        'AUR-RECOVERY-106',
        'Pre-write verification preserved stable unknown view-filter states.',
        {
          originalRunId: recoveryPlan.originalRunId,
          filterPaths: semanticComparison.stableUnknownFilterPaths,
        },
      );
    }
    const freshPlan = buildRecoveryPlan({
      recoveryRunId,
      originalPlan,
      originalResult,
      inspection: freshInspection,
      createdAt: recoveryPlan.createdAt,
    });
    for (const object of freshPlan.verifiedObjects) {
      if (!object.externalId) continue;
      await this.dependencies.store.appendRecoveryCheckpoint(recoveryRunId, {
        timestamp: this.now().toISOString(),
        recoveryRunId,
        originalRunId: recoveryPlan.originalRunId,
        actionId: object.actionId,
        externalId: object.externalId,
        ...(object.url ? { url: object.url } : {}),
        type: object.type,
        name: object.name,
        source: 'pre-execution-verification',
      });
    }

    await this.dependencies.store.updateStatus(recoveryRunId, 'recovering');
    await this.event(
      recoveryRunId,
      'info',
      'AUR-RECOVERY-103',
      'Fresh explicit approval and pre-write verification completed; recovery started.',
      { originalRunId: recoveryPlan.originalRunId },
    );
    const startedAt = this.now().toISOString();
    let createdObjects: ExecutionResult['createdObjects'] = [];
    let completedActionIds: string[] = [];
    let warnings: string[] = stableUnknownFilterWarning ? [stableUnknownFilterWarning] : [];
    let failures: ExecutionResult['failures'] = [];
    let invocationInProgress = false;
    let activeActionId: string | undefined;

    try {
      for (const action of recoveryPlan.plannedActions) {
        if (options.signal?.aborted) {
          throw new AurousError({
            code: 'AUR-AGENT-007',
            summary: 'Recovery was cancelled before the next external action.',
            probableCause: 'The user or calling process requested cancellation.',
            nextAction: 'No subsequent action ran. Generate a fresh recovery plan before retrying.',
            severity: 'recoverable',
            runId: recoveryRunId,
          });
        }
        invocationInProgress = true;
        activeActionId = action.id;
        const invocation = await this.withProgress(
          `recovery action ${action.id}`,
          options.signal,
          () =>
            adapter.executeRecoveryAction({
              workspace: this.dependencies.workspace,
              runDirectory: this.dependencies.store.runDirectory(recoveryRunId),
              recoveryPlan,
              action,
              knownObjects: [...recoveryPlan.verifiedObjects, ...createdObjects],
              productivity,
              timeoutMs: config.timeoutMs,
              ...(options.signal ? { signal: options.signal } : {}),
            }),
        );
        const normalized = parseRecoveryActionBoundary(
          invocation.value,
          invocation.boundaryDiagnostics,
          recoveryRunId,
          action.id,
        );
        const boundaryDiagnostics = normalized.diagnostics;
        await this.dependencies.store.saveCommandLog(
          recoveryRunId,
          `recovery-action-${action.id}`,
          sanitizeBoundaryText(invocation.stdout, boundaryDiagnostics),
          sanitizeBoundaryText(invocation.stderr, boundaryDiagnostics),
        );
        for (const diagnostic of boundaryDiagnostics) {
          await this.event(
            recoveryRunId,
            'error',
            diagnostic.canonicalCode,
            'Malformed agent failure code normalized at the recovery action-result boundary.',
            redactValue({
              actionId: diagnostic.actionId ?? action.id,
              rawValidationPath: diagnostic.validationPath,
              canonicalCode: diagnostic.canonicalCode,
              originalMalformedCode: diagnostic.originalMalformedCode,
              ambiguousWrite: true,
              originalRunId: recoveryPlan.originalRunId,
            }),
          );
        }
        const actionResult = normalized.result;
        validateRecoveryActionResult(recoveryPlan, action, actionResult);
        const checkpointObjects = recoveryActionCheckpointObjects(
          action,
          actionResult,
          boundaryDiagnostics.length > 0,
        );
        const newlyCreatedObjects =
          action.operation === 'create' ? actionResult.createdObjects : [];
        createdObjects = mergeCreatedObjects(createdObjects, newlyCreatedObjects);
        completedActionIds = [
          ...new Set([...completedActionIds, ...actionResult.completedActionIds]),
        ];
        warnings = [
          ...warnings,
          ...actionResult.warnings,
          ...(boundaryDiagnostics.length > 0
            ? [
                `Recovery action ${action.id} returned a malformed failure code. Aurous normalized it to AUR-AGENT-005; external write completion remains ambiguous.`,
              ]
            : []),
        ];
        failures = [...failures, ...actionResult.failures];
        for (const object of checkpointObjects) {
          if (!object.externalId) continue;
          await this.dependencies.store.appendRecoveryCheckpoint(recoveryRunId, {
            timestamp: this.now().toISOString(),
            recoveryRunId,
            originalRunId: recoveryPlan.originalRunId,
            actionId: object.actionId,
            externalId: object.externalId,
            ...(object.url ? { url: object.url } : {}),
            type: object.type,
            name: object.name,
            source: 'action-result',
          });
        }
        invocationInProgress = false;
        const ambiguousWrite =
          boundaryDiagnostics.length > 0 ||
          (actionResult.status !== 'succeeded' && checkpointObjects.length > 0);
        const intermediate: ExecutionResult = {
          status: 'partial',
          summary:
            boundaryDiagnostics.length > 0
              ? `Recovery action ${action.id} returned malformed boundary data; its exact object identity was checkpointed, but write completion remains ambiguous.`
              : checkpointObjects.length > 0
                ? `Recovery checkpoint persisted after ${action.id}.`
                : actionResult.status === 'succeeded'
                  ? `Recovery action ${action.id} completed without a new-object checkpoint.`
                  : `Recovery action ${action.id} failed without an external write checkpoint.`,
          createdObjects,
          completedActionIds,
          warnings,
          failures,
          startedAt,
          finishedAt: this.now().toISOString(),
        };
        await this.dependencies.store.saveResult(recoveryRunId, intermediate);
        await this.event(
          recoveryRunId,
          actionResult.status === 'succeeded' ? 'info' : 'error',
          'AUR-RECOVERY-104',
          `Recovery action ${action.id} recorded.`,
          {
            status: actionResult.status,
            command: invocation.command,
            durationMs: invocation.durationMs,
            ambiguousWrite,
            checkpointedObjectCount: checkpointObjects.length,
          },
        );
        if (actionResult.status !== 'succeeded') {
          await this.dependencies.store.updateStatus(recoveryRunId, 'partial');
          this.dependencies.output.log(formatExecutionResult(intermediate));
          return intermediate;
        }
        activeActionId = undefined;
      }
      const result: ExecutionResult = {
        status: 'succeeded',
        summary: `Recovery completed all ${recoveryPlan.plannedActions.length} approved actions.`,
        createdObjects,
        completedActionIds,
        warnings,
        failures,
        startedAt,
        finishedAt: this.now().toISOString(),
      };
      await this.dependencies.store.saveResult(recoveryRunId, result);
      await this.dependencies.store.updateStatus(recoveryRunId, 'succeeded');
      await this.event(recoveryRunId, 'info', 'AUR-RECOVERY-105', 'Recovery completed.', {
        completedActionIds,
      });
      this.dependencies.output.log(formatExecutionResult(result));
      return result;
    } catch (error) {
      const classified = asAurousError(error, recoveryRunId);
      if (error instanceof AurousCommandError) {
        await this.dependencies.store.saveCommandLog(
          recoveryRunId,
          'recovery-agent-failed',
          error.stdout,
          error.stderr,
        );
      }
      const ambiguousWrite = invocationInProgress;
      const finalStatus =
        classified.code === 'AUR-AGENT-007' && !ambiguousWrite && completedActionIds.length === 0
          ? 'cancelled'
          : 'partial';
      const failedResult: ExecutionResult = {
        status: finalStatus,
        summary: ambiguousWrite
          ? `${classified.message} The last action may have written before its identity was checkpointed.`
          : classified.message,
        createdObjects,
        completedActionIds,
        warnings,
        failures: [
          ...failures,
          {
            code: classified.code,
            summary: classified.message,
            probableCause: classified.probableCause,
            nextAction: ambiguousWrite
              ? 'Do not retry this recovery run. Inspect exact external state and create a fresh read-only recovery plan.'
              : classified.nextAction,
            severity: classified.severity,
          },
        ],
        startedAt,
        finishedAt: this.now().toISOString(),
      };
      await this.dependencies.store.saveResult(recoveryRunId, failedResult);
      await this.dependencies.store.updateStatus(recoveryRunId, finalStatus);
      await this.event(recoveryRunId, 'error', classified.code, failedResult.summary, {
        ambiguousWrite,
        ...(activeActionId ? { actionId: activeActionId } : {}),
        originalRunId: recoveryPlan.originalRunId,
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
    const [record, plan, result, events, agentFailureSummary] = await Promise.all([
      this.dependencies.store.getRun(runId),
      this.dependencies.store.loadPlan(runId).catch(() => undefined),
      this.dependencies.store.loadResult(runId),
      this.dependencies.store.readEvents(runId),
      verbose ? this.dependencies.store.readAgentFailureSummary(runId) : Promise.resolve(undefined),
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
      if (verbose && Object.keys(event.metadata).length > 0) {
        const metadata =
          agentFailureSummary && 'probableCause' in event.metadata
            ? { ...event.metadata, probableCause: 'See agent terminal error summary below.' }
            : event.metadata;
        this.dependencies.output.log(`    ${JSON.stringify(metadata)}`);
      }
    }
    if (verbose && agentFailureSummary)
      this.dependencies.output.log(`Agent terminal error (redacted):\n${agentFailureSummary}`);
    if (verbose)
      this.dependencies.output.log(
        `Local run directory: ${this.dependencies.store.runDirectory(runId)}`,
      );
    this.dependencies.output.log(
      `Follow-up prompt: Investigate Aurous run ${runId} using this redacted report. Preserve the approved plan scope and address the first fatal or recoverable AUR-* event.`,
    );
  }

  private async withProgress<T>(
    phase: string,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const progressWord = progressWordFor(phase);
    this.dependencies.output.log(
      formatProgress(progressWord, `Agent invocation started: ${phase}.`),
    );
    const timer = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - started) / 1_000));
      this.dependencies.output.log(
        formatProgress(progressWord, `Agent invocation in progress: ${phase}.`, elapsedSeconds),
      );
    }, this.progressIntervalMs);
    timer.unref?.();
    try {
      const value = await task();
      const elapsedSeconds = ((Date.now() - started) / 1_000).toFixed(1);
      this.dependencies.output.log(
        formatProgress('Hallmarking', `Agent invocation completed: ${phase}.`, elapsedSeconds),
      );
      return value;
    } catch (error) {
      const elapsedSeconds = ((Date.now() - started) / 1_000).toFixed(1);
      const outcome =
        signal?.aborted || (error instanceof AurousError && error.code === 'AUR-AGENT-007')
          ? 'cancelled'
          : error instanceof AurousError && error.code === 'AUR-AGENT-003'
            ? 'timed out'
            : 'failed';
      this.dependencies.output.log(
        formatProgress('Tempering', `Agent invocation ${outcome}: ${phase}.`, elapsedSeconds),
      );
      throw error;
    } finally {
      clearInterval(timer);
    }
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

function progressWordFor(phase: string): ProgressWord {
  if (phase.includes('apply') || phase.includes('action')) return 'Forging';
  if (phase.includes('plan') || phase.includes('inspection') || phase.includes('verification'))
    return 'Assaying';
  return 'Polishing';
}

function parseRecoveryActionBoundary(
  value: unknown,
  adapterDiagnostics: ExecutionBoundaryDiagnostic[] | undefined,
  recoveryRunId: string,
  actionId: string,
): { result: ExecutionResult; diagnostics: ExecutionBoundaryDiagnostic[] } {
  try {
    const normalized = normalizeExecutionResultBoundary(value);
    const diagnostics = [...(adapterDiagnostics ?? []), ...normalized.diagnostics].filter(
      (diagnostic, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.actionId === diagnostic.actionId &&
            candidate.originalMalformedCode === diagnostic.originalMalformedCode &&
            JSON.stringify(candidate.validationPath) === JSON.stringify(diagnostic.validationPath),
        ) === index,
    );
    return { result: normalized.result, diagnostics };
  } catch (error) {
    throw new AurousError({
      code: 'AUR-AGENT-005',
      summary: `Recovery action ${actionId} returned an invalid structured result.`,
      probableCause:
        'The agent response could not be safely parsed at the recovery action-result boundary.',
      nextAction:
        'Do not retry this recovery run. Inspect the exact external state and generate a fresh read-only recovery plan.',
      runId: recoveryRunId,
      cause: error,
    });
  }
}

function sanitizeBoundaryText(text: string, diagnostics: ExecutionBoundaryDiagnostic[]): string {
  return diagnostics.reduce(
    (sanitized, diagnostic) =>
      sanitized.split(diagnostic.originalMalformedCode).join('[REDACTED_MALFORMED_AUR_CODE]'),
    text,
  );
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
    const propertyKeys = action.properties.map((property) => property.key);
    if (new Set(propertyKeys).size !== propertyKeys.length) {
      throw new AurousError({
        code: 'AUR-PLAN-004',
        summary: `The generated plan has duplicate property keys in ${action.id}.`,
        probableCause:
          'The agent returned an ambiguous strict property-entry list for one planned action.',
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
    ...(result.skippedActions ?? []).map((action) => action.actionId),
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

function normalizeExecutionCompatibility(
  plan: AurousPlan,
  result: ExecutionResult,
): ExecutionResult {
  if (plan.tool !== 'linear') return result;
  const notes = [...(result.compatibilityNotes ?? [])];
  for (const object of [...result.createdObjects, ...(result.skippedActions ?? [])]) {
    if (!object.externalId) {
      notes.push(
        `Official Linear MCP returned no ID for ${object.type} "${object.name}"; the action result cannot be used for exact-ID replay.`,
      );
    }
    if (!object.url) {
      notes.push(
        `Official Linear MCP returned no standalone URL for ${object.type} "${object.name}"; its exact ID was preserved.`,
      );
    }
  }
  return ExecutionResultSchema.parse({ ...result, compatibilityNotes: [...new Set(notes)] });
}

function linearPlanTeam(plan: AurousPlan): string | undefined {
  return plan.plannedActions
    .flatMap((action) => action.properties)
    .find((property) => property.key === 'linear.team')?.value;
}

function validateInspectionScope(
  originalResult: ExecutionResult,
  inspectedObjects: RecoveryPlan['inspection']['objects'],
): void {
  const expectedIds = originalResult.createdObjects.flatMap((object) =>
    object.externalId ? [object.externalId] : [],
  );
  const inspectedIds = inspectedObjects.map((object) => object.externalId);
  const expected = new Set(expectedIds);
  const received = new Set(inspectedIds);
  if (
    expected.size !== received.size ||
    [...expected].some((externalId) => !received.has(externalId)) ||
    inspectedIds.length !== received.size ||
    inspectedObjects.some((object) => {
      const recorded = originalResult.createdObjects.find(
        (candidate) => candidate.externalId === object.externalId,
      );
      return recorded?.actionId !== object.actionId;
    })
  ) {
    throw new AurousError({
      code: 'AUR-RECOVERY-007',
      summary: 'The recovery inspection did not return each recorded object exactly once.',
      probableCause: 'The agent omitted, duplicated, or expanded the exact-ID inspection scope.',
      nextAction: 'No writes were attempted. Retry the read-only recovery inspection.',
    });
  }
}

function validateRecoveryActionResult(
  recoveryPlan: RecoveryPlan,
  action: AurousPlan['plannedActions'][number],
  result: ExecutionResult,
): void {
  const referenced = [
    ...result.completedActionIds,
    ...result.createdObjects.map((object) => object.actionId),
    ...result.failures.flatMap((failure) => (failure.actionId ? [failure.actionId] : [])),
  ];
  if (referenced.some((actionId) => actionId !== action.id)) {
    throw new AurousError({
      code: 'AUR-RECOVERY-008',
      summary: `Recovery action ${action.id} reported work outside its one-action scope.`,
      probableCause: 'The agent referenced a different approved action in its result.',
      nextAction: 'Stop recovery and inspect the target using exact external IDs.',
      runId: recoveryPlan.recoveryRunId,
    });
  }
  if (result.status === 'succeeded' && !result.completedActionIds.includes(action.id)) {
    throw new AurousError({
      code: 'AUR-RECOVERY-009',
      summary: `Recovery action ${action.id} claimed success without completion evidence.`,
      probableCause: 'The structured action result was internally inconsistent.',
      nextAction: 'Do not execute later actions; create a fresh read-only recovery plan.',
      runId: recoveryPlan.recoveryRunId,
    });
  }
  if (result.status === 'succeeded' && ['create', 'update'].includes(action.operation)) {
    const object = result.createdObjects.find((candidate) => candidate.actionId === action.id);
    if (!object?.externalId) {
      throw new AurousError({
        code: 'AUR-RECOVERY-010',
        summary: `Recovery action ${action.id} did not return a checkpointable external ID.`,
        probableCause: 'The MCP write may have succeeded without durable identity evidence.',
        nextAction: 'Do not retry. Inspect the target and create a fresh recovery plan.',
        runId: recoveryPlan.recoveryRunId,
      });
    }
    const expectedId = action.properties.find(
      (property) => property.key === 'notion.recovery.externalId',
    )?.value;
    if (expectedId && object.externalId !== expectedId) {
      throw new AurousError({
        code: 'AUR-RECOVERY-011',
        summary: `Recovery action ${action.id} returned a different external ID than the approved update.`,
        probableCause: 'The existing object was not reused exactly as approved.',
        nextAction: 'Stop recovery and inspect both IDs. Do not retry automatically.',
        runId: recoveryPlan.recoveryRunId,
      });
    }
  }
}

function mergeCreatedObjects(
  current: ExecutionResult['createdObjects'],
  next: ExecutionResult['createdObjects'],
): ExecutionResult['createdObjects'] {
  const merged = new Map(
    current.map((object) => [`${object.actionId}:${object.externalId ?? object.name}`, object]),
  );
  for (const object of next)
    merged.set(`${object.actionId}:${object.externalId ?? object.name}`, object);
  return [...merged.values()];
}

function recoveryActionCheckpointObjects(
  action: AurousPlan['plannedActions'][number],
  result: ExecutionResult,
  malformedBoundary: boolean,
): ExecutionResult['createdObjects'] {
  if (malformedBoundary || result.status === 'succeeded' || action.operation === 'create') {
    return result.createdObjects;
  }
  return [];
}
