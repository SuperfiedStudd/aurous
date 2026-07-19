import { describe, expect, it } from 'vitest';
import {
  RecoveryInspectionSchema,
  diffRecoverySemanticInspections,
  recoverySemanticFingerprint,
  type RecoveryInspection,
} from '../src/domain/recovery.js';

const originalCapturedShape = RecoveryInspectionSchema.parse({
  objects: [
    {
      actionId: 'action-001',
      externalId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      url: 'https://app.notion.com/p/3a2c0122d2928130bde0f68012dac01a',
      found: true,
      objectType: 'page',
      title: 'Aurous Product HQ',
      parentId: null,
      properties: [{ name: 'title', type: 'title', options: [] }],
      views: [],
      recordCount: null,
      limitations: ['Page property schema was not exposed.'],
    },
    {
      actionId: 'action-003',
      externalId: '7f965334-0f81-4d4c-966b-6b3d9d969fa2',
      url: 'https://app.notion.com/p/7f9653340f814d4c966b6b3d9d969fa2',
      found: true,
      objectType: 'database',
      title: 'Milestone Tracker',
      parentId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      properties: [
        { name: 'Milestone', type: 'title', options: [] },
        { name: 'Phase', type: 'select', options: ['Foundation', 'Follow-up', 'Later'] },
        { name: 'Status', type: 'status', options: ['Not started', 'In progress', 'Done'] },
      ],
      views: [
        { name: 'Default view', type: 'table', filterSummary: null },
        { name: 'Status Board', type: 'board', filterSummary: null },
      ],
      recordCount: null,
      limitations: ['The exact database fetch did not expose a record count.'],
    },
    {
      actionId: 'action-005',
      externalId: 'ed157dff-ae92-44cd-af58-a3225dee46d9',
      url: 'https://app.notion.com/p/ed157dffae9244cdaf58a3225dee46d9',
      found: true,
      objectType: 'database',
      title: 'Task Database',
      parentId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      properties: [
        {
          name: 'Area',
          type: 'select',
          options: ['CLI', 'Context ingestion', 'Notion'],
        },
        { name: 'Task', type: 'title', options: [] },
      ],
      views: [
        { name: 'Backlog', type: 'table', filterSummary: 'No active filters; empty AND group.' },
        { name: 'Blocked', type: 'table', filterSummary: 'No active filters; empty AND group.' },
      ],
      recordCount: null,
      limitations: ['View identifiers were not fetched.'],
    },
  ],
  customStatusOptions: { supported: false, evidence: 'Status option syntax is unavailable.' },
  customSelectOptions: { supported: true, evidence: 'Select option syntax is available.' },
  updateViewFilters: { supported: true, evidence: 'View filter syntax is available.' },
  warnings: ['Read-only exact-ID inspection.'],
});

const preExecutionCapturedShape = RecoveryInspectionSchema.parse({
  ...originalCapturedShape,
  objects: [
    {
      ...originalCapturedShape.objects[2],
      properties: [
        { name: 'Task', type: 'title', options: [] },
        { name: 'Area', type: 'select', options: ['Notion', 'CLI', 'Context ingestion'] },
      ],
      views: [
        { name: 'Blocked', type: 'table', filterSummary: 'Empty AND filter group (0 filters).' },
        { name: 'Backlog', type: 'table', filterSummary: 'Empty AND filter group (0 filters).' },
      ],
      limitations: ['Filter availability differed in this response.'],
    },
    {
      ...originalCapturedShape.objects[1],
      limitations: ['No filter configuration was exposed.'],
    },
    {
      ...originalCapturedShape.objects[0],
      properties: [],
      limitations: ['Title value was exposed without a property schema.'],
    },
  ],
  customStatusOptions: { supported: false, evidence: 'Different capability prose.' },
  customSelectOptions: { supported: true, evidence: 'Different capability prose.' },
  updateViewFilters: { supported: true, evidence: 'Different capability prose.' },
  warnings: ['Different read-only warning prose.'],
});

describe('recovery semantic verification', () => {
  it('treats the captured inspection and pre-execution shapes as equivalent', () => {
    expect(recoverySemanticFingerprint(preExecutionCapturedShape)).toBe(
      recoverySemanticFingerprint(originalCapturedShape),
    );
    expect(
      diffRecoverySemanticInspections(originalCapturedShape, preExecutionCapturedShape),
    ).toEqual([]);
  });

  it.each([
    [
      'missing object',
      (inspection: RecoveryInspection) => ({ ...inspection, objects: inspection.objects.slice(1) }),
    ],
    [
      'title',
      (inspection: RecoveryInspection) => ({
        ...inspection,
        objects: inspection.objects.map((object) =>
          object.externalId === '7f965334-0f81-4d4c-966b-6b3d9d969fa2'
            ? { ...object, title: 'Renamed Tracker' }
            : object,
        ),
      }),
    ],
    [
      'existence',
      (inspection: RecoveryInspection) => ({
        ...inspection,
        objects: inspection.objects.map((object) =>
          object.externalId === '7f965334-0f81-4d4c-966b-6b3d9d969fa2'
            ? { ...object, found: false }
            : object,
        ),
      }),
    ],
    [
      'object type',
      (inspection: RecoveryInspection) => ({
        ...inspection,
        objects: inspection.objects.map((object) =>
          object.externalId === '7f965334-0f81-4d4c-966b-6b3d9d969fa2'
            ? { ...object, objectType: 'page' }
            : object,
        ),
      }),
    ],
    [
      'parent',
      (inspection: RecoveryInspection) => ({
        ...inspection,
        objects: inspection.objects.map((object) =>
          object.externalId === '7f965334-0f81-4d4c-966b-6b3d9d969fa2'
            ? { ...object, parentId: 'different-parent-id' }
            : object,
        ),
      }),
    ],
    [
      'database option',
      (inspection: RecoveryInspection) => ({
        ...inspection,
        objects: inspection.objects.map((object) =>
          object.externalId === '7f965334-0f81-4d4c-966b-6b3d9d969fa2'
            ? {
                ...object,
                properties: object.properties.map((property) =>
                  property.name === 'Phase'
                    ? { ...property, options: ['Foundation', 'Later'] }
                    : property,
                ),
              }
            : object,
        ),
      }),
    ],
    [
      'required view',
      (inspection: RecoveryInspection) => ({
        ...inspection,
        objects: inspection.objects.map((object) =>
          object.externalId === 'ed157dff-ae92-44cd-af58-a3225dee46d9'
            ? { ...object, views: object.views.filter((view) => view.name !== 'Backlog') }
            : object,
        ),
      }),
    ],
    [
      'capability',
      (inspection: RecoveryInspection) => ({
        ...inspection,
        updateViewFilters: { ...inspection.updateViewFilters, supported: false },
      }),
    ],
  ])('detects material drift in %s', (_label, change) => {
    const changed = RecoveryInspectionSchema.parse(change(preExecutionCapturedShape));
    expect(recoverySemanticFingerprint(changed)).not.toBe(
      recoverySemanticFingerprint(originalCapturedShape),
    );
    expect(diffRecoverySemanticInspections(originalCapturedShape, changed)).not.toEqual([]);
  });
});
