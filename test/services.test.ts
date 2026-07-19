import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { commandFailure } from '../src/adapters/agents/helpers.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';

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
  const capture = captureOutput();
  const store = new LocalRunStore(workspace);
  const services = new AurousServices({ workspace, store, output: capture.output });
  await services.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  return { workspace, capture, store, services };
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
});
