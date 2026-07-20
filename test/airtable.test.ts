import { describe, expect, it } from 'vitest';
import { AirtableAdapter } from '../src/adapters/productivity/airtable.js';
import { buildPlanningPrompt } from '../src/adapters/agents/prompts.js';
import type { ContextPack, ResolvedDestination } from '../src/domain/destinations.js';

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
});
