import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { commandFailure } from '../src/adapters/agents/helpers.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type {
  DestinationDiscovery,
  ResolvedDestination,
  SanitizedDiscoveryTrace,
} from '../src/domain/destinations.js';
import type {
  AurousPlan,
  ContextBundle,
  ExecutionResult,
  PlanProposal,
  RunRecord,
  RunStatus,
} from '../src/domain/schemas.js';

function captureOutput(): { output: Output; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    output: {
      log(message = '') {
        lines.push(message);
      },
      error(message) {
        lines.push(message);
      },
    },
  };
}

async function fixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-service-'));
  await writeFile(path.join(workspace, 'README.md'), '# Example\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"example"}\n');
  const capture = captureOutput();
  const store = new LocalRunStore(workspace);
  const services = new AurousServices({ workspace, store, output: capture.output });
  await services.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  return { workspace, capture, store, services };
}

function discoveryFrom(destination: ResolvedDestination): DestinationDiscovery {
  return {
    integration: destination.integration,
    candidates: [
      {
        id: destination.id,
        name: destination.name,
        kind: destination.kind,
        description: destination.sourceDetail,
        existingAurousMatch: true,
      },
    ],
    existingObjects: destination.existingObjects,
    inspectedAt: destination.verifiedAt,
    warnings: destination.discoveryWarnings,
  };
}

