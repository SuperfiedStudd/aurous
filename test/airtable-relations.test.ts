import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { AirtableAdapter } from '../src/adapters/productivity/airtable.js';
import {
  materializeAirtableRelationAction,
  resolveAirtableRelationForExecution,
} from '../src/adapters/productivity/airtable-relations.js';
import type { Output } from '../src/core/output.js';
import { asAurousError } from '../src/core/errors.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanAction, PlanProposal } from '../src/domain/schemas.js';

const workspaceDestination: ResolvedDestination = {
  integration: 'airtable',
  id: 'wsphk1OmoSFXlTmwM',
  name: 'My First Workspace',
  kind: 'workspace',
  source: 'existing-match',
  sourceDetail: 'Workspace with inspected base and tables.',
  verifiedAt: '2026-07-20T19:38:22.000Z',
  existingObjects: [
    {
      id: 'apptXzRq0zEfjhz4X',
      name: 'Reading Tracker',
      type: 'airtable.base',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'wsphk1OmoSFXlTmwM',
    },
    {
      id: 'tblBooks',
      name: 'Books',
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'apptXzRq0zEfjhz4X',
    },
    {
      id: 'tblCategories',
      name: 'Categories',
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'apptXzRq0zEfjhz4X',
    },
    {
      id: 'fldCategoryLink',
      name: 'Category',
      type: 'airtable.field',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tblBooks',
    },
  ],
  discoveryWarnings: [],
};

