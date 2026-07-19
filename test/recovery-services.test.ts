import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type {
  AurousPlan,
  ContextBundle,
  ExecutionResult,
  RunRecord,
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-recovery-service-'));
  await writeFile(path.join(workspace, 'README.md'), '# Recovery fixture\n');
  const store = new LocalRunStore(workspace);
  const capture = captureOutput();
  const services = new AurousServices({ workspace, store, output: capture.output });
  await services.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  const plan = await services.plan({ contextPaths: ['.'], objective: 'Create a workspace' });
  const timestamp = '2026-07-19T01:26:38.000Z';
  const partial: ExecutionResult = {
    status: 'partial',
    summary: 'Interrupted after the root page.',
    createdObjects: [
      {
        actionId: 'action-001',
        type: 'page',
        name: 'Project Command Center',
        externalId: 'persisted-root-id',
        url: 'https://mock.aurous.local/persisted-root-id',
      },
    ],
    completedActionIds: ['action-001'],
    warnings: [],
    failures: [],
    startedAt: timestamp,
    finishedAt: timestamp,
  };
  await store.saveResult(plan.runId, partial);
  await store.updateStatus(plan.runId, 'partial');
  capture.lines.length = 0;
  return { workspace, store, capture, services, originalRunId: plan.runId };
}

