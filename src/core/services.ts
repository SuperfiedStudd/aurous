import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  createAgentAdapter,
  type AgentAdapter,
  type AgentDiagnostic,
} from '../adapters/agents/index.js';
import { createProductivityAdapter } from '../adapters/productivity/index.js';
import {
  exactObjectTypeMatches,
  normalizedObjectType,
} from '../adapters/productivity/exact-bindings.js';
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
  type ToolName,
  isForbiddenDestinationPlaceholder,
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
import { ContextPackStore, detectProjectRoot, destinationFor } from './context-pack.js';
import { resolveDestination, type DestinationChooser } from './destination-resolver.js';
import {
  DestinationDiscoverySchema,
  SanitizedDiscoveryTraceSchema,
  type ResolvedDestination,
} from '../domain/destinations.js';
import { uncoveredRequirements, validateObjectiveIntent } from './intent.js';

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
  model?: string;
  embedded?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  chooseDestination?: DestinationChooser;
  destinationOverride?: { id: string; name: string };
  preset?: string;
  verbose?: boolean;
}

export interface ApplyOptions {
  confirmed: boolean;
  confirm?: () => Promise<boolean>;
  alreadyPreviewed?: boolean;
  model?: string;
  embedded?: boolean;
  signal?: AbortSignal;
  verbose?: boolean;
}

