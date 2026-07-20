import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const teamId = 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b';
const issueUuid = '11111111-2222-4333-8444-555555555555';
const issueTitle = 'Aurous Smoke 20260720T201226Z Add CSV bank-statement import';

const emptyIssueDestination: ResolvedDestination = {
  integration: 'linear',
  id: teamId,
  name: 'JasjyotSingh',
  kind: 'team',
  source: 'only-choice',
  sourceDetail: 'One accessible team; no matching smoke issue.',
  verifiedAt: '2026-07-20T21:59:06.000Z',
  existingObjects: [
    {
      id: '58f32b14-0b3d-4da3-8b41-91280ad54a8e',
      name: 'Aurous — Build Week Launch',
      type: 'project',
      destinationId: teamId,
    },
  ],
  discoveryWarnings: [
    'No issue with the exact title Aurous Smoke 20260720T201226Z Add CSV bank-statement import was found.',
  ],
};

const existingIssueDestination: ResolvedDestination = {
  ...emptyIssueDestination,
  sourceDetail: 'Team with the exact smoke issue already inspected.',
  existingObjects: [
    ...emptyIssueDestination.existingObjects,
    {
      id: issueUuid,
      name: issueTitle,
      type: 'Linear issue',
      destinationId: teamId,
      parentId: '58f32b14-0b3d-4da3-8b41-91280ad54a8e',
      identifier: 'JAS-42',
      url: `https://linear.app/team/issue/JAS-42`,
    },
  ],
  discoveryWarnings: [],
};

describe('Linear structured mutation classification', () => {
  it('accepts a create whose description mentions reuse/skip when no issue exists', async () => {
    const plan = await planWithProposal(
      emptyIssueDestination,
      createIssueProposal({
        description:
          'Create exactly one actionable Linear issue. Persist the immutable UUID so reruns skip or reuse that exact issue without authorizing mutation from its title or human-readable key.',
        properties: [
          { key: 'linear.teamId', value: teamId },
          { key: 'linear.title', value: issueTitle },
          {
            key: 'linear.dedupe.rerunPolicy',
            value:
              'Do not create a duplicate issue on rerun. Reuse or skip only after inspection supplies the immutable Linear issue UUID.',
          },
        ],
      }),
      `Create ${issueTitle}`,
    );
    expect(plan.plannedActions[0]?.operation).toBe('create');
    expect(
      plan.plannedActions[0]?.properties.some(
        (property) => property.key === 'linear.dedupe.knownExternalId',
      ),
    ).toBe(false);
    expect(plan.plannedActions[0]?.description.toLowerCase()).toContain('reuse');
  });

  it('does not change structured create operation because prose mentions reuse', async () => {
    const plan = await planWithProposal(
      emptyIssueDestination,
      createIssueProposal({
        description: 'Reuse/skip language in prose only; operation remains create.',
        target: issueTitle,
      }),
      `Create ${issueTitle}`,
    );
    expect(plan.plannedActions.map((action) => action.operation)).toEqual(['create']);
    expect(plan.plannedActions[0]?.target).toBe(issueTitle);
  });

  it('normalizes a create that matches a known issue into exact UUID reuse', async () => {
    const plan = await planWithProposal(
      existingIssueDestination,
      createIssueProposal({
        description: 'Create or reuse the CSV import issue.',
      }),
      `Create or reuse ${issueTitle}`,
    );
    expect(plan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.dedupe.knownExternalId', value: issueUuid },
        { key: 'linear.issueId', value: issueUuid },
        { key: 'linear.issueKey', value: 'JAS-42' },
      ]),
    );
    expect(plan.plannedActions[0]?.properties).not.toEqual(
      expect.arrayContaining([{ key: 'linear.issueId', value: 'JAS-42' }]),
    );
  });

  it('still rejects update/reuse without an immutable Linear UUID via AUR-PLAN-009', async () => {
    await expect(
      planWithProposal(
        emptyIssueDestination,
        {
          proposedWorkspaceStructure: [
            { kind: 'Linear issue', name: issueTitle, purpose: 'Update without UUID.' },
          ],
          plannedActions: [
            {
              id: 'action-001',
              operation: 'update',
              objectType: 'Linear issue',
              target: issueTitle,
              description: 'Update the CSV import issue.',
              properties: [
                { key: 'linear.teamId', value: teamId },
                { key: 'linear.title', value: issueTitle },
              ],
              dependsOn: [],
            },
          ],
          assumptions: [],
          warnings: [],
          destructiveActions: [],
          expectedResult: 'Should fail.',
        },
        `Update ${issueTitle}`,
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });
});

function createIssueProposal(options?: {
  description?: string;
  target?: string;
  properties?: { key: string; value: string }[];
}): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      {
        kind: 'Linear issue',
        name: issueTitle,
        purpose: 'Track CSV bank-statement import.',
      },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'Linear issue',
        target: options?.target ?? issueTitle,
        description:
          options?.description ?? 'Create exactly one Linear issue for CSV bank-statement import.',
        properties: options?.properties ?? [
          { key: 'linear.teamId', value: teamId },
          { key: 'linear.title', value: issueTitle },
        ],
        dependsOn: [],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'One prefixed Linear issue exists.',
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-linear-classify-'));
  await writeFile(path.join(workspace, 'README.md'), '# Linear classification\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"linear-classify"}\n');
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'linear' });
  const output: Output = {
    log() {},
    error() {},
  };
  return { workspace, store, output };
}

async function planWithProposal(
  destination: ResolvedDestination,
  proposal: PlanProposal,
  objective: string,
) {
  const { workspace, store, output } = await serviceFixture();
  const services = new AurousServices({
    workspace,
    store,
    output,
    agentFactory: () => planningAgent(discoveryFrom(destination), proposal),
  });
  return services.plan({
    agent: 'mock',
    tool: 'linear',
    contextPaths: ['.'],
    objective,
  });
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
