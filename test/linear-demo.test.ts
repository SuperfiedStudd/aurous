import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { LinearAdapter } from '../src/adapters/productivity/linear.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import { LinearDemoContextSchema, buildLinearDemoPlan } from '../src/domain/linear-demo.js';
import type { ContextBundle } from '../src/domain/schemas.js';

const presetPath = new URL('../demo/linear-build-week.json', import.meta.url);

describe('Linear demo planning', () => {
  it('turns the structured preset into a deterministic explicit Linear plan', async () => {
    const content = await readFile(presetPath, 'utf8');
    const preset = LinearDemoContextSchema.parse(JSON.parse(content));
    const context: ContextBundle = {
      summary: {
        approvedPaths: ['/demo/linear-build-week.json'],
        files: [
          {
            path: '/demo/linear-build-week.json',
            relativePath: 'linear-build-week.json',
            bytes: Buffer.byteLength(content),
            category: 'configuration',
          },
        ],
        fileCount: 1,
        totalBytes: Buffer.byteLength(content),
        skipped: [],
      },
      documents: [
        { path: '/demo/linear-build-week.json', relativePath: 'linear-build-week.json', content },
      ],
    };
    const input = {
      runId: 'run-20260719T120000Z-abcdef',
      createdAt: '2026-07-19T12:00:00.000Z',
      agent: 'codex' as const,
      team: 'JasjyotSingh',
      teamId: 'team-jasjyotsingh-exact-id',
      context,
      preset,
    };

    const first = buildLinearDemoPlan(input);
    const second = buildLinearDemoPlan(input);

    expect(first.plannedActions).toEqual(second.plannedActions);
    expect(first.plannedActions).toHaveLength(11);
    expect(first.plannedActions.map((action) => action.objectType)).toEqual([
      'project',
      'label',
      'label',
      'milestone',
      'milestone',
      'issue',
      'issue',
      'issue',
      'issue',
      'issue',
      'issue',
    ]);
    expect(first.plannedActions[5]).toMatchObject({
      id: 'action-006',
      target: 'Lock the Linear demo contract',
      dependsOn: ['action-001', 'action-002', 'action-004'],
    });
    expect(first.plannedActions[5]?.properties).toContainEqual({
      key: 'linear.state',
      value: 'In Progress',
    });
    const executionContract = new LinearAdapter().executionInstructions(first);
    expect(executionContract).toContain('call list_issue_labels once');
    expect(executionContract).toContain('locate each known label by its exact ID');
  });

  it('saves the previewed plan and attempts no write when approval is declined', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-linear-demo-'));
    const preset = await readFile(presetPath, 'utf8');
    await writeFile(path.join(workspace, 'linear-demo.json'), preset);
    const lines: string[] = [];
    const output: Output = {
      log(message = '') {
        lines.push(message);
      },
      error(message) {
        lines.push(message);
      },
    };
    const store = new LocalRunStore(workspace);
    const services = new AurousServices({ workspace, store, output });
    await services.init({ defaultAgent: 'mock', defaultTool: 'linear' });

    const plan = await services.planLinearDemo({
      contextPaths: ['linear-demo.json'],
    });
    const result = await services.apply(plan.runId, {
      confirmed: false,
      alreadyPreviewed: true,
      confirm: () => Promise.resolve(false),
    });

    expect(result).toBeUndefined();
    expect((await store.getRun(plan.runId)).status).toBe('planned');
    expect(await store.loadResult(plan.runId)).toBeUndefined();
    expect(lines.join('\n')).toContain('linear.project: Aurous — Build Week Launch');
    expect(lines.join('\n')).toContain('Apply cancelled. No external writes were attempted.');
  });

  it('records missing Linear URLs as explicit compatibility notes', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-linear-result-'));
    await writeFile(path.join(workspace, 'linear-demo.json'), await readFile(presetPath, 'utf8'));
    const output: Output = { log() {}, error() {} };
    const store = new LocalRunStore(workspace);
    const planning = new AurousServices({ workspace, store, output });
    await planning.init({ defaultAgent: 'mock', defaultTool: 'linear' });
    const plan = await planning.planLinearDemo({
      contextPaths: ['linear-demo.json'],
    });
    const mock = new MockAgentAdapter();
    const noLabelUrl: AgentAdapter = {
      ...mock,
      name: 'mock',
      diagnose: () => mock.diagnose(),
      generatePlan: (input) => mock.generatePlan(input),
      inspectRecovery: (input) => mock.inspectRecovery(input),
      executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
      manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
      executePlan: () =>
        Promise.resolve({
          value: {
            status: 'succeeded',
            summary: 'One label created.',
            createdObjects: [
              {
                actionId: 'action-002',
                type: 'label',
                name: 'Aurous: Integration',
                externalId: 'label-id',
              },
            ],
            skippedActions: [],
            completedActionIds: ['action-002'],
            compatibilityNotes: [],
            warnings: [],
            failures: [],
            startedAt: '2026-07-19T12:00:00.000Z',
            finishedAt: '2026-07-19T12:00:01.000Z',
          },
          command: ['mock-linear-result'],
          stdout: '{}',
          stderr: '',
          durationMs: 1,
        }),
    };
    const applying = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => noLabelUrl,
    });

    const result = await applying.apply(plan.runId, { confirmed: true });

    expect(result?.compatibilityNotes).toEqual([
      'Official Linear MCP returned no standalone URL for label "Aurous: Integration"; its exact ID was preserved.',
    ]);
  });

  it('carries exact IDs from a compatible successful run into the next preview', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-linear-replay-'));
    await writeFile(path.join(workspace, 'linear-demo.json'), await readFile(presetPath, 'utf8'));
    const output: Output = { log() {}, error() {} };
    const store = new LocalRunStore(workspace);
    const services = new AurousServices({ workspace, store, output });
    await services.init({ defaultAgent: 'mock', defaultTool: 'linear' });
    const first = await services.planLinearDemo({
      contextPaths: ['linear-demo.json'],
    });
    await services.apply(first.runId, { confirmed: true });

    const repeat = await services.planLinearDemo({
      contextPaths: ['linear-demo.json'],
    });

    expect(
      repeat.plannedActions.filter((action) =>
        action.properties.some((property) => property.key === 'linear.dedupe.knownExternalId'),
      ),
    ).toHaveLength(11);
    expect(repeat.plannedActions[5]?.properties).toContainEqual({
      key: 'linear.dedupe.knownExternalId',
      value: 'mock-action-006',
    });
    expect(repeat.assumptions.join('\n')).toContain('Exact external IDs');
  });
});
