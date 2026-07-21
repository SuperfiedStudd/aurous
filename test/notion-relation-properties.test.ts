import { describe, expect, it } from 'vitest';
import { NotionAdapter } from '../src/adapters/productivity/notion.js';
import { bindNotionRelationProperty } from '../src/adapters/productivity/notion-relation-properties.js';
import type { ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanAction, PlanProposal } from '../src/domain/schemas.js';

const taskRecordId = '3a4c0122-d292-8162-942d-d7e059e89c41';
const checklistRecordId = '3a4c0122-d292-8150-a6dc-f217cec2969e';
const taskDbId = 'ed157dff-ae92-44cd-af58-a3225dee46d9';
const checklistDbId = '6dfe13ba-b7d6-4aec-ae28-6c4e408b53a9';
const milestoneTrackerDbId = '7f965334-0f81-4d4c-966b-6b3d9d969fa2';
const relatedTaskPropertyId = 'Related Task';
const milestonePropertyId = 'aDpycQ';

/** Sanitized fixture matching the live workspace: Related Task connects checklist→task. */
const smokeDestination: ResolvedDestination = {
  integration: 'notion',
  id: '3a2c0122-d292-8130-bde0-f68012dac01a',
  name: 'Aurous Product HQ',
  kind: 'page',
  source: 'existing-match',
  sourceDetail: 'Sanitized Notion smoke fixture.',
  verifiedAt: '2026-07-21T02:19:34.000Z',
  existingObjects: [
    {
      id: taskRecordId,
      name: 'Aurous Smoke 20260720T201226Z Record trailer episode',
      type: 'notion.record',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: taskDbId,
      linkedIds: [],
    },
    {
      id: checklistRecordId,
      name: 'Aurous Smoke 20260720T201226Z Launch gate',
      type: 'notion.record',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: checklistDbId,
      linkedIds: [],
    },
    {
      id: taskDbId,
      name: 'Task Database',
      type: 'database',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      identifier: 'collection://74fc2fce-1fa1-481f-a412-4c2e405ada3e',
    },
    {
      id: checklistDbId,
      name: 'Launch Checklist',
      type: 'database',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      identifier: 'collection://12d311ca-096e-4f82-8edd-2a438f8f4841',
    },
    {
      id: milestoneTrackerDbId,
      name: 'Milestone Tracker',
      type: 'database',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      identifier: 'collection://d844db05-a088-4783-9e3c-ecfa2cb2acc1',
    },
    {
      id: milestonePropertyId,
      name: 'Milestone',
      type: 'notion.relation_property',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: taskDbId,
      identifier: 'relation',
      linkedIds: [milestoneTrackerDbId, 'd844db05-a088-4783-9e3c-ecfa2cb2acc1'],
    },
    {
      id: relatedTaskPropertyId,
      name: 'Related Task',
      type: 'notion.relation_property',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: checklistDbId,
      identifier: 'relation',
      linkedIds: [taskDbId, '74fc2fce-1fa1-481f-a412-4c2e405ada3e'],
    },
  ],
  discoveryWarnings: [],
};