describe('Airtable typed same-plan relations', () => {
  it('rejects ${action-004.output.airtable.recordId} placeholders via AUR-PLAN-009', async () => {
    const proposal = samePlanRelationProposal({
      relation: {
        key: 'airtable.linkedRecordIds',
        value: '["${action-002.output.airtable.recordId}"]',
      },
      sourceRecordId: '${action-004.output.airtable.recordId}',
      includeTypedRelation: false,
    });
    await expect(planWithProposal(workspaceDestination, proposal)).rejects.toMatchObject({
      code: 'AUR-PLAN-009',
    });
  });

  it('accepts a valid typed same-plan airtable.relation through planning', async () => {
    const plan = await planWithProposal(workspaceDestination, samePlanRelationProposal());
    const link = plan.plannedActions.find((action) => action.id === 'action-003');
    expect(link?.properties).toEqual(
      expect.arrayContaining([
        {
          key: 'airtable.relation',
          value: JSON.stringify({
            source: { baseActionId: 'action-002' },
            targets: [{ baseActionId: 'action-001' }],
            fieldId: 'fldCategoryLink',
          }),
        },
      ]),
    );
    expect(link?.properties.some((property) => property.value.includes('${'))).toBe(false);
  });

  it('apply resolves exact created record IDs from approved action results', async () => {
    const { services, planned } = await planServices(
      workspaceDestination,
      samePlanRelationProposal(),
    );
    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.createdObjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: 'action-001', externalId: 'mock-action-001' }),
        expect.objectContaining({ actionId: 'action-002', externalId: 'mock-action-002' }),
      ]),
    );
    const relationSkip = result?.skippedActions?.find((action) => action.actionId === 'action-003');
    expect(relationSkip?.externalId).toBe('mock-action-002');
    expect(relationSkip?.reason).toContain('airtable.relation');

    const materialized = materializeAirtableRelationAction(
      planned.plannedActions.find((action) => action.id === 'action-003')!,
      new Map([
        ['action-001', 'mock-action-001'],
        ['action-002', 'mock-action-002'],
      ]),
      {
        resultTypeByAction: new Map([
          ['action-001', 'airtable.record'],
          ['action-002', 'airtable.record'],
        ]),
      },
    );
    expect(materialized.properties).toEqual(
      expect.arrayContaining([
        { key: 'airtable.recordId', value: 'mock-action-002' },
        { key: 'airtable.linkedRecordIds', value: '["mock-action-001"]' },
      ]),
    );
  });

  it('stops before the relation write when a dependency result is missing', () => {
    try {
      resolveAirtableRelationForExecution(
        relationActionOnly(),
        new Map([['action-002', 'mock-action-002']]),
        {
          resultTypeByAction: new Map([['action-002', 'airtable.record']]),
        },
      );
      expect.fail('expected AUR-APPLY-005');
    } catch (error) {
      const classified = asAurousError(error);
      expect(classified.code).toBe('AUR-APPLY-005');
      expect(classified.message).toContain('action-001');
    }
  });

  it('stops safely when a dependency returns the wrong object type', () => {
    try {
      resolveAirtableRelationForExecution(
        relationActionOnly(),
        new Map([
          ['action-001', 'mock-action-001'],
          ['action-002', 'mock-action-002'],
        ]),
        {
          resultTypeByAction: new Map([
            ['action-001', 'airtable.table'],
            ['action-002', 'airtable.record'],
          ]),
        },
      );
      expect.fail('expected AUR-APPLY-005');
    } catch (error) {
      const classified = asAurousError(error);
      expect(classified.code).toBe('AUR-APPLY-005');
      expect(classified.message).toMatch(/table|expected record/i);
    }
  });

  it('identical rerun reuses exact IDs and creates no duplicate records', async () => {
    const afterFirst: ResolvedDestination = {
      ...workspaceDestination,
      existingObjects: [
        ...workspaceDestination.existingObjects,
        {
          id: 'recCategory1',
          name: 'Fiction',
          type: 'airtable.record',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'tblCategories',
        },
        {
          id: 'recBook1',
          name: 'Dune',
          type: 'airtable.record',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'tblBooks',
          linkedIds: ['recCategory1'],
        },
      ],
    };
    const proposal = samePlanRelationProposal({
      reuseIds: { category: 'recCategory1', book: 'recBook1' },
      relationExact: {
        sourceRecordId: 'recBook1',
        targetRecordId: 'recCategory1',
      },
    });
    const { services, planned } = await planServices(afterFirst, proposal);
    expect(planned.plannedActions[0]?.properties).toContainEqual({
      key: 'airtable.dedupe.knownExternalId',
      value: 'recCategory1',
    });
    expect(planned.plannedActions[1]?.properties).toContainEqual({
      key: 'airtable.dedupe.knownExternalId',
      value: 'recBook1',
    });
    expect(planned.plannedActions[2]?.properties).toContainEqual({
      key: 'airtable.dedupe.skipReason',
      value: 'already-satisfied-relation',
    });
    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.createdObjects).toEqual([]);
    expect(result?.skippedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: 'action-003',
          reason: 'Already-satisfied relation; no write required.',
          externalId: 'recBook1',
        }),
      ]),
    );
  });

  it('already-satisfied typed relation with exact recordIds produces no write', async () => {
    const destination: ResolvedDestination = {
      ...workspaceDestination,
      existingObjects: [
        ...workspaceDestination.existingObjects,
        {
          id: 'recAELdj1f2Fnp5gM',
          name: 'Complete README',
          type: 'airtable.record',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'tblBooks',
          linkedIds: ['rec4Tn5BNce63bHHN'],
        },
        {
          id: 'rec4Tn5BNce63bHHN',
          name: 'Launch deliverables',
          type: 'airtable.record',
          destinationId: 'wsphk1OmoSFXlTmwM',
          parentId: 'tblCategories',
        },
      ],
    };
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [{ kind: 'record', name: 'Link', purpose: 'noop' }],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'link',
          objectType: 'airtable.record',
          target: 'Link Complete README to Launch deliverables',
          description: 'Link exact inspected records.',
          properties: [
            { key: 'airtable.baseId', value: 'apptXzRq0zEfjhz4X' },
            { key: 'airtable.tableId', value: 'tblBooks' },
            { key: 'airtable.fieldId', value: 'fldCategoryLink' },
            {
              key: 'airtable.relation',
              value: JSON.stringify({
                source: { recordId: 'recAELdj1f2Fnp5gM' },
                targets: [{ recordId: 'rec4Tn5BNce63bHHN' }],
                fieldId: 'fldCategoryLink',
              }),
            },
          ],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'No-op relation.',
    };
    const { services, planned } = await planServices(destination, proposal);
    expect(planned.plannedActions[0]?.properties).toContainEqual({
      key: 'airtable.dedupe.skipReason',
      value: 'already-satisfied-relation',
    });
    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.createdObjects).toEqual([]);
    expect(result?.skippedActions?.[0]?.reason).toBe(
      'Already-satisfied relation; no write required.',
    );
  });

  it('keeps AUR-PLAN-009 rejecting prose-only and placeholder IDs', async () => {
    const adapter = new AirtableAdapter();
    expect(adapter.destinationPlanningInstructions(workspaceDestination)).toContain(
      'airtable.relation',
    );
    expect(adapter.destinationPlanningInstructions(workspaceDestination)).toContain('${action-');

    await expect(
      planWithProposal(workspaceDestination, {
        proposedWorkspaceStructure: [
          { kind: 'record', name: 'Orphan link', purpose: 'Should fail.' },
        ],
        plannedActions: [
          {
            id: 'action-001',
            operation: 'link',
            objectType: 'airtable.record',
            target: 'Link the existing Complete README task to the existing Launch deliverables',
            description: 'Reuse existing records without exact IDs.',
            properties: [
              { key: 'airtable.baseId', value: 'apptXzRq0zEfjhz4X' },
              { key: 'airtable.tableId', value: 'tblBooks' },
              { key: 'airtable.fieldId', value: 'fldCategoryLink' },
            ],
            dependsOn: [],
          },
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Should fail.',
      }),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });
});

