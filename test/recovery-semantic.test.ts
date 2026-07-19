import { readFile } from 'node:fs/promises';
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

const noFilterConfiguredCapturedShape = RecoveryInspectionSchema.parse({
  objects: [
    inspectionObject('action-001', 'page', 'Aurous Product HQ', []),
    inspectionObject('action-002', 'page', 'Project Overview', []),
    inspectionObject('action-003', 'database', 'Milestone Tracker', [
      { name: 'Default view', type: 'table', filterSummary: 'No filter configured' },
      { name: 'All Milestones', type: 'table', filterSummary: 'No filter configured' },
      { name: 'Status Board', type: 'board', filterSummary: 'No filter configured' },
      { name: 'Delivery Timeline', type: 'timeline', filterSummary: 'No filter configured' },
    ]),
    inspectionObject('action-005', 'database', 'Task Database', [
      {
        name: 'Backlog',
        type: 'table',
        filterSummary: 'No filters (empty AND filter group)',
      },
      {
        name: 'Blocked',
        type: 'table',
        filterSummary: 'No filters (empty AND filter group)',
      },
      { name: 'By Milestone', type: 'table', filterSummary: 'No filter configured' },
      { name: 'Default view', type: 'table', filterSummary: 'No filter configured' },
      { name: 'Work Board', type: 'board', filterSummary: 'No filter configured' },
    ]),
  ],
  customStatusOptions: { supported: false, evidence: 'Planning inspection prose.' },
  customSelectOptions: { supported: true, evidence: 'Planning inspection prose.' },
  updateViewFilters: { supported: true, evidence: 'Planning inspection prose.' },
  warnings: ['Planning inspection warning.'],
});

const nullFilterCapturedShape = RecoveryInspectionSchema.parse({
  ...noFilterConfiguredCapturedShape,
  objects: noFilterConfiguredCapturedShape.objects.map((object) => ({
    ...object,
    views: object.views.map((view) => ({ ...view, filterSummary: null })),
    limitations: ['Different pre-write verification prose.'],
  })),
  customStatusOptions: { supported: false, evidence: 'Verification prose.' },
  customSelectOptions: { supported: true, evidence: 'Verification prose.' },
  updateViewFilters: { supported: true, evidence: 'Verification prose.' },
  warnings: ['Verification warning.'],
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
    null,
    '',
    'no filter configured',
    'no filters configured',
    'no active filters',
    'no filter',
    'empty filter',
    'empty AND filter group',
    '0 filters',
  ])('normalizes the explicit empty-filter representation %j', (filterSummary) => {
    expect(recoverySemanticFingerprint(singleFilterInspection(filterSummary))).toBe(
      recoverySemanticFingerprint(singleFilterInspection(null)),
    );
  });

  it('normalizes all seven captured no-filter-configured differences to no semantic diff', async () => {
    const capturedDiff = JSON.parse(
      await readFile(
        new URL('./fixtures/recovery-no-filter-configured-diff.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{ path: string; expected: string; actual: null }>;

    expect(capturedDiff).toHaveLength(7);
    expect(
      capturedDiff.every(
        ({ expected, actual }) => expected === 'no filter configured' && actual === null,
      ),
    ).toBe(true);
    expect(
      diffRecoverySemanticInspections(noFilterConfiguredCapturedShape, nullFilterCapturedShape),
    ).toEqual([]);
  });

  it('fails closed when a real filter condition changes', () => {
    const expected = singleFilterInspection('Status equals "Backlog"');
    const actual = singleFilterInspection('Status equals "Blocked"');

    expect(diffRecoverySemanticInspections(expected, actual)).toEqual([
      {
        path: '$.objects[0].views[0].filterState',
        expected: 'status equals "backlog"',
        actual: 'status equals "blocked"',
      },
    ]);
  });

  it('fails closed when a real filter is removed', () => {
    const expected = singleFilterInspection('Status equals "Unknown"');
    const actual = singleFilterInspection('no filter configured');

    expect(diffRecoverySemanticInspections(expected, actual)).toEqual([
      {
        path: '$.objects[0].views[0].filterState',
        expected: 'status equals "unknown"',
        actual: null,
      },
    ]);
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

function inspectionObject(
  actionId: string,
  objectType: 'page' | 'database',
  title: string,
  views: Array<{ name: string; type: string; filterSummary: string | null }>,
) {
  return {
    actionId,
    externalId: `${actionId}-exact-id`,
    url: `https://app.notion.com/p/${actionId}`,
    found: true,
    objectType,
    title,
    parentId: objectType === 'page' && actionId === 'action-001' ? null : 'action-001-exact-id',
    properties: [],
    views,
    recordCount: null,
    limitations: ['Captured inspection prose.'],
  };
}

function singleFilterInspection(filterSummary: string | null): RecoveryInspection {
  return RecoveryInspectionSchema.parse({
    objects: [
      inspectionObject('action-003', 'database', 'Milestone Tracker', [
        { name: 'Status Board', type: 'board', filterSummary },
      ]),
    ],
    customStatusOptions: { supported: false, evidence: 'Capability prose.' },
    customSelectOptions: { supported: true, evidence: 'Capability prose.' },
    updateViewFilters: { supported: true, evidence: 'Capability prose.' },
    warnings: [],
  });
}
