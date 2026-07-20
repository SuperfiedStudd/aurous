import { describe, expect, it } from 'vitest';
import { AirtableAdapter } from '../src/adapters/productivity/airtable.js';
import { buildPlanningPrompt } from '../src/adapters/agents/prompts.js';
import { normalizedObjectType } from '../src/adapters/productivity/exact-bindings.js';
import type { ContextPack, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const destination: ResolvedDestination = {
  integration: 'airtable',
  id: 'wsp_build_week',
  name: 'Build Week',
  kind: 'workspace',
  source: 'only-choice',
  sourceDetail: 'One writable workspace.',
  verifiedAt: '2026-07-20T00:00:00.000Z',
  existingObjects: [
    {
      id: 'app_hq',
      name: 'Aurous Build Week HQ',
      type: 'base',
      destinationId: 'wsp_build_week',
      url: 'https://airtable.com/app_hq',
    },
  ],
  discoveryWarnings: [],
};

/** Bounded sanitized snapshot from discovery-20260720T031132Z-0e2671 (not a second live run). */
const reuseDestination: ResolvedDestination = {
  integration: 'airtable',
  id: 'wsphk1OmoSFXlTmwM',
  name: 'My First Workspace',
  kind: 'workspace',
  source: 'existing-match',
  sourceDetail: 'Exact existing Aurous Build Week HQ base was inspected.',
  verifiedAt: '2026-07-20T03:12:58.481Z',
  existingObjects: [
    {
      id: 'apptXzRq0zEfjhz4X',
      name: 'Aurous Build Week HQ',
      type: 'airtable.base',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'wsphk1OmoSFXlTmwM',
    },
    {
      id: 'tblxpUvoq8TfoFUKW',
      name: 'Workstreams',
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'apptXzRq0zEfjhz4X',
    },
    {
      id: 'tbl2II3FoagbaK7bn',
      name: 'Tasks',
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'apptXzRq0zEfjhz4X',
    },
    {
      id: 'tblzDn026xkRMGanS',
      name: 'Integrations',
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'apptXzRq0zEfjhz4X',
    },
    {
      id: 'fldoeYUEMXMJp5bUB',
      name: 'Workstream',
      type: 'airtable.field',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tbl2II3FoagbaK7bn',
    },
    {
      id: 'fldwFFJ3qjePsyQQm',
      name: 'Readiness',
      type: 'airtable.field',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tblzDn026xkRMGanS',
    },
    {
      id: 'recAELdj1f2Fnp5gM',
      name: 'Complete README',
      type: 'airtable.record',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tbl2II3FoagbaK7bn',
    },
  ],
  discoveryWarnings: [
    'An exact existing base named "Aurous Build Week HQ" was inspected and already contains exactly the requested Workstreams, Tasks, and Integrations tables.',
    'Another accessible base named "Untitled Base" exists; it is not a project match and should not be repurposed for this launch.',
  ],
};

const contextPack: ContextPack = {
  schemaVersion: 1,
  project: {
    name: 'aurous',
    root: '/project',
    technology: ['TypeScript'],
    commands: ['npm run check'],
  },
  activeIntegrations: [],
  destinations: [],
  workspacePreferences: { verbose: false },
  updatedAt: '2026-07-20T00:00:00.000Z',
};

describe('Airtable productivity adapter', () => {
  it('binds exact workspace and inspected base identities without a fabricated base ID', () => {
    const adapter = new AirtableAdapter();
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [
          { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
        ],
        plannedActions: [
          {
            id: 'action-001',
            operation: 'create',
            objectType: 'base',
            target: 'Aurous Build Week HQ',
            description: 'Reuse exact base.',
            properties: [],
            dependsOn: [],
          },
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Airtable base is ready.',
      },
      destination,
    );
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'airtable.workspaceId', value: 'wsp_build_week' },
        { key: 'airtable.dedupe.knownExternalId', value: 'app_hq' },
      ]),
    );
    expect(adapter.destinationPlanningInstructions(destination)).toContain('airtable.baseActionId');
  });

  it('requires bootstrap tables on new-base plans and names the three launch tables', () => {
    const instructions = new AirtableAdapter().destinationPlanningInstructions(destination);
    expect(instructions).toContain('airtable.base.initialTables');
    expect(instructions).toContain('Workstreams');
    expect(instructions).toContain('Tasks');
    expect(instructions).toContain('Integrations');
    expect(instructions).toContain('airtable.bootstrapTableName');
    expect(new AirtableAdapter().planningInstructions('Launch HQ')).toContain(
      'airtable.base.initialTables',
    );
  });

  it('injects the same normalized Context Pack v1 into Airtable planning prompts', () => {
    const prompt = buildPlanningPrompt(
      'Create a small launch base.',
      {
        summary: {
          approvedPaths: ['/project'],
          files: [],
          fileCount: 0,
          totalBytes: 0,
          skipped: [],
        },
        documents: [],
      },
      contextPack,
      new AirtableAdapter(),
      destination,
    );
    expect(prompt).toContain('Normalized reusable Context Pack v1');
    expect(prompt).toContain('"name": "aurous"');
    expect(prompt).toContain('airtable.workspaceId');
  });

  it('normalizes Airtable MCP object aliases used by the planner and discovery', () => {
    expect(normalizedObjectType('airtable.base')).toBe('base');
    expect(normalizedObjectType('airtable_field')).toBe('field');
    expect(normalizedObjectType('airtable.records')).toBe('record');
    expect(normalizedObjectType('airtable.record')).toBe('record');
    expect(normalizedObjectType('airtable.table')).toBe('table');
  });

  it('stamps exact reuse IDs from a sanitized discovery snapshot instead of duplicate creates', () => {
    const adapter = new AirtableAdapter();
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'base', name: 'Aurous Build Week HQ', purpose: 'Launch HQ' },
        { kind: 'table', name: 'Workstreams', purpose: 'Track workstreams.' },
        { kind: 'table', name: 'Tasks', purpose: 'Track tasks.' },
        { kind: 'table', name: 'Integrations', purpose: 'Track integrations.' },
        { kind: 'field', name: 'Readiness', purpose: 'Integration readiness.' },
        { kind: 'record', name: 'Complete README', purpose: 'README task.' },
      ],
      plannedActions: [
        airtableAction('action-001', 'base', 'Aurous Build Week HQ', 'Create or reuse the base.'),
        airtableAction('action-002', 'table', 'Workstreams', 'Create or reuse Workstreams.'),
        airtableAction('action-003', 'table', 'Tasks', 'Create or reuse Tasks.'),
        airtableAction('action-004', 'table', 'Integrations', 'Create or reuse Integrations.'),
        airtableAction('action-005', 'field', 'Readiness', 'Create or reuse Readiness.'),
        airtableAction('action-006', 'records', 'Complete README', 'Create or reuse README task.'),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Existing Airtable objects are reused by exact ID.',
    };

    const bound = adapter.bindDestination(proposal, reuseDestination);
    const knownIds = bound.plannedActions.map(
      (action) =>
        action.properties.find((property) => property.key === 'airtable.dedupe.knownExternalId')
          ?.value,
    );

    expect(knownIds).toEqual([
      'apptXzRq0zEfjhz4X',
      'tblxpUvoq8TfoFUKW',
      'tbl2II3FoagbaK7bn',
      'tblzDn026xkRMGanS',
      'fldwFFJ3qjePsyQQm',
      'recAELdj1f2Fnp5gM',
    ]);
    expect(bound.plannedActions.every((action) => action.description.startsWith('Reuse'))).toBe(
      true,
    );
    expect(bound.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Untitled Base'),
        expect.stringContaining('Workstreams, Tasks, and Integrations'),
      ]),
    );
  });
});

function airtableAction(
  id: string,
  objectType: string,
  target: string,
  description: string,
): PlanProposal['plannedActions'][number] {
  return {
    id,
    operation: 'create',
    objectType,
    target,
    description,
    properties: [],
    dependsOn: [],
  };
}