async function capturedActionFixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-captured-action-'));
  const store = new LocalRunStore(workspace);
  const capture = captureOutput();
  await store.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  const originalRunId = 'run-20260719T012638Z-cefb7b';
  const timestamp = '2026-07-19T01:26:38.000Z';
  const context: ContextBundle = {
    summary: {
      approvedPaths: [workspace],
      files: [],
      fileCount: 0,
      totalBytes: 0,
      skipped: [],
    },
    documents: [],
  };
  const record: RunRecord = {
    runId: originalRunId,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'partial',
    agent: 'mock',
    tool: 'notion',
    objective: 'Create the captured Notion workspace.',
    approvedContextPaths: [workspace],
    runKind: 'standard',
  };
  const plan: AurousPlan = {
    schemaVersion: 1,
    runId: originalRunId,
    createdAt: timestamp,
    agent: 'mock',
    tool: 'notion',
    objective: record.objective,
    contextSummary: context.summary,
    proposedWorkspaceStructure: [
      { kind: 'page', name: 'Project HQ', purpose: 'Root workspace.' },
      { kind: 'page', name: 'Project Overview', purpose: 'Project overview.' },
      { kind: 'database', name: 'Milestone Tracker', purpose: 'Track milestones.' },
      { kind: 'database', name: 'Action Register', purpose: 'Track actions.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'page',
        target: 'Project HQ',
        description: 'Create the root page.',
        properties: [],
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'page',
        target: 'Project Overview',
        description: 'Create the overview page.',
        properties: [{ key: 'notion.parent', value: 'Project HQ' }],
        dependsOn: ['action-001'],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'database',
        target: 'Milestone Tracker',
        description: 'Create a milestone database with the approved workflow.',
        properties: [
          { key: 'notion.parent', value: 'Project HQ' },
          {
            key: 'notion.database.properties',
            value: JSON.stringify([
              { name: 'Milestone', type: 'title' },
              { name: 'Status', type: 'status' },
            ]),
          },
          {
            key: 'notion.database.statuses',
            value: JSON.stringify([
              { name: 'Not started' },
              { name: 'In progress' },
              { name: 'Done' },
            ]),
          },
        ],
        dependsOn: ['action-001'],
      },
      {
        id: 'action-004',
        operation: 'create',
        objectType: 'database',
        target: 'Action Register',
        description: 'Create the action register.',
        properties: [
          { key: 'notion.parent', value: 'Project HQ' },
          {
            key: 'notion.database.properties',
            value: JSON.stringify([{ name: 'Action', type: 'title' }]),
          },
        ],
        dependsOn: ['action-003'],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'A linked project workspace with milestone and action databases.',
  };
  const partial: ExecutionResult = {
    status: 'partial',
    summary: 'Four exact object identities were persisted before completion.',
    createdObjects: [
      {
        actionId: 'action-001',
        type: 'page',
        name: 'Project HQ',
        externalId: '11111111-1111-4111-8111-111111111111',
        url: 'https://app.notion.com/p/11111111111141118111111111111111',
      },
      {
        actionId: 'action-002',
        type: 'page',
        name: 'Project Overview',
        externalId: '22222222-2222-4222-8222-222222222222',
        url: 'https://app.notion.com/p/22222222222242228222222222222222',
      },
      {
        actionId: 'action-003',
        type: 'database',
        name: 'Milestone Tracker',
        externalId: '7f965334-0f81-4d4c-966b-6b3d9d969fa2',
        url: 'https://app.notion.com/p/7f9653340f814d4c966b6b3d9d969fa2',
      },
      {
        actionId: 'action-004',
        type: 'database',
        name: 'Action Register',
        externalId: '44444444-4444-4444-8444-444444444444',
        url: 'https://app.notion.com/p/44444444444444448444444444444444',
      },
    ],
    completedActionIds: ['action-001', 'action-002'],
    warnings: [],
    failures: [],
    startedAt: timestamp,
    finishedAt: timestamp,
  };
  await store.createRun(record, context);
  await store.savePlan(plan);
  await store.saveResult(originalRunId, partial);
  return { workspace, store, capture, originalRunId };
}

function agentWith(
  overrides: Partial<Pick<AgentAdapter, 'inspectRecovery' | 'executeRecoveryAction'>> = {},
): AgentAdapter {
  const mock = new MockAgentAdapter();
  return {
    name: 'mock',
    diagnose: () => mock.diagnose(),
    generatePlan: (input) => mock.generatePlan(input),
    executePlan: (input) => mock.executePlan(input),
    inspectRecovery: overrides.inspectRecovery ?? ((input) => mock.inspectRecovery(input)),
    executeRecoveryAction:
      overrides.executeRecoveryAction ?? ((input) => mock.executeRecoveryAction(input)),
    manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
  };
}

describe('AurousServices recovery flow', () => {
  it('persists recovery linkage and does not write when confirmation is declined', async () => {
    const { workspace, store, capture, originalRunId } = await fixture();
    let executionCalls = 0;
    const adapter = agentWith({
      executeRecoveryAction: async (input) => {
        executionCalls += 1;
        return new MockAgentAdapter().executeRecoveryAction(input);
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
    });
    const recovery = await services.recover(originalRunId);
    const record = await store.getRun(recovery.recoveryRunId);
    expect(record).toMatchObject({
      runKind: 'recovery',
      recoveryOf: originalRunId,
      status: 'recovery-planned',
    });
    expect((await store.loadRecoveryPlan(recovery.recoveryRunId)).originalRunId).toBe(
      originalRunId,
    );

    const result = await services.applyRecovery(recovery.recoveryRunId, {
      confirm: () => Promise.resolve(false),
    });
    expect(result).toBeUndefined();
    expect(executionCalls).toBe(0);
    expect((await store.getRun(recovery.recoveryRunId)).status).toBe('recovery-planned');
    expect(capture.lines.join('\n')).toContain('No external writes were attempted');
  });

  it('checkpoints each approved recovery action and never replays completed work', async () => {
    const { services, store, originalRunId } = await fixture();
    const recovery = await services.recover(originalRunId);
    const result = await services.applyRecovery(recovery.recoveryRunId, {
      confirm: () => Promise.resolve(true),
    });
    expect(result?.status).toBe('succeeded');
    expect(result?.completedActionIds).not.toContain('action-001');
    expect(result?.completedActionIds).toEqual(recovery.plannedActions.map((action) => action.id));
    const checkpoints = await store.readRecoveryCheckpoints(recovery.recoveryRunId);
    expect(checkpoints.filter((item) => item.source === 'action-result')).toHaveLength(
      recovery.plannedActions.length,
    );
    expect(checkpoints.find((item) => item.actionId === 'action-001')?.externalId).toBe(
      'persisted-root-id',
    );
    expect((await store.getRun(recovery.recoveryRunId)).status).toBe('succeeded');
  });

  it('fails closed with a redacted semantic diff before any recovery write on material drift', async () => {
    const { workspace, store, capture, originalRunId } = await fixture();
    const mock = new MockAgentAdapter();
    let inspections = 0;
    let executionCalls = 0;
    const adapter = agentWith({
      inspectRecovery: async (input) => {
        const inspection = await mock.inspectRecovery(input);
        inspections += 1;
        if (inspections === 2) {
          return {
            ...inspection,
            value: {
              ...inspection.value,
              objects: inspection.value.objects.map((object) => ({
                ...object,
                title: `${object.title} renamed`,
              })),
            },
          };
        }
        return inspection;
      },
      executeRecoveryAction: async (input) => {
        executionCalls += 1;
        return mock.executeRecoveryAction(input);
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
    });
    const recovery = await services.recover(originalRunId);

    await expect(
      services.applyRecovery(recovery.recoveryRunId, { confirm: () => Promise.resolve(true) }),
    ).rejects.toMatchObject({ code: 'AUR-RECOVERY-011' });

    expect(executionCalls).toBe(0);
    expect((await store.getRun(recovery.recoveryRunId)).status).toBe('failed');
    expect((await store.loadResult(recovery.recoveryRunId))?.status).toBe('failed');
    const event = (await store.readEvents(recovery.recoveryRunId)).find(
      (candidate) => candidate.code === 'AUR-RECOVERY-011',
    );
    expect(event?.metadata.originalRunId).toBe(originalRunId);
    const semanticDiff = event?.metadata.semanticDiff;
    if (!Array.isArray(semanticDiff)) throw new Error('Expected a machine-readable semantic diff.');
    expect(semanticDiff).toContainEqual({
      path: '$.objects[0].title',
      expected: 'Project Command Center',
      actual: 'Project Command Center renamed',
    });
  });

  it('fails closed before any recovery write when the filter state stays unknown', async () => {
    const { workspace, store, capture, originalRunId } = await fixture();
    const mock = new MockAgentAdapter();
    let executionCalls = 0;
    const adapter = agentWith({
      inspectRecovery: async (input) => {
        const inspection = await mock.inspectRecovery(input);
        return {
          ...inspection,
          value: {
            ...inspection.value,
            objects: inspection.value.objects.map((object, index) =>
              index === 0
                ? {
                    ...object,
                    views: [
                      {
                        name: 'Uncertain view',
                        type: 'table',
                        filterState: {
                          kind: 'unknown' as const,
                          conditionCount: null,
                          fingerprint: null,
                        },
                      },
                    ],
                  }
                : object,
            ),
          },
        };
      },
      executeRecoveryAction: async (input) => {
        executionCalls += 1;
        return mock.executeRecoveryAction(input);
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
    });
    const recovery = await services.recover(originalRunId);

    await expect(
      services.applyRecovery(recovery.recoveryRunId, {
        confirm: () => Promise.resolve(true),
      }),
    ).rejects.toMatchObject({ code: 'AUR-RECOVERY-011' });

    expect(executionCalls).toBe(0);
    const event = (await store.readEvents(recovery.recoveryRunId)).find(
      (candidate) => candidate.code === 'AUR-RECOVERY-011',
    );
    expect(event?.metadata.semanticDiff).toContainEqual(
      expect.objectContaining({ path: '$.objects[0].views[0].filterState' }),
    );
  });

  it('stops after a partial recovery action and executes no subsequent actions', async () => {
    const { workspace, store, capture, originalRunId } = await fixture();
    let executionCalls = 0;
    const adapter = agentWith({
      executeRecoveryAction: (input) => {
        executionCalls += 1;
        const now = new Date().toISOString();
        return Promise.resolve({
          value: {
            status: 'partial',
            summary: 'The first action could not be checkpointed.',
            createdObjects: [],
            completedActionIds: [],
            warnings: [],
            failures: [
              {
                actionId: input.action.id,
                code: 'AUR-MCP-123',
                summary: 'Simulated partial action.',
                probableCause: 'Test fixture.',
                nextAction: 'Inspect before retrying.',
                severity: 'recoverable',
              },
            ],
            startedAt: now,
            finishedAt: now,
          },
          command: ['partial-recovery-agent'],
          stdout: '{}',
          stderr: '',
          durationMs: 1,
        });
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
    });
    const recovery = await services.recover(originalRunId);
    const result = await services.applyRecovery(recovery.recoveryRunId, {
      confirm: () => Promise.resolve(true),
    });
    expect(result?.status).toBe('partial');
    expect(executionCalls).toBe(1);
    expect((await store.getRun(recovery.recoveryRunId)).status).toBe('partial');
    expect(result?.failures).toContainEqual(expect.objectContaining({ code: 'AUR-MCP-123' }));
    expect(
      (await store.readEvents(recovery.recoveryRunId)).some(
        (event) => event.code === 'AUR-AGENT-005',
      ),
    ).toBe(false);
  });

  it('contains the captured action-003 malformed code without retrying an ambiguous write', async () => {
    const { workspace, store, capture, originalRunId } = await capturedActionFixture();
    const captured = JSON.parse(
      await readFile(
        new URL('./fixtures/recovery-action-003-malformed.json', import.meta.url),
        'utf8',
      ),
    ) as ExecutionResult;
    const executedActionIds: string[] = [];
    const adapter = agentWith({
      executeRecoveryAction: (input) => {
        executedActionIds.push(input.action.id);
        return Promise.resolve({
          value: captured,
          command: ['captured-recovery-agent'],
          stdout: JSON.stringify(captured),
          stderr: '',
          durationMs: 1,
        });
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
    });
    const recovery = await services.recover(originalRunId);
    expect(recovery.plannedActions.map((action) => action.id)).toEqual([
      'action-003',
      'action-004',
    ]);

    const result = await services.applyRecovery(recovery.recoveryRunId, {
      confirm: () => Promise.resolve(true),
    });

    expect(executedActionIds).toEqual(['action-003']);
    expect(result).toMatchObject({
      status: 'partial',
      completedActionIds: [],
      failures: [{ actionId: 'action-003', code: 'AUR-AGENT-005' }],
    });
    expect(JSON.stringify(result)).not.toContain('AUR-RECOVERY-CANCELLED');
    expect(JSON.stringify(result)).not.toContain('AUR-CORE-001');
    expect(result?.summary).toContain('write completion remains ambiguous');
    expect((await store.getRun(recovery.recoveryRunId)).status).toBe('partial');
    expect(await store.loadResult(recovery.recoveryRunId)).toMatchObject({
      status: 'partial',
      failures: [{ actionId: 'action-003', code: 'AUR-AGENT-005' }],
    });

    const boundaryEvent = (await store.readEvents(recovery.recoveryRunId)).find(
      (event) => event.code === 'AUR-AGENT-005',
    );
    expect(boundaryEvent).toMatchObject({
      metadata: {
        actionId: 'action-003',
        rawValidationPath: ['failures', 0, 'code'],
        canonicalCode: 'AUR-AGENT-005',
        originalMalformedCode: 'AUR-RECOVERY-CANCELLED',
        ambiguousWrite: true,
      },
    });
    const checkpoints = await store.readRecoveryCheckpoints(recovery.recoveryRunId);
    expect(checkpoints).toContainEqual(
      expect.objectContaining({
        actionId: 'action-003',
        externalId: '7f965334-0f81-4d4c-966b-6b3d9d969fa2',
        source: 'action-result',
      }),
    );
    const log = await readFile(
      path.join(
        store.runDirectory(recovery.recoveryRunId),
        'logs',
        'recovery-action-action-003.json',
      ),
      'utf8',
    );
    expect(log).toContain('[REDACTED_MALFORMED_AUR_CODE]');
    expect(log).not.toContain('AUR-RECOVERY-CANCELLED');
  });

  it('fails closed on a genuinely invalid action result and executes no later action', async () => {
    const { workspace, store, capture, originalRunId } = await capturedActionFixture();
    const executedActionIds: string[] = [];
    const adapter = agentWith({
      executeRecoveryAction: (input) => {
        executedActionIds.push(input.action.id);
        return Promise.resolve({
          value: { status: 'succeeded' } as ExecutionResult,
          command: ['invalid-recovery-agent'],
          stdout: '{"status":"succeeded"}',
          stderr: '',
          durationMs: 1,
        });
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
    });
    const recovery = await services.recover(originalRunId);

    await expect(
      services.applyRecovery(recovery.recoveryRunId, {
        confirm: () => Promise.resolve(true),
      }),
    ).rejects.toMatchObject({ code: 'AUR-AGENT-005' });
    expect(executedActionIds).toEqual(['action-003']);
    expect((await store.getRun(recovery.recoveryRunId)).status).toBe('partial');
    expect(await store.loadResult(recovery.recoveryRunId)).toMatchObject({
      status: 'partial',
      failures: [{ code: 'AUR-AGENT-005' }],
    });
    expect(await store.readRecoveryCheckpoints(recovery.recoveryRunId)).not.toContainEqual(
      expect.objectContaining({ source: 'action-result' }),
    );
  });

  it('records cancellation before the first recovery action without invoking a write', async () => {
    const { workspace, store, capture, originalRunId } = await fixture();
    let executionCalls = 0;
    const adapter = agentWith({
      executeRecoveryAction: async (input) => {
        executionCalls += 1;
        return new MockAgentAdapter().executeRecoveryAction(input);
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
    });
    const recovery = await services.recover(originalRunId);
    const controller = new AbortController();
    controller.abort();
    await expect(
      services.applyRecovery(recovery.recoveryRunId, {
        confirm: () => Promise.resolve(true),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'AUR-AGENT-007' });
    expect(executionCalls).toBe(0);
    expect((await store.getRun(recovery.recoveryRunId)).status).toBe('cancelled');
  });

  it('emits a heartbeat while a read-only recovery inspection is still running', async () => {
    const { workspace, store, capture, originalRunId } = await fixture();
    const mock = new MockAgentAdapter();
    const adapter = agentWith({
      inspectRecovery: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return mock.inspectRecovery(input);
      },
    });
    const services = new AurousServices({
      workspace,
      store,
      output: capture.output,
      agentFactory: () => adapter,
      progressIntervalMs: 5,
    });
    await services.recover(originalRunId);
    expect(capture.lines.join('\n')).toContain(
      'Agent invocation in progress: read-only recovery inspection',
    );
  });
});