describe('Notion discovered relation property binding', () => {
  it('selects Related Task from schema instead of a planner-invented name', () => {
    const bound = bindNotionRelationProperty(
      relationAction({
        properties: [
          { key: 'notion.relation.name', value: 'Launch Checklist' },
          { key: 'notion.relation.sourceRecordId', value: checklistRecordId },
          { key: 'notion.relation.targetRecordIds', value: JSON.stringify([taskRecordId]) },
        ],
      }),
      smokeDestination,
    );
    expect(bound.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.relation.name', value: 'Related Task' },
        { key: 'notion.relation.propertyId', value: relatedTaskPropertyId },
      ]),
    );
  });

  it('rejects Task→Launch gate via Milestone because Milestone targets Milestone Tracker', () => {
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.name', value: 'Milestone' },
            { key: 'notion.relation.sourceRecordId', value: taskRecordId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([checklistRecordId]) },
          ],
        }),
        smokeDestination,
      ),
    ).toThrow(/No discovered Notion relation property/);
  });

  it('accepts Related Task linkedIds expressed as the Task Database collection UUID', () => {
    const taskCollectionId = '74fc2fce-1fa1-481f-a412-4c2e405ada3e';
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: smokeDestination.existingObjects.map((object) =>
        object.id === relatedTaskPropertyId ? { ...object, linkedIds: [taskCollectionId] } : object,
      ),
    };
    const bound = bindNotionRelationProperty(
      relationAction({
        properties: [
          { key: 'notion.relation.sourceRecordId', value: checklistRecordId },
          { key: 'notion.relation.targetRecordIds', value: JSON.stringify([taskRecordId]) },
        ],
      }),
      destination,
    );
    expect(bound.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.relation.name', value: 'Related Task' },
        { key: 'notion.relation.propertyId', value: relatedTaskPropertyId },
      ]),
    );
  });

  it('uses Related Task through NotionAdapter.bindDestination for the smoke fixture', () => {
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(smokeProposal('Launch Checklist'), smokeDestination);
    const action = bound.plannedActions[0]!;
    expect(action.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.relation.name', value: 'Related Task' },
        { key: 'notion.relation.propertyId', value: relatedTaskPropertyId },
        { key: 'notion.dedupe.knownExternalId', value: checklistRecordId },
        { key: 'notion.relation.sourceRecordId', value: checklistRecordId },
        { key: 'notion.relation.targetRecordIds', value: JSON.stringify([taskRecordId]) },
      ]),
    );
  });

  it('fails closed when zero relation properties accept the target database', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: smokeDestination.existingObjects.filter(
        (object) => object.id !== relatedTaskPropertyId,
      ),
    };
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.name', value: 'Launch Checklist' },
            { key: 'notion.relation.sourceRecordId', value: checklistRecordId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([taskRecordId]) },
          ],
        }),
        destination,
      ),
    ).toThrow(/No discovered Notion relation property/);
  });

  it('fails closed when multiple compatible relation properties are ambiguous', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: [
        ...smokeDestination.existingObjects,
        {
          id: 'prop-alt-related',
          name: 'Also Related',
          type: 'notion.relation_property',
          destinationId: smokeDestination.id,
          parentId: checklistDbId,
          identifier: 'relation',
          linkedIds: [taskDbId],
        },
      ],
    };
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.sourceRecordId', value: checklistRecordId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([taskRecordId]) },
          ],
        }),
        destination,
      ),
    ).toThrow(/ambiguous/i);
  });

  it('skips an already-satisfied relation after binding the discovered property', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: smokeDestination.existingObjects.map((object) =>
        object.id === checklistRecordId ? { ...object, linkedIds: [taskRecordId] } : object,
      ),
    };
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(smokeProposal('Launch Checklist'), destination);
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.relation.name', value: 'Related Task' },
        { key: 'notion.relation.propertyId', value: relatedTaskPropertyId },
        { key: 'notion.dedupe.skipReason', value: 'already-satisfied-relation' },
      ]),
    );
  });

  it('never selects a non-relation property even when names match', () => {
    const destination: ResolvedDestination = {
      ...smokeDestination,
      existingObjects: [
        ...smokeDestination.existingObjects.filter((object) => object.id !== relatedTaskPropertyId),
        {
          id: 'prop-text-related',
          name: 'Related Task',
          type: 'notion.property',
          destinationId: smokeDestination.id,
          parentId: checklistDbId,
          identifier: 'rich_text',
          linkedIds: [taskDbId],
        },
      ],
    };
    expect(() =>
      bindNotionRelationProperty(
        relationAction({
          properties: [
            { key: 'notion.relation.name', value: 'Related Task' },
            { key: 'notion.relation.sourceRecordId', value: checklistRecordId },
            { key: 'notion.relation.targetRecordIds', value: JSON.stringify([taskRecordId]) },
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
    target: 'Aurous Smoke 20260720T201226Z Launch gate',
    description: 'Relate launch gate to trailer episode.',
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
          { key: 'notion.dedupe.knownExternalId', value: checklistRecordId },
          { key: 'notion.relation.name', value: relationName },
          { key: 'notion.relation.sourceRecordId', value: checklistRecordId },
          { key: 'notion.relation.targetRecordIds', value: JSON.stringify([taskRecordId]) },
        ],
      }),
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'Launch gate related to trailer episode.',
  };
}
