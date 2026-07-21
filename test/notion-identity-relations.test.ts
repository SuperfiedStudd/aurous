import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { NotionAdapter } from '../src/adapters/productivity/notion.js';
import { normalizeNotionKnownExternalIdAlias } from '../src/adapters/productivity/notion-identity.js';
import {
  materializeNotionRelationAction,
  parseNotionRelation,
} from '../src/adapters/productivity/notion-relations.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanAction, PlanProposal } from '../src/domain/schemas.js';

const sourceId = '3a4c0122-d292-8162-942d-d7e059e89c41';
const targetId = '3a4c0122-d292-8150-a6dc-f217cec2969e';

const notionDestination: ResolvedDestination = {
  integration: 'notion',
  id: '3a2c0122-d292-8130-bde0-f68012dac01a',
  name: 'Aurous Product HQ',
  kind: 'page',
  source: 'existing-match',
  sourceDetail: 'Exact Product HQ page inspected.',
  verifiedAt: '2026-07-21T00:51:24.000Z',
  existingObjects: [
    {
      id: sourceId,
      name: 'Aurous Smoke 20260720T201226Z Record trailer episode',
      type: 'page',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: 'ed157dff-ae92-44cd-af58-a3225dee46d9',
      linkedIds: [],
    },
    {
      id: targetId,
      name: 'Aurous Smoke 20260720T201226Z Launch gate',
      type: 'page',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: '6dfe13ba-b7d6-4aec-ae28-6c4e408b53a9',
      linkedIds: [],
    },
  ],
  discoveryWarnings: [],
};

