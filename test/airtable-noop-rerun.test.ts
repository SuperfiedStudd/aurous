import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { materializeAirtableCompletedNoOpProposal } from '../src/adapters/productivity/airtable-noop.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const prefix = 'Aurous Smoke 20260720T201226Z';
const bookName = `${prefix} The Left Hand of Darkness`;
const categoryName = `${prefix} Science Fiction`;
const bookId = 'rec5xynNH83BIBZUS';
const categoryId = 'recSwNHPn7CPaA2oQ';

const satisfiedDestination: ResolvedDestination = {
  integration: 'airtable',
  id: 'wsphk1OmoSFXlTmwM',
  name: 'My First Workspace',
  kind: 'workspace',
  source: 'existing-match',
  sourceDetail: 'Rerun after first apply.',
  verifiedAt: '2026-07-20T21:26:06.000Z',
  existingObjects: [
    {
      id: 'appWm8GBmsgzUWWbU',
      name: `${prefix} Nightstand Reading Tracker`,
      type: 'airtable.base',
      destinationId: 'wsphk1OmoSFXlTmwM',
    },
    {
      id: 'tblGayadkwY5Hrr72',
      name: `${prefix} Books`,
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'appWm8GBmsgzUWWbU',
    },
    {
      id: 'tblSFIQUZ7p0Jj0D8',
      name: `${prefix} Categories`,
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'appWm8GBmsgzUWWbU',
    },
    {
      id: bookId,
      name: bookName,
      type: 'airtable.record',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tblGayadkwY5Hrr72',
      linkedIds: [categoryId],
    },
    {
      id: categoryId,
      name: categoryName,
      type: 'airtable.record',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tblSFIQUZ7p0Jj0D8',
      linkedIds: [bookId],
    },
  ],
  discoveryWarnings: [],
};

function emptyNoOpPlannerOutput(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      {
        kind: 'airtable.workspace',
        name: 'My First Workspace',
        purpose: 'Approved destination workspace.',
      },
      {
        kind: 'airtable.base',
        name: `${prefix} Nightstand Reading Tracker`,
        purpose: 'Existing minimal reading-tracker base.',
        parent: 'My First Workspace',
      },
      {
        kind: 'airtable.table',
        name: `${prefix} Books`,
        purpose: 'Existing books table.',
        parent: `${prefix} Nightstand Reading Tracker`,
      },
      {
        kind: 'airtable.record',
        name: bookName,
        purpose: `Existing requested book record ${bookId}, already linked to category record ${categoryId}.`,
        parent: `${prefix} Books`,
      },
      {
        kind: 'airtable.table',
        name: `${prefix} Categories`,
        purpose: 'Existing categories table.',
        parent: `${prefix} Nightstand Reading Tracker`,
      },
      {
        kind: 'airtable.record',
        name: categoryName,
        purpose: `Existing requested category record ${categoryId}, already linked to book record ${bookId}.`,
        parent: `${prefix} Categories`,
      },
    ],
    plannedActions: [],
    assumptions: [
      'Exact inspected IDs confirm both requested records and the relation already exist.',
      'Because creation and linking are already satisfied, the minimal compliant plan is a complete no-op.',
    ],
    warnings: ['Do not create duplicate records.'],
    destructiveActions: [],
    expectedResult:
      'No mutations are performed. The approved Airtable workspace already contains the requested records and link.',
  };
}

