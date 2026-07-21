import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import { NotionAdapter } from '../src/adapters/productivity/notion.js';
import { normalizeNotionPlanCapabilities } from '../src/adapters/productivity/notion-plan-capabilities.js';
import { propertyValue } from '../src/adapters/productivity/exact-bindings.js';
import type { ResolvedDestination } from '../src/domain/destinations.js';
import type { AurousPlan, PlanProposal } from '../src/domain/schemas.js';

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function loadCeoProposal(): Promise<PlanProposal> {
  return JSON.parse(
    await readFile(path.join(fixtureDirectory, 'notion-ceo-life-workspace-proposal.json'), 'utf8'),
  ) as PlanProposal;
}

async function loadExistingDestination(): Promise<ResolvedDestination> {
  const payload = JSON.parse(
    await readFile(
      path.join(fixtureDirectory, 'notion-ceo-life-workspace-existing-objects.json'),
      'utf8',
    ),
  ) as {
    destinationId: string;
    destinationName: string;
    existingObjects: ResolvedDestination['existingObjects'];
  };
  return {
    integration: 'notion',
    id: payload.destinationId,
    name: payload.destinationName,
    kind: 'page',
    source: 'existing-match',
    sourceDetail: 'Partial CEO life-workspace run objects for idempotent retry.',
    verifiedAt: '2026-07-21T04:36:03.000Z',
    existingObjects: payload.existingObjects,
    discoveryWarnings: [],
  };
}

function emptyDestination(): ResolvedDestination {
  return {
    integration: 'notion',
    id: '3a2c0122-d292-8130-bde0-f68012dac01a',
    name: 'Aurous Product HQ',
    kind: 'page',
    source: 'only-choice',
    sourceDetail: 'Fresh CEO life-workspace plan.',
    verifiedAt: '2026-07-21T04:36:03.000Z',
    existingObjects: [],
    discoveryWarnings: [],
  };
}

function databaseProperties(action: PlanProposal['plannedActions'][number]): Array<Record<string, unknown>> {
  const raw = propertyValue(action.properties, 'notion.database.properties');
  if (!raw) return [];
  return JSON.parse(raw) as Array<Record<string, unknown>>;
}

describe('Notion CEO life-workspace capability normalization', () => {
  it('normalizes the CEO fixture to supported MCP operations before preview', async () => {
    const proposal = await loadCeoProposal();
    expect(proposal.plannedActions.filter((action) => action.operation === 'create')).toHaveLength(
      14,
    );
    expect(
      proposal.plannedActions.filter(
        (action) => action.operation === 'create' && action.objectType.includes('page'),
      ),
    ).toHaveLength(6);
    expect(
      proposal.plannedActions.filter(
        (action) => action.operation === 'create' && action.objectType.includes('database'),
      ),
    ).toHaveLength(8);

    const normalized = normalizeNotionPlanCapabilities(proposal, emptyDestination());
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(normalized, emptyDestination());

    for (const action of bound.plannedActions) {
      expect(propertyValue(action.properties, 'notion.page.linkedViews')).toBeUndefined();
      for (const property of databaseProperties(action)) {
        expect(property.type).not.toBe('status');
        expect(property.type).not.toBe('relation');
        expect(property.format).not.toBe('percent');
      }
    }

    const goals = bound.plannedActions.find((action) => action.id === 'action-015');
    expect(goals).toBeDefined();
    const goalsProperties = databaseProperties(goals!);
    const statusProperty = goalsProperties.find((property) => property.name === 'Status');
    expect(statusProperty?.type).toBe('select');
    expect(statusProperty?.options).toEqual(
      expect.arrayContaining(['On track', 'At risk'] as string[]),
    );
    const progressProperty = goalsProperties.find((property) => property.name === 'Progress');
    expect(progressProperty?.type).toBe('number');
    expect(progressProperty).not.toHaveProperty('format');
    expect(goalsProperties.find((property) => property.name === 'Projects')).toEqual(
      expect.objectContaining({
        type: 'text',
      }),
    );

    const home = bound.plannedActions.find((action) => action.id === 'action-023');
    expect(propertyValue(home!.properties, 'notion.page.navigationLinks')).toBeTruthy();
    expect(propertyValue(home!.properties, 'notion.page.sections')).toContain('Today');
    expect(bound.warnings.some((warning) => /Status options are unsupported/i.test(warning))).toBe(
      true,
    );
    expect(bound.warnings.some((warning) => /percent/i.test(warning))).toBe(true);
    expect(bound.warnings.some((warning) => /relation/i.test(warning))).toBe(true);
    expect(bound.warnings.some((warning) => /linked database views/i.test(warning))).toBe(true);
  });

  it('reuses the 14 exact-title objects from a partial run and apply creates zero duplicates', async () => {
    const proposal = await loadCeoProposal();
    const destination = await loadExistingDestination();
    expect(destination.existingObjects).toHaveLength(14);

    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(proposal, destination);
    const creates = bound.plannedActions.filter((action) => action.operation === 'create');
    expect(creates).toHaveLength(14);
    for (const action of creates) {
      expect(propertyValue(action.properties, 'notion.dedupe.knownExternalId')).toBeTruthy();
      expect(propertyValue(action.properties, 'notion.dedupe.skipReason')).toBe('already-exists');
    }

    const configures = bound.plannedActions.filter((action) => action.operation === 'configure');
    for (const action of configures) {
      expect(propertyValue(action.properties, 'notion.dedupe.knownExternalId')).toBeTruthy();
      for (const property of databaseProperties(action)) {
        expect(property.type).not.toBe('status');
        expect(property.type).not.toBe('relation');
        expect(property.format).not.toBe('percent');
      }
      expect(propertyValue(action.properties, 'notion.page.linkedViews')).toBeUndefined();
    }

    const plan: AurousPlan = {
      schemaVersion: 1,
      runId: 'run-ceo-life-retry',
      createdAt: '2026-07-21T04:36:03.000Z',
      agent: 'mock',
      tool: 'notion',
      objective: 'Set up my life and work in Notion using the context I provided.',
      contextSummary: {
        approvedPaths: ['ceo-context.md'],
        files: [],
        fileCount: 1,
        totalBytes: 100,
        skipped: [],
      },
      proposedWorkspaceStructure: bound.proposedWorkspaceStructure,
      plannedActions: bound.plannedActions,
      assumptions: bound.assumptions,
      warnings: bound.warnings,
      destructiveActions: bound.destructiveActions,
      expectedResult: bound.expectedResult,
    };

    const mock = new MockAgentAdapter();
    const execution = await mock.executePlan({
      workspace: process.cwd(),
      runDirectory: path.join(process.cwd(), '.aurous', 'runs', plan.runId),
      plan,
      productivity: adapter,
      timeoutMs: 5_000,
    });

    expect(execution.value.status).toBe('succeeded');
    expect(execution.value.createdObjects).toHaveLength(0);
    expect(execution.value.skippedActions.length).toBeGreaterThanOrEqual(14);
    expect(
      execution.value.skippedActions.filter((action) =>
        creates.some((create) => create.id === action.actionId),
      ),
    ).toHaveLength(14);
    expect(execution.value.completedActionIds).toHaveLength(28);
  });
});
