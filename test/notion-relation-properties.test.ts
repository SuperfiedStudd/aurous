import { describe, expect, it } from 'vitest';
import { NotionAdapter } from '../src/adapters/productivity/notion.js';
import { bindNotionRelationProperty } from '../src/adapters/productivity/notion-relation-properties.js';
import type { ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanAction, PlanProposal } from '../src/domain/schemas.js';

const sourceId = '3a4c0122-d292-8162-942d-d7e059e89c41';
const targetId = '3a4c0122-d292-8150-a6dc-f217cec2969e';
const taskDbId = 'ed157dff-ae92-44cd-af58-a3225dee46d9';
const checklistDbId = '6dfe13ba-b7d6-4aec-ae28-6c4e408b53a9';
const milestonePropertyId = 'prop-milestone-task-db';

const smokeDestination: ResolvedDestination = {
  integration: 'notion',
  id: '3a2c0122-d292-8130-bde0-f68012dac01a',
  name: 'Aurous Product HQ',
  kind: 'page',
  source: 'existing-match',
  sourceDetail: 'Sanitized Notion smoke fixture.',
  verifiedAt: '2026-07-21T01:25:39.000Z',
  existingObjects: [
    {
      id: sourceId,
      name: 'Aurous Smoke 20260720T201226Z Record trailer episode',
      type: 'notion.record',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: taskDbId,
      linkedIds: [],
    },
    {
      id: targetId,
      name: 'Aurous Smoke 20260720T201226Z Launch gate',
      type: 'notion.record',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: checklistDbId,
      linkedIds: [],
    },
    {
      id: milestonePropertyId,
      name: 'Milestone',
      type: 'notion.property',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: taskDbId,
      identifier: 'relation',
      linkedIds: [checklistDbId],
    },
  ],
  discoveryWarnings: [],
};

describe('Notion discovered relation property binding', () => {
  it('selects a discovered relation property instead of a planner-invented name', () => {
    const bound = bindNotionRelationProperty(
      relationAction({
        properties: [
          { key: 'notion.relation.name', value: 'Launch Checklist' },
          { key: 'notion.relation.sourceRecordId', value: sourceId },
          { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
        ],
      }),
      smokeDestination,
    );
    expect(bound.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.relation.name', value: 'Milestone' },
        { key: 'notion.relation.propertyId', value: milestonePropertyId },
      ]),
    );
  });

  it('uses Milestone in the sanitized smoke fixture through NotionAdapter.bindDestination', () => {
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(smokeProposal('Launch Checklist'), smokeDestination);
    const action = bound.plannedActions[0]!;
    expect(action.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.relation.name', value: 'Milestone' },
        { key: 'notion.relation.propertyId', value: milestonePropertyId },
        { key: 'notion.dedupe.knownExternalId', value: sourceId },
        { key: 'notion.relation.sourceRecordId', value: sourceId },
        { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
      ]),
    );
  });

  it('fails safely when no discovered relation property exists', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: smokeDestination.existingObjects.filter(
        (object) => object.id !== milestonePropertyId,
      ),
    };
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.name', value: 'Launch Checklist' },
            { key: 'notion.relation.sourceRecordId', value: sourceId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
          ],
        }),
        destination,
      ),
    ).toThrow(/No discovered Notion relation property/);
  });

  it('fails when multiple relation properties exist unless one exact discovered name matches', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: [
        ...smokeDestination.existingObjects,
        {
          id: 'prop-secondary-task-db',
          name: 'Secondary',
          type: 'notion.property',
          destinationId: smokeDestination.id,
          parentId: taskDbId,
          identifier: 'relation',
          linkedIds: [checklistDbId],
        },
      ],
    };
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.name', value: 'Launch Checklist' },
            { key: 'notion.relation.sourceRecordId', value: sourceId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
          ],
        }),
        destination,
      ),
    ).toThrow(/ambiguous/i);

    const exact = bindNotionRelationProperty(
      relationAction({
        properties: [
          { key: 'notion.relation.name', value: 'Milestone' },
          { key: 'notion.relation.sourceRecordId', value: sourceId },
          { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
        ],
      }),
      destination,
    );
    expect(exact.properties).toContainEqual({
      key: 'notion.relation.propertyId',
      value: milestonePropertyId,
    });
  });

  it('fails safely when the relation targets a database the property does not accept', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: [
        ...smokeDestination.existingObjects,
        {
          id: 'foreign-record',
          name: 'Foreign record',
          type: 'notion.record',
          destinationId: smokeDestination.id,
          parentId: 'foreign-database',
        },
      ],
    };
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.name', value: 'Milestone' },
            { key: 'notion.relation.sourceRecordId', value: sourceId },
            {
              key: 'notion.relation.targetRecordIds',
              value: JSON.stringify(['foreign-record']),
            },
          ],
        }),
        destination,
      ),
    ).toThrow(/No discovered Notion relation property/);
  });

  it('skips an already-satisfied relation after binding the discovered property', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: smokeDestination.existingObjects.map((object) =>
        object.id === sourceId ? { ...object, linkedIds: [targetId] } : object,
      ),
    };
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(smokeProposal('Launch Checklist'), destination);
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.relation.name', value: 'Milestone' },
        { key: 'notion.relation.propertyId', value: milestonePropertyId },
        { key: 'notion.dedupe.skipReason', value: 'already-satisfied-relation' },
      ]),
    );
  });

  it('never selects a non-relation property even when names match', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: [
        ...smokeDestination.existingObjects.filter((object) => object.id !== milestonePropertyId),
        {
          id: 'prop-text-milestone',
          name: 'Milestone',
          type: 'notion.property',
          destinationId: smokeDestination.id,
          parentId: taskDbId,
          identifier: 'rich_text',
          linkedIds: [checklistDbId],
        },
      ],
    };
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.name', value: 'Milestone' },
            { key: 'notion.relation.sourceRecordId', value: sourceId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
          ],
        }),
        destination,
      ),
    ).toThrow(/No discovered Notion relation property/);
  });
});

function relationAction(overrides?: Partial<PlanAction>): PlanAction {
  return {
    id: 'action-001',
    operation: 'link',
    objectType: 'notion.database_record',
    target: 'Aurous Smoke 20260720T201226Z Record trailer episode',
    description: 'Relate trailer episode to launch gate.',
    properties: [],
    dependsOn: [],
    ...overrides,
  };
}

function smokeProposal(relationName: string): PlanProposal {
  return {
    proposedWorkspaceStructure: [],
    plannedActions: [
      relationAction({
        properties: [
          { key: 'notion.destination.parentPageId', value: smokeDestination.id },
          { key: 'notion.dedupe.knownExternalId', value: sourceId },
          { key: 'notion.relation.name', value: relationName },
          { key: 'notion.relation.sourceRecordId', value: sourceId },
          { key: 'notion.relation.targetRecordIds', value: JSON.stringify([targetId]) },
        ],
      }),
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'Related via discovered property.',
  };
}
