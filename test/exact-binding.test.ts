import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { AirtableAdapter } from '../src/adapters/productivity/airtable.js';
import { LinearAdapter } from '../src/adapters/productivity/linear.js';
import { NotionAdapter } from '../src/adapters/productivity/notion.js';
import {
  isSyntheticRelationshipTarget,
  normalizedObjectType,
  resolveExactObject,
} from '../src/adapters/productivity/exact-bindings.js';
import { asAurousError, AurousError } from '../src/core/errors.js';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

/** Sanitized Airtable fixture modeled on run-20260720T193822Z-aac054. */
const airtableDestination: ResolvedDestination = {
  integration: 'airtable',
  id: 'wsphk1OmoSFXlTmwM',
  name: 'My First Workspace',
  kind: 'workspace',
  source: 'existing-match',
  sourceDetail: 'Exact existing Aurous Build Week HQ base was inspected.',
  verifiedAt: '2026-07-20T19:38:22.000Z',
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
      id: 'tblOther',
      name: 'Tasks',
      type: 'airtable.table',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'apptOther',
    },
    {
      id: 'fldoeYUEMXMJp5bUB',
      name: 'Workstream',
      type: 'airtable.field',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tbl2II3FoagbaK7bn',
    },
    {
      id: 'recAELdj1f2Fnp5gM',
      name: 'Complete README',
      type: 'airtable.record',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tbl2II3FoagbaK7bn',
    },
    {
      id: 'rec4Tn5BNce63bHHN',
      name: 'Launch deliverables',
      type: 'airtable.record',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tblxpUvoq8TfoFUKW',
    },
    {
      id: 'recSameNameOtherTable',
      name: 'Complete README',
      type: 'airtable.record',
      destinationId: 'wsphk1OmoSFXlTmwM',
      parentId: 'tblOther',
    },
  ],
  discoveryWarnings: [],
};

/** Sanitized Linear fixture modeled on run-20260720T194305Z-75a5e1 (UUID identity). */
const linearIssueUuid = '11111111-2222-4333-8444-555555555555';
const linearDestination: ResolvedDestination = {
  integration: 'linear',
  id: 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b',
  name: 'JasjyotSingh',
  kind: 'team',
  source: 'saved-project',
  sourceDetail: 'Reverified saved team.',
  verifiedAt: '2026-07-20T19:43:05.000Z',
  existingObjects: [
    {
      id: '58f32b14-0b3d-4da3-8b41-91280ad54a8e',
      name: 'Aurous — Build Week Launch',
      type: 'project',
      destinationId: 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b',
      parentId: 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b',
    },
    {
      id: linearIssueUuid,
      name: 'Complete the README for Build Week launch',
      type: 'issue',
      destinationId: 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b',
      parentId: '58f32b14-0b3d-4da3-8b41-91280ad54a8e',
      identifier: 'JAS-17',
      url: 'https://linear.app/jasjyotsingh/issue/JAS-17/complete-the-readme-for-build-week-launch',
    },
    {
      id: '22222222-3333-4444-8555-666666666666',
      name: 'Complete the README for Build Week launch',
      type: 'issue',
      destinationId: 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b',
      parentId: 'project-other',
      identifier: 'JAS-99',
    },
  ],
  discoveryWarnings: [],
};

/** Sanitized Notion fixture modeled on run-20260720T194655Z-9ba581. */
const notionDestination: ResolvedDestination = {
  integration: 'notion',
  id: '3a2c0122-d292-8130-bde0-f68012dac01a',
  name: 'Aurous Product HQ',
  kind: 'page',
  source: 'existing-match',
  sourceDetail: 'Exact Product HQ page inspected.',
  verifiedAt: '2026-07-20T19:46:55.000Z',
  existingObjects: [
    {
      id: '3a2c0122-d292-81ed-b4f6-eab2abb2f67c',
      name: 'Complete the README',
      type: 'page',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: '74fc2fce-1fa1-481f-a412-4c2e405ada3e',
    },
    {
      id: '3a2c0122-d292-815c-942c-fb042aeb9112',
      name: 'README completion',
      type: 'page',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: '12d311ca-096e-4f82-8edd-2a438f8f4841',
    },
    {
      id: 'page-other-db-readme',
      name: 'README completion',
      type: 'page',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: 'data-source-other',
    },
    {
      id: 'prop-related-task-readme',
      name: 'Related Task',
      type: 'notion.property',
      destinationId: '3a2c0122-d292-8130-bde0-f68012dac01a',
      parentId: '12d311ca-096e-4f82-8edd-2a438f8f4841',
      identifier: 'relation',
      linkedIds: ['74fc2fce-1fa1-481f-a412-4c2e405ada3e'],
    },
  ],
  discoveryWarnings: [],
};