describe('Notion identity alias and relation normalization', () => {
  it('normalizes a discovered notion.knownExternalId alias safely', () => {
    const action = relationAction({
      properties: [
        { key: 'notion.destination.parentPageId', value: notionDestination.id },
        { key: 'notion.knownExternalId', value: sourceId },
        { key: 'notion.relation.name', value: 'Launch Checklist' },
        { key: 'notion.relation.sourceRecordId', value: sourceId },
        { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
      ],
    });
    const normalized = normalizeNotionKnownExternalIdAlias(action, notionDestination);
    expect(normalized.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.dedupe.knownExternalId', value: sourceId },
        { key: 'notion.relation.sourceRecordId', value: sourceId },
      ]),
    );
    expect(normalized.properties.some((property) => property.key === 'notion.knownExternalId')).toBe(
      false,
    );

    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [],
        plannedActions: [action],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Related.',
      },
      notionDestination,
    );
    expect(bound.plannedActions[0]?.objectType).toBe('notion.database_record');
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.dedupe.knownExternalId', value: sourceId },
        { key: 'notion.relation.sourceRecordId', value: sourceId },
        { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
      ]),
    );
  });

  it('fails closed for a planner-invented notion.knownExternalId alias', async () => {
    const invented = '00000000-0000-4000-8000-000000000099';
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        {
          kind: 'database_record',
          name: 'Aurous Smoke 20260720T201226Z Record trailer episode',
          purpose: 'Task.',
        },
      ],
      plannedActions: [
        relationAction({
          properties: [
            { key: 'notion.destination.parentPageId', value: notionDestination.id },
            { key: 'notion.knownExternalId', value: invented },
            { key: 'notion.relation.name', value: 'Launch Checklist' },
            { key: 'notion.relation.sourceRecordId', value: invented },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
          ],
        }),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Should fail.',
    };
    await expect(planWithProposal(notionDestination, proposal)).rejects.toMatchObject({
      code: 'AUR-PLAN-009',
    });
  });

  it('produces a structurally normalized relation action from exact discovered IDs', () => {
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [],
        plannedActions: [
          relationAction({
            properties: [
              { key: 'notion.destination.parentPageId', value: notionDestination.id },
              { key: 'notion.relation.name', value: 'Launch Checklist' },
              { key: 'notion.relation.sourceRecordId', value: sourceId },
              { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
            ],
          }),
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Related.',
      },
      notionDestination,
    );
    const action = bound.plannedActions[0]!;
    expect(action.objectType).toBe('notion.database_record');
    expect(action.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.dedupe.knownExternalId', value: sourceId },
        { key: 'notion.relation.sourceRecordId', value: sourceId },
        { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
      ]),
    );
  });

  it('accepts typed same-plan notion.relation refs and resolves exact prior-action IDs', async () => {
    const proposal = samePlanRelationProposal();
    const plan = await planWithProposal(notionDestination, proposal);
    const link = plan.plannedActions.find((action) => action.id === 'action-003');
    expect(link?.objectType).toBe('notion.database_record');
    expect(parseNotionRelation(propertyValue(link!, 'notion.relation'))).toEqual(
      expect.objectContaining({
        source: { recordActionId: 'action-001' },
        targets: [{ recordActionId: 'action-002' }],
      }),
    );

    const materialized = materializeNotionRelationAction(
      link!,
      new Map([
        ['action-001', sourceId],
        ['action-002', targetId],
      ]),
      {
        resultTypeByAction: new Map([
          ['action-001', 'notion.record'],
          ['action-002', 'notion.record'],
        ]),
      },
    );
    expect(materialized.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.dedupe.knownExternalId', value: sourceId },
        { key: 'notion.relation.sourceRecordId', value: sourceId },
        { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
      ]),
    );

    const { workspace, store, output } = await serviceFixture();
    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => planningAgent(discoveryFrom(notionDestination), proposal),
    });
    const planned = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Create two records and relate them',
    });
    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.status).toBe('succeeded');
    expect(result?.createdObjects.length).toBeGreaterThanOrEqual(2);
  });

  it('reuses exact records and skips an already-satisfied relation on identical rerun', async () => {
    const destination: ResolvedDestination = {
      ...notionDestination,
      existingObjects: notionDestination.existingObjects.map((object) =>
        object.id === sourceId ? { ...object, linkedIds: [targetId] } : object,
      ),
    };
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        {
          kind: 'database_record',
          name: 'Aurous Smoke 20260720T201226Z Record trailer episode',
          purpose: 'Task.',
        },
        {
          kind: 'database_record',
          name: 'Aurous Smoke 20260720T201226Z Launch gate',
          purpose: 'Gate.',
        },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'update',
          objectType: 'notion.database_record',
          target: 'Aurous Smoke 20260720T201226Z Record trailer episode',
          description: 'Reuse exact task record.',
          properties: [
            { key: 'notion.destination.parentPageId', value: destination.id },
            { key: 'notion.knownExternalId', value: sourceId },
          ],
          dependsOn: [],
        },
        {
          id: 'action-002',
          operation: 'update',
          objectType: 'notion.database_record',
          target: 'Aurous Smoke 20260720T201226Z Launch gate',
          description: 'Reuse exact checklist record.',
          properties: [
            { key: 'notion.destination.parentPageId', value: destination.id },
            { key: 'notion.dedupe.knownExternalId', value: targetId },
          ],
          dependsOn: [],
        },
        relationAction({
          id: 'action-003',
          target: 'Aurous Smoke 20260720T201226Z Record trailer episode',
          properties: [
            { key: 'notion.destination.parentPageId', value: destination.id },
            { key: 'notion.knownExternalId', value: sourceId },
            { key: 'notion.relation.name', value: 'Launch Checklist' },
            { key: 'notion.relation.sourceRecordId', value: sourceId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
          ],
        }),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'No-op reuse.',
    };

    const { workspace, store, output } = await serviceFixture();
    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => planningAgent(discoveryFrom(destination), proposal),
    });
    const planned = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Reuse trailer episode and launch gate relation',
    });
    const relation = planned.plannedActions.find((action) =>
      action.properties.some((property) => property.key === 'notion.relation.targetRecordIds'),
    );
    expect(relation?.properties).toContainEqual({
      key: 'notion.dedupe.skipReason',
      value: 'already-satisfied-relation',
    });
    expect(relation?.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.dedupe.knownExternalId', value: sourceId },
        { key: 'notion.relation.sourceRecordId', value: sourceId },
        { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
      ]),
    );

    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.createdObjects).toEqual([]);
    expect(result?.skippedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: relation?.id,
          reason: 'Already-satisfied relation; no write required.',
          externalId: sourceId,
        }),
      ]),
    );
  });
});

