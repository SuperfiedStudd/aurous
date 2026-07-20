import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import {
  assertLinearAuthorizationId,
  normalizeLinearExecutionIdentities,
  resolveLinearIssueIdentity,
} from '../src/adapters/productivity/linear-identity.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { ExecutionResult, PlanProposal } from '../src/domain/schemas.js';

const teamId = 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b';
const projectId = '58f32b14-0b3d-4da3-8b41-91280ad54a8e';
const issueUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const issueKey = 'JAS-19';
const issueTitle = 'Aurous Smoke 20260720T201226Z Add CSV bank-statement import';

describe('Linear live UUID identity persistence', () => {
  it('persists UUID and key separately from a live-style create response', () => {
    const result = normalizeLinearExecutionIdentities(
      executionResult([
        {
          actionId: 'action-001',
          type: 'Linear issue',
          name: issueTitle,
          externalId: issueUuid,
          identifier: issueKey,
          url: `https://linear.app/team/issue/${issueKey}/csv-import`,
        },
      ]),
    );

    expect(result.createdObjects[0]).toMatchObject({
      externalId: issueUuid,
      identifier: issueKey,
    });
    expect(result.createdObjects[0]?.externalId).not.toBe(issueKey);
  });

  it('resolves a key-only create response via exactly one read-only UUID lookup', () => {
    const resolved = resolveLinearIssueIdentity({
      externalId: issueKey,
      name: issueTitle,
      lookupMatches: [
        {
          id: issueUuid,
          identifier: issueKey,
          name: issueTitle,
          url: `https://linear.app/team/issue/${issueKey}/csv-import`,
        },
      ],
    });

    expect(resolved).toEqual({
      externalId: issueUuid,
      identifier: issueKey,
      url: `https://linear.app/team/issue/${issueKey}/csv-import`,
    });
  });

  it('fails safely when key-only lookup returns zero or multiple UUID matches', () => {
    expect(() =>
      resolveLinearIssueIdentity({
        externalId: issueKey,
        lookupMatches: [],
      }),
    ).toThrow(/could not be resolved to exactly one immutable UUID/);

    expect(() =>
      resolveLinearIssueIdentity({
        externalId: issueKey,
        lookupMatches: [
          { id: issueUuid, identifier: issueKey },
          { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', identifier: issueKey },
        ],
      }),
    ).toThrow(/resolved to 2 immutable UUIDs/);

    expect(() =>
      normalizeLinearExecutionIdentities(
        executionResult([
          {
            actionId: 'action-001',
            type: 'issue',
            name: issueTitle,
            externalId: issueKey,
          },
        ]),
      ),
    ).toThrow(/could not be resolved to exactly one immutable UUID/);
  });

  it('rejects KEY-shaped values in authorization ID fields', () => {
    expect(() => assertLinearAuthorizationId(issueKey, 'linear.issueId')).toThrow(
      /immutable Linear issue UUID is required/,
    );
    expect(() => assertLinearAuthorizationId(issueUuid, 'linear.issueId')).not.toThrow();

    const swapped = resolveLinearIssueIdentity({
      externalId: issueKey,
      identifier: issueUuid,
    });
    expect(swapped.externalId).toBe(issueUuid);
    expect(swapped.identifier).toBe(issueKey);
  });

  it('binds the persisted UUID on identical rerun and creates no duplicate', async () => {
    const { workspace, store, output } = await serviceFixture();
    let applyCount = 0;
    const firstDiscovery = discoveryFrom(baseDestination());
    const afterCreateDiscovery = discoveryFrom({
      ...baseDestination(),
      existingObjects: [
        ...baseDestination().existingObjects,
        {
          id: issueUuid,
          name: issueTitle,
          type: 'Linear issue',
          destinationId: teamId,
          parentId: projectId,
          identifier: issueKey,
          url: `https://linear.app/team/issue/${issueKey}/csv-import`,
        },
      ],
    });
    const mock = new MockAgentAdapter();

    const agent: AgentAdapter = {
      name: 'mock',
      diagnose: () => mock.diagnose(),
      discoverDestinations: () =>
        Promise.resolve({
          value: applyCount === 0 ? firstDiscovery : afterCreateDiscovery,
          command: ['test-discovery'],
          stdout: '',
          stderr: '',
          durationMs: 1,
        }),
      generatePlan: () =>
        Promise.resolve({
          value: createProposal(),
          command: ['test-plan'],
          stdout: '',
          stderr: '',
          durationMs: 1,
        }),
      executePlan: (input) => {
        applyCount += 1;
        const known = input.plan.plannedActions[0]?.properties.find(
          (property) => property.key === 'linear.dedupe.knownExternalId',
        )?.value;
        if (known) {
          return Promise.resolve({
            value: {
              status: 'succeeded' as const,
              summary: 'Reused exact Linear issue; no write.',
              createdObjects: [],
              skippedActions: [
                {
                  actionId: 'action-001',
                  type: 'Linear issue',
                  name: issueTitle,
                  reason: 'Already-existing object; no write required.',
                  externalId: issueUuid,
                  identifier: issueKey,
                  url: `https://linear.app/team/issue/${issueKey}/csv-import`,
                },
              ],
              completedActionIds: ['action-001'],
              compatibilityNotes: [],
              warnings: [],
              failures: [],
              startedAt: '2026-07-20T22:00:00.000Z',
              finishedAt: '2026-07-20T22:00:01.000Z',
            },
            command: ['test-apply-reuse'],
            stdout: '',
            stderr: '',
            durationMs: 1,
          });
        }
        return Promise.resolve({
          value: {
            status: 'succeeded' as const,
            summary: 'Created Linear issue.',
            createdObjects: [
              {
                actionId: 'action-001',
                type: 'Linear issue',
                name: issueTitle,
                externalId: issueUuid,
                identifier: issueKey,
                url: `https://linear.app/team/issue/${issueKey}/csv-import`,
              },
            ],
            skippedActions: [],
            completedActionIds: ['action-001'],
            compatibilityNotes: [],
            warnings: [],
            failures: [],
            startedAt: '2026-07-20T22:00:00.000Z',
            finishedAt: '2026-07-20T22:00:01.000Z',
          },
          command: ['test-apply-create'],
          stdout: '',
          stderr: '',
          durationMs: 1,
        });
      },
      inspectRecovery: (input) => mock.inspectRecovery(input),
      executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
      manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
    };

    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => agent,
    });

    const firstPlan = await services.plan({
      agent: 'mock',
      tool: 'linear',
      contextPaths: ['.'],
      objective: `Create ${issueTitle}`,
    });
    expect(
      firstPlan.plannedActions[0]?.properties.some(
        (property) => property.key === 'linear.dedupe.knownExternalId',
      ),
    ).toBe(false);

    const firstApply = await services.apply(firstPlan.runId, { confirmed: true });
    expect(firstApply?.createdObjects).toEqual([
      expect.objectContaining({
        externalId: issueUuid,
        identifier: issueKey,
      }),
    ]);
    expect(firstApply?.createdObjects[0]?.externalId).not.toBe(issueKey);

    const rerunPlan = await services.plan({
      agent: 'mock',
      tool: 'linear',
      contextPaths: ['.'],
      objective: `Create ${issueTitle}`,
    });
    expect(rerunPlan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.dedupe.knownExternalId', value: issueUuid },
        { key: 'linear.issueId', value: issueUuid },
        { key: 'linear.issueKey', value: issueKey },
      ]),
    );
    expect(rerunPlan.plannedActions[0]?.properties).not.toEqual(
      expect.arrayContaining([
        { key: 'linear.issueId', value: issueKey },
        { key: 'linear.dedupe.knownExternalId', value: issueKey },
      ]),
    );

    const rerunApply = await services.apply(rerunPlan.runId, { confirmed: true });
    expect(rerunApply?.createdObjects).toEqual([]);
    expect(rerunApply?.skippedActions).toEqual([
      expect.objectContaining({
        externalId: issueUuid,
        identifier: issueKey,
      }),
    ]);
    expect(applyCount).toBe(2);
  });

  it('treats already-satisfied Linear issue state as reuse/skip with no create', async () => {
    const destination = {
      ...baseDestination(),
      existingObjects: [
        ...baseDestination().existingObjects,
        {
          id: issueUuid,
          name: issueTitle,
          type: 'Linear issue',
          destinationId: teamId,
          parentId: projectId,
          identifier: issueKey,
        },
      ],
    };
    const { workspace, store, output } = await serviceFixture();
    const mock = new MockAgentAdapter();
    const satisfiedProposal: PlanProposal = {
      ...createProposal(),
      plannedActions: [
        {
          ...createProposal().plannedActions[0]!,
          operation: 'update',
          description: 'Reuse the exact verified existing Linear issue.',
          properties: [
            { key: 'linear.teamId', value: teamId },
            { key: 'linear.title', value: issueTitle },
            { key: 'linear.projectId', value: projectId },
            { key: 'linear.issueId', value: issueUuid },
            { key: 'linear.issueKey', value: issueKey },
            { key: 'linear.dedupe.knownExternalId', value: issueUuid },
            { key: 'linear.dedupe.skipReason', value: 'already-exists' },
          ],
        },
      ],
    };
    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => ({
        name: 'mock',
        diagnose: () => mock.diagnose(),
        discoverDestinations: () =>
          Promise.resolve({
            value: discoveryFrom(destination),
            command: ['test-discovery'],
            stdout: '',
            stderr: '',
            durationMs: 1,
          }),
        generatePlan: () =>
          Promise.resolve({
            value: satisfiedProposal,
            command: ['test-plan'],
            stdout: '',
            stderr: '',
            durationMs: 1,
          }),
        executePlan: (input) => mock.executePlan(input),
        inspectRecovery: (input) => mock.inspectRecovery(input),
        executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
        manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
      }),
    });

    const plan = await services.plan({
      agent: 'mock',
      tool: 'linear',
      contextPaths: ['.'],
      objective: `Create ${issueTitle}`,
    });
    expect(plan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.dedupe.knownExternalId', value: issueUuid },
        { key: 'linear.issueId', value: issueUuid },
        { key: 'linear.issueKey', value: issueKey },
      ]),
    );

    const result = await services.apply(plan.runId, { confirmed: true });
    expect(result?.createdObjects).toEqual([]);
    expect(result?.skippedActions).toEqual([
      expect.objectContaining({
        actionId: 'action-001',
        externalId: issueUuid,
        reason: 'Already-existing object; no write required.',
      }),
    ]);
  });

  it('still rejects KEY-only authorization through planning with AUR-PLAN-010', async () => {
    const { workspace, store, output } = await serviceFixture();
    const mock = new MockAgentAdapter();
    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => ({
        name: 'mock',
        diagnose: () => mock.diagnose(),
        discoverDestinations: () =>
          Promise.resolve({
            value: discoveryFrom(baseDestination()),
            command: ['test-discovery'],
            stdout: '',
            stderr: '',
            durationMs: 1,
          }),
        generatePlan: () =>
          Promise.resolve({
            value: {
              ...createProposal(),
              plannedActions: [
                {
                  ...createProposal().plannedActions[0]!,
                  operation: 'update' as const,
                  target: issueKey,
                  properties: [
                    { key: 'linear.teamId', value: teamId },
                    { key: 'linear.issueId', value: issueKey },
                    { key: 'linear.issueKey', value: issueKey },
                    { key: 'linear.dedupe.knownExternalId', value: issueKey },
                  ],
                },
              ],
            },
            command: ['test-plan'],
            stdout: '',
            stderr: '',
            durationMs: 1,
          }),
        executePlan: (input) => mock.executePlan(input),
        inspectRecovery: (input) => mock.inspectRecovery(input),
        executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
        manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
      }),
    });

    await expect(
      services.plan({
        agent: 'mock',
        tool: 'linear',
        contextPaths: ['.'],
        objective: `Update ${issueKey}`,
      }),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-010' });
  });
});

