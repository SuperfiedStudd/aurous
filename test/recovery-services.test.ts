import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { ExecutionResult } from '../src/domain/schemas.js';

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