function relationAction(overrides?: Partial<PlanAction>): PlanAction {
  return {
    id: 'action-001',
    operation: 'update',
    objectType: 'notion.database_record_relation',
    target: 'Aurous Smoke 20260720T201226Z Record trailer episode',
    description: 'Relate trailer episode to launch gate. Do not delete anything.',
    properties: [],
    dependsOn: [],
    ...overrides,
  };
}

function samePlanRelationProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      {
        kind: 'record',
        name: 'Aurous Smoke 20260720T201226Z Record trailer episode',
        purpose: 'Task.',
      },
      {
        kind: 'record',
        name: 'Aurous Smoke 20260720T201226Z Launch gate',
        purpose: 'Gate.',
      },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'notion.record',
        target: 'ed157dff-ae92-44cd-af58-a3225dee46d9',
        description: 'Create trailer episode task. Do not delete anything.',
        properties: [
          { key: 'notion.destination.parentPageId', value: notionDestination.id },
          { key: 'notion.databaseId', value: 'ed157dff-ae92-44cd-af58-a3225dee46d9' },
          {
            key: 'notion.record.title',
            value: 'Aurous Smoke 20260720T201226Z Record trailer episode',
          },
        ],
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'notion.record',
        target: '6dfe13ba-b7d6-4aec-ae28-6c4e408b53a9',
        description: 'Create launch gate. Do not delete anything.',
        properties: [
          { key: 'notion.destination.parentPageId', value: notionDestination.id },
          { key: 'notion.databaseId', value: '6dfe13ba-b7d6-4aec-ae28-6c4e408b53a9' },
          {
            key: 'notion.record.title',
            value: 'Aurous Smoke 20260720T201226Z Launch gate',
          },
        ],
        dependsOn: [],
      },
      {
        id: 'action-003',
        operation: 'link',
        objectType: 'notion.database_record',
        target: 'Relate trailer episode to launch gate',
        description: 'Relate the exact same-plan records. Do not delete anything.',
        properties: [
          { key: 'notion.destination.parentPageId', value: notionDestination.id },
          { key: 'notion.relation.name', value: 'Launch Checklist' },
          {
            key: 'notion.relation',
            value: JSON.stringify({
              name: 'Launch Checklist',
              source: { recordActionId: 'action-001' },
              targets: [{ baseActionId: 'action-002' }],
            }),
          },
        ],
        dependsOn: ['action-001', 'action-002'],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'Two records related by typed same-plan refs.',
  };
}

function propertyValue(action: PlanAction, key: string): string | undefined {
  return action.properties.find((property) => property.key === key)?.value;
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-notion-'));
  await writeFile(path.join(workspace, 'README.md'), '# Notion identity\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"notion-identity"}\n');
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  const output: Output = {
    log() {},
    error() {},
  };
  return { workspace, store, output };
}

function planningAgent(
  discovery: DestinationDiscovery,
  proposal: PlanProposal,
): AgentAdapter {
  const mock = new MockAgentAdapter();
  return {
    name: 'mock',
    diagnose: () => mock.diagnose(),
    discoverDestinations: () =>
      Promise.resolve({
        value: discovery,
        command: ['mock', 'discover'],
        stdout: '',
        stderr: '',
        durationMs: 0,
      }),
    generatePlan: () =>
      Promise.resolve({
        value: proposal,
        command: ['mock', 'plan'],
        stdout: '',
        stderr: '',
        durationMs: 0,
      }),
    executePlan: (input) => mock.executePlan(input),
    inspectRecovery: (input) => mock.inspectRecovery(input),
    executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
    manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
  };
}

async function planWithProposal(destination: ResolvedDestination, proposal: PlanProposal) {
  const { workspace, store, output } = await serviceFixture();
  const services = new AurousServices({
    workspace,
    store,
    output,
    agentFactory: () => planningAgent(discoveryFrom(destination), proposal),
  });
  return services.plan({
    agent: 'mock',
    tool: 'notion',
    contextPaths: ['.'],
    objective: 'Relate podcast launch records. Do not delete anything.',
  });
}