describe('Airtable identical-rerun no-op plans', () => {
  it('materializes empty plannedActions into exact-ID skip actions when discovery is complete', () => {
    const materialized = materializeAirtableCompletedNoOpProposal(
      emptyNoOpPlannerOutput(),
      satisfiedDestination,
    ) as PlanProposal;
    expect(materialized.plannedActions.length).toBeGreaterThan(0);
    expect(materialized.plannedActions.map((action) => action.operation)).toEqual(
      expect.arrayContaining(['update', 'link']),
    );
    expect(materialized.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'airtable.dedupe.knownExternalId', value: bookId },
        { key: 'airtable.dedupe.skipReason', value: 'already-exists' },
      ]),
    );
    expect(
      materialized.plannedActions.some((action) =>
        action.properties.some(
          (property) =>
            property.key === 'airtable.dedupe.skipReason' &&
            property.value === 'already-satisfied-relation',
        ),
      ),
    ).toBe(true);
  });

  it('leaves unsafe empty planner output unchanged so schema validation still fails', () => {
    const unsafe = {
      ...emptyNoOpPlannerOutput(),
      proposedWorkspaceStructure: [
        {
          kind: 'airtable.record',
          name: 'Not In Discovery',
          purpose: 'Invented record without an inspected ID.',
        },
      ],
    };
    const materialized = materializeAirtableCompletedNoOpProposal(unsafe, satisfiedDestination);
    expect((materialized as PlanProposal).plannedActions).toEqual([]);
  });

  it('identical Airtable rerun succeeds with exact IDs, skips, and zero writes', async () => {
    const { services, planned } = await planServices(
      satisfiedDestination,
      emptyNoOpPlannerOutput(),
    );
    expect(planned.runId).toMatch(/^run-/);
    expect(planned.plannedActions.length).toBeGreaterThan(0);
    expect(planned.plannedActions.every((action) => action.operation !== 'create')).toBe(true);
    for (const action of planned.plannedActions) {
      expect(action.properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'airtable.dedupe.knownExternalId' }),
          expect.objectContaining({ key: 'airtable.dedupe.skipReason' }),
        ]),
      );
    }
    expect(
      planned.plannedActions.some((action) =>
        action.properties.some(
          (property) =>
            property.key === 'airtable.dedupe.skipReason' &&
            property.value === 'already-satisfied-relation',
        ),
      ),
    ).toBe(true);

    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.status).toBe('succeeded');
    expect(result?.createdObjects).toEqual([]);
    expect(result?.skippedActions?.length).toBeGreaterThan(0);
    expect(result?.skippedActions?.every((action) => Boolean(action.externalId))).toBe(true);
    expect(
      result?.skippedActions?.some((action) =>
        (action.reason || '').toLowerCase().includes('already'),
      ),
    ).toBe(true);
  });

  it('still rejects empty unsafe planner output through planning', async () => {
    await expect(
      planServices(satisfiedDestination, {
        ...emptyNoOpPlannerOutput(),
        proposedWorkspaceStructure: [
          {
            kind: 'airtable.record',
            name: 'Missing Record',
            purpose: 'No inspected ID.',
          },
        ],
        plannedActions: [],
      }),
    ).rejects.toMatchObject({ code: 'AUR-CORE-001' });
  });

  it('keeps AUR-PLAN-009 rejecting prose-only reuse on rerun destinations', async () => {
    const { workspace, store, output } = await serviceFixture();
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'record', name: 'Uninspected Book', purpose: 'Should fail without exact ID.' },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'update',
          objectType: 'airtable.record',
          target: 'Uninspected Book',
          description: 'Reuse by name only.',
          properties: [{ key: 'airtable.tableId', value: 'tblGayadkwY5Hrr72' }],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Should fail.',
    };
    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => planningAgent(discoveryFrom(satisfiedDestination), proposal),
    });
    await expect(
      services.plan({
        agent: 'mock',
        tool: 'airtable',
        contextPaths: ['.'],
        objective: 'Reuse Uninspected Book by name only.',
      }),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });
});

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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-airtable-noop-'));
  await writeFile(path.join(workspace, 'README.md'), '# Airtable no-op rerun\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"airtable-noop"}\n');
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'airtable' });
  const output: Output = {
    log() {},
    error() {},
  };
  return { workspace, store, output };
}

async function planServices(destination: ResolvedDestination, proposal: PlanProposal) {
  const { workspace, store, output } = await serviceFixture();
  const services = new AurousServices({
    workspace,
    store,
    output,
    agentFactory: () => planningAgent(discoveryFrom(destination), proposal),
  });
  const planned = await services.plan({
    agent: 'mock',
    tool: 'airtable',
    contextPaths: ['.'],
    objective: `Reuse ${bookName} and ${categoryName} and keep their link; do not create duplicates.`,
  });
  return { services, planned };
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
