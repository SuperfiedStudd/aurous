import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { LinearAdapter } from '../src/adapters/productivity/linear.js';
import {
  LINEAR_ISSUE_KEY_IDENTITY,
  resolveLinearIssueIdentity,
  resolveVerifiedLinearIssueKey,
} from '../src/adapters/productivity/linear-identity.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanAction, PlanProposal } from '../src/domain/schemas.js';

const teamId = 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b';
const otherTeamId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const projectId = '58f32b14-0b3d-4da3-8b41-91280ad54a8e';
const issueKey = 'JAS-19';
const issueTitle = 'Aurous Smoke 20260720T201226Z Add CSV bank-statement import';

describe('Linear issue-key authorization', () => {
  it('authorizes reuse when a uniquely discovered team-scoped issue key is bound', async () => {
    const adapter = new LinearAdapter();
    const bound = adapter.bindDestination(reuseProposal(), keyDestination());
    const action = bound.plannedActions[0]!;
    expect(action.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
        { key: 'linear.issueKey', value: issueKey },
        { key: 'linear.dedupe.knownExternalId', value: issueKey },
      ]),
    );
    expect(resolveVerifiedLinearIssueKey(action, keyDestination())?.id).toBe(issueKey);

    const plan = await planWithProposal(
      'linear',
      discoveryFrom(keyDestination()),
      reuseProposal(),
      `Reuse ${issueTitle}`,
    );
    expect(plan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
        { key: 'linear.issueKey', value: issueKey },
        { key: 'linear.dedupe.knownExternalId', value: issueKey },
      ]),
    );
  });

  it('authorizes a key identity even when the planner stamps sentinel projectId=none', async () => {
    const plan = await planWithProposal(
      'linear',
      discoveryFrom(keyDestination()),
      {
        ...reuseProposal(),
        plannedActions: [
          {
            ...reuseProposal().plannedActions[0]!,
            operation: 'configure',
            target: issueKey,
            description: 'No-op: reuse the exact uniquely inspected issue without mutation.',
            properties: [
              { key: 'linear.teamId', value: teamId },
              { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
              { key: 'linear.issueKey', value: issueKey },
              { key: 'linear.dedupe.knownExternalId', value: issueKey },
              { key: 'linear.projectId', value: 'none' },
              { key: 'linear.milestoneId', value: 'none' },
              { key: 'linear.title', value: issueTitle },
            ],
          },
        ],
      },
      `Reuse ${issueTitle}`,
    );
    expect(plan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
        { key: 'linear.issueKey', value: issueKey },
        { key: 'linear.dedupe.knownExternalId', value: issueKey },
      ]),
    );
    // projectId/milestoneId=none are identifier sentinels meaning "no relationship"; they are
    // stripped so a literal 'none' never reaches ID resolution at execution, while the key identity
    // is still authorized above. Value-bearing 'none' (titles/status) is kept elsewhere.
    expect(plan.plannedActions[0]?.properties.some((property) => property.value === 'none')).toBe(
      false,
    );
  });

  it('rejects a planner-invented issue key without discovery', async () => {
    await expect(
      planWithProposal(
        'linear',
        discoveryFrom(emptyDestination()),
        {
          ...reuseProposal(),
          plannedActions: [
            {
              ...reuseProposal().plannedActions[0]!,
              target: issueKey,
              properties: [
                { key: 'linear.teamId', value: teamId },
                { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
                { key: 'linear.issueKey', value: issueKey },
                { key: 'linear.issueId', value: issueKey },
                { key: 'linear.dedupe.knownExternalId', value: issueKey },
              ],
            },
          ],
        },
        `Update ${issueKey}`,
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-010' });
  });

  it('rejects a prose-only issue key that never enters structured identity fields', async () => {
    await expect(
      planWithProposal(
        'linear',
        discoveryFrom(keyDestination()),
        {
          ...reuseProposal(),
          plannedActions: [
            {
              ...reuseProposal().plannedActions[0]!,
              operation: 'update',
              target: 'Unrelated title that is not discovered',
              description: `Please update ${issueKey} mentioned only in prose.`,
              properties: [{ key: 'linear.teamId', value: teamId }],
            },
          ],
        },
        'Update Unrelated title that is not discovered',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });

  it('rejects zero or multiple discovery matches for an issue key', () => {
    expect(() =>
      resolveVerifiedLinearIssueKey(keyClaimAction(issueKey), {
        ...emptyDestination(),
        existingObjects: [],
      }),
    ).toThrow(/unverified issue key/);

    expect(() =>
      resolveVerifiedLinearIssueKey(keyClaimAction(issueKey), {
        ...keyDestination(),
        existingObjects: [
          {
            id: issueKey,
            name: issueTitle,
            type: 'issue',
            destinationId: teamId,
            parentId: projectId,
            identifier: issueKey,
          },
          {
            id: 'JAS-19-dup',
            name: `${issueTitle} (dup)`,
            type: 'issue',
            destinationId: teamId,
            parentId: projectId,
            identifier: issueKey,
          },
        ],
      }),
    ).toThrow(/matched 2 issues|unverified issue key/);
  });

  it('rejects an issue key scoped to another team or workspace', () => {
    expect(() =>
      resolveVerifiedLinearIssueKey(keyClaimAction(issueKey), {
        ...keyDestination(),
        existingObjects: [
          {
            id: issueKey,
            name: issueTitle,
            type: 'issue',
            destinationId: otherTeamId,
            parentId: projectId,
            identifier: issueKey,
          },
        ],
      }),
    ).toThrow(/unverified issue key/);
  });

  it('cannot authorize Airtable, Notion, or Trello actions with the Linear exception', async () => {
    const poisoned = [
      { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
      { key: 'linear.issueKey', value: issueKey },
      { key: 'linear.dedupe.knownExternalId', value: issueKey },
    ];

    await expect(
      planWithProposal(
        'airtable',
        discoveryFrom(airtableDestination()),
        {
          proposedWorkspaceStructure: [{ kind: 'record', name: 'Task', purpose: 'Should fail.' }],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'update',
              objectType: 'airtable.record',
              target: 'Task',
              description: 'Reuse Task.',
              properties: [
                { key: 'airtable.workspaceId', value: 'wspPoison' },
                { key: 'airtable.baseId', value: 'appPoison' },
                { key: 'airtable.tableId', value: 'tblPoison' },
                ...poisoned,
              ],
              dependsOn: [],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Fail.',
        },
        'Update Task',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });

    await expect(
      planWithProposal(
        'notion',
        discoveryFrom(notionDestination()),
        {
          proposedWorkspaceStructure: [{ kind: 'page', name: 'Task', purpose: 'Should fail.' }],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'update',
              objectType: 'notion.page',
              target: 'Task',
              description: 'Reuse Task.',
              properties: [
                { key: 'notion.destination.parentPageId', value: notionDestination().id },
                ...poisoned,
              ],
              dependsOn: [],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Fail.',
        },
        'Update Task',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });

    await expect(
      planWithProposal(
        'trello',
        discoveryFrom(trelloDestination()),
        {
          proposedWorkspaceStructure: [{ kind: 'card', name: 'Task', purpose: 'Should fail.' }],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'update',
              objectType: 'trello.card',
              target: 'Task',
              description: 'Reuse Task.',
              properties: [{ key: 'trello.boardId', value: trelloDestination().id }, ...poisoned],
              dependsOn: [],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Fail.',
        },
        'Update Task',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });

  it('identical rerun creates no duplicate and performs zero unnecessary writes', async () => {
    const { workspace, store, output } = await serviceFixture();
    let applyCount = 0;
    const afterCreate = discoveryFrom(keyDestination());
    const mock = new MockAgentAdapter();
    const agent: AgentAdapter = {
      name: 'mock',
      diagnose: () => mock.diagnose(),
      discoverDestinations: () =>
        Promise.resolve({
          value: applyCount === 0 ? discoveryFrom(emptyDestination()) : afterCreate,
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
                  externalId: issueKey,
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
                externalId: issueKey,
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
    const firstApply = await services.apply(firstPlan.runId, { confirmed: true });
    expect(firstApply?.createdObjects).toEqual([
      expect.objectContaining({ externalId: issueKey, identifier: issueKey }),
    ]);
    expect(
      resolveLinearIssueIdentity({
        externalId: issueKey,
        identifier: issueKey,
      }),
    ).toMatchObject({
      externalId: issueKey,
      identityType: LINEAR_ISSUE_KEY_IDENTITY,
    });

    const rerunPlan = await services.plan({
      agent: 'mock',
      tool: 'linear',
      contextPaths: ['.'],
      objective: `Create ${issueTitle}`,
    });
    expect(rerunPlan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
        { key: 'linear.issueKey', value: issueKey },
        { key: 'linear.dedupe.knownExternalId', value: issueKey },
      ]),
    );

    const rerunApply = await services.apply(rerunPlan.runId, { confirmed: true });
    expect(rerunApply?.createdObjects).toEqual([]);
    expect(rerunApply?.skippedActions).toEqual([
      expect.objectContaining({
        actionId: 'action-001',
        externalId: issueKey,
        reason: 'Already-existing object; no write required.',
      }),
    ]);
    expect(applyCount).toBe(2);
  });

  it('rejects a key-shaped auth field that lacks linear.identityType', async () => {
    await expect(
      planWithProposal(
        'linear',
        discoveryFrom(emptyDestination()),
        {
          ...reuseProposal(),
          plannedActions: [
            {
              ...reuseProposal().plannedActions[0]!,
              operation: 'update',
              target: issueKey,
              properties: [
                { key: 'linear.teamId', value: teamId },
                { key: 'linear.issueKey', value: issueKey },
                { key: 'linear.issueId', value: issueKey },
                { key: 'linear.dedupe.knownExternalId', value: issueKey },
              ],
            },
          ],
        },
        `Update ${issueKey}`,
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-010' });
  });
});

function keyClaimAction(key: string): PlanAction {
  return {
    id: 'action-001',
    operation: 'update',
    objectType: 'Linear issue',
    target: issueTitle,
    description: 'Reuse issue.',
    properties: [
      { key: 'linear.teamId', value: teamId },
      { key: 'linear.identityType', value: LINEAR_ISSUE_KEY_IDENTITY },
      { key: 'linear.issueKey', value: key },
      { key: 'linear.dedupe.knownExternalId', value: key },
    ],
    dependsOn: [],
  };
}

function keyDestination(): ResolvedDestination {
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
      {
        id: issueKey,
        name: issueTitle,
        type: 'Linear issue',
        destinationId: teamId,
        parentId: projectId,
        identifier: issueKey,
        url: `https://linear.app/team/issue/${issueKey}/csv-import`,
      },
    ],
    discoveryWarnings: [],
  };
}

function emptyDestination(): ResolvedDestination {
  return {
    ...keyDestination(),
    existingObjects: [
      {
        id: projectId,
        name: 'Aurous — Build Week Launch',
        type: 'project',
        destinationId: teamId,
      },
    ],
  };
}

function reuseProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      { kind: 'Linear issue', name: issueTitle, purpose: 'CSV import tracking.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'update',
        objectType: 'Linear issue',
        target: issueTitle,
        description: 'Reuse the discovered CSV import issue.',
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
    expectedResult: 'One Linear issue is reused.',
  };
}

function createProposal(): PlanProposal {
  return {
    ...reuseProposal(),
    plannedActions: [
      {
        ...reuseProposal().plannedActions[0]!,
        operation: 'create',
        description: 'Create exactly one Linear issue for CSV bank-statement import.',
      },
    ],
  };
}

function airtableDestination(): ResolvedDestination {
  return {
    integration: 'airtable',
    id: 'wspPoison',
    name: 'Poison workspace',
    kind: 'workspace',
    source: 'only-choice',
    sourceDetail: 'test',
    verifiedAt: '2026-07-20T22:00:00.000Z',
    existingObjects: [],
    discoveryWarnings: [],
  };
}

function notionDestination(): ResolvedDestination {
  return {
    integration: 'notion',
    id: '3a2c0122-d292-8130-bde0-f68012dac01a',
    name: 'Poison HQ',
    kind: 'page',
    source: 'only-choice',
    sourceDetail: 'test',
    verifiedAt: '2026-07-20T22:00:00.000Z',
    existingObjects: [],
    discoveryWarnings: [],
  };
}

function trelloDestination(): ResolvedDestination {
  return {
    integration: 'trello',
    id: 'boardPoison',
    name: 'Poison board',
    kind: 'board',
    source: 'only-choice',
    sourceDetail: 'test',
    verifiedAt: '2026-07-20T22:00:00.000Z',
    existingObjects: [],
    discoveryWarnings: [],
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

async function planWithProposal(
  tool: 'linear' | 'airtable' | 'notion' | 'trello',
  discovery: DestinationDiscovery,
  proposal: PlanProposal,
  objective: string,
) {
  const { workspace, store, output } = await serviceFixture(tool);
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
          value: discovery,
          command: ['test-discovery'],
          stdout: '',
          stderr: '',
          durationMs: 1,
        }),
      generatePlan: () =>
        Promise.resolve({
          value: proposal,
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
  return services.plan({
    agent: 'mock',
    tool,
    contextPaths: ['.'],
    objective,
  });
}

async function serviceFixture(tool: 'linear' | 'airtable' | 'notion' | 'trello' = 'linear') {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-linear-key-auth-'));
  await writeFile(path.join(workspace, 'README.md'), '# Linear key auth\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"linear-key-auth"}\n');
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: tool });
  const output: Output = {
    log() {},
    error() {},
  };
  return { workspace, store, output };
}
