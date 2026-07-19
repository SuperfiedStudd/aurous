import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  RecoveryInspectionSchema,
  compareRecoverySemanticInspections,
  diffRecoverySemanticInspections,
  recoverySemanticFingerprint,
  recoverySemanticInspection,
  type RecoveryInspection,
  type ViewFilterState,
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
    views: object.views.map((view) => legacyView(view, null)),
    limitations: ['Different pre-write verification prose.'],
  })),
  customStatusOptions: { supported: false, evidence: 'Verification prose.' },
  customSelectOptions: { supported: true, evidence: 'Verification prose.' },
  updateViewFilters: { supported: true, evidence: 'Verification prose.' },
  warnings: ['Verification warning.'],
});

const emptyAdvancedGroupPlannedShape = withTaskEmptyFilterSummary(
  noFilterConfiguredCapturedShape,
  'Advanced filter is an AND group containing zero filters.',
);

const emptyAdvancedGroupVerificationShape = RecoveryInspectionSchema.parse({
  ...withTaskEmptyFilterSummary(
    emptyAdvancedGroupPlannedShape,
    'No filters; exposed advanced filter is an empty AND group.',
  ),
  objects: [
    ...withTaskEmptyFilterSummary(
      emptyAdvancedGroupPlannedShape,
      'No filters; exposed advanced filter is an empty AND group.',
    ).objects,
  ].reverse(),
  customStatusOptions: { supported: false, evidence: 'Different verification prose.' },
  customSelectOptions: { supported: true, evidence: 'Different verification prose.' },
  updateViewFilters: { supported: true, evidence: 'Different verification prose.' },
  warnings: ['Different verification warning.'],
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

  it.each([
    'advanced filter is an and group containing zero filters.',
    'no filters; exposed advanced filter is an empty and group.',
    'empty and filter group',
    'and group containing zero filters',
    'advanced filter contains zero filters',
    'empty advanced filter group',
  ])('normalizes the explicit empty advanced-group representation %j', (filterSummary) => {
    expect(recoverySemanticFingerprint(singleFilterInspection(filterSummary))).toBe(
      recoverySemanticFingerprint(singleFilterInspection(null)),
    );
  });

  it('normalizes the two captured empty advanced-group differences to no semantic diff', async () => {
    const capturedDiff = JSON.parse(
      await readFile(
        new URL('./fixtures/recovery-empty-filter-group-diff.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{ path: string; expected: string; actual: string }>;

    expect(capturedDiff).toEqual([
      {
        path: '$.objects[3].views[0].filterState',
        expected: 'advanced filter is an and group containing zero filters.',
        actual: 'no filters; exposed advanced filter is an empty and group.',
      },
      {
        path: '$.objects[3].views[1].filterState',
        expected: 'advanced filter is an and group containing zero filters.',
        actual: 'no filters; exposed advanced filter is an empty and group.',
      },
    ]);
    expect(
      diffRecoverySemanticInspections(
        emptyAdvancedGroupPlannedShape,
        emptyAdvancedGroupVerificationShape,
      ),
    ).toEqual([]);
  });

  it('normalizes every captured legacy empty-filter artifact to typed none', async () => {
    const capturedRuns = JSON.parse(
      await readFile(
        new URL('./fixtures/recovery-typed-filter-state-runs.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{
      runId: string;
      planned: Array<string | null>;
      verification: Array<string | null>;
    }>;

    expect(capturedRuns.map((run) => run.runId)).toEqual([
      'run-20260719T032352Z-939347',
      'run-20260719T033850Z-d0c5a4',
      'run-20260719T035401Z-2679ce',
    ]);
    for (const run of capturedRuns) {
      const planned = legacyFilterListInspection(run.planned);
      const verification = legacyFilterListInspection(run.verification);
      expect(diffRecoverySemanticInspections(planned, verification), run.runId).toEqual([]);
      for (const inspection of [planned, verification]) {
        expect(
          recoverySemanticInspection(inspection).objects[0]?.views.map((view) => view.filterState),
          run.runId,
        ).toEqual(run.planned.map(() => ({ kind: 'none', conditionCount: 0, fingerprint: null })));
      }
    }
  });

  it('does not equate a real AND group containing one condition with an empty group', () => {
    const configured = singleTypedFilterInspection(configuredState());
    const empty = singleTypedFilterInspection(noFilterState());

    expect(diffRecoverySemanticInspections(configured, empty)).not.toEqual([]);
  });

  it.each([
    ['property', configuredState({ property: 'Priority' })],
    ['operator', configuredState({ operator: 'does_not_equal' })],
    ['value', configuredState({ value: '"Blocked"' })],
  ])('fails closed when a configured filter %s changes', (_label, changedState) => {
    const expected = singleTypedFilterInspection(configuredState());
    const actual = singleTypedFilterInspection(changedState);

    expect(diffRecoverySemanticInspections(expected, actual)).not.toEqual([]);
  });

  it('fails closed when the configured condition count changes', () => {
    const expected = singleTypedFilterInspection(configuredState());
    const actual = singleTypedFilterInspection(twoConditionState());

    expect(diffRecoverySemanticInspections(expected, actual)).not.toEqual([]);
  });

  it('fails closed when nested group structure changes', () => {
    const expected = singleTypedFilterInspection(nestedConfiguredState('and'));
    const actual = singleTypedFilterInspection(nestedConfiguredState('or'));

    expect(diffRecoverySemanticInspections(expected, actual)).not.toEqual([]);
  });

  it('canonicalizes configured fingerprint node ordering', () => {
    const ordered = configuredState();
    if (ordered.kind !== 'configured') throw new Error('Expected configured state.');
    const reversed: ViewFilterState = {
      ...ordered,
      fingerprint: { nodes: [...ordered.fingerprint.nodes].reverse() },
    };

    expect(
      diffRecoverySemanticInspections(
        singleTypedFilterInspection(ordered),
        singleTypedFilterInspection(reversed),
      ),
    ).toEqual([]);
  });

  it('rejects configured filter states whose count is zero or mismatches the fingerprint', () => {
    const configured = configuredState();
    if (configured.kind !== 'configured') throw new Error('Expected configured state.');
    expect(() =>
      singleTypedFilterInspection({
        kind: 'configured',
        conditionCount: 0,
        fingerprint: configured.fingerprint,
      }),
    ).toThrow();
    expect(() =>
      singleTypedFilterInspection({
        ...configured,
        conditionCount: 2,
      }),
    ).toThrow();
  });

  it('fails closed when a real filter is removed', () => {
    const expected = singleTypedFilterInspection(configuredState());
    const actual = singleTypedFilterInspection(noFilterState());

    expect(diffRecoverySemanticInspections(expected, actual)).not.toEqual([]);
  });

  it('treats identical typed unknown states as unchanged and reports their paths', () => {
    const unknown = singleTypedFilterInspection(unknownFilterState());
    const sameUnknown = singleTypedFilterInspection(unknownFilterState());

    expect(compareRecoverySemanticInspections(unknown, sameUnknown)).toEqual({
      differences: [],
      stableUnknownFilterPaths: ['$.objects[0].views[0].filterState'],
    });
  });

  it('fails closed when unknown is compared with none or configured', () => {
    const unknown = singleTypedFilterInspection(unknownFilterState());
    const empty = singleTypedFilterInspection(noFilterState());
    const configured = singleTypedFilterInspection(configuredState());

    expect(diffRecoverySemanticInspections(empty, unknown)).not.toEqual([]);
    expect(diffRecoverySemanticInspections(unknown, configured)).not.toEqual([]);
  });

  it.each([
    ['conditionCount', { kind: 'unknown', conditionCount: 1, fingerprint: null }],
    [
      'fingerprint',
      {
        kind: 'unknown',
        conditionCount: null,
        fingerprint: configuredState().kind === 'configured' ? configuredState().fingerprint : null,
      },
    ],
  ])('fails closed when an unknown filter %s changes', (_label, changedState) => {
    const expected = singleTypedFilterInspection(unknownFilterState());
    const actual = structuredClone(expected);
    actual.objects[0]!.views[0]!.filterState = changedState as ViewFilterState;

    expect(diffRecoverySemanticInspections(expected, actual)).not.toEqual([]);
  });

  it('converts identical ambiguous legacy prose to stable unknown', () => {
    const legacy = singleFilterInspection('Status equals "Backlog"');
    const sameLegacy = singleFilterInspection('Status equals "Backlog"');

    expect(recoverySemanticInspection(legacy).objects[0]?.views[0]?.filterState).toEqual(
      unknownFilterState(),
    );
    expect(compareRecoverySemanticInspections(legacy, sameLegacy)).toEqual({
      differences: [],
      stableUnknownFilterPaths: ['$.objects[0].views[0].filterState'],
    });
  });

  it('matches the exact seven stable unknown paths from run-20260719T042308Z-f4ec1a', async () => {
    const capturedDiff = JSON.parse(
      await readFile(
        new URL('./fixtures/recovery-stable-unknown-filter-diff.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{
      path: string;
      expected: ViewFilterState;
      actual: ViewFilterState;
    }>;
    const expected = stableUnknownCapturedInspection();
    const actual = stableUnknownCapturedInspection();

    expect(capturedDiff).toHaveLength(7);
    expect(
      capturedDiff.every(
        (entry) => JSON.stringify(entry.expected) === JSON.stringify(entry.actual),
      ),
    ).toBe(true);
    expect(compareRecoverySemanticInspections(expected, actual)).toEqual({
      differences: [],
      stableUnknownFilterPaths: capturedDiff.map((entry) => entry.path),
    });
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

function singleTypedFilterInspection(filterState: ViewFilterState): RecoveryInspection {
  return RecoveryInspectionSchema.parse({
    objects: [
      {
        ...inspectionObject('action-003', 'database', 'Milestone Tracker', []),
        views: [{ name: 'Status Board', type: 'board', filterState }],
      },
    ],
    customStatusOptions: { supported: false, evidence: 'Capability prose.' },
    customSelectOptions: { supported: true, evidence: 'Capability prose.' },
    updateViewFilters: { supported: true, evidence: 'Capability prose.' },
    warnings: [],
  });
}

function legacyFilterListInspection(filterSummaries: Array<string | null>): RecoveryInspection {
  return RecoveryInspectionSchema.parse({
    objects: [
      inspectionObject(
        'action-005',
        'database',
        'Task Database',
        filterSummaries.map((filterSummary, index) => ({
          name: `Captured view ${String(index).padStart(2, '0')}`,
          type: 'table',
          filterSummary,
        })),
      ),
    ],
    customStatusOptions: { supported: false, evidence: 'Captured capability prose.' },
    customSelectOptions: { supported: true, evidence: 'Captured capability prose.' },
    updateViewFilters: { supported: true, evidence: 'Captured capability prose.' },
    warnings: [],
  });
}

function stableUnknownCapturedInspection(): RecoveryInspection {
  const unknown = unknownFilterState();
  const none = noFilterState();
  return RecoveryInspectionSchema.parse({
    objects: [
      inspectionObject('action-001', 'page', 'Aurous Product HQ', []),
      inspectionObject('action-002', 'page', 'Project Overview', []),
      {
        ...inspectionObject('action-003', 'database', 'Milestone Tracker', []),
        views: [
          { name: 'All Milestones', type: 'table', filterState: unknown },
          { name: 'Default view', type: 'table', filterState: unknown },
          { name: 'Delivery Timeline', type: 'timeline', filterState: unknown },
          { name: 'Status Board', type: 'board', filterState: unknown },
        ],
      },
      {
        ...inspectionObject('action-005', 'database', 'Task Database', []),
        views: [
          { name: 'Backlog', type: 'table', filterState: none },
          { name: 'Blocked', type: 'table', filterState: none },
          { name: 'By Milestone', type: 'table', filterState: unknown },
          { name: 'Default view', type: 'table', filterState: unknown },
          { name: 'Work Board', type: 'board', filterState: unknown },
        ],
      },
    ],
    customStatusOptions: { supported: false, evidence: 'Captured capability prose.' },
    customSelectOptions: { supported: true, evidence: 'Captured capability prose.' },
    updateViewFilters: { supported: true, evidence: 'Captured capability prose.' },
    warnings: [],
  });
}

function noFilterState(): ViewFilterState {
  return { kind: 'none', conditionCount: 0, fingerprint: null };
}

function unknownFilterState(): ViewFilterState {
  return { kind: 'unknown', conditionCount: null, fingerprint: null };
}

function configuredState(
  overrides: { property?: string; operator?: string; value?: string } = {},
): ViewFilterState {
  return {
    kind: 'configured',
    conditionCount: 1,
    fingerprint: {
      nodes: [
        { path: '$', kind: 'and', property: null, operator: null, value: null },
        {
          path: '$.conditions[0]',
          kind: 'condition',
          property: overrides.property ?? 'Status',
          operator: overrides.operator ?? 'equals',
          value: overrides.value ?? '"Backlog"',
        },
      ],
    },
  };
}

function twoConditionState(): ViewFilterState {
  const first = configuredState();
  if (first.kind !== 'configured') throw new Error('Expected a configured fixture.');
  return {
    kind: 'configured',
    conditionCount: 2,
    fingerprint: {
      nodes: [
        ...first.fingerprint.nodes,
        {
          path: '$.conditions[1]',
          kind: 'condition',
          property: 'Priority',
          operator: 'equals',
          value: '"High"',
        },
      ],
    },
  };
}

function nestedConfiguredState(groupKind: 'and' | 'or'): ViewFilterState {
  return {
    kind: 'configured',
    conditionCount: 1,
    fingerprint: {
      nodes: [
        { path: '$', kind: 'and', property: null, operator: null, value: null },
        {
          path: '$.conditions[0]',
          kind: groupKind,
          property: null,
          operator: null,
          value: null,
        },
        {
          path: '$.conditions[0].conditions[0]',
          kind: 'condition',
          property: 'Status',
          operator: 'equals',
          value: '"Backlog"',
        },
      ],
    },
  };
}

function legacyView(
  view: RecoveryInspection['objects'][number]['views'][number],
  filterSummary: string | null,
) {
  return { name: view.name, type: view.type, filterSummary };
}

function withTaskEmptyFilterSummary(
  inspection: RecoveryInspection,
  filterSummary: string,
): RecoveryInspection {
  return RecoveryInspectionSchema.parse({
    ...inspection,
    objects: inspection.objects.map((object) =>
      object.actionId === 'action-005'
        ? {
            ...object,
            views: object.views.map((view) =>
              view.name === 'Backlog' || view.name === 'Blocked'
                ? legacyView(view, filterSummary)
                : view,
            ),
          }
        : object,
    ),
  });
}
