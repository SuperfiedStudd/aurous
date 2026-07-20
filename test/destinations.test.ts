import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProductivityAdapter } from '../src/adapters/productivity/index.js';
import { ContextPackStore } from '../src/core/context-pack.js';
import { resolveDestination } from '../src/core/destination-resolver.js';
import type {
  DestinationCandidate,
  DestinationDiscovery,
  ResolvedDestination,
} from '../src/domain/destinations.js';
import { ContextPackSchema } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const inspectedAt = '2026-07-19T12:00:00.000Z';

function candidate(
  id: string,
  name: string,
  kind: 'page' | 'team' = 'page',
  existingAurousMatch = false,
): DestinationCandidate {
  return { id, name, kind, description: `${name} destination`, existingAurousMatch };
}

function discovery(
  integration: 'notion' | 'linear' | 'mock',
  candidates: DestinationCandidate[],
  existingObjects: DestinationDiscovery['existingObjects'] = [],
): DestinationDiscovery {
  return { integration, candidates, existingObjects, inspectedAt, warnings: [] };
}

const proposal: PlanProposal = {
  proposedWorkspaceStructure: [
    { kind: 'page', name: 'Aurous Product HQ', purpose: 'Project home' },
  ],
  plannedActions: [
    {
      id: 'action-001',
      operation: 'create',
      objectType: 'page',
      target: 'Aurous Product HQ',
      description: 'Create the project home.',
      properties: [],
      dependsOn: [],
    },
  ],
  assumptions: [],
  warnings: [],
  destructiveActions: [],
  expectedResult: 'A project home.',
};