export interface LinearDemoPlanOptions {
  agent?: string;
  team?: string;
  contextPaths: string[];
  model?: string;
  embedded?: boolean;
  chooseDestination?: DestinationChooser;
  destinationOverride?: { id: string; name: string };
  preset?: string;
  objective?: string;
  verbose?: boolean;
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
        `  MCP notion=${agent.mcp.notion.status}, linear=${agent.mcp.linear.status}, airtable=${agent.mcp.airtable.status}, trello=${agent.mcp.trello.status}`,
      );
      if (verbose) {
        if (agent.version) this.dependencies.output.log(`  Version: ${agent.version}`);
        this.dependencies.output.log(`  Auth: ${agent.authentication.detail}`);
        this.dependencies.output.log(`  Notion: ${agent.mcp.notion.detail}`);
        this.dependencies.output.log(`  Linear: ${agent.mcp.linear.detail}`);
        this.dependencies.output.log(`  Airtable: ${agent.mcp.airtable.detail}`);
        this.dependencies.output.log(`  Trello: ${agent.mcp.trello.detail}`);
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
    const projectRoot = await detectProjectRoot(this.dependencies.workspace);
    const runId = createRunId(this.now());
    const timestamp = this.now().toISOString();
    if (!options.embedded)
      this.dependencies.output.log(
        formatOpeningHeader({
          agent: agentName,
          target: toolName,
          mode: 'Planning',
          runId,
          model: options.model ?? modelDisplayName(agentName),
        }),
      );
    const context = await ingestContext({
      cwd: projectRoot,
      paths: options.contextPaths,
    });
    const contextPack = await new ContextPackStore(projectRoot).loadOrCreate(options.preset);
    if (!options.embedded)
      this.dependencies.output.log(`\n${formatContextSummary(context.summary)}`);

    const adapter = this.agentFactory(agentName);
    const productivity = createProductivityAdapter(toolName);
    const destination = await this.resolvePlanningDestination({
      adapter,
      productivity,
      context,
      contextPack,
      objective,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.chooseDestination ? { choose: options.chooseDestination } : {}),
      ...(options.destinationOverride ? { explicitOverride: options.destinationOverride } : {}),
      ...(options.preset ? { preset: options.preset } : {}),
      projectRoot,
    });
    if (!destination) throw destinationCancelled();

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
      const invocation = await this.withProgress('plan generation', options.signal, () =>
        adapter.generatePlan({
          runId,
          workspace: this.dependencies.workspace,
          runDirectory: this.dependencies.store.runDirectory(runId),
          objective,
          context,
          contextPack,
          productivity,
          destination,
          timeoutMs: options.timeoutMs ?? config.timeoutMs,
          ...(options.model ? { model: options.model } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
      await this.dependencies.store.saveCommandLog(
        runId,
        'plan-agent',
        invocation.stdout,
        invocation.stderr,
      );
      const bound = PlanProposalSchema.parse(
        productivity.bindDestination(PlanProposalSchema.parse(invocation.value), destination),
      );
      const proposal = PlanProposalSchema.parse({
        ...bound,
        assumptions: [
          ...bound.assumptions,
          ...(options.preset
            ? [`Preset explicitly selected: ${options.preset}. User intent remains binding.`]
            : ['Planning mode: natural-language intent; no preset was inferred.']),
        ],
      });
      validateProposalSemantics(proposal);
      validateObjectiveIntent(objective, proposal);
      validateResolvedPlanDestination(
        proposal,
        productivity.destination.exactIdProperty,
        destination.id,
      );
      validateExactObjectAuthorizations(proposal, toolName, destination);
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
      this.dependencies.output.log(`\n${formatPlan(plan, { verbose: Boolean(options.verbose) })}`);
      if (!options.embedded)
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
    const projectRoot = await detectProjectRoot(this.dependencies.workspace);
    const runId = createRunId(this.now());
    const timestamp = this.now().toISOString();
    if (!options.embedded)
      this.dependencies.output.log(
        formatOpeningHeader({
          agent: agentName,
          target: 'linear',
          mode: 'Demo',
          runId,
          model: options.model ?? modelDisplayName(agentName),
        }),
      );
    const context = await ingestContext({
      cwd: projectRoot,
      paths: options.contextPaths,
    });
    const preset = parseLinearDemoContext(context);
    const requestedObjective =
      options.objective ??
      `Set up Linear for ${preset.projectName}${options.team ? ` in ${options.team}` : ''}`;
    const adapter = this.agentFactory(agentName);
    const productivity = createProductivityAdapter('linear');
    const destination = await this.resolvePlanningDestination({
      adapter,
      productivity,
      context,
      objective: requestedObjective,
      timeoutMs: config.timeoutMs,
      ...(options.model ? { model: options.model } : {}),
      ...(options.chooseDestination ? { choose: options.chooseDestination } : {}),
      ...(options.destinationOverride ? { explicitOverride: options.destinationOverride } : {}),
      preset: options.preset ?? preset.preset,
      projectRoot,
    });
    if (!destination) throw destinationCancelled();
    if (!options.embedded) {
      this.dependencies.output.log(`\n${formatContextSummary(context.summary)}`);
      this.dependencies.output.log(
        `\n${formatPlainNotice('Destination', [
          `Preset  ${preset.preset}`,
          `Team    ${destination.name}`,
          'Writes  none until explicit approval',
        ])}`,
      );
    }
    this.progress('Assaying', 'Generating a deterministic Linear plan from approved context.');

    const generatedPlan = buildLinearDemoPlan({
      runId,
      createdAt: timestamp,
      agent: agentName,
      team: destination.name,
      teamId: destination.id,
      context,
      preset,
    });
    const uncovered = uncoveredRequirements(requestedObjective, generatedPlan);
    const presetPlan = AurousPlanSchema.parse({
      ...generatedPlan,
      objective: requestedObjective,
      assumptions: [
        ...generatedPlan.assumptions,
        `Preset explicitly selected: ${preset.preset}. User intent remains binding.`,
      ],
      warnings: [
        ...generatedPlan.warnings,
        ...uncovered.map(
          (requirement) =>
            `The explicitly selected preset does not support the material requirement ${JSON.stringify(requirement)}.`,
        ),
      ],
    });
    const destinationBoundProposal = productivity.bindDestination(presetPlan, destination);
    const destinationBoundPlan = AurousPlanSchema.parse({
      ...presetPlan,
      ...destinationBoundProposal,
    });
    const plan = AurousPlanSchema.parse(
      await this.attachKnownLinearReferences(
        AurousPlanSchema.parse(destinationBoundPlan),
        destination.id,
      ),
    );
    validateProposalSemantics(plan);
    validateObjectiveIntent(requestedObjective, plan);
    validateResolvedPlanDestination(plan, productivity.destination.exactIdProperty, destination.id);
    validateExactObjectAuthorizations(plan, 'linear', destination);
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
      team: destination.name,
      teamId: destination.id,
      actionCount: plan.plannedActions.length,
      milestoneCount: preset.milestones.length,
      issueCount: preset.knownTasks.length,
      knownReferenceCount: plan.plannedActions.filter((action) =>
        action.properties.some((property) => property.key === 'linear.dedupe.knownExternalId'),
      ).length,
    });
    this.progress('Hallmarking', 'Validated plan saved to local run history.');
    this.dependencies.output.log(`\n${formatPlan(plan, { verbose: Boolean(options.verbose) })}`);
    return plan;
  }

  private async attachKnownLinearReferences(plan: AurousPlan, team: string): Promise<AurousPlan> {
    const references = new Map<string, { externalId: string; url?: string; sourceRunId: string }>();
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
              sourceRunId: record.runId,
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
        if (action.properties.some((property) => property.key === 'linear.dedupe.knownExternalId'))
          return action;
        const reference = references.get(`${action.objectType}\u0000${action.target}`);
        if (!reference) return action;
        return {
          ...action,
          properties: [
            ...action.properties,
            { key: 'linear.dedupe.knownExternalId', value: reference.externalId },
            ...(reference.url ? [{ key: 'linear.dedupe.knownUrl', value: reference.url }] : []),
            {
              key: 'linear.dedupe.identitySource',
              value: `verified-run:${reference.sourceRunId}`,
            },
          ],
        };
      }),
      assumptions: [
        ...plan.assumptions,
        'Exact external IDs from the earliest compatible successful Aurous run will be fetched and verified before any fallback lookup.',
      ],
    };
  }

  private async resolvePlanningDestination(input: {
    adapter: AgentAdapter;
    productivity: ReturnType<typeof createProductivityAdapter>;
    context: Awaited<ReturnType<typeof ingestContext>>;
    contextPack?: import('../domain/destinations.js').ContextPack;
    objective: string;
    timeoutMs: number;
    model?: string;
    signal?: AbortSignal;
    choose?: DestinationChooser;
    explicitOverride?: { id: string; name: string };
    preset?: string;
    projectRoot?: string;
  }): Promise<ResolvedDestination | undefined> {
    const projectRoot = input.projectRoot ?? (await detectProjectRoot(this.dependencies.workspace));
    const contextStore = new ContextPackStore(projectRoot);
    const pack = await contextStore.loadOrCreate(input.preset);
    const discoveryId = createRunId(this.now()).replace(/^run-/, 'discovery-');
    const runDirectory = path.join(projectRoot, '.aurous', 'discovery', discoveryId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    this.progress(
      'Assaying',
      `Inspecting ${integrationDisplayName(input.productivity.name)} read-only.`,
    );
    const fallbackAdapter = input.adapter.name === 'mock' ? createAgentAdapter('mock') : undefined;
    const discover =
      input.adapter.discoverDestinations?.bind(input.adapter) ??
      fallbackAdapter?.discoverDestinations?.bind(fallbackAdapter);
    if (!discover) {
      throw new AurousError({
        code: 'AUR-DEST-005',
        summary: 'The selected agent cannot discover integration destinations.',
        probableCause: 'This agent adapter predates context-aware onboarding.',
        nextAction: 'Choose Codex, Claude Code, or the built-in mock agent.',
      });
    }
    const invocation = await discover({
      discoveryId,
      workspace: projectRoot,
      runDirectory,
      objective: input.objective,
      projectName: pack.project.name,
      context: input.context,
      contextPack: input.contextPack ?? pack,
      productivity: input.productivity,
      timeoutMs: input.timeoutMs,
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const discovery = DestinationDiscoverySchema.parse({
      ...invocation.value,
      inspectedAt: this.now().toISOString(),
    });
    await writeFile(
      path.join(runDirectory, 'destination-discover-agent-response.json'),
      `${JSON.stringify(discovery)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const trace = invocation.discoveryTrace
      ? SanitizedDiscoveryTraceSchema.parse(redactValue(invocation.discoveryTrace))
      : undefined;
    if (trace) {
      await writeFile(
        path.join(runDirectory, 'discovery-trace.json'),
        `${JSON.stringify(trace, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    }
    if (
      input.adapter.name === 'codex' &&
      input.productivity.name !== 'mock' &&
      (!trace || trace.operations.length === 0)
    ) {
      throw new AurousError({
        code: 'AUR-DEST-009',
        summary: 'Codex destination discovery did not produce an auditable MCP read trace.',
        probableCause:
          'The agent event stream omitted official MCP operation evidence, so the discovered IDs cannot be audited safely.',
        nextAction: 'No writes occurred. Update Codex and repeat destination discovery.',
        runId: discoveryId,
      });
    }
    if (discovery.integration !== input.productivity.name) {
      throw new AurousError({
        code: 'AUR-DEST-006',
        summary: 'Destination discovery returned the wrong integration.',
        probableCause: 'The read-only response crossed integration boundaries.',
        nextAction: 'No writes occurred. Retry destination discovery.',
      });
    }
    const saved = destinationFor(pack, input.productivity.name);
    const destination = await resolveDestination({
      adapter: input.productivity,
      discovery,
      objective: input.objective,
      projectName: pack.project.name,
      ...(saved ? { saved } : {}),
      ...(input.choose ? { choose: input.choose } : {}),
      ...(input.explicitOverride ? { explicitOverride: input.explicitOverride } : {}),
    });
    if (!destination) return undefined;
    await contextStore.saveDestination(destination, input.preset);
    this.dependencies.output.log(`✓ Using ${destination.name}`);
    return destination;
  }

  async apply(runId: string, options: ApplyOptions): Promise<ExecutionResult | undefined> {
    const [record, plan, config] = await Promise.all([
      this.dependencies.store.getRun(runId),
      this.dependencies.store.loadPlan(runId),
      this.dependencies.store.loadConfig(),
    ]);
    validateExecutablePlanDestination(plan);
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
      if (!options.embedded)
        this.dependencies.output.log(
          formatOpeningHeader({
            agent: plan.agent,
            target: plan.tool,
            mode: 'Approval',
            runId,
            model: options.model ?? modelDisplayName(plan.agent),
          }),
        );
      this.dependencies.output.log(`\n${formatPlan(plan, { verbose: Boolean(options.verbose) })}`);
    }
    const confirmed = options.confirmed || (options.confirm ? await options.confirm() : false);
    if (!confirmed) {
      await this.event(
        runId,
        'warning',
        'AUR-APPLY-100',
        'Apply preview declined; no external writes attempted.',
      );
      if (!options.embedded)
        this.dependencies.output.log(
          `\n${formatPlainNotice('Approval', [
            'Apply cancelled. No external writes were attempted.',
          ])}`,
        );
      return undefined;
    }
    if (!options.embedded)
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
      const invocation = await this.withProgress(
        'plan apply',
        options.signal,
        () =>
          adapter.executePlan({
            workspace: this.dependencies.workspace,
            runDirectory: this.dependencies.store.runDirectory(runId),
            plan,
            productivity,
            timeoutMs: config.timeoutMs,
            ...(options.model ? { model: options.model } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        plan.plannedActions.length,
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
      await this.persistExactExecutionObjects(plan, result);
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

  private async persistExactExecutionObjects(
    plan: AurousPlan,
    result: ExecutionResult,
  ): Promise<void> {
    if (plan.tool === 'mock') return;
    const projectRoot = await detectProjectRoot(this.dependencies.workspace);
    const contextStore = new ContextPackStore(projectRoot);
    const pack = await contextStore.loadOrCreate();
    const saved = destinationFor(pack, plan.tool);
    if (!saved) return;
    const exactResults = [...result.createdObjects, ...(result.skippedActions ?? [])].filter(
      (object) => Boolean(object.externalId),
    );
    if (exactResults.length === 0) return;
    const existing = new Map(saved.existingObjects.map((object) => [object.id, object]));
    const resultIdByAction = new Map(
      exactResults.flatMap((object) =>
        object.externalId ? [[object.actionId, object.externalId]] : [],
      ),
    );
    for (const object of exactResults) {
      const action = plan.plannedActions.find((candidate) => candidate.id === object.actionId);
      if (!action || !object.externalId) continue;
      existing.set(object.externalId, {
        id: object.externalId,
        name: object.name,
        type: object.type || action.objectType,
        destinationId: saved.id,
        ...(plan.tool === 'airtable'
          ? { parentId: airtableParentId(action, resultIdByAction) }
          : plan.tool === 'trello'
            ? { parentId: trelloParentId(action, resultIdByAction, saved.id) }
            : {}),
        ...(object.url ? { url: object.url } : {}),
      });
    }
    await contextStore.saveDestination({
      ...saved,
      verifiedAt: this.now().toISOString(),
      existingObjects: [...existing.values()].sort(
        (a, b) =>
          a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    });
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
    actionTotal?: number,
  ): Promise<T> {
    const started = Date.now();
    const progressWord = progressWordFor(phase);
    this.progress(progressWord, progressDetail(phase, 'started', actionTotal));
    const timer = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - started) / 1_000));
      this.progress(
        progressWord,
        progressDetail(phase, 'in progress', actionTotal),
        elapsedSeconds,
      );
    }, this.progressIntervalMs);
    timer.unref?.();
    try {
      const value = await task();
      const elapsedSeconds = ((Date.now() - started) / 1_000).toFixed(1);
      this.progress('Hallmarking', progressDetail(phase, 'completed', actionTotal), elapsedSeconds);
      return value;
    } catch (error) {
      const elapsedSeconds = ((Date.now() - started) / 1_000).toFixed(1);
      const outcome =
        signal?.aborted || (error instanceof AurousError && error.code === 'AUR-AGENT-007')
          ? 'cancelled'
          : error instanceof AurousError && error.code === 'AUR-AGENT-003'
            ? 'timed out'
            : 'failed';
      this.progress('Tempering', `Agent invocation ${outcome}: ${phase}.`, elapsedSeconds);
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  private progress(word: ProgressWord, detail: string, elapsedSeconds?: string | number): void {
    if (this.dependencies.output.progress)
      this.dependencies.output.progress(word, detail, elapsedSeconds);
    else this.dependencies.output.log(formatProgress(word, detail, elapsedSeconds));
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

function airtableParentId(
  action: AurousPlan['plannedActions'][number],
  resultIdByAction: Map<string, string>,
): string | undefined {
  const property = (key: string) => action.properties.find((entry) => entry.key === key)?.value;
  if (action.objectType.toLocaleLowerCase() === 'base') return undefined;
  const exact = property('airtable.tableId') ?? property('airtable.baseId');
  if (exact) return exact;
  const actionRef = property('airtable.tableActionId') ?? property('airtable.baseActionId');
  return actionRef ? resultIdByAction.get(actionRef) : undefined;
}

function trelloParentId(
  action: AurousPlan['plannedActions'][number],
  resultIdByAction: Map<string, string>,
  workspaceId: string,
): string | undefined {
  const property = (key: string) => action.properties.find((entry) => entry.key === key)?.value;
  const kind = normalizedObjectType(action.objectType);
  if (kind === 'board') return workspaceId;
  if (kind === 'list') {
    return (
      property('trello.boardId') ??
      (property('trello.boardActionId')
        ? resultIdByAction.get(property('trello.boardActionId')!)
        : undefined)
    );
  }
  if (kind === 'card') {
    return (
      property('trello.listId') ??
      (property('trello.listActionId')
        ? resultIdByAction.get(property('trello.listActionId')!)
        : undefined)
    );
  }
  if (kind === 'checklist') {
    return (
      property('trello.cardId') ??
      (property('trello.cardActionId')
        ? resultIdByAction.get(property('trello.cardActionId')!)
        : undefined)
    );
  }
  if (kind === 'label') {
    return (
      property('trello.boardId') ??
      (property('trello.boardActionId')
        ? resultIdByAction.get(property('trello.boardActionId')!)
        : undefined)
    );
  }
  return undefined;
}

function validateTrelloReferences(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
  actions: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'],
  destination: ResolvedDestination,
): void {
  const kind = normalizedObjectType(action.objectType);
  if (kind === 'label' && action.operation === 'create') {
    throw new AurousError({
      code: 'AUR-PLAN-018',
      summary: `Trello action ${action.id} cannot create a label.`,
      probableCause: 'The official Trello MCP has no label-creation tool.',
      nextAction:
        'Attach an existing label with trello.labelId from discovery, or omit the label action.',
    });
  }
  if (/archive|delete/i.test(action.operation) || /archive|delet/i.test(action.description)) {
    throw new AurousError({
      code: 'AUR-PLAN-019',
      summary: `Trello action ${action.id} proposes unsupported archive or deletion work.`,
      probableCause: 'Aurous Trello MVP never archives or deletes objects.',
      nextAction: 'Regenerate the plan without archive or delete actions.',
    });
  }
  for (const property of action.properties) {
    if (/archive|delete/i.test(property.key) || /archive|delete/i.test(property.value)) {
      throw new AurousError({
        code: 'AUR-PLAN-019',
        summary: `Trello action ${action.id} includes unsupported archive or deletion properties.`,
        probableCause: 'Aurous Trello MVP never archives or deletes objects.',
        nextAction: 'Regenerate the plan without archive or delete properties.',
      });
    }
  }
  if (kind === 'workspace' && action.operation === 'create') {
    throw new AurousError({
      code: 'AUR-PLAN-020',
      summary: 'Trello plans must not create a workspace.',
      probableCause: 'Aurous uses the authorized OAuth workspace only.',
      nextAction: 'Operate inside the discovered workspace destination.',
    });
  }
  const expected = new Map([
    ['trello.boardId', 'board'],
    ['trello.listId', 'list'],
    ['trello.cardId', 'card'],
    ['trello.checklistId', 'checklist'],
    ['trello.labelId', 'label'],
  ]);
  for (const [key, type] of expected) {
    const value = action.properties.find((property) => property.key === key)?.value;
    if (!value) continue;
    const exact = destination.existingObjects.find((object) => object.id === value);
    if (!exact || !exactObjectTypeMatches('trello', exact.type, type)) {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Trello action ${action.id} references an uninspected ${type} ID.`,
        probableCause: `The immutable ${key} value was not returned by read-only discovery.`,
        nextAction:
          'Re-run Trello discovery. New dependent objects must reference an approved create action ID instead.',
      });
    }
  }
  for (const [key, type] of [
    ['trello.boardActionId', 'board'],
    ['trello.listActionId', 'list'],
    ['trello.cardActionId', 'card'],
  ] as const) {
    const value = action.properties.find((property) => property.key === key)?.value;
    if (!value) continue;
    const dependency = actions.find((candidate) => candidate.id === value);
    if (
      !dependency ||
      dependency.operation !== 'create' ||
      !exactObjectTypeMatches('trello', dependency.objectType, type) ||
      !dependsOnAction(action, value, actions)
    ) {
      throw new AurousError({
        code: 'AUR-PLAN-012',
        summary: `Trello action ${action.id} has an invalid ${key} dependency.`,
        probableCause:
          'A dependent object did not reference an immutable approved create action of the required type.',
        nextAction:
          'Regenerate the plan with explicit create-action dependencies and no placeholder IDs.',
      });
    }
  }
  if (kind === 'list' && action.operation === 'create') {
    const boardId = propertyValue(action, 'trello.boardId');
    const boardActionId = propertyValue(action, 'trello.boardActionId');
    if (!boardId && !boardActionId) {
      throw new AurousError({
        code: 'AUR-PLAN-021',
        summary: `Trello list ${JSON.stringify(action.target)} is missing an exact board parent.`,
        probableCause: 'List creation requires trello.boardId or trello.boardActionId.',
        nextAction: 'Bind the list to an inspected board or an approved board create action.',
      });
    }
  }
  if (kind === 'card' && (action.operation === 'create' || action.operation === 'update')) {
    const listId = propertyValue(action, 'trello.listId');
    const listActionId = propertyValue(action, 'trello.listActionId');
    if (!listId && !listActionId && action.operation === 'create') {
      throw new AurousError({
        code: 'AUR-PLAN-022',
        summary: `Trello card ${JSON.stringify(action.target)} is missing an exact list parent.`,
        probableCause: 'Card creation requires trello.listId or trello.listActionId.',
        nextAction: 'Bind the card to an inspected list or an approved list create action.',
      });
    }
  }
  if (kind === 'checklist' && action.operation === 'create') {
    const cardId = propertyValue(action, 'trello.cardId');
    const cardActionId = propertyValue(action, 'trello.cardActionId');
    if (!cardId && !cardActionId) {
      throw new AurousError({
        code: 'AUR-PLAN-023',
        summary: `Trello checklist ${JSON.stringify(action.target)} is missing an exact card parent.`,
        probableCause: 'Checklist creation requires trello.cardId or trello.cardActionId.',
        nextAction: 'Bind the checklist to an inspected card or an approved card create action.',
      });
    }
  }
}

function progressWordFor(phase: string): ProgressWord {
  if (phase.includes('apply') || phase.includes('action')) return 'Forging';
  if (phase.includes('plan') || phase.includes('inspection') || phase.includes('verification'))
    return 'Assaying';
  return 'Polishing';
}

function progressDetail(
  phase: string,
  state: 'started' | 'in progress' | 'completed',
  actionTotal?: number,
): string {
  if (phase === 'plan apply' && actionTotal !== undefined) {
    const completed = state === 'completed' ? actionTotal : 0;
    return `${state === 'completed' ? 'Approved actions completed' : 'Executing approved workspace actions'} · ${completed}/${actionTotal}`;
  }
  return `Agent invocation ${state}: ${phase}.`;
}

function modelDisplayName(agent: AgentName): string {
  return agent === 'mock' ? 'built-in deterministic adapter' : 'auto';
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
    const values = [
      action.target,
      action.description,
      ...action.properties.map((property) => property.value),
    ];
    if (values.some(isForbiddenDestinationPlaceholder)) {
      throw new AurousError({
        code: 'AUR-PLAN-005',
        summary: `The generated plan contains an unresolved destination in ${action.id}.`,
        probableCause:
          'Planning attempted to preserve a destination placeholder instead of an exact ID.',
        nextAction: 'Run read-only destination discovery again; no external writes were attempted.',
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

function validateResolvedPlanDestination(
  proposal: ReturnType<typeof PlanProposalSchema.parse>,
  propertyKey: string,
  destinationId: string,
): void {
  if (
    proposal.plannedActions.some(
      (action) =>
        action.properties.find((property) => property.key === propertyKey)?.value !== destinationId,
    )
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-006',
      summary: 'The generated plan is not fully bound to the verified destination.',
      probableCause: `At least one action omitted the immutable ${propertyKey} exact ID.`,
      nextAction: 'No writes were attempted. Regenerate the plan after destination inspection.',
    });
  }
}

function validateExactObjectAuthorizations(
  proposal: ReturnType<typeof PlanProposalSchema.parse>,
  tool: ToolName,
  destination: ResolvedDestination,
): void {
  const namespace =
    tool === 'linear'
      ? 'linear'
      : tool === 'notion'
        ? 'notion'
        : tool === 'airtable'
          ? 'airtable'
          : tool === 'trello'
            ? 'trello'
            : 'mock';
  const exactKey = `${namespace}.dedupe.knownExternalId`;
  const inspectedById = new Map(destination.existingObjects.map((object) => [object.id, object]));
  for (const action of proposal.plannedActions) {
    const knownId = action.properties.find((property) => property.key === exactKey)?.value;
    if (requiresExactExistingId(action) && !knownId) {
      throw new AurousError({
        code: 'AUR-PLAN-009',
        summary: `Action ${action.id} (${action.objectType} ${JSON.stringify(action.target)}) proposes reuse or update without an exact external ID.`,
        probableCause:
          'Discovery found or implied an existing object, but the immutable action retained only a name-based authorization.',
        nextAction:
          'No writes were attempted. Inspect the object by exact ID or regenerate this action as an explicit create decision.',
      });
    }
    if (knownId) {
      const inspected = inspectedById.get(knownId);
      const previouslyVerified = action.properties
        .find((property) => property.key === `${namespace}.dedupe.identitySource`)
        ?.value.match(/^verified-run:run-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$/);
      if (
        !previouslyVerified &&
        (!inspected ||
          inspected.name !== action.target ||
          !exactObjectTypeMatches(tool, inspected.type, action.objectType))
      ) {
        throw new AurousError({
          code: 'AUR-PLAN-010',
          summary: `Action ${action.id} contains exact ID ${knownId}, but current inspection did not verify it as ${action.objectType} ${JSON.stringify(action.target)}.`,
          probableCause: 'A stale or name-matched identity entered the proposed immutable plan.',
          nextAction:
            'No writes were attempted. Repeat read-only discovery and exact-ID inspection.',
        });
      }
    }
    if (tool === 'linear') validateLinearRelationshipIds(action, destination);
    if (tool === 'airtable')
      validateAirtableReferences(action, proposal.plannedActions, destination);
    if (tool === 'notion') validateNotionRelationshipIds(action, destination);
    if (tool === 'trello') validateTrelloReferences(action, proposal.plannedActions, destination);
  }
}

function validateNotionRelationshipIds(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
  destination: ResolvedDestination,
): void {
  const targetIdsValue = action.properties.find(
    (property) =>
      property.key === 'notion.relation.targetRecordIds' ||
      property.key === 'notion.relation.targetRecordId',
  )?.value;
  if (!targetIdsValue) return;
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(targetIdsValue) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) ids = parsed;
    else if (typeof targetIdsValue === 'string') ids = [targetIdsValue];
  } catch {
    ids = [targetIdsValue];
  }
  for (const id of ids) {
    const exact = destination.existingObjects.find((object) => object.id === id);
    if (!exact || !exactObjectTypeMatches('notion', exact.type, 'database_record')) {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Notion action ${action.id} references an uninspected related record ID.`,
        probableCause:
          'Related Notion records must be authorized by exact discovered IDs, not prose.',
        nextAction:
          'No writes were attempted. Bind notion.relation.targetRecordIds from discovery.',
      });
    }
  }
  const sourceId = action.properties.find(
    (property) => property.key === 'notion.relation.sourceRecordId',
  )?.value;
  if (
    sourceId &&
    action.properties.find((property) => property.key === 'notion.dedupe.knownExternalId')
      ?.value !== sourceId
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-009',
      summary: `Action ${action.id} (${action.objectType} ${JSON.stringify(action.target)}) proposes a relation update without binding the exact source record ID.`,
      probableCause:
        'The relation source ID stayed outside the structured exact-authorization field.',
      nextAction:
        'No writes were attempted. Bind notion.dedupe.knownExternalId to the source record.',
    });
  }
}

function validateAirtableReferences(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
  actions: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'],
  destination: ResolvedDestination,
): void {
  const baseAction = actions.find(
    (candidate) =>
      normalizedObjectType(candidate.objectType) === 'base' && candidate.operation === 'create',
  );
  const bootstrapTables = baseAction ? airtableBootstrapTableNames(baseAction) : [];
  if (
    baseAction &&
    !baseAction.properties.some((property) => property.key === 'airtable.dedupe.knownExternalId') &&
    bootstrapTables.length === 0
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-013',
      summary: 'Airtable new-base plan omits required bootstrap table definitions.',
      probableCause: 'The official Airtable create_base operation cannot create an empty base.',
      nextAction:
        'Regenerate the plan with one non-empty airtable.base.initialTables array on the base create action.',
    });
  }
  if (
    baseAction &&
    normalizedObjectType(action.objectType) === 'table' &&
    propertyValue(action, 'airtable.baseActionId') === baseAction.id
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-014',
      summary: `Airtable bootstrap table ${JSON.stringify(action.target)} must be included in the base creation action.`,
      probableCause:
        'Creating it later would require an empty base, which the official MCP rejects.',
      nextAction:
        'Include the table and its primary field in airtable.base.initialTables, then use dependent field or record actions.',
    });
  }
  const bootstrapTable = propertyValue(action, 'airtable.bootstrapTableName');
  if (bootstrapTable && !bootstrapTables.includes(bootstrapTable)) {
    throw new AurousError({
      code: 'AUR-PLAN-015',
      summary: `Airtable action ${action.id} references a bootstrap table not defined by the base action.`,
      probableCause: 'The action would need a fabricated or unverified table ID.',
      nextAction:
        'Reference one exact table name from the immutable airtable.base.initialTables payload.',
    });
  }
  const linkedBootstrapTable = propertyValue(action, 'airtable.linkedBootstrapTableName');
  if (linkedBootstrapTable && !bootstrapTables.includes(linkedBootstrapTable)) {
    throw new AurousError({
      code: 'AUR-PLAN-016',
      summary: `Airtable action ${action.id} links to a bootstrap table not defined by the base action.`,
      probableCause:
        'The linked-record relationship cannot be resolved from an approved exact action result.',
      nextAction:
        'Reference one exact table name from the immutable airtable.base.initialTables payload.',
    });
  }
  const expected = new Map([
    ['airtable.baseId', 'base'],
    ['airtable.tableId', 'table'],
    ['airtable.fieldId', 'field'],
    ['airtable.recordId', 'record'],
  ]);
  for (const [key, type] of expected) {
    const value = action.properties.find((property) => property.key === key)?.value;
    if (!value) continue;
    const exact = destination.existingObjects.find((object) => object.id === value);
    if (!exact || !exactObjectTypeMatches('airtable', exact.type, type)) {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Airtable action ${action.id} references an uninspected ${type} ID.`,
        probableCause: `The immutable ${key} value was not returned by read-only discovery.`,
        nextAction:
          'Re-run Airtable discovery. New dependent objects must reference an approved create action ID instead.',
      });
    }
  }
  const linkedRecordIds = action.properties.find(
    (property) => property.key === 'airtable.linkedRecordIds',
  )?.value;
  if (linkedRecordIds) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(linkedRecordIds) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) ids = parsed;
      else throw new Error('invalid');
    } catch {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Airtable action ${action.id} has malformed airtable.linkedRecordIds.`,
        probableCause: 'Linked-record values must be a JSON array of exact inspected record IDs.',
        nextAction: 'No writes were attempted. Bind exact related record IDs before preview.',
      });
    }
    if (ids.length === 0) {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Airtable action ${action.id} omits linked record IDs for a relationship update.`,
        probableCause: 'A relation mutation cannot authorize related objects from names or prose.',
        nextAction:
          'No writes were attempted. Include exact airtable.linkedRecordIds from discovery.',
      });
    }
    for (const id of ids) {
      const exact = destination.existingObjects.find((object) => object.id === id);
      if (!exact || !exactObjectTypeMatches('airtable', exact.type, 'record')) {
        throw new AurousError({
          code: 'AUR-PLAN-011',
          summary: `Airtable action ${action.id} references an uninspected linked record ID.`,
          probableCause:
            'The immutable airtable.linkedRecordIds value was not returned by discovery.',
          nextAction: 'Re-run Airtable discovery and bind exact related record IDs before preview.',
        });
      }
    }
  }
  if (
    (action.operation === 'link' ||
      action.properties.some((property) => property.key === 'airtable.linkedRecordIds')) &&
    !action.properties.some((property) => property.key === 'airtable.recordId') &&
    !action.properties.some((property) => property.key === 'airtable.dedupe.knownExternalId')
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-009',
      summary: `Action ${action.id} (${action.objectType} ${JSON.stringify(action.target)}) proposes a relationship update without an exact target record ID.`,
      probableCause:
        'Discovery found or implied existing records, but the mutation target was not bound by exact ID.',
      nextAction:
        'No writes were attempted. Bind airtable.recordId / knownExternalId for the source record.',
    });
  }
  for (const [key, type] of [
    ['airtable.baseActionId', 'base'],
    ['airtable.tableActionId', 'table'],
    ['airtable.fieldActionId', 'field'],
  ] as const) {
    const value = action.properties.find((property) => property.key === key)?.value;
    if (!value) continue;
    const dependency = actions.find((candidate) => candidate.id === value);
    if (
      !dependency ||
      dependency.operation !== 'create' ||
      !exactObjectTypeMatches('airtable', dependency.objectType, type) ||
      !dependsOnAction(action, value, actions)
    ) {
      throw new AurousError({
        code: 'AUR-PLAN-012',
        summary: `Airtable action ${action.id} has an invalid ${key} dependency.`,
        probableCause:
          'A dependent object did not reference an immutable approved create action of the required type.',
        nextAction:
          'Regenerate the plan with explicit create-action dependencies and no placeholder IDs.',
      });
    }
  }
}

function dependsOnAction(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
  requiredActionId: string,
  actions: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'],
): boolean {
  const byId = new Map(actions.map((candidate) => [candidate.id, candidate]));
  const pending = [...action.dependsOn];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === requiredActionId) return true;
    visited.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

function propertyValue(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
  key: string,
): string | undefined {
  return action.properties.find((property) => property.key === key)?.value;
}

function airtableBootstrapTableNames(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
): string[] {
  const value = propertyValue(action, 'airtable.base.initialTables');
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const names = parsed.map((table) => (isNamedAirtableTable(table) ? table.name : undefined));
    if (names.some((name) => !name)) throw new Error('missing name');
    return [...new Set(names as string[])];
  } catch {
    throw new AurousError({
      code: 'AUR-PLAN-017',
      summary: 'Airtable bootstrap table definitions are not valid JSON.',
      probableCause: 'The base create action did not provide a bounded table array with names.',
      nextAction: 'Regenerate the plan with valid airtable.base.initialTables JSON.',
    });
  }
}

function isNamedAirtableTable(value: unknown): value is { name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function validateLinearRelationshipIds(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
  destination: ResolvedDestination,
): void {
  validateLinearSingleRelationship(action, destination, 'project');
  validateLinearSingleRelationship(action, destination, 'milestone');
  const labels = action.properties.find((property) =>
    ['linear.labels', 'labels'].includes(property.key),
  )?.value;
  if (!labels) return;
  let names: string[] = [];
  try {
    const parsed = JSON.parse(labels) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) names = parsed;
  } catch {
    return;
  }
  const existingNames = names.filter((name) =>
    destination.existingObjects.some(
      (object) => normalizedObjectType(object.type) === 'label' && object.name === name,
    ),
  );
  const idsValue = action.properties.find((property) => property.key === 'linear.labelIds')?.value;
  if (!idsValue && existingNames.length === 0) return;
  let ids: string[] = [];
  try {
    const parsed = idsValue ? (JSON.parse(idsValue) as unknown) : undefined;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) ids = parsed;
  } catch {
    // The precise action error below is safer than accepting malformed IDs.
  }
  if (
    ids.length !== names.length ||
    names.some((name, index) => {
      const object = destination.existingObjects.find((candidate) => candidate.id === ids[index]);
      return !object || normalizedObjectType(object.type) !== 'label' || object.name !== name;
    })
  )
    throw exactRelationshipError(action.id, 'label');
}

function validateLinearSingleRelationship(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
  destination: ResolvedDestination,
  type: 'project' | 'milestone',
): void {
  const name = action.properties.find((property) =>
    [`linear.${type}`, type].includes(property.key),
  )?.value;
  if (!name) return;
  const existing = destination.existingObjects.some(
    (object) => normalizedObjectType(object.type) === type && object.name === name,
  );
  const id = action.properties.find((property) => property.key === `linear.${type}Id`)?.value;
  if (!id && !existing) return;
  const verified = destination.existingObjects.find((object) => object.id === id);
  if (!verified || normalizedObjectType(verified.type) !== type || verified.name !== name)
    throw exactRelationshipError(action.id, type);
}

function exactRelationshipError(actionId: string, type: string): AurousError {
  return new AurousError({
    code: 'AUR-PLAN-011',
    summary: `Action ${actionId} references an existing Linear ${type} without its verified exact ID.`,
    probableCause:
      'The relationship was authorized by a friendly name instead of current inspection.',
    nextAction: 'No writes were attempted. Bind the inspected relationship ID before preview.',
  });
}

function requiresExactExistingId(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
): boolean {
  return (
    action.operation === 'update' ||
    (action.operation === 'link' && requiresExactIdForLink(action)) ||
    /\b(?:reuse|reconcile|skip)\b/i.test(action.description) ||
    isSyntheticRelationshipCreate(action) ||
    action.properties.some(
      (property) =>
        /\b(?:reuse|existing)\b/i.test(property.key) &&
        !property.key.endsWith('.knownExternalId') &&
        !property.key.endsWith('.knownUrl'),
    )
  );
}

function requiresExactIdForLink(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
): boolean {
  if (action.objectType.toLocaleLowerCase().includes('relation')) return true;
  if (/\blink\b.+\bto\b/i.test(action.target)) return true;
  if (/\bexisting\b.+\band\b.+\bexisting\b/i.test(action.target)) return true;
  return action.properties.some((property) =>
    [
      'airtable.recordId',
      'airtable.linkedRecordIds',
      'linear.issueId',
      'notion.relation.sourceRecordId',
      'notion.relation.targetRecordId',
      'notion.relation.targetRecordIds',
      'notion.pageId',
      'notion.recordId',
    ].includes(property.key),
  );
}

function isSyntheticRelationshipCreate(
  action: ReturnType<typeof PlanProposalSchema.parse>['plannedActions'][number],
): boolean {
  if (action.operation !== 'create') return false;
  return (
    /\blink\b.+\bto\b/i.test(action.target) ||
    action.objectType.toLocaleLowerCase().includes('relation')
  );
}

function validateExecutablePlanDestination(plan: AurousPlan): void {
  const adapter = createProductivityAdapter(plan.tool);
  const key = adapter.destination.exactIdProperty;
  const ids = plan.plannedActions.map(
    (action) => action.properties.find((property) => property.key === key)?.value,
  );
  if (ids.some((id) => !id || isForbiddenDestinationPlaceholder(id)) || new Set(ids).size !== 1) {
    throw new AurousError({
      code: 'AUR-APPLY-004',
      summary: 'This saved plan has no single verified destination.',
      probableCause: `The immutable plan is missing a consistent exact ${key} value.`,
      nextAction:
        'Create a new plan; Aurous will discover and save the destination before preview.',
      runId: plan.runId,
      severity: 'recoverable',
    });
  }
  for (const action of plan.plannedActions) {
    if (
      requiresExactExistingId(action) &&
      !action.properties.some((property) => property.key.endsWith('.dedupe.knownExternalId'))
    ) {
      throw new AurousError({
        code: 'AUR-APPLY-005',
        summary: `Saved action ${action.id} cannot execute because its reuse or update target has no exact external ID.`,
        probableCause:
          'The saved plan predates exact-ID reuse validation or lost its identity binding.',
        nextAction: 'Create a new plan after read-only destination inspection.',
        runId: plan.runId,
        severity: 'recoverable',
      });
    }
  }
}

function destinationCancelled(): AurousError {
  return new AurousError({
    code: 'AUR-DEST-004',
    summary: 'Destination selection was canceled.',
    probableCause: 'The user canceled before an immutable plan was created.',
    nextAction: 'Describe the request again whenever you are ready.',
    severity: 'recoverable',
  });
}

function integrationDisplayName(tool: ToolName): string {
  if (tool === 'notion') return 'Notion';
  if (tool === 'linear') return 'Linear';
  if (tool === 'airtable') return 'Airtable';
  if (tool === 'trello') return 'Trello';
  return 'Mock';
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
    .find((property) => property.key === 'linear.teamId')?.value;
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
