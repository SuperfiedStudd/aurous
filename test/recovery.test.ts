import { describe, expect, it } from 'vitest';
import {
  RecoveryPlanSchema,
  buildRecoveryPlan,
  type RecoveryInspection,
} from '../src/domain/recovery.js';
import type { AurousPlan, ExecutionResult } from '../src/domain/schemas.js';

const createdAt = '2026-07-19T02:00:00.000Z';

function fixture() {
  const plan: AurousPlan = {
    schemaVersion: 1,
    runId: 'run-20260719T010000Z-aaaaaa',
    createdAt,
    agent: 'codex',
    tool: 'notion',
    objective: 'Build a small workspace',
    contextSummary: {
      approvedPaths: ['README.md'],
      files: [],
      fileCount: 0,
      totalBytes: 0,
      skipped: [],
    },
    proposedWorkspaceStructure: [
      { kind: 'page', name: 'HQ', purpose: 'Root' },
      { kind: 'database', name: 'Tasks', purpose: 'Work', parent: 'HQ' },
      { kind: 'database-record-set', name: 'Starter tasks', purpose: 'Seed', parent: 'Tasks' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'page',
        target: 'HQ',
        description: 'Create root.',
        properties: [],
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'database',
        target: 'Tasks',
        description: 'Create tasks.',
        properties: [
          { key: 'notion.parent', value: 'HQ' },
          {
            key: 'notion.database.properties',
            value: JSON.stringify([
              { name: 'Task', type: 'title' },
              { name: 'Status', type: 'status' },
            ]),
          },
          {
            key: 'notion.database.statuses',
            value: JSON.stringify([
              { name: 'Backlog', group: 'To do' },
              { name: 'Blocked', group: 'In progress' },
              { name: 'Done', group: 'Complete' },
            ]),
          },
        ],
        dependsOn: ['action-001'],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'database-record-set',
        target: 'Starter tasks',
        description: 'Create records.',
        properties: [{ key: 'notion.database', value: 'Tasks' }],
        dependsOn: ['action-002'],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'Workspace ready.',
  };
  const result: ExecutionResult = {
    status: 'partial',
    summary: 'Stopped after partial database creation.',
    createdObjects: [
      {
        actionId: 'action-001',
        type: 'page',
        name: 'HQ',
        externalId: 'page-id',
        url: 'https://notion.so/page-id',
      },
      {
        actionId: 'action-002',
        type: 'database',
        name: 'Tasks',
        externalId: 'database-id',
        url: 'https://notion.so/database-id',
      },
    ],
    completedActionIds: ['action-001'],
    warnings: [],
    failures: [],
    startedAt: createdAt,
    finishedAt: createdAt,
  };
  const inspection: RecoveryInspection = {
    objects: [
      {
        actionId: 'action-001',
        externalId: 'page-id',
        url: 'https://notion.so/page-id',
        found: true,
        objectType: 'page',
        title: 'HQ',
        parentId: null,
        properties: [],
        views: [],
        recordCount: null,
        limitations: [],
      },
      {
        actionId: 'action-002',
        externalId: 'database-id',
        url: 'https://notion.so/database-id',
        found: true,
        objectType: 'database',
        title: 'Tasks',
        parentId: 'page-id',
        properties: [
          { name: 'Task', type: 'title', options: [] },
          {
            name: 'Status',
            type: 'status',
            options: ['Not started', 'In progress', 'Done'],
          },
        ],
        views: [],
        recordCount: 0,
        limitations: [],
      },
    ],
    customStatusOptions: { supported: false, evidence: 'Not exposed by MCP.' },
    customSelectOptions: { supported: true, evidence: 'Explicit options supported.' },
    updateViewFilters: { supported: true, evidence: 'View updates supported.' },
    warnings: [],
  };
  return { plan, result, inspection };
}

describe('partial-run recovery planning', () => {
  it('classifies completed, partially completed, and pending actions', () => {
    const { plan, result, inspection } = fixture();
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.classifications.map(({ actionId, status }) => ({ actionId, status }))).toEqual([
      { actionId: 'action-001', status: 'completed' },
      { actionId: 'action-002', status: 'partially_completed' },
      { actionId: 'action-003', status: 'pending' },
    ]);
  });

  it('skips completed work and updates the exact persisted database ID', () => {
    const { plan, result, inspection } = fixture();
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.plannedActions.map((action) => action.id)).toEqual([
      'action-002',
      'action-003',
    ]);
    expect(recovery.plannedActions[0]).toMatchObject({ operation: 'update', target: 'Tasks' });
    expect(
      recovery.plannedActions[0]?.properties.find(
        (property) => property.key === 'notion.recovery.externalId',
      )?.value,
    ).toBe('database-id');
    expect(recovery.destructiveActions).toEqual([]);
  });

  it('converts unsupported custom Status definitions to explicit Select options', () => {
    const { plan, result, inspection } = fixture();
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.compatibilityDecisions[0]).toMatchObject({
      property: 'Status',
      approvedType: 'Notion Status',
      recoveryType: 'Notion Select',
    });
    const encoded = recovery.plannedActions[0]?.properties.find(
      (property) => property.key === 'notion.database.properties',
    )?.value;
    expect(JSON.parse(encoded ?? '[]')).toContainEqual({
      name: 'Status',
      type: 'select',
      options: ['Backlog', 'Blocked', 'Done'],
    });
  });

  it('blocks when neither custom Status nor explicit Select options are supported', () => {
    const { plan, result, inspection } = fixture();
    inspection.customSelectOptions = { supported: false, evidence: 'Unavailable.' };
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.isExecutable).toBe(false);
    expect(recovery.classifications.find((item) => item.actionId === 'action-002')?.status).toBe(
      'blocked',
    );
    expect(recovery.classifications.find((item) => item.actionId === 'action-003')?.status).toBe(
      'blocked',
    );
  });

  it('blocks repair of an existing filtered view when the MCP cannot update filters', () => {
    const { plan, result, inspection } = fixture();
    plan.plannedActions[1]?.properties.push({
      key: 'notion.database.views',
      value: JSON.stringify([{ name: 'Backlog', type: 'table', filter: { Status: 'Backlog' } }]),
    });
    inspection.objects[1]?.views.push({
      name: 'Backlog',
      type: 'table',
      filterState: { kind: 'none', conditionCount: 0, fingerprint: null },
    });
    inspection.updateViewFilters = { supported: false, evidence: 'Unavailable.' };
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.isExecutable).toBe(false);
    expect(recovery.classifications.find((item) => item.actionId === 'action-002')).toMatchObject({
      status: 'blocked',
      recoveryOperation: 'block',
    });
  });

  it('treats a same-name or mismatched exact ID as drift and never plans duplicate creation', () => {
    const { plan, result, inspection } = fixture();
    inspection.objects[1] = { ...inspection.objects[1]!, externalId: 'same-name-other-id' };
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.isExecutable).toBe(false);
    expect(recovery.classifications.find((item) => item.actionId === 'action-002')).toMatchObject({
      status: 'drifted',
      recoveryOperation: 'block',
      externalId: 'database-id',
    });
    expect(recovery.plannedActions.some((action) => action.target === 'Tasks')).toBe(false);
  });

  it('keeps explicitly non-written dependency failures pending but blocks ambiguous attempts', () => {
    const { plan, result, inspection } = fixture();
    result.failures.push(
      {
        actionId: 'action-003',
        code: 'AUR-APPLY-001',
        summary: 'Starter tasks were not created.',
        probableCause: 'The database dependency was incomplete.',
        nextAction: 'Complete the dependency first.',
        severity: 'recoverable',
      },
      {
        actionId: 'action-004',
        code: 'AUR-MCP-099',
        summary: 'The external response was lost.',
        probableCause: 'Transport interruption.',
        nextAction: 'Inspect before retrying.',
        severity: 'recoverable',
      },
    );
    plan.plannedActions.push({
      id: 'action-004',
      operation: 'create',
      objectType: 'page',
      target: 'Ambiguous page',
      description: 'Potentially written.',
      properties: [],
      dependsOn: [],
    });
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.classifications.find((item) => item.actionId === 'action-003')?.status).toBe(
      'pending',
    );
    expect(recovery.classifications.find((item) => item.actionId === 'action-004')).toMatchObject({
      status: 'blocked',
      recoveryOperation: 'block',
    });
  });

  it('never trusts partial-write prose to authorize re-creation without the structured no-write code', () => {
    const { plan, result, inspection } = fixture();
    result.failures.push({
      actionId: 'action-003',
      code: 'AUR-MCP-050',
      summary: 'The record set was created but its views were not configured.',
      probableCause: 'The MCP write partially applied before stopping.',
      nextAction: 'Inspect the record set before retrying.',
      severity: 'recoverable',
    });
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    expect(recovery.classifications.find((item) => item.actionId === 'action-003')).toMatchObject({
      status: 'blocked',
      recoveryOperation: 'block',
    });
    expect(recovery.plannedActions.some((action) => action.target === 'Starter tasks')).toBe(false);
    expect(recovery.isExecutable).toBe(false);
  });

  it('loads legacy persisted recovery-plan filter prose through the typed boundary', () => {
    const { plan, result, inspection } = fixture();
    const recovery = buildRecoveryPlan({
      recoveryRunId: 'run-20260719T020000Z-bbbbbb',
      originalPlan: plan,
      originalResult: result,
      inspection,
      createdAt,
    });
    const stored = JSON.parse(JSON.stringify(recovery)) as {
      inspection: { objects: Array<{ actionId: string; views: unknown[] }> };
    };
    const database = stored.inspection.objects.find((object) => object.actionId === 'action-002');
    if (!database) throw new Error('Expected stored database inspection.');
    database.views = [{ name: 'Backlog', type: 'table', filterSummary: 'No filter configured' }];

    const parsed = RecoveryPlanSchema.parse(stored);
    expect(parsed.inspection.objects[1]?.views[0]?.filterState).toEqual({
      kind: 'none',
      conditionCount: 0,
      fingerprint: null,
    });
  });
});