function executionResult(createdObjects: ExecutionResult['createdObjects']): ExecutionResult {
  return {
    status: 'succeeded',
    summary: 'test',
    createdObjects,
    skippedActions: [],
    completedActionIds: createdObjects.map((object) => object.actionId),
    compatibilityNotes: [],
    warnings: [],
    failures: [],
    startedAt: '2026-07-20T22:00:00.000Z',
    finishedAt: '2026-07-20T22:00:01.000Z',
  };
}

function baseDestination(): ResolvedDestination {
  return {
    integration: 'linear',
    id: teamId,
    name: 'JasjyotSingh',
    kind: 'team',
    source: 'only-choice',
    sourceDetail: 'One accessible team.',
    verifiedAt: '2026-07-20T22:00:00.000Z',
    existingObjects: [
      {
        id: projectId,
        name: 'Aurous — Build Week Launch',
        type: 'project',
        destinationId: teamId,
      },
    ],
    discoveryWarnings: [],
  };
}

function createProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      { kind: 'Linear issue', name: issueTitle, purpose: 'CSV import tracking.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'Linear issue',
        target: issueTitle,
        description: 'Create exactly one Linear issue for CSV bank-statement import.',
        properties: [
          { key: 'linear.teamId', value: teamId },
          { key: 'linear.title', value: issueTitle },
          { key: 'linear.projectId', value: projectId },
        ],
        dependsOn: [],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'One Linear issue exists.',
  };
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

async function serviceFixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-linear-identity-'));
  await writeFile(path.join(workspace, 'README.md'), '# Linear identity\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"linear-identity"}\n');
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'linear' });
  const output: Output = {
    log() {},
    error() {},
  };
  return { workspace, store, output };
}