function samePlanRelationProposal(options?: {
  relation?: { key: string; value: string };
  sourceRecordId?: string;
  includeTypedRelation?: boolean;
  reuseIds?: { category: string; book: string };
  relationExact?: { sourceRecordId: string; targetRecordId: string };
}): PlanProposal {
  const includeTypedRelation = options?.includeTypedRelation !== false;
  const category: PlanAction = {
    id: 'action-001',
    operation: options?.reuseIds ? 'update' : 'create',
    objectType: 'airtable.record',
    target: 'Fiction',
    description: options?.reuseIds
      ? 'Reuse exact Fiction category.'
      : 'Create Fiction category record.',
    properties: [
      { key: 'airtable.baseId', value: 'apptXzRq0zEfjhz4X' },
      { key: 'airtable.tableId', value: 'tblCategories' },
      ...(options?.reuseIds
        ? [{ key: 'airtable.dedupe.knownExternalId', value: options.reuseIds.category }]
        : []),
    ],
    dependsOn: [],
  };
  const book: PlanAction = {
    id: 'action-002',
    operation: options?.reuseIds ? 'update' : 'create',
    objectType: 'airtable.record',
    target: 'Dune',
    description: options?.reuseIds ? 'Reuse exact Dune book.' : 'Create Dune book record.',
    properties: [
      { key: 'airtable.baseId', value: 'apptXzRq0zEfjhz4X' },
      { key: 'airtable.tableId', value: 'tblBooks' },
      ...(options?.reuseIds
        ? [{ key: 'airtable.dedupe.knownExternalId', value: options.reuseIds.book }]
        : []),
    ],
    dependsOn: [],
  };
  const relationValue = options?.relationExact
    ? JSON.stringify({
        source: { recordId: options.relationExact.sourceRecordId },
        targets: [{ recordId: options.relationExact.targetRecordId }],
        fieldId: 'fldCategoryLink',
      })
    : JSON.stringify({
        source: { baseActionId: 'action-002' },
        targets: [{ baseActionId: 'action-001' }],
        fieldId: 'fldCategoryLink',
      });
  const link: PlanAction = {
    id: 'action-003',
    operation: 'link',
    objectType: 'airtable.record',
    target: 'Link Dune to Fiction',
    description: 'Authorize typed same-plan Airtable relation.',
    properties: [
      { key: 'airtable.baseId', value: 'apptXzRq0zEfjhz4X' },
      { key: 'airtable.tableId', value: 'tblBooks' },
      { key: 'airtable.fieldId', value: 'fldCategoryLink' },
      ...(options?.sourceRecordId
        ? [{ key: 'airtable.recordId', value: options.sourceRecordId }]
        : []),
      ...(options?.relation
        ? [options.relation]
        : includeTypedRelation
          ? [{ key: 'airtable.relation', value: relationValue }]
          : []),
    ],
    dependsOn: options?.relationExact ? [] : ['action-001', 'action-002'],
  };
  return {
    proposedWorkspaceStructure: [
      { kind: 'record', name: 'Fiction', purpose: 'Category.' },
      { kind: 'record', name: 'Dune', purpose: 'Book.' },
    ],
    plannedActions: [category, book, link],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'Category and book related by typed dependency.',
  };
}

function relationActionOnly(): PlanAction {
  return {
    id: 'action-003',
    operation: 'link',
    objectType: 'airtable.record',
    target: 'Link Dune to Fiction',
    description: 'Authorize typed same-plan Airtable relation.',
    properties: [
      {
        key: 'airtable.relation',
        value: JSON.stringify({
          source: { baseActionId: 'action-002' },
          targets: [{ baseActionId: 'action-001' }],
        }),
      },
    ],
    dependsOn: ['action-001', 'action-002'],
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-airtable-rel-'));
  await writeFile(path.join(workspace, 'README.md'), '# Airtable relations\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"airtable-relations"}\n');
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'airtable' });
  const output: Output = {
    log() {},
    error() {},
  };
  return { workspace, store, output };
}

async function planWithProposal(destination: ResolvedDestination, proposal: PlanProposal) {
  const { planned } = await planServices(destination, proposal);
  return planned;
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
    objective: 'Create Fiction and Dune then relate them',
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