describe('shared destination resolution', () => {
  it('automatically selects one available Notion destination', async () => {
    const adapter = createProductivityAdapter('notion');
    const resolved = await resolveDestination({
      adapter,
      discovery: discovery('notion', [candidate('page-private', 'Private workspace')]),
      objective: 'Set up Notion for this project',
      projectName: 'Aurous',
    });

    expect(resolved).toMatchObject({
      id: 'page-private',
      name: 'Private workspace',
      source: 'only-choice',
    });
  });

  it('shows friendly choices for multiple Notion destinations and never exposes IDs', async () => {
    let shownQuestion = '';
    let shownNames: string[] = [];
    const choose = (
      request: import('../src/core/destination-resolver.js').DestinationChoiceRequest,
    ) => {
      shownQuestion = request.question;
      shownNames = request.candidates.map((item) => item.name);
      return Promise.resolve(request.candidates.findIndex((item) => item.name === 'Product'));
    };
    const resolved = await resolveDestination({
      adapter: createProductivityAdapter('notion'),
      discovery: discovery('notion', [
        candidate('page-private', 'Private workspace'),
        candidate('page-product', 'Product'),
        candidate('page-engineering', 'Engineering'),
      ]),
      objective: 'Set up Notion for this project',
      projectName: 'Aurous',
      choose,
    });

    expect(shownQuestion).toBe('Where should Aurous build this workspace?');
    expect(shownNames).toContain('Product');
    expect(resolved).toMatchObject({ id: 'page-product', source: 'user-choice' });
  });

  it('explains a missing accessible Notion page without requesting an ID or URL', async () => {
    await expect(
      resolveDestination({
        adapter: createProductivityAdapter('notion'),
        discovery: discovery('notion', []),
        objective: 'Set up Notion',
        projectName: 'Aurous',
      }),
    ).rejects.toMatchObject({
      code: 'AUR-DEST-001',
      message:
        'Aurous cannot access a suitable Notion page yet; share or create one page for Aurous, then try again.',
    });
  });

  it('prefers one inspected existing Product HQ and binds its exact ID for reuse', async () => {
    const adapter = createProductivityAdapter('notion');
    const resolved = await resolveDestination({
      adapter,
      discovery: discovery(
        'notion',
        [
          candidate('page-private', 'Private workspace'),
          candidate('page-product', 'Aurous Product HQ', 'page', true),
        ],
        [
          {
            id: 'page-product',
            name: 'Aurous Product HQ',
            type: 'page',
            destinationId: 'page-product',
            url: 'https://notion.so/page-product',
          },
        ],
      ),
      objective: 'Set up Notion for this project',
      projectName: 'Aurous',
    });
    const bound = adapter.bindDestination(proposal, resolved!);

    expect(resolved?.source).toBe('existing-match');
    expect(bound.plannedActions[0]?.description).toContain('Reuse or reconcile');
    expect(bound.plannedActions[0]?.properties).toEqual(
      expect.arrayContaining([
        { key: 'notion.destination.parentPageId', value: 'page-product' },
        { key: 'notion.dedupe.knownExternalId', value: 'page-product' },
      ]),
    );
  });

  it('binds an inspected Notion database record returned by the MCP as a page', async () => {
    const adapter = createProductivityAdapter('notion');
    const resolved = await resolveDestination({
      adapter,
      discovery: discovery(
        'notion',
        [candidate('page-product', 'Aurous Product HQ', 'page', true)],
        [
          {
            id: 'record-readme',
            name: 'Complete the README',
            type: 'page',
            destinationId: 'page-product',
            url: 'https://notion.so/record-readme',
            parentId: 'data-source-tasks',
          },
        ],
      ),
      objective: 'Update the existing README task in Notion',
      projectName: 'Aurous',
    });
    const recordProposal: PlanProposal = {
      ...proposal,
      proposedWorkspaceStructure: [
        { kind: 'database-record', name: 'Complete the README', purpose: 'Track completion.' },
      ],
      plannedActions: [
        {
          ...proposal.plannedActions[0]!,
          operation: 'update',
          objectType: 'database-record',
          target: 'Complete the README',
          description: 'Reuse and update the inspected README task.',
        },
      ],
    };

    const bound = adapter.bindDestination(recordProposal, resolved!);

    expect(bound.plannedActions[0]?.properties).toContainEqual({
      key: 'notion.dedupe.knownExternalId',
      value: 'record-readme',
    });
    expect(bound.plannedActions[0]?.properties).toContainEqual({
      key: 'notion.dedupe.knownUrl',
      value: 'https://notion.so/record-readme',
    });
  });

  it('automatically selects one Linear team and uses friendly selection for multiple teams', async () => {
    const adapter = createProductivityAdapter('linear');
    const one = await resolveDestination({
      adapter,
      discovery: discovery('linear', [candidate('team-product', 'Product', 'team')]),
      objective: 'Set up Linear',
      projectName: 'Aurous',
    });
    const choose = () => Promise.resolve(1);
    const multiple = await resolveDestination({
      adapter,
      discovery: discovery('linear', [
        candidate('team-engineering', 'Engineering', 'team'),
        candidate('team-product', 'Product', 'team'),
      ]),
      objective: 'Set up Linear',
      projectName: 'Aurous',
      choose,
    });

    expect(one).toMatchObject({ id: 'team-product', source: 'only-choice' });
    expect(multiple).toMatchObject({ id: 'team-product', source: 'user-choice' });
  });

  it('binds an inspected Linear label by exact ID despite MCP type naming', async () => {
    const adapter = createProductivityAdapter('linear');
    const resolved = await resolveDestination({
      adapter,
      discovery: discovery(
        'linear',
        [candidate('team-product', 'Product', 'team')],
        [
          {
            id: 'label-exact-id',
            name: 'Launch',
            type: 'issue_label',
            destinationId: 'team-product',
          },
        ],
      ),
      objective: 'Add the Launch label',
      projectName: 'Aurous',
    });
    const labelProposal: PlanProposal = {
      ...proposal,
      proposedWorkspaceStructure: [{ kind: 'label', name: 'Launch', purpose: 'Mark launch work.' }],
      plannedActions: [
        {
          ...proposal.plannedActions[0]!,
          objectType: 'label',
          target: 'Launch',
          description: 'Create the launch label.',
        },
      ],
    };

    const bound = adapter.bindDestination(labelProposal, resolved!);
    expect(bound.plannedActions[0]?.properties).toContainEqual({
      key: 'linear.dedupe.knownExternalId',
      value: 'label-exact-id',
    });
    expect(bound.plannedActions[0]?.description).toContain('Reuse the exact verified existing');
  });

  it('selects a deterministic canonical exact object and surfaces duplicate risk', async () => {
    const adapter = createProductivityAdapter('linear');
    const resolved = await resolveDestination({
      adapter,
      discovery: discovery(
        'linear',
        [candidate('team-product', 'Product', 'team')],
        [
          {
            id: 'aaaaaaaa-1111-4222-8333-444444444444',
            name: 'Prepare launch',
            type: 'issue',
            destinationId: 'team-product',
            identifier: 'JAS-11',
          },
          {
            id: 'bbbbbbbb-1111-4222-8333-444444444444',
            name: 'Prepare launch',
            type: 'issue',
            destinationId: 'team-product',
            identifier: 'JAS-5',
          },
        ],
      ),
      objective: 'Prepare launch',
      projectName: 'Aurous',
    });
    const issueProposal: PlanProposal = {
      ...proposal,
      proposedWorkspaceStructure: [
        { kind: 'issue', name: 'Prepare launch', purpose: 'Prepare launch.' },
      ],
      plannedActions: [
        {
          ...proposal.plannedActions[0]!,
          objectType: 'issue',
          target: 'Prepare launch',
          description: 'Create the launch issue.',
        },
      ],
    };

    const bound = adapter.bindDestination(issueProposal, resolved!);
    expect(bound.plannedActions[0]?.properties).toContainEqual({
      key: 'linear.dedupe.knownExternalId',
      value: 'aaaaaaaa-1111-4222-8333-444444444444',
    });
    expect(bound.plannedActions[0]?.properties).toContainEqual({
      key: 'linear.issueKey',
      value: 'JAS-11',
    });
    expect(bound.warnings.join('\n')).toContain('selected one canonical exact object');
    expect(bound.warnings.join('\n')).toContain('will remain untouched');
  });

  it('honors an explicit friendly destination in the natural-language request first', async () => {
    const resolved = await resolveDestination({
      adapter: createProductivityAdapter('linear'),
      discovery: discovery('linear', [
        candidate('team-product', 'Product', 'team', true),
        candidate('team-engineering', 'Engineering', 'team'),
      ]),
      objective: 'Set up Linear using Engineering',
      projectName: 'Aurous',
    });

    expect(resolved).toMatchObject({
      id: 'team-engineering',
      source: 'explicit-instruction',
    });
  });

  it('reuses a reverified saved team and ignores an invalid saved destination', async () => {
    const adapter = createProductivityAdapter('linear');
    const candidates = [
      candidate('team-engineering', 'Engineering', 'team'),
      candidate('team-product', 'Product', 'team'),
    ];
    const saved = savedDestination('linear', 'team-product', 'Product', 'team');
    const remembered = await resolveDestination({
      adapter,
      discovery: discovery('linear', candidates),
      objective: 'Set up Linear',
      projectName: 'Aurous',
      saved,
    });
    let choiceRequested = false;
    const choose = () => {
      choiceRequested = true;
      return Promise.resolve(0);
    };
    const invalidSaved = await resolveDestination({
      adapter,
      discovery: discovery('linear', candidates),
      objective: 'Set up Linear',
      projectName: 'Aurous',
      saved: savedDestination('linear', 'deleted-team', 'Old team', 'team'),
      choose,
    });

    expect(remembered).toMatchObject({ id: 'team-product', source: 'saved-project' });
    expect(choiceRequested).toBe(true);
    expect(invalidSaved).toMatchObject({ id: 'team-engineering', source: 'user-choice' });
  });

  it('returns no destination when numbered selection is canceled', async () => {
    const resolved = await resolveDestination({
      adapter: createProductivityAdapter('linear'),
      discovery: discovery('linear', [
        candidate('team-a', 'Product', 'team'),
        candidate('team-b', 'Engineering', 'team'),
      ]),
      objective: 'Set up Linear',
      projectName: 'Aurous',
      choose: () => Promise.resolve(undefined),
    });
    expect(resolved).toBeUndefined();
  });

  it('accepts a verified exact ID or URL only through an advanced override', async () => {
    const resolved = await resolveDestination({
      adapter: createProductivityAdapter('notion'),
      discovery: discovery('notion', [
        {
          ...candidate('page-product', 'Product'),
          url: 'https://notion.so/page-product',
        },
      ]),
      objective: 'Set up Notion',
      projectName: 'Aurous',
      explicitOverride: { id: 'https://notion.so/page-product', name: 'Product' },
    });

    expect(resolved).toMatchObject({
      id: 'page-product',
      name: 'Product',
      source: 'advanced-override',
    });
  });

  it('supports the same contract for the mock third integration', async () => {
    const adapter = createProductivityAdapter('mock');
    const resolved = await resolveDestination({
      adapter,
      discovery: discovery('mock', [candidate('mock-space', 'Demo workspace', 'page')]),
      objective: 'Set up the demo workspace',
      projectName: 'Aurous',
    });
    const bound = adapter.bindDestination(proposal, resolved!);

    expect(adapter.destination.exactIdProperty).toBe('mock.workspaceId');
    expect(bound.plannedActions[0]?.properties).toContainEqual({
      key: 'mock.workspaceId',
      value: 'mock-space',
    });
  });
});

