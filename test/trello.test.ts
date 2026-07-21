import { describe, expect, it } from 'vitest';
import { TrelloAdapter } from '../src/adapters/productivity/trello.js';
import { createProductivityAdapter } from '../src/adapters/productivity/index.js';
import { normalizedObjectType } from '../src/adapters/productivity/exact-bindings.js';
import { normalizeTrelloPlanCapabilities } from '../src/adapters/productivity/trello-plan-capabilities.js';
import { buildPlanningPrompt } from '../src/adapters/agents/prompts.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import { ToolNameSchema, PlanProposalSchema, type PlanProposal } from '../src/domain/schemas.js';
import type { ContextPack, ResolvedDestination } from '../src/domain/destinations.js';
import { routeNaturalRequest } from '../src/core/shell.js';

const workspace: ResolvedDestination = {
  integration: 'trello',
  id: 'wsp_aurous',
  name: 'Aurous Workspace',
  kind: 'workspace',
  source: 'only-choice',
  sourceDetail: 'One authorized Trello workspace.',
  verifiedAt: '2026-07-20T00:00:00.000Z',
  existingObjects: [],
  discoveryWarnings: [],
};

const reuseDestination: ResolvedDestination = {
  integration: 'trello',
  id: 'wsp_aurous',
  name: 'Aurous Workspace',
  kind: 'workspace',
  source: 'existing-match',
  sourceDetail: 'Exact board inspected.',
  verifiedAt: '2026-07-20T11:00:00.000Z',
  existingObjects: [
    {
      id: 'board_hq',
      name: 'Aurous Launch HQ',
      type: 'trello.board',
      destinationId: 'wsp_aurous',
      parentId: 'wsp_aurous',
      url: 'https://trello.com/b/board_hq/aurous-launch-hq',
    },
    {
      id: 'list_build',
      name: 'Build',
      type: 'trello.list',
      destinationId: 'wsp_aurous',
      parentId: 'board_hq',
    },
    {
      id: 'list_demo',
      name: 'Demo',
      type: 'trello.list',
      destinationId: 'wsp_aurous',
      parentId: 'board_hq',
    },
    {
      id: 'list_submit',
      name: 'Submit',
      type: 'trello.list',
      destinationId: 'wsp_aurous',
      parentId: 'board_hq',
    },
    {
      id: 'card_readme_build',
      name: 'Complete README',
      type: 'trello.card',
      destinationId: 'wsp_aurous',
      parentId: 'list_build',
      url: 'https://trello.com/c/card_readme_build',
    },
    {
      id: 'card_readme_submit',
      name: 'Complete README',
      type: 'trello.card',
      destinationId: 'wsp_aurous',
      parentId: 'list_submit',
      url: 'https://trello.com/c/card_readme_submit',
    },
    {
      id: 'card_devpost',
      name: 'Devpost submission',
      type: 'trello.card',
      destinationId: 'wsp_aurous',
      parentId: 'list_submit',
      url: 'https://trello.com/c/card_devpost',
    },
    {
      id: 'check_launch',
      name: 'Launch checklist',
      type: 'trello.checklist',
      destinationId: 'wsp_aurous',
      parentId: 'card_devpost',
    },
    {
      id: 'label_ready',
      name: 'Ready',
      type: 'trello.label',
      destinationId: 'wsp_aurous',
      parentId: 'board_hq',
    },
  ],
  discoveryWarnings: [
    'An exact existing board named "Aurous Launch HQ" was inspected with Build, Demo, and Submit lists.',
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

describe('Trello productivity adapter', () => {
  it('registers trello in ToolNameSchema and the adapter factory', () => {
    expect(ToolNameSchema.parse('trello')).toBe('trello');
    expect(createProductivityAdapter('trello')).toBeInstanceOf(TrelloAdapter);
  });

  it('routes explicit Trello requests even when other integrations are mentioned', () => {
    expect(
      routeNaturalRequest(
        'Set up a Trello board for tracking our Notion, Linear, and Airtable launch.',
        'notion',
      ),
    ).toBe('trello');
    expect(
      routeNaturalRequest('Create a Trello workflow for the Aurous integrations.', 'linear'),
    ).toBe('trello');
    expect(
      routeNaturalRequest('Use Trello to track readiness across Notion and Linear.', 'airtable'),
    ).toBe('trello');
    expect(routeNaturalRequest('Organize my current project', 'notion')).toBe('notion');
  });

  it('normalizes Trello object aliases', () => {
    expect(normalizedObjectType('trello.board')).toBe('board');
    expect(normalizedObjectType('trello_list')).toBe('list');
    expect(normalizedObjectType('cards')).toBe('card');
    expect(normalizedObjectType('checklists')).toBe('checklist');
    expect(normalizedObjectType('labels')).toBe('label');
    expect(normalizedObjectType('workspaces')).toBe('workspace');
  });

  it('binds workspace destination and exact board reuse without fabricating IDs', () => {
    const adapter = new TrelloAdapter();
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [
          { kind: 'board', name: 'Aurous Launch HQ', purpose: 'Launch HQ' },
        ],
        plannedActions: [
          {
            id: 'action-001',
            operation: 'create',
            objectType: 'board',
            target: 'Aurous Launch HQ',
            description: 'Create or reuse the board.',
            properties: [],
            dependsOn: [],
          },
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Board ready.',
      },
      reuseDestination,
    );
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'trello.workspaceId', value: 'wsp_aurous' },
        { key: 'trello.dedupe.knownExternalId', value: 'board_hq' },
        { key: 'trello.dedupe.knownUrl', value: 'https://trello.com/b/board_hq/aurous-launch-hq' },
      ]),
    );
  });

  it('reuses lists and checklists by exact parent-scoped identity', () => {
    const adapter = new TrelloAdapter();
    const proposal: PlanProposal = {
      proposedWorkspaceStructure: [],
      plannedActions: [
        trelloAction('action-001', 'board', 'Aurous Launch HQ', []),
        trelloAction(
          'action-002',
          'list',
          'Build',
          [
            { key: 'trello.boardActionId', value: 'action-001' },
            { key: 'trello.board', value: 'Aurous Launch HQ' },
          ],
          ['action-001'],
        ),
        trelloAction(
          'action-003',
          'card',
          'Devpost submission',
          [
            { key: 'trello.listId', value: 'list_submit' },
            { key: 'trello.list', value: 'Submit' },
          ],
          ['action-001'],
        ),
        trelloAction(
          'action-004',
          'checklist',
          'Launch checklist',
          [
            { key: 'trello.cardActionId', value: 'action-003' },
            { key: 'trello.card', value: 'Devpost submission' },
          ],
          ['action-003'],
        ),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Reuse exact Trello objects.',
    };
    const bound = adapter.bindDestination(proposal, reuseDestination);
    expect(
      bound.plannedActions.map(
        (action) =>
          action.properties.find((property) => property.key === 'trello.dedupe.knownExternalId')
            ?.value,
      ),
    ).toEqual(['board_hq', 'list_build', 'card_devpost', 'check_launch']);
  });

  it('does not bind the same card title across different lists', () => {
    const adapter = new TrelloAdapter();
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [],
        plannedActions: [
          trelloAction('action-001', 'card', 'Complete README', [
            { key: 'trello.listId', value: 'list_build' },
            { key: 'trello.list', value: 'Build' },
          ]),
          trelloAction('action-002', 'card', 'Complete README', [
            { key: 'trello.listId', value: 'list_submit' },
            { key: 'trello.list', value: 'Submit' },
          ]),
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Parent-scoped card reuse.',
      },
      reuseDestination,
    );
    expect(
      bound.plannedActions[0]?.properties.find(
        (property) => property.key === 'trello.dedupe.knownExternalId',
      )?.value,
    ).toBe('card_readme_build');
    expect(
      bound.plannedActions[1]?.properties.find(
        (property) => property.key === 'trello.dedupe.knownExternalId',
      )?.value,
    ).toBe('card_readme_submit');
  });

  it('reuses the canonical board when two same-named boards exist under the workspace', () => {
    const adapter = new TrelloAdapter();
    const duplicateBoards: ResolvedDestination = {
      ...workspace,
      source: 'existing-match',
      existingObjects: [
        {
          id: 'board_dup_b',
          name: 'Aurous Launch HQ',
          type: 'trello.board',
          destinationId: 'wsp_aurous',
          parentId: 'wsp_aurous',
        },
        {
          id: 'board_dup_a',
          name: 'Aurous Launch HQ',
          type: 'trello.board',
          destinationId: 'wsp_aurous',
          parentId: 'wsp_aurous',
        },
      ],
    };
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [],
        plannedActions: [trelloAction('action-001', 'board', 'Aurous Launch HQ', [])],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Reuse the canonical board.',
      },
      duplicateBoards,
    );
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'trello.dedupe.knownExternalId', value: 'board_dup_a' },
        { key: 'trello.dedupe.skipReason', value: 'already-exists' },
      ]),
    );
    expect(bound.warnings.join(' ')).toMatch(/Duplicate risk/);
  });

  it('attaches an existing label by exact ID only and never invents one', () => {
    const adapter = new TrelloAdapter();
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [],
        plannedActions: [
          trelloAction('action-001', 'card', 'Devpost submission', [
            { key: 'trello.listId', value: 'list_submit' },
            { key: 'trello.label', value: 'Ready' },
          ]),
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Label attached.',
      },
      reuseDestination,
    );
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([{ key: 'trello.labelId', value: 'label_ready' }]),
    );
  });

  it('warns when the same card name is ambiguous without a parent list', () => {
    const adapter = new TrelloAdapter();
    const bound = adapter.bindDestination(
      {
        proposedWorkspaceStructure: [],
        plannedActions: [trelloAction('action-001', 'card', 'Complete README', [])],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Ambiguity warning.',
      },
      reuseDestination,
    );
    expect(
      bound.plannedActions[0]?.properties.some(
        (property) => property.key === 'trello.dedupe.knownExternalId',
      ),
    ).toBe(false);
    expect(bound.warnings.join(' ')).toMatch(/Ambiguous card/);
  });

  it('injects Trello planning guidance into prompts', () => {
    const prompt = buildPlanningPrompt(
      'Create a Trello board.',
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
      new TrelloAdapter(),
      workspace,
    );
    expect(prompt).toContain('trello.workspaceId');
    expect(prompt).toContain('trello.boardActionId');
    expect(prompt).toContain('Never create labels');
  });

  it('rejects label creation and archive-oriented descriptions in local validation helpers', () => {
    expect(() =>
      assertTrelloSafety({
        proposedWorkspaceStructure: [],
        plannedActions: [
          {
            id: 'action-001',
            operation: 'create',
            objectType: 'label',
            target: 'New Label',
            description: 'Create a label.',
            properties: [{ key: 'trello.boardId', value: 'board_hq' }],
            dependsOn: [],
          },
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Label created.',
      }),
    ).toThrowError(/cannot create a label/);

    expect(() =>
      assertTrelloSafety({
        proposedWorkspaceStructure: [],
        plannedActions: [
          {
            id: 'action-001',
            operation: 'update',
            objectType: 'card',
            target: 'Devpost submission',
            description: 'Archive the Devpost submission card.',
            properties: [
              { key: 'trello.dedupe.knownExternalId', value: 'card_devpost' },
              { key: 'trello.listId', value: 'list_submit' },
            ],
            dependsOn: [],
          },
        ],
        assumptions: [],
        warnings: [],
        destructiveActions: [],
        expectedResult: 'Archived.',
      }),
    ).toThrowError(/archive or deletion/);
  });

  it('mock Trello launch plan has exact quantities and immutable dependencies', async () => {
    const agent = new MockAgentAdapter();
    const adapter = new TrelloAdapter();
    const generated = await agent.generatePlan({
      runId: 'run-test',
      workspace: '/project',
      runDirectory: '/tmp',
      objective:
        'Set up a Trello board named Aurous Launch HQ with exactly three lists: Build, Demo, and Submit. Add only the essential cards for README completion, demo recording, Devpost submission, and Notion, Linear, Airtable, and Trello readiness. Add a launch checklist to the Devpost submission card. Do not create duplicates.',
      context: {
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
      productivity: adapter,
      destination: workspace,
      timeoutMs: 1000,
    });
    const bound = adapter.bindDestination(generated.value, workspace);
    const boards = bound.plannedActions.filter(
      (action) => normalizedObjectType(action.objectType) === 'board',
    );
    const lists = bound.plannedActions.filter(
      (action) => normalizedObjectType(action.objectType) === 'list',
    );
    const cards = bound.plannedActions.filter(
      (action) => normalizedObjectType(action.objectType) === 'card',
    );
    const checklists = bound.plannedActions.filter(
      (action) => normalizedObjectType(action.objectType) === 'checklist',
    );
    const labels = bound.plannedActions.filter(
      (action) => normalizedObjectType(action.objectType) === 'label',
    );
    expect(boards).toHaveLength(1);
    expect(lists).toHaveLength(3);
    expect(cards).toHaveLength(7);
    expect(checklists).toHaveLength(1);
    expect(labels).toHaveLength(0);
    expect(lists.every((action) => action.dependsOn.includes('action-001'))).toBe(true);
    expect(
      cards.every((action) =>
        action.properties.some((property) => property.key === 'trello.listActionId'),
      ),
    ).toBe(true);
    expect(checklists[0]?.dependsOn).toContain('action-007');
    expect(bound.warnings.join(' ')).toMatch(/Do not create duplicates/i);
    expect(() => PlanProposalSchema.parse(bound)).not.toThrow();
    expect(() => assertTrelloSafety(bound)).not.toThrow();
  });

  it('reports trello ready in mock doctor diagnostics', async () => {
    const diagnostic = await new MockAgentAdapter().diagnose();
    expect(diagnostic.mcp.trello.status).toBe('ready');
  });

  it('converts a create-label with a known labelId to an attach update without a skip stamp', () => {
    const normalized = normalizeTrelloPlanCapabilities({
      proposedWorkspaceStructure: [],
      plannedActions: [
        trelloAction('action-001', 'label', 'Ready', [
          { key: 'trello.labelId', value: 'label_ready' },
        ]),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Attach existing label.',
    });
    const label = normalized.plannedActions[0];
    expect(label?.operation).toBe('update');
    expect(label?.properties).toEqual(
      expect.arrayContaining([{ key: 'trello.dedupe.knownExternalId', value: 'label_ready' }]),
    );
    expect(label?.properties.some((property) => property.key === 'trello.dedupe.skipReason')).toBe(
      false,
    );
  });

  it('strips a trello.labelId that references a removed label action', () => {
    const normalized = normalizeTrelloPlanCapabilities({
      proposedWorkspaceStructure: [],
      plannedActions: [
        trelloAction(
          'action-001',
          'card',
          'Task card',
          [{ key: 'trello.labelId', value: 'action-002' }],
          ['action-002'],
        ),
        trelloAction('action-002', 'label', 'New Label', []),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Card without a dangling label reference.',
    });
    expect(normalized.plannedActions.map((action) => action.id)).not.toContain('action-002');
    const card = normalized.plannedActions.find((action) => action.id === 'action-001');
    expect(card?.properties.some((property) => property.key === 'trello.labelId')).toBe(false);
    expect(card?.dependsOn).not.toContain('action-002');
  });

  it('keeps a real Trello label external ID on a card through the cleanup', () => {
    const normalized = normalizeTrelloPlanCapabilities({
      proposedWorkspaceStructure: [],
      plannedActions: [
        trelloAction('action-001', 'card', 'Task card', [
          { key: 'trello.labelId', value: 'label_ready' },
        ]),
        trelloAction('action-002', 'label', 'New Label', []),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Card keeps its real label ID.',
    });
    const card = normalized.plannedActions.find((action) => action.id === 'action-001');
    expect(card?.properties).toContainEqual({ key: 'trello.labelId', value: 'label_ready' });
  });
});

function trelloAction(
  id: string,
  objectType: string,
  target: string,
  properties: { key: string; value: string }[],
  dependsOn: string[] = [],
): PlanProposal['plannedActions'][number] {
  return {
    id,
    operation: 'create',
    objectType,
    target,
    description: `Create or reuse ${target}.`,
    properties,
    dependsOn,
  };
}

function assertTrelloSafety(proposal: PlanProposal): void {
  for (const action of proposal.plannedActions) {
    const kind = normalizedObjectType(action.objectType);
    if (kind === 'label' && action.operation === 'create') {
      throw new Error('cannot create a label');
    }
    if (/archive|delet/i.test(action.description)) {
      throw new Error('archive or deletion');
    }
    for (const [key, type] of [
      ['trello.boardActionId', 'board'],
      ['trello.listActionId', 'list'],
      ['trello.cardActionId', 'card'],
    ] as const) {
      const value = action.properties.find((property) => property.key === key)?.value;
      if (!value) continue;
      const dependency = proposal.plannedActions.find((candidate) => candidate.id === value);
      if (
        !dependency ||
        dependency.operation !== 'create' ||
        normalizedObjectType(dependency.objectType) !== type ||
        !dependsOn(action, value, proposal.plannedActions)
      ) {
        throw new Error(`invalid ${key}`);
      }
    }
    if (
      kind === 'list' &&
      action.operation === 'create' &&
      !action.properties.some((property) =>
        ['trello.boardId', 'trello.boardActionId'].includes(property.key),
      )
    ) {
      throw new Error('missing board parent');
    }
    if (
      kind === 'card' &&
      action.operation === 'create' &&
      !action.properties.some((property) =>
        ['trello.listId', 'trello.listActionId'].includes(property.key),
      )
    ) {
      throw new Error('missing list parent');
    }
    if (
      kind === 'checklist' &&
      action.operation === 'create' &&
      !action.properties.some((property) =>
        ['trello.cardId', 'trello.cardActionId'].includes(property.key),
      )
    ) {
      throw new Error('missing card parent');
    }
  }
}

function dependsOn(
  action: PlanProposal['plannedActions'][number],
  requiredActionId: string,
  actions: PlanProposal['plannedActions'],
): boolean {
  const byId = new Map(actions.map((candidate) => [candidate.id, candidate]));
  const pending = [...action.dependsOn];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === requiredActionId) return true;
    visited.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}