describe('exact-ID binding for reuse, update, and relations', () => {
  it('treats Linear/Notion type aliases as normalized object kinds', () => {
    expect(normalizedObjectType('Linear issue')).toBe('issue');
    expect(normalizedObjectType('notion.database_record_relation')).toBe('database_record');
    expect(normalizedObjectType('airtable.record')).toBe('record');
  });

  it('does not treat IDs embedded only in prose as structured authorization', () => {
    expect(
      isSyntheticRelationshipTarget(
        'Existing README task 3a2c0122-d292-81ed-b4f6-eab2abb2f67c and existing README completion checklist record 3a2c0122-d292-815c-942c-fb042aeb9112',
      ),
    ).toBe(true);
    expect(
      isSyntheticRelationshipTarget(
        'Link the existing Complete README task to the existing Launch deliverables workstream',
      ),
    ).toBe(true);
  });

  it('binds Airtable relation updates to the exact task record and linked workstream IDs', () => {
    const adapter = new AirtableAdapter();
    const bound = adapter.bindDestination(airtableRelationProposal(), airtableDestination);
    const action = bound.plannedActions[0]!;

    expect(action.target).toBe('Complete README');
    expect(action.objectType).toBe('airtable.record');
    expect(action.properties).toEqual(
      expect.arrayContaining([
        { key: 'airtable.dedupe.knownExternalId', value: 'recAELdj1f2Fnp5gM' },
        { key: 'airtable.recordId', value: 'recAELdj1f2Fnp5gM' },
        { key: 'airtable.linkedRecordIds', value: '["rec4Tn5BNce63bHHN"]' },
        { key: 'airtable.fieldId', value: 'fldoeYUEMXMJp5bUB' },
        { key: 'airtable.tableId', value: 'tbl2II3FoagbaK7bn' },
      ]),
    );
    expect(action.operation).not.toBe('create');
  });

  it('rejects Airtable reuse/update without an exact target ID via AUR-PLAN-009', async () => {
    const proposal = airtableRelationProposal();
    proposal.plannedActions[0] = {
      ...proposal.plannedActions[0]!,
      properties: proposal.plannedActions[0]!.properties.filter(
        (property) => property.key !== 'airtable.recordId',
      ),
    };
    await expect(
      planWithProposal(
        'airtable',
        discoveryFrom(airtableDestination),
        proposal,
        'Link Complete README to Launch deliverables',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });

  it('fails safely when Airtable linked workstream IDs are removed', async () => {
    const proposal = airtableRelationProposal();
    proposal.plannedActions[0] = {
      ...proposal.plannedActions[0]!,
      properties: proposal.plannedActions[0]!.properties.map((property) =>
        property.key === 'airtable.linkedRecordIds' ? { ...property, value: '[]' } : property,
      ),
    };
    await expect(
      planWithProposal(
        'airtable',
        discoveryFrom(airtableDestination),
        proposal,
        'Link Complete README to Launch deliverables',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-011' });
  });

  it('does not bind the same Airtable record name from another table', () => {
    const action = {
      id: 'action-001',
      operation: 'update' as const,
      objectType: 'airtable.record',
      target: 'Complete README',
      description: 'Reuse the README task.',
      properties: [{ key: 'airtable.tableId', value: 'tbl2II3FoagbaK7bn' }],
      dependsOn: [],
    };
    const matched = resolveExactObject(
      airtableDestination,
      action,
      'airtable',
      'tbl2II3FoagbaK7bn',
    );
    expect(matched?.id).toBe('recAELdj1f2Fnp5gM');
    const other = resolveExactObject(airtableDestination, action, 'airtable', 'tblOther');
    expect(other?.id).toBe('recSameNameOtherTable');
  });

  it('rejects synthetic Airtable relationship record creation', async () => {
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'record', name: 'Link task to workstream', purpose: 'Bad synthetic create.' },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'create',
          objectType: 'airtable.record',
          target:
            'Link the existing Complete README task to the existing Launch deliverables workstream',
          description: 'Create a synthetic relationship record.',
          properties: [
            { key: 'airtable.workspaceId', value: airtableDestination.id },
            { key: 'airtable.baseId', value: 'apptXzRq0zEfjhz4X' },
            { key: 'airtable.tableId', value: 'tbl2II3FoagbaK7bn' },
          ],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Should fail.',
    };
    await expect(
      planWithProposal(
        'airtable',
        discoveryFrom(airtableDestination),
        proposal,
        'Link Complete README to Launch deliverables',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });

  it('accepts a fully bound Airtable relation update through immutable validation', async () => {
    const plan = await planWithProposal(
      'airtable',
      discoveryFrom(airtableDestination),
      airtableRelationProposal(),
      'Link Complete README to Launch deliverables',
    );
    expect(plan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'airtable.dedupe.knownExternalId', value: 'recAELdj1f2Fnp5gM' },
        { key: 'airtable.linkedRecordIds', value: '["rec4Tn5BNce63bHHN"]' },
      ]),
    );
  });

  it('resolves Linear JAS-17 to the exact discovered issue UUID', () => {
    const adapter = new LinearAdapter();
    const bound = adapter.bindDestination(linearIssueProposal(), linearDestination);
    const action = bound.plannedActions[0]!;
    expect(action.target).toBe('Complete the README for Build Week launch');
    expect(action.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.dedupe.knownExternalId', value: linearIssueUuid },
        { key: 'linear.issueId', value: linearIssueUuid },
        { key: 'linear.issueKey', value: 'JAS-17' },
      ]),
    );
    expect(action.properties.some((property) => property.value === 'null')).toBe(false);
  });

  it('proves JAS-17 alone cannot authorize an update', async () => {
    const proposal = linearIssueProposal();
    proposal.plannedActions[0] = {
      ...proposal.plannedActions[0]!,
      target: 'JAS-17',
      description: 'Update JAS-17.',
      properties: [
        { key: 'linear.teamId', value: linearDestination.id },
        { key: 'linear.issueId', value: 'JAS-17' },
        { key: 'linear.issueKey', value: 'JAS-17' },
        { key: 'linear.dedupe.knownExternalId', value: 'JAS-17' },
      ],
    };
    await expect(
      planWithProposal(
        'linear',
        {
          integration: 'linear',
          candidates: [
            {
              id: linearDestination.id,
              name: linearDestination.name,
              kind: 'team',
              description: '',
              existingAurousMatch: false,
            },
          ],
          existingObjects: [],
          inspectedAt: linearDestination.verifiedAt,
          warnings: [],
        },
        proposal,
        'Update JAS-17',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-010' });
  });

  it('stops safely when a Linear issue key resolves to zero UUIDs', async () => {
    const proposal = linearIssueProposal();
    proposal.plannedActions[0] = {
      ...proposal.plannedActions[0]!,
      properties: [
        { key: 'linear.teamId', value: linearDestination.id },
        { key: 'linear.issueKey', value: 'JAS-404' },
        { key: 'linear.issueId', value: 'JAS-404' },
      ],
      target: 'JAS-404',
      description: 'Reuse missing issue JAS-404.',
    };
    await expect(
      planWithProposal('linear', discoveryFrom(linearDestination), proposal, 'Reuse JAS-404'),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-010' });
  });

  it('does not bind the same Linear title under another project parent', () => {
    const action = {
      id: 'action-001',
      operation: 'update' as const,
      objectType: 'Linear issue',
      target: 'Complete the README for Build Week launch',
      description: 'Reuse the README issue.',
      properties: [{ key: 'linear.projectId', value: '58f32b14-0b3d-4da3-8b41-91280ad54a8e' }],
      dependsOn: [],
    };
    expect(
      resolveExactObject(
        linearDestination,
        action,
        'linear',
        '58f32b14-0b3d-4da3-8b41-91280ad54a8e',
      )?.id,
    ).toBe(linearIssueUuid);
    expect(resolveExactObject(linearDestination, action, 'linear', 'project-other')?.id).toBe(
      '22222222-3333-4444-8555-666666666666',
    );
  });

  it('accepts a Linear update once the exact discovered issue UUID is bound', async () => {
    const plan = await planWithProposal(
      'linear',
      discoveryFrom(linearDestination),
      linearIssueProposal(),
      'Reuse JAS-17 for README completion',
    );
    expect(plan.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'linear.dedupe.knownExternalId', value: linearIssueUuid },
        { key: 'linear.issueId', value: linearIssueUuid },
        { key: 'linear.issueKey', value: 'JAS-17' },
      ]),
    );
  });

  it('turns an already-satisfied Airtable relation into a skip no-op with no write', async () => {
    const destination: ResolvedDestination = {
      ...airtableDestination,
      existingObjects: airtableDestination.existingObjects.map((object) =>
        object.id === 'recAELdj1f2Fnp5gM'
          ? { ...object, linkedIds: ['rec4Tn5BNce63bHHN'] }
          : object,
      ),
    };
    const { workspace, store, output } = await serviceFixture();
    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => planningAgent(discoveryFrom(destination), airtableRelationProposal()),
    });
    const planned = await services.plan({
      agent: 'mock',
      tool: 'airtable',
      contextPaths: ['.'],
      objective: 'Link Complete README to Launch deliverables',
    });
    expect(planned.plannedActions[0]?.properties).toContainEqual({
      key: 'airtable.dedupe.skipReason',
      value: 'already-satisfied-relation',
    });
    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.createdObjects).toEqual([]);
    expect(result?.skippedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: 'action-001',
          reason: 'Already-satisfied relation; no write required.',
          externalId: 'recAELdj1f2Fnp5gM',
        }),
      ]),
    );
  });

  it('turns an already-satisfied Notion relation into a skip no-op with no write', async () => {
    const destination: ResolvedDestination = {
      ...notionDestination,
      existingObjects: notionDestination.existingObjects.map((object) =>
        object.id === '3a2c0122-d292-815c-942c-fb042aeb9112'
          ? { ...object, linkedIds: ['3a2c0122-d292-81ed-b4f6-eab2abb2f67c'] }
          : object,
      ),
    };
    const { workspace, store, output } = await serviceFixture();
    const services = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => planningAgent(discoveryFrom(destination), notionRelationProposal()),
    });
    const planned = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['.'],
      objective: 'Preserve README checklist relation',
    });
    expect(planned.plannedActions[0]?.properties).toContainEqual({
      key: 'notion.dedupe.skipReason',
      value: 'already-satisfied-relation',
    });
    const result = await services.apply(planned.runId, { confirmed: true });
    expect(result?.createdObjects).toEqual([]);
    expect(result?.skippedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: 'action-001',
          reason: 'Already-satisfied relation; no write required.',
          externalId: '3a2c0122-d292-815c-942c-fb042aeb9112',
        }),
      ]),
    );
  });

  it('normalizes Notion relation updates onto the exact source record with structured related IDs', () => {
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(notionRelationProposal(), notionDestination);
    const action = bound.plannedActions[0]!;
    expect(action.objectType).toBe('notion.database_record');
    expect(action.target).toBe('README completion');
    expect(action.properties).toEqual(
      expect.arrayContaining([
        {
          key: 'notion.dedupe.knownExternalId',
          value: '3a2c0122-d292-815c-942c-fb042aeb9112',
        },
        {
          key: 'notion.relation.sourceRecordId',
          value: '3a2c0122-d292-815c-942c-fb042aeb9112',
        },
        {
          key: 'notion.relation.targetRecordIds',
          value: '["3a2c0122-d292-81ed-b4f6-eab2abb2f67c"]',
        },
      ]),
    );
  });

  it('still triggers AUR-PLAN-009 when Notion IDs appear only in the description', async () => {
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'database_record', name: 'README completion', purpose: 'Gate.' },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'link',
          objectType: 'notion.database_record_relation',
          target:
            'Existing README task 3a2c0122-d292-81ed-b4f6-eab2abb2f67c and existing README completion checklist record 3a2c0122-d292-815c-942c-fb042aeb9112',
          description:
            'Reuse relation mentioned only in prose with IDs 3a2c0122-d292-81ed-b4f6-eab2abb2f67c and 3a2c0122-d292-815c-942c-fb042aeb9112.',
          properties: [
            {
              key: 'notion.destination.parentPageId',
              value: notionDestination.id,
            },
            { key: 'notion.relation.name', value: 'Related Task' },
          ],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Should fail.',
    };
    await expect(
      planWithProposal(
        'notion',
        discoveryFrom(notionDestination),
        proposal,
        'Link README task to checklist',
      ),
    ).rejects.toMatchObject({ code: 'AUR-PLAN-009' });
  });

  it('does not bind the same Notion record title from another database parent', () => {
    const action = {
      id: 'action-001',
      operation: 'update' as const,
      objectType: 'notion.database_record',
      target: 'README completion',
      description: 'Reuse checklist gate.',
      properties: [],
      dependsOn: [],
    };
    expect(
      resolveExactObject(
        notionDestination,
        action,
        'notion',
        '12d311ca-096e-4f82-8edd-2a438f8f4841',
      )?.id,
    ).toBe('3a2c0122-d292-815c-942c-fb042aeb9112');
    expect(resolveExactObject(notionDestination, action, 'notion', 'data-source-other')?.id).toBe(
      'page-other-db-readme',
    );
  });

  it('accepts a Notion relation update after exact source binding', async () => {
    const plan = await planWithProposal(
      'notion',
      discoveryFrom(notionDestination),
      notionRelationProposal(),
      'Preserve README checklist relation',
    );
    expect(plan.plannedActions[0]?.properties).toContainEqual({
      key: 'notion.dedupe.knownExternalId',
      value: '3a2c0122-d292-815c-942c-fb042aeb9112',
    });
  });

  it('attaches the failing run ID onto classified Aurous errors', () => {
    const classified = asAurousError(
      new AurousError({
        code: 'AUR-PLAN-009',
        summary: 'missing id',
        probableCause: 'test',
        nextAction: 'stop',
      }),
      'run-20260720T194305Z-75a5e1',
    );
    expect(classified.runId).toBe('run-20260720T194305Z-75a5e1');
    expect(classified.code).toBe('AUR-PLAN-009');
  });

  it('allocates distinct run directories for sequential failed plans', async () => {
    const { workspace, store, output } = await serviceFixture();
    const failingAirtable = {
      ...airtableRelationProposal(),
      plannedActions: [
        {
          ...airtableRelationProposal().plannedActions[0]!,
          properties: airtableRelationProposal().plannedActions[0]!.properties.filter(
            (property) => property.key !== 'airtable.recordId',
          ),
        },
      ],
    };
    const failingLinear: PlanProposal = {
      ...linearIssueProposal(),
      plannedActions: [
        {
          ...linearIssueProposal().plannedActions[0]!,
          properties: [{ key: 'linear.teamId', value: linearDestination.id }],
          description: 'Update existing issue without exact ID.',
        },
      ],
    };
    const airtableServices = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () => planningAgent(discoveryFrom(airtableDestination), failingAirtable),
    });
    const linearServices = new AurousServices({
      workspace,
      store,
      output,
      agentFactory: () =>
        planningAgent(
          {
            integration: 'linear',
            candidates: [
              {
                id: linearDestination.id,
                name: linearDestination.name,
                kind: 'team',
                description: '',
                existingAurousMatch: false,
              },
            ],
            existingObjects: [],
            inspectedAt: linearDestination.verifiedAt,
            warnings: [],
          },
          failingLinear,
        ),
    });

    const first = await airtableServices
      .plan({
        agent: 'mock',
        tool: 'airtable',
        contextPaths: ['.'],
        objective: 'Airtable fail one',
      })
      .then(
        () => undefined,
        (error: unknown) => error as AurousError,
      );
    const second = await linearServices
      .plan({
        agent: 'mock',
        tool: 'linear',
        contextPaths: ['.'],
        objective: 'Linear fail two',
      })
      .then(
        () => undefined,
        (error: unknown) => error as AurousError,
      );

    expect(first?.code).toBe('AUR-PLAN-009');
    expect(['AUR-PLAN-009', 'AUR-PLAN-010']).toContain(second?.code);
    expect(first?.runId).toMatch(/^run-/);
    expect(second?.runId).toMatch(/^run-/);
    expect(first?.runId).not.toBe(second?.runId);
    expect(await store.getRun(first!.runId!)).toMatchObject({ status: 'failed' });
    expect(await store.getRun(second!.runId!)).toMatchObject({ status: 'failed' });
  });
});

function airtableRelationProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      { kind: 'airtable.base', name: 'Aurous Build Week HQ', purpose: 'Launch hub.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'link',
        objectType: 'airtable.record',
        target:
          'Link the existing Complete README task to the existing Launch deliverables workstream',
        description:
          'Reuse exact existing records and link Complete README to Launch deliverables. Do not create duplicates.',
        properties: [
          { key: 'airtable.workspaceId', value: 'wsphk1OmoSFXlTmwM' },
          { key: 'airtable.workspace', value: 'My First Workspace' },
          { key: 'airtable.baseId', value: 'apptXzRq0zEfjhz4X' },
          { key: 'airtable.tableId', value: 'tbl2II3FoagbaK7bn' },
          { key: 'airtable.recordId', value: 'recAELdj1f2Fnp5gM' },
          { key: 'airtable.fieldId', value: 'fldoeYUEMXMJp5bUB' },
          { key: 'airtable.linkedRecordIds', value: '["rec4Tn5BNce63bHHN"]' },
        ],
        dependsOn: [],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'Task linked to workstream by exact IDs.',
  };
}

function linearIssueProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      {
        kind: 'Linear issue',
        name: 'Complete the README for Build Week launch',
        purpose: 'Reuse.',
      },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'update',
        objectType: 'Linear issue',
        target: 'JAS-17',
        description: 'Reuse JAS-17 for README completion; do not create duplicates.',
        properties: [
          { key: 'linear.teamId', value: 'bb8b0d4d-79b8-4d7d-a635-69bfacf82b9b' },
          { key: 'linear.team', value: 'JasjyotSingh' },
          { key: 'linear.issueId', value: 'JAS-17' },
          { key: 'linear.title', value: 'Complete the README for Build Week launch' },
          { key: 'linear.project', value: 'Aurous — Build Week Launch' },
          { key: 'linear.projectId', value: '58f32b14-0b3d-4da3-8b41-91280ad54a8e' },
          { key: 'linear.milestone', value: 'null' },
          { key: 'linear.milestoneId', value: 'null' },
          { key: 'linear.labels', value: '[]' },
          { key: 'linear.labelIds', value: '[]' },
        ],
        dependsOn: [],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'JAS-17 is reused by exact ID.',
  };
}

function notionRelationProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      { kind: 'database_record', name: 'README completion', purpose: 'Checklist gate.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'link',
        objectType: 'notion.database_record_relation',
        target:
          'Existing README task 3a2c0122-d292-81ed-b4f6-eab2abb2f67c and existing README completion checklist record 3a2c0122-d292-815c-942c-fb042aeb9112',
        description:
          'Reuse and preserve the inspected README gating relation; Do not create duplicates.',
        properties: [
          {
            key: 'notion.destination.parentPageId',
            value: '3a2c0122-d292-8130-bde0-f68012dac01a',
          },
          { key: 'notion.relation.name', value: 'Related Task' },
          {
            key: 'notion.relation.sourceRecordId',
            value: '3a2c0122-d292-815c-942c-fb042aeb9112',
          },
          {
            key: 'notion.relation.targetRecordId',
            value: '3a2c0122-d292-81ed-b4f6-eab2abb2f67c',
          },
        ],
        dependsOn: [],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'Relation preserved by exact IDs.',
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-exact-'));
  await writeFile(path.join(workspace, 'README.md'), '# Exact binding\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"exact-binding"}\n');
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  const output: Output = {
    log() {},
    error() {},
  };
  const services = new AurousServices({ workspace, store, output });
  return { workspace, store, services, output };
}

async function planWithProposal(
  tool: 'airtable' | 'linear' | 'notion',
  discovery: DestinationDiscovery,
  proposal: PlanProposal,
  objective: string,
) {
  const { workspace, store, output } = await serviceFixture();
  const services = new AurousServices({
    workspace,
    store,
    output,
    agentFactory: () => planningAgent(discovery, proposal),
  });
  return services.plan({
    agent: 'mock',
    tool,
    contextPaths: ['.'],
    objective,
  });
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