describe('project context pack', () => {
  it('persists readable destination provenance and forgets it reversibly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aurous-context-pack-'));
    await writeFile(
      path.join(root, 'README.md'),
      '# Goldsmith project\n\nA local-first workspace planner that turns project context into safe previews.\n',
    );
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'goldsmith', description: 'Safe workspace planning.' }),
    );
    const store = new ContextPackStore(root);
    await store.saveDestination(
      savedDestination('notion', 'page-product', 'Product', 'page', 'user-choice'),
      'software-launch',
    );

    const persisted = ContextPackSchema.parse(
      JSON.parse(await readFile(path.join(root, '.aurous', 'context.json'), 'utf8')) as unknown,
    );
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      project: {
        name: path.basename(root),
        root,
        summary: 'A local-first workspace planner that turns project context into safe previews.',
        summaryProvenance: {
          kind: 'repository-files',
          sources: ['README.md', 'package.json'],
          maxSourceBytes: 16384,
        },
      },
      selectedPreset: 'software-launch',
      selectedPresetSource: 'explicit-user',
      activeIntegrations: ['notion'],
      destinations: [
        {
          integration: 'notion',
          id: 'page-product',
          name: 'Product',
          source: 'user-choice',
          sourceDetail: 'Test provenance.',
          verifiedAt: inspectedAt,
        },
      ],
      workspacePreferences: { verbose: false },
    });
    expect(JSON.stringify(persisted)).not.toMatch(/token|credential|mcp/i);

    const forgotten = await store.forgetDestination('notion');
    expect(forgotten.destinations).toEqual([]);
    expect(forgotten.activeIntegrations).toEqual([]);
  });
});

function savedDestination(
  integration: 'notion' | 'linear' | 'mock',
  id: string,
  name: string,
  kind: string,
  source: ResolvedDestination['source'] = 'saved-project',
): ResolvedDestination {
  return {
    integration,
    id,
    name,
    kind,
    source,
    sourceDetail: 'Test provenance.',
    verifiedAt: inspectedAt,
    existingObjects: [],
    discoveryWarnings: [],
  };
}