describe('AurousServices mock flow', () => {
  it('plans, previews, applies, and persists a complete mock run', async () => {
    const { workspace, capture, store, services } = await fixture();
    const plan = await services.plan({
      contextPaths: ['.'],
      objective: 'Help manage this project',
    });

    expect(plan.agent).toBe('mock');
    expect(plan.tool).toBe('notion');
    expect(plan.plannedActions).toHaveLength(5);
    expect(
      plan.plannedActions.every((action) =>
        action.properties.some(
          (property) =>
            property.key === 'notion.destination.parentPageId' &&
            property.value === 'mock-notion-private-page',
        ),
      ),
    ).toBe(true);
    expect(capture.lines.join('\n')).toContain('Context summary (shown before agent invocation)');
    expect((await store.getRun(plan.runId)).status).toBe('planned');

    const result = await services.apply(plan.runId, { confirmed: true });
    expect(result?.status).toBe('succeeded');
    expect(result?.completedActionIds).toEqual(plan.plannedActions.map((action) => action.id));
    expect((await store.getRun(plan.runId)).status).toBe('succeeded');
    expect(await store.loadResult(plan.runId)).toEqual(result);

    const planLog = await readFile(
      path.join(workspace, '.aurous', 'runs', plan.runId, 'logs', 'plan-agent.json'),
      'utf8',
    );
    expect(planLog).toContain('Project Command Center');
  });

  it('never overwrites the authoritative result when a post-save step throws', async () => {
    const { workspace, capture } = await fixture();
    const savedResults: ExecutionResult[] = [];
    class PostSaveFailingStore extends LocalRunStore {
      override async saveResult(runId: string, result: ExecutionResult): Promise<void> {
        savedResults.push(result);
        await super.saveResult(runId, result);
      }
      override async updateStatus(runId: string, status: RunStatus): Promise<RunRecord> {
        if (status === 'succeeded' || status === 'partial') {
          throw new Error('simulated bookkeeping failure after the authoritative result was saved');
        }
        return super.updateStatus(runId, status);
      }
    }
    const store = new PostSaveFailingStore(workspace);
    const services = new AurousServices({ workspace, store, output: capture.output });
    const plan = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Keep created-object IDs safe on rerun',
    });

    await expect(services.apply(plan.runId, { confirmed: true })).rejects.toBeDefined();

    const persisted = await store.loadResult(plan.runId);
    expect(persisted?.status).toBe('succeeded');
    expect(savedResults).toHaveLength(1);
    expect(savedResults[0]?.status).toBe('succeeded');
    expect(persisted?.createdObjects).toEqual(savedResults[0]?.createdObjects);
  });

  it('reconciles the record status after a transient post-save write failure', async () => {
    const { workspace, capture } = await fixture();
    class TransientUpdateStore extends LocalRunStore {
      terminalFailuresRemaining = 1;
      override async updateStatus(runId: string, status: RunStatus): Promise<RunRecord> {
        if (
          (status === 'succeeded' || status === 'partial') &&
          this.terminalFailuresRemaining > 0
        ) {
          this.terminalFailuresRemaining -= 1;
          throw new Error('transient status write failure');
        }
        return super.updateStatus(runId, status);
      }
    }
    const store = new TransientUpdateStore(workspace);
    const services = new AurousServices({ workspace, store, output: capture.output });
    const plan = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Recover the record status on a flaky write',
    });

    await expect(services.apply(plan.runId, { confirmed: true })).rejects.toBeDefined();

    expect((await store.getRun(plan.runId)).status).toBe('succeeded');
    expect((await store.loadResult(plan.runId))?.status).toBe('succeeded');
  });

  it('accepts a Trello create-card that carries only its parent list ID', async () => {
    const { workspace, capture, store } = await fixture();
    const destination: ResolvedDestination = {
      integration: 'trello',
      id: 'wsp_aurous',
      name: 'Aurous Workspace',
      kind: 'workspace',
      source: 'existing-match',
      sourceDetail: 'Exact board inspected.',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      existingObjects: [
        {
          id: 'board_hq',
          name: 'Launch HQ',
          type: 'trello.board',
          destinationId: 'wsp_aurous',
          parentId: 'wsp_aurous',
        },
        {
          id: 'list_build',
          name: 'Build',
          type: 'trello.list',
          destinationId: 'wsp_aurous',
          parentId: 'board_hq',
        },
      ],
      discoveryWarnings: [],
    };
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [{ kind: 'card', name: 'Wire up CI', purpose: 'Track a task.' }],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'create',
          objectType: 'trello.card',
          target: 'Wire up CI',
          description: 'Create a new card in the Build list.',
          properties: [{ key: 'trello.listId', value: 'list_build' }],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'A new card exists in the Build list.',
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => planningAgent(discoveryFrom(destination), proposal),
    });

    const plan = await services.plan({
      agent: 'mock',
      tool: 'trello',
      contextPaths: ['.'],
      objective: 'Add a Build task card to the launch board',
    });

    const card = plan.plannedActions.find((action) => action.objectType === 'trello.card');
    expect(card?.operation).toBe('create');
    expect(card?.properties.find((property) => property.key === 'trello.listId')?.value).toBe(
      'list_build',
    );
    expect(card?.properties.some((property) => property.key === 'trello.dedupe.knownExternalId')).toBe(
      false,
    );
  });

  it('does not trust a prior Notion run bound to a different destination for exact-ID reuse', async () => {
    const { workspace, capture, store } = await fixture();
    const objective = 'Reuse the launch note page in Notion';
    const priorParentPageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const priorExternalId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const priorRunId = 'run-20260720T120000Z-aaaaaa';
    const priorContext: ContextBundle = {
      summary: {
        approvedPaths: [workspace],
        files: [],
        fileCount: 0,
        totalBytes: 0,
        skipped: [],
      },
      documents: [],
    };
    const priorPlan: AurousPlan = {
      schemaVersion: 1,
      runId: priorRunId,
      createdAt: '2026-07-20T12:00:00.000Z',
      agent: 'mock',
      tool: 'notion',
      objective,
      contextSummary: priorContext.summary,
      proposedWorkspaceStructure: [{ kind: 'page', name: 'Launch note', purpose: 'Root note.' }],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'create',
          objectType: 'page',
          target: 'Launch note',
          description: 'Create the launch note page.',
          properties: [{ key: 'notion.destination.parentPageId', value: priorParentPageId }],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'A launch note page exists.',
    };
    await store.createRun(
      {
        runId: priorRunId,
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-20T12:00:00.000Z',
        status: 'planning',
        agent: 'mock',
        tool: 'notion',
        objective,
        approvedContextPaths: [workspace],
        runKind: 'standard',
      },
      priorContext,
    );
    await store.savePlan(priorPlan);
    await store.saveResult(priorRunId, {
      status: 'succeeded',
      summary: 'Created the launch note.',
      createdObjects: [
        {
          actionId: 'action-001',
          type: 'page',
          name: 'Launch note',
          externalId: priorExternalId,
          url: `https://notion.so/${priorExternalId}`,
        },
      ],
      skippedActions: [],
      completedActionIds: ['action-001'],
      compatibilityNotes: [],
      warnings: [],
      failures: [],
      startedAt: '2026-07-20T12:00:00.000Z',
      finishedAt: '2026-07-20T12:00:01.000Z',
    });
    await store.updateStatus(priorRunId, 'succeeded');

    const otherDestination: ResolvedDestination = {
      integration: 'notion',
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'A different Notion parent',
      kind: 'page',
      source: 'existing-match',
      sourceDetail: 'A different, unrelated Notion parent page.',
      verifiedAt: '2026-07-21T09:00:00.000Z',
      existingObjects: [],
      discoveryWarnings: [],
    };
    const reuseProposal: PlanProposal = {
      proposedWorkspaceStructure: [{ kind: 'page', name: 'Launch note', purpose: 'Reuse note.' }],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'update',
          objectType: 'page',
          target: 'Launch note',
          description: 'Reuse the existing launch note by its prior ID.',
          properties: [{ key: 'notion.knownExternalId', value: priorExternalId }],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'The launch note is reused.',
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => planningAgent(discoveryFrom(otherDestination), reuseProposal),
    });

    await expect(
      services.plan({ agent: 'mock', tool: 'notion', contextPaths: ['.'], objective }),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });

  it('does not apply when confirmation is declined', async () => {
    const { store, services } = await fixture();
    const plan = await services.plan({ contextPaths: ['.'], objective: 'Plan only' });
    const result = await services.apply(plan.runId, {
      confirmed: false,
      confirm: () => Promise.resolve(false),
    });
    expect(result).toBeUndefined();
    expect((await store.getRun(plan.runId)).status).toBe('planned');
    expect(await store.loadResult(plan.runId)).toBeUndefined();
  });

  it('rejects and persists an execution response outside approved scope', async () => {
    const { store, workspace, capture } = await fixture();
    const invalidAgent: AgentAdapter = {
      ...new MockAgentAdapter(),
      name: 'mock',
      diagnose: () => new MockAgentAdapter().diagnose(),
      generatePlan: (input) => new MockAgentAdapter().generatePlan(input),
      inspectRecovery: (input) => new MockAgentAdapter().inspectRecovery(input),
      executeRecoveryAction: (input) => new MockAgentAdapter().executeRecoveryAction(input),
      manualFallback: (directory, phase, prompt) =>
        new MockAgentAdapter().manualFallback(directory, phase, prompt),
      executePlan: () =>
        Promise.resolve({
          value: {
            status: 'succeeded',
            summary: 'Expanded scope',
            createdObjects: [],
            completedActionIds: ['action-999'],
            warnings: [],
            failures: [],
            startedAt: '2026-07-18T12:00:00.000Z',
            finishedAt: '2026-07-18T12:00:01.000Z',
          },
          command: ['invalid-agent'],
          stdout: '{}',
          stderr: '',
          durationMs: 1,
        }),
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => invalidAgent,
    });
    const plan = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Stay in scope',
    });
    await expect(services.apply(plan.runId, { confirmed: true })).rejects.toMatchObject({
      code: 'AUR-APPLY-003',
    });
    expect((await store.getRun(plan.runId)).status).toBe('failed');
    expect((await store.loadResult(plan.runId))?.failures[0]?.code).toBe('AUR-APPLY-003');
  });

  it('persists cancelled command output after redaction', async () => {
    const { store, workspace, capture } = await fixture();
    const mock = new MockAgentAdapter();
    const cancelledAgent: AgentAdapter = {
      name: 'mock',
      diagnose: () => mock.diagnose(),
      generatePlan: (input) => mock.generatePlan(input),
      inspectRecovery: (inspectionInput) => mock.inspectRecovery(inspectionInput),
      executeRecoveryAction: (executionInput) => mock.executeRecoveryAction(executionInput),
      manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
      executePlan: () =>
        Promise.reject(
          commandFailure(
            'Mock agent',
            'apply',
            ['mock', 'apply'],
            'partial stdout sk-abcdefghijklmnop',
            'embedded project prompt should stay hidden\nERROR: {"message":"schema rejected"}',
            false,
            true,
            12,
          ),
        ),
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => cancelledAgent,
    });
    const plan = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Test cancellation',
    });
    await expect(services.apply(plan.runId, { confirmed: true })).rejects.toMatchObject({
      code: 'AUR-AGENT-007',
      severity: 'recoverable',
    });
    expect(capture.lines.join('\n')).toContain('Agent invocation cancelled: plan apply');
    expect((await store.getRun(plan.runId)).status).toBe('cancelled');
    expect((await store.loadResult(plan.runId))?.status).toBe('cancelled');
    const failedLog = await readFile(
      path.join(workspace, '.aurous', 'runs', plan.runId, 'logs', 'apply-agent-failed.json'),
      'utf8',
    );
    expect(failedLog).toContain('[REDACTED_OPENAI_KEY]');
    expect(failedLog).not.toContain('sk-abcdefghijklmnop');

    capture.lines.length = 0;
    await services.diagnoseRun(plan.runId, true);
    const diagnostic = capture.lines.join('\n');
    expect(diagnostic).toContain('Agent terminal error (redacted)');
    expect(diagnostic).toContain('schema rejected');
    expect(diagnostic).not.toContain('embedded project prompt should stay hidden');
  });

  it('reports an agent timeout distinctly from a generic failure', async () => {
    const { store, workspace, capture } = await fixture();
    const mock = new MockAgentAdapter();
    const timedOutAgent: AgentAdapter = {
      name: 'mock',
      diagnose: () => mock.diagnose(),
      generatePlan: (input) => mock.generatePlan(input),
      inspectRecovery: (inspectionInput) => mock.inspectRecovery(inspectionInput),
      executeRecoveryAction: (executionInput) => mock.executeRecoveryAction(executionInput),
      manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
      executePlan: () =>
        Promise.reject(
          commandFailure(
            'Mock agent',
            'apply',
            ['mock', 'apply'],
            '',
            'deadline exceeded',
            true,
            false,
            300_000,
          ),
        ),
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => timedOutAgent,
    });
    const plan = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Test timeout progress',
    });
    await expect(services.apply(plan.runId, { confirmed: true })).rejects.toMatchObject({
      code: 'AUR-AGENT-003',
    });
    expect(capture.lines.join('\n')).toContain('Agent invocation timed out: plan apply');
  });

  it('rejects unresolved destination placeholders before a plan can be approved', async () => {
    const { store, workspace, capture } = await fixture();
    const mock = new MockAgentAdapter();
    const unresolved: AgentAdapter = {
      name: 'mock',
      diagnose: () => mock.diagnose(),
      discoverDestinations: (input) => mock.discoverDestinations(input),
      generatePlan: async (input) => {
        const invocation = await mock.generatePlan(input);
        return {
          ...invocation,
          value: {
            ...invocation.value,
            plannedActions: invocation.value.plannedActions.map((action, index) =>
              index === 0
                ? {
                    ...action,
                    properties: [
                      ...action.properties,
                      { key: 'notion.parent', value: 'user-selected-parent' },
                    ],
                  }
                : action,
            ),
          },
        };
      },
      executePlan: (input) => mock.executePlan(input),
      inspectRecovery: (input) => mock.inspectRecovery(input),
      executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
      manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => unresolved,
    });

    await expect(
      services.plan({
        agent: 'mock',
        tool: 'notion',
        contextPaths: ['.'],
        objective: 'Create a safe Notion workspace',
      }),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-005' });
    expect((await store.listRuns())[0]?.status).toBe('failed');
  });

  it('uses natural-language Linear planning and retains README and submission intent', async () => {
    const { workspace, store, capture } = await fixture();
    const objective =
      'Add final Build Week launch work. Create two issues only: one for completing the README and one for preparing the Devpost submission materials before July 21.';
    const discovery: DestinationDiscovery = {
      integration: 'linear',
      candidates: [
        {
          id: 'team-exact',
          name: 'Product',
          kind: 'team',
          description: 'Product team',
          existingAurousMatch: true,
        },
      ],
      existingObjects: [
        {
          id: 'project-exact',
          name: 'Aurous — Build Week Launch',
          type: 'project',
          destinationId: 'team-exact',
        },
      ],
      inspectedAt: '2026-07-19T12:00:00.000Z',
      warnings: ['Existing duplicate demo issues will remain untouched.'],
    };
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'issue', name: 'Complete the README', purpose: 'Complete the README.' },
        {
          kind: 'issue',
          name: 'Prepare Devpost submission materials',
          purpose: 'Prepare the Devpost submission materials.',
        },
      ],
      plannedActions: [
        linearIssue('action-001', 'Complete the README', 'Complete the README before launch.'),
        linearIssue(
          'action-002',
          'Prepare Devpost submission materials',
          'Prepare the Devpost submission materials before July 21.',
        ),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Two issues covering the README and Devpost submission materials.',
    };
    const agent = planningAgent(discovery, proposal);
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => agent,
    });

    const plan = await services.plan({
      agent: 'mock',
      tool: 'linear',
      contextPaths: ['.'],
      objective,
    });

    expect(plan.plannedActions.map((action) => action.target)).toEqual([
      'Complete the README',
      'Prepare Devpost submission materials',
    ]);
    expect(plan.plannedActions).toHaveLength(2);
    expect(
      plan.plannedActions.every((action) =>
        action.properties.some(
          (property) => property.key === 'linear.projectId' && property.value === 'project-exact',
        ),
      ),
    ).toBe(true);
    expect(plan.assumptions.join('\n')).toContain('no preset was inferred');
    expect(plan.warnings).toContain('Existing duplicate demo issues will remain untouched.');
  });

  it('rejects an update action without an inspected exact external ID', async () => {
    const { workspace, store, capture } = await fixture();
    const discovery: DestinationDiscovery = {
      integration: 'linear',
      candidates: [
        {
          id: 'team-exact',
          name: 'Product',
          kind: 'team',
          description: 'Product team',
          existingAurousMatch: false,
        },
      ],
      existingObjects: [],
      inspectedAt: '2026-07-19T12:00:00.000Z',
      warnings: [],
    };
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'issue', name: 'Unknown existing issue', purpose: 'Update it.' },
      ],
      plannedActions: [
        {
          ...linearIssue('action-001', 'Unknown existing issue', 'Update the existing issue.'),
          operation: 'update',
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'The issue is updated.',
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => planningAgent(discovery, proposal),
    });

    await expect(
      services.plan({
        agent: 'mock',
        tool: 'linear',
        contextPaths: ['.'],
        objective: 'Update the existing issue',
      }),
    ).rejects.toMatchObject({
      code: 'AUR-PLAN-009',
    });
  });

  it('accepts an exactly inspected Notion record, stamps discovery, and saves an audit trace', async () => {
    const { workspace, store, capture } = await fixture();
    const current = '2026-07-19T20:30:00.000Z';
    const discovery: DestinationDiscovery = {
      integration: 'notion',
      candidates: [
        {
          id: 'page-product',
          name: 'Aurous Product HQ',
          kind: 'page',
          description: 'Existing Product HQ',
          existingAurousMatch: true,
        },
      ],
      existingObjects: [
        {
          id: 'record-readme',
          name: 'Complete the README',
          type: 'page',
          destinationId: 'page-product',
          url: 'https://notion.so/record-readme',
          parentId: 'data-source-tasks',
        },
      ],
      inspectedAt: '2020-01-01T00:00:00.000Z',
      warnings: [],
    };
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'database-record', name: 'Complete the README', purpose: 'Track completion.' },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'update',
          objectType: 'database-record',
          target: 'Complete the README',
          description: 'Reuse and update the exact existing README task.',
          properties: [],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'The existing README task is updated.',
    };
    const trace: SanitizedDiscoveryTrace = {
      schemaVersion: 1,
      discoveryId: 'discovery-20260719T203000Z-abc123',
      integration: 'notion',
      agent: 'codex',
      startedAt: '2026-07-19T20:29:59.000Z',
      completedAt: current,
      success: true,
      sanitized: true,
      operations: [
        {
          sequence: 1,
          server: 'notion',
          operation: 'notion-fetch',
          purpose: 'Inspect an exact Notion object and its identity or relationships.',
          startedAt: '2026-07-19T20:29:59.000Z',
          completedAt: current,
          success: true,
          returnedObjectIds: ['page-product', 'record-readme'],
        },
      ],
      warnings: [],
    };
    const base = planningAgent(discovery, proposal);
    const agent: AgentAdapter = {
      ...base,
      name: 'codex',
      discoverDestinations: async () => ({
        ...(await base.discoverDestinations!({} as never)),
        discoveryTrace: trace,
      }),
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => agent,
      now: () => new Date(current),
    });

    const plan = await services.plan({
      agent: 'codex',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Update the existing README task in Notion',
    });

    expect(plan.plannedActions[0]?.properties).toContainEqual({
      key: 'notion.dedupe.knownExternalId',
      value: 'record-readme',
    });
    const discoveryRoot = path.join(workspace, '.aurous', 'discovery');
    const [directory] = await readdir(discoveryRoot);
    const normalized = JSON.parse(
      await readFile(
        path.join(discoveryRoot, directory!, 'destination-discover-agent-response.json'),
        'utf8',
      ),
    ) as DestinationDiscovery;
    const savedTrace = JSON.parse(
      await readFile(path.join(discoveryRoot, directory!, 'discovery-trace.json'), 'utf8'),
    ) as SanitizedDiscoveryTrace;
    expect(normalized.inspectedAt).toBe(current);
    expect(savedTrace.operations[0]?.returnedObjectIds).toEqual(['page-product', 'record-readme']);
  });

  it('accepts an Airtable new-base plan with three bootstrap tables and transitive action refs', async () => {
    const { workspace, store, capture } = await fixture();
    const discovery = airtableWorkspaceDiscovery();
    const initialTables = JSON.stringify([
      { name: 'Workstreams', primaryField: { name: 'Workstream', type: 'singleLineText' } },
      { name: 'Tasks', primaryField: { name: 'Task', type: 'singleLineText' } },
      { name: 'Integrations', primaryField: { name: 'Integration', type: 'singleLineText' } },
    ]);
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
        { kind: 'field', name: 'Workstream', purpose: 'Link tasks to workstreams.' },
        { kind: 'record', name: 'Complete README', purpose: 'Track README completion.' },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'create',
          objectType: 'airtable.base',
          target: 'Aurous Build Week HQ',
          description: 'Create the launch base with bootstrap tables.',
          properties: [
            { key: 'airtable.base.name', value: 'Aurous Build Week HQ' },
            { key: 'airtable.base.initialTables', value: initialTables },
          ],
          dependsOn: [],
        },
        {
          id: 'action-002',
          operation: 'create',
          objectType: 'airtable.field',
          target: 'Workstream',
          description: 'Add the Workstream linked-record field on Tasks.',
          properties: [
            { key: 'airtable.baseActionId', value: 'action-001' },
            { key: 'airtable.bootstrapTableName', value: 'Tasks' },
            { key: 'airtable.linkedBootstrapTableName', value: 'Workstreams' },
            { key: 'airtable.field.name', value: 'Workstream' },
          ],
          dependsOn: ['action-001'],
        },
        {
          id: 'action-003',
          operation: 'create',
          objectType: 'airtable.records',
          target: 'Complete README',
          description: 'Seed the README task after the Workstream field exists.',
          properties: [
            { key: 'airtable.baseActionId', value: 'action-001' },
            { key: 'airtable.bootstrapTableName', value: 'Tasks' },
            {
              key: 'airtable.records',
              value: JSON.stringify([
                { Task: 'Complete README', Workstream: 'Launch deliverables' },
              ]),
            },
          ],
          dependsOn: ['action-002'],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Airtable launch base is ready.',
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => planningAgent(discovery, proposal),
    });

    const plan = await services.plan({
      agent: 'mock',
      tool: 'airtable',
      contextPaths: ['.'],
      objective: 'Set up Airtable for README completion without duplicates.',
    });

    const bootstrap = JSON.parse(
      plan.plannedActions[0]?.properties.find(
        (property) => property.key === 'airtable.base.initialTables',
      )?.value ?? '[]',
    ) as Array<{ name: string }>;
    expect(bootstrap.map((table) => table.name)).toEqual(['Workstreams', 'Tasks', 'Integrations']);
    expect(plan.plannedActions[2]?.dependsOn).toEqual(['action-002']);
    expect(
      plan.plannedActions[2]?.properties.some(
        (property) => property.key === 'airtable.baseActionId' && property.value === 'action-001',
      ),
    ).toBe(true);
  });

  it('rejects Airtable plans that omit bootstrap tables, create them later, or break action refs', async () => {
    const { workspace, store, capture } = await fixture();
    const discovery = airtableWorkspaceDiscovery();

    await expect(
      planAirtable(
        workspace,
        store,
        capture.output,
        discovery,
        {
          proposedWorkspaceStructure: [
            { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
          ],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'create',
              objectType: 'base',
              target: 'Aurous Build Week HQ',
              description: 'Create an empty base.',
              properties: [{ key: 'airtable.base.name', value: 'Aurous Build Week HQ' }],
              dependsOn: [],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Base created.',
        },
        'Set up Airtable for this project',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-013' });

    await expect(
      planAirtable(
        workspace,
        store,
        capture.output,
        discovery,
        {
          proposedWorkspaceStructure: [
            { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
            { kind: 'table', name: 'Workstreams', purpose: 'Track workstreams.' },
          ],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'create',
              objectType: 'base',
              target: 'Aurous Build Week HQ',
              description: 'Create the base with bootstrap tables.',
              properties: [
                {
                  key: 'airtable.base.initialTables',
                  value: JSON.stringify([
                    {
                      name: 'Workstreams',
                      primaryField: { name: 'Workstream', type: 'singleLineText' },
                    },
                  ]),
                },
              ],
              dependsOn: [],
            },
            {
              id: 'action-002',
              operation: 'create',
              objectType: 'table',
              target: 'Workstreams',
              description: 'Create Workstreams after the base.',
              properties: [{ key: 'airtable.baseActionId', value: 'action-001' }],
              dependsOn: ['action-001'],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Base and table created.',
        },
        'Set up Airtable for this project',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-014' });

    await expect(
      planAirtable(
        workspace,
        store,
        capture.output,
        discovery,
        {
          proposedWorkspaceStructure: [
            { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
            { kind: 'field', name: 'Readiness', purpose: 'Track readiness.' },
          ],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'create',
              objectType: 'base',
              target: 'Aurous Build Week HQ',
              description: 'Create the base with bootstrap tables.',
              properties: [
                {
                  key: 'airtable.base.initialTables',
                  value: JSON.stringify([
                    {
                      name: 'Workstreams',
                      primaryField: { name: 'Workstream', type: 'singleLineText' },
                    },
                    { name: 'Tasks', primaryField: { name: 'Task', type: 'singleLineText' } },
                    {
                      name: 'Integrations',
                      primaryField: { name: 'Integration', type: 'singleLineText' },
                    },
                  ]),
                },
              ],
              dependsOn: [],
            },
            {
              id: 'action-002',
              operation: 'create',
              objectType: 'field',
              target: 'Readiness',
              description: 'Add Readiness on a fabricated table.',
              properties: [
                { key: 'airtable.baseActionId', value: 'action-001' },
                { key: 'airtable.bootstrapTableName', value: 'Phantom' },
              ],
              dependsOn: ['action-001'],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Invalid bootstrap reference.',
        },
        'Set up Airtable for this project',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-015' });

    await expect(
      planAirtable(
        workspace,
        store,
        capture.output,
        discovery,
        {
          proposedWorkspaceStructure: [
            { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
            { kind: 'field', name: 'Readiness', purpose: 'Track readiness.' },
          ],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'create',
              objectType: 'base',
              target: 'Aurous Build Week HQ',
              description: 'Create the base with bootstrap tables.',
              properties: [
                {
                  key: 'airtable.base.initialTables',
                  value: JSON.stringify([
                    {
                      name: 'Integrations',
                      primaryField: { name: 'Integration', type: 'singleLineText' },
                    },
                  ]),
                },
              ],
              dependsOn: [],
            },
            {
              id: 'action-002',
              operation: 'create',
              objectType: 'field',
              target: 'Readiness',
              description: 'Add Readiness without depending on the base action.',
              properties: [
                { key: 'airtable.baseActionId', value: 'action-001' },
                { key: 'airtable.bootstrapTableName', value: 'Integrations' },
              ],
              dependsOn: [],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Missing transitive dependency.',
        },
        'Set up Airtable for this project',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-012' });
  });

  it('binds exact Airtable reuse IDs from a sanitized discovery snapshot of the live base', async () => {
    const { workspace, store, capture } = await fixture();
    const discovery: DestinationDiscovery = {
      integration: 'airtable',
      candidates: [
        {
          id: 'wsphk1OmoSFXlTmwM',
          name: 'My First Workspace',
          kind: 'workspace',
          description: 'Owner-accessible Airtable workspace.',
          existingAurousMatch: true,
        },
      ],
      existingObjects: [
        {
          id: 'apptXzRq0zEfjhz4X',
          name: 'Aurous Build Week HQ',
          type: 'airtable.base',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'wsphk1OmoSFXlTmwM',
        },
        {
          id: 'tblxpUvoq8TfoFUKW',
          name: 'Workstreams',
          type: 'airtable.table',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'apptXzRq0zEfjhz4X',
        },
        {
          id: 'tbl2II3FoagbaK7bn',
          name: 'Tasks',
          type: 'airtable.table',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'apptXzRq0zEfjhz4X',
        },
        {
          id: 'tblzDn026xkRMGanS',
          name: 'Integrations',
          type: 'airtable.table',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'apptXzRq0zEfjhz4X',
        },
        {
          id: 'fldwFFJ3qjePsyQQm',
          name: 'Readiness',
          type: 'airtable.field',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'tblzDn026xkRMGanS',
        },
        {
          id: 'recAELdj1f2Fnp5gM',
          name: 'Complete README',
          type: 'airtable.record',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'tbl2II3FoagbaK7bn',
        },
      ],
      inspectedAt: '2026-07-20T03:12:58.481Z',
      warnings: [
        'An exact existing base named "Aurous Build Week HQ" was inspected and already contains exactly the requested Workstreams, Tasks, and Integrations tables.',
        'Another accessible base named "Untitled Base" exists; it is not a project match and should not be repurposed for this launch.',
      ],
    };
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
        { kind: 'table', name: 'Workstreams', purpose: 'Track workstreams.' },
        { kind: 'table', name: 'Tasks', purpose: 'Track tasks.' },
        { kind: 'table', name: 'Integrations', purpose: 'Track integrations.' },
        { kind: 'field', name: 'Readiness', purpose: 'Track readiness.' },
        { kind: 'record', name: 'Complete README', purpose: 'Track README.' },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'create',
          objectType: 'base',
          target: 'Aurous Build Week HQ',
          description: 'Create the launch base.',
          properties: [],
          dependsOn: [],
        },
        {
          id: 'action-002',
          operation: 'create',
          objectType: 'table',
          target: 'Workstreams',
          description: 'Create Workstreams.',
          properties: [],
          dependsOn: [],
        },
        {
          id: 'action-003',
          operation: 'create',
          objectType: 'table',
          target: 'Tasks',
          description: 'Create Tasks.',
          properties: [],
          dependsOn: [],
        },
        {
          id: 'action-004',
          operation: 'create',
          objectType: 'table',
          target: 'Integrations',
          description: 'Create Integrations.',
          properties: [],
          dependsOn: [],
        },
        {
          id: 'action-005',
          operation: 'create',
          objectType: 'field',
          target: 'Readiness',
          description: 'Create Readiness.',
          properties: [],
          dependsOn: [],
        },
        {
          id: 'action-006',
          operation: 'create',
          objectType: 'records',
          target: 'Complete README',
          description: 'Create the README task.',
          properties: [],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Existing objects are reused by exact ID.',
    };
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => planningAgent(discovery, proposal),
    });

    const plan = await services.plan({
      agent: 'mock',
      tool: 'airtable',
      contextPaths: ['.'],
      objective: 'Set up Airtable for README completion without duplicates.',
    });

    expect(
      plan.plannedActions.map(
        (action) =>
          action.properties.find((property) => property.key === 'airtable.dedupe.knownExternalId')
            ?.value,
      ),
    ).toEqual([
      'apptXzRq0zEfjhz4X',
      'tblxpUvoq8TfoFUKW',
      'tbl2II3FoagbaK7bn',
      'tblzDn026xkRMGanS',
      'fldwFFJ3qjePsyQQm',
      'recAELdj1f2Fnp5gM',
    ]);
    expect(plan.plannedActions.every((action) => action.description.startsWith('Reuse'))).toBe(
      true,
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Untitled Base')]),
    );
  });
});

function airtableWorkspaceDiscovery(): DestinationDiscovery {
  return {
    integration: 'airtable',
    candidates: [
      {
        id: 'wsphk1OmoSFXlTmwM',
        name: 'My First Workspace',
        kind: 'workspace',
        description: 'Owner-accessible Airtable workspace.',
        existingAurousMatch: false,
      },
    ],
    existingObjects: [],
    inspectedAt: '2026-07-20T03:00:00.000Z',
    warnings: [],
  };
}

async function planAirtable(
  workspace: string,
  store: LocalRunStore,
  output: Output,
  discovery: DestinationDiscovery,
  proposal: PlanProposal,
  objective: string,
) {
  const services = new AurousServices({
    workspace,
    store,
    output,
    agentFactory: () => planningAgent(discovery, proposal),
  });
  return services.plan({
    agent: 'mock',
    tool: 'airtable',
    contextPaths: ['.'],
    objective,
  });
}

function linearIssue(id: string, target: string, description: string) {
  return {
    id,
    operation: 'create' as const,
    objectType: 'issue',
    target,
    description,
    properties: [
      { key: 'linear.project', value: 'Aurous — Build Week Launch' },
      { key: 'linear.priority', value: '2' },
    ],
    dependsOn: [],
  };
}

function planningAgent(discovery: DestinationDiscovery, proposal: PlanProposal): AgentAdapter {
  const mock = new MockAgentAdapter();
  return {
    name: 'mock',
    diagnose: () => mock.diagnose(),
    discoverDestinations: () =>
      Promise.resolve({
        value: discovery,
        command: ['test-discovery'],
        stdout: JSON.stringify(discovery),
        stderr: '',
        durationMs: 1,
      }),
    generatePlan: () =>
      Promise.resolve({
        value: proposal,
        command: ['test-plan'],
        stdout: JSON.stringify(proposal),
        stderr: '',
        durationMs: 1,
      }),
    executePlan: (input) => mock.executePlan(input),
    inspectRecovery: (input) => mock.inspectRecovery(input),
    executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
    manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
  };
}
