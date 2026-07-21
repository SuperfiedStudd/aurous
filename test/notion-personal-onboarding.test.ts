import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import { NotionAdapter } from '../src/adapters/productivity/notion.js';
import {
  deriveNotionRootName,
  ensureNotionPersonalRootPlan,
  isIgnoredNotionDestination,
  isNotionPersonalOnboarding,
  NOTION_WORKSPACE_SENTINEL,
  resolveNotionPersonalDestination,
} from '../src/adapters/productivity/notion-onboarding.js';
import { propertyValue } from '../src/adapters/productivity/exact-bindings.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const inspectedAt = '2026-07-21T04:36:03.000Z';
const objective =
  'Set up my life and work in Notion using the context I provided. Show me the complete plan and preview before making changes.';

async function loadCeoProposal(): Promise<PlanProposal> {
  return JSON.parse(
    await readFile(path.join(fixtureDirectory, 'notion-ceo-life-workspace-proposal.json'), 'utf8'),
  ) as PlanProposal;
}

function discovery(
  candidates: DestinationDiscovery['candidates'],
  existingObjects: DestinationDiscovery['existingObjects'] = [],
): DestinationDiscovery {
  return {
    integration: 'notion',
    candidates,
    existingObjects,
    inspectedAt,
    warnings: [],
  };
}

describe('Notion personal onboarding', () => {
  it('derives a Life OS root and ignores product demo destinations', () => {
    expect(deriveNotionRootName(objective)).toBe('Life OS');
    expect(
      isIgnoredNotionDestination(
        { name: 'Aurous Product HQ', description: 'Prior demo parent' },
        objective,
      ),
    ).toBe(true);
    expect(
      isIgnoredNotionDestination(
        { name: 'Aurous Product HQ', description: 'deleted page' },
        objective,
      ),
    ).toBe(true);
    expect(isNotionPersonalOnboarding(objective, '', true)).toBe(true);
    expect(isNotionPersonalOnboarding('Set up Notion for this project', '', true)).toBe(false);
  });

  it('creates a fresh root when discovery has no pages or only stale Product HQ', () => {
    const empty = resolveNotionPersonalDestination({
      discovery: discovery([]),
      objective,
    });
    expect(empty).toMatchObject({
      id: NOTION_WORKSPACE_SENTINEL,
      name: 'Life OS',
      source: 'context-root-create',
    });

    const stale = resolveNotionPersonalDestination({
      discovery: discovery([
        {
          id: 'deleted-hq',
          name: 'Aurous Product HQ',
          kind: 'page',
          description: 'deleted / archived demo page',
          existingAurousMatch: true,
        },
      ]),
      objective,
    });
    expect(stale.source).toBe('context-root-create');
    expect(stale.name).toBe('Life OS');
    expect(stale.id).toBe(NOTION_WORKSPACE_SENTINEL);
  });

  it('reuses an active Life OS root found in the current discovery only', () => {
    const resolved = resolveNotionPersonalDestination({
      discovery: discovery(
        [
          {
            id: 'life-os-live',
            name: 'Life OS',
            kind: 'page',
            description: 'Active personal root',
            existingAurousMatch: true,
          },
          {
            id: 'hq',
            name: 'Aurous Product HQ',
            kind: 'page',
            description: 'Unrelated demo',
            existingAurousMatch: true,
          },
        ],
        [
          {
            id: 'child-db',
            name: 'Goals & Outcomes',
            type: 'notion.database',
            destinationId: 'life-os-live',
            parentId: 'life-os-live',
          },
        ],
      ),
      objective,
    });
    expect(resolved).toMatchObject({
      id: 'life-os-live',
      name: 'Life OS',
      source: 'existing-match',
    });
    expect(resolved.existingObjects.map((object) => object.name)).toEqual(['Goals & Outcomes']);
  });

  it('injects Life OS as action-001 without requiring a user-selected parent', async () => {
    const destination: ResolvedDestination = {
      integration: 'notion',
      id: NOTION_WORKSPACE_SENTINEL,
      name: 'Life OS',
      kind: 'page',
      source: 'context-root-create',
      sourceDetail: 'Fresh root',
      verifiedAt: inspectedAt,
      existingObjects: [],
      discoveryWarnings: [],
    };
    const proposal = await loadCeoProposal();
    const ensured = ensureNotionPersonalRootPlan(proposal, destination);
    expect(ensured.plannedActions[0]).toMatchObject({
      id: 'action-001',
      operation: 'create',
      target: 'Life OS',
    });
    expect(propertyValue(ensured.plannedActions[0]!.properties, 'notion.parent.workspace')).toBe(
      'true',
    );
    expect(
      propertyValue(ensured.plannedActions[0]!.properties, 'notion.destination.parentPageId'),
    ).toBe(NOTION_WORKSPACE_SENTINEL);
    for (const action of ensured.plannedActions.slice(1)) {
      expect(action.dependsOn).toContain('action-001');
      expect(propertyValue(action.properties, 'notion.destination.rootActionId')).toBe(
        'action-001',
      );
      expect(propertyValue(action.properties, 'notion.destination.parentPageId')).toBe(
        NOTION_WORKSPACE_SENTINEL,
      );
    }
    expect(ensured.plannedActions.some((action) => action.target === 'CEO Home')).toBe(true);
  });

  it('plans and applies a full CEO life workspace under a fresh automatic root', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-life-os-'));
    await writeFile(path.join(workspace, 'ceo-context.md'), '# CEO life context\nLife and work.\n');
    const store = new LocalRunStore(workspace);
    await store.init({ defaultAgent: 'mock', defaultTool: 'notion' });
    await writeFile(
      path.join(workspace, '.aurous', 'context.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        project: { name: path.basename(workspace), root: workspace, technology: [], commands: [] },
        activeIntegrations: ['notion'],
        destinations: [
          {
            integration: 'notion',
            id: 'stale-deleted-hq',
            name: 'Aurous Product HQ',
            kind: 'page',
            source: 'saved-project',
            sourceDetail: 'deleted previous demo',
            verifiedAt: inspectedAt,
            existingObjects: [],
            discoveryWarnings: [],
          },
        ],
        workspacePreferences: { verbose: false },
        updatedAt: inspectedAt,
      })}\n`,
    );

    const mock = new MockAgentAdapter();
    const notion = new NotionAdapter();
    const ceoProposal = await loadCeoProposal();
    const discoveryEmpty = discovery(
      [
        {
          id: 'stale-deleted-hq',
          name: 'Aurous Product HQ',
          kind: 'page',
          description: 'deleted previous demo workspace',
          existingAurousMatch: true,
        },
      ],
      [],
    );
    const output = {
      logs: [] as string[],
      log(message = '') {
        this.logs.push(message);
      },
      error(message: string) {
        this.logs.push(message);
      },
    };

    const makeAgent = (discoveryValue: DestinationDiscovery): (() => AgentAdapter) => () => ({
      name: 'mock',
      diagnose: () => mock.diagnose(),
      discoverDestinations: () =>
        Promise.resolve({
          value: discoveryValue,
          command: ['mock-discovery'],
          stdout: JSON.stringify(discoveryValue),
          stderr: '',
          durationMs: 0,
        }),
      generatePlan: () =>
        Promise.resolve({
          value: ceoProposal,
          command: ['mock-plan'],
          stdout: '{}',
          stderr: '',
          durationMs: 0,
        }),
      executePlan: (input) => mock.executePlan(input),
      inspectRecovery: (input) => mock.inspectRecovery(input),
      executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
      manualFallback: (directory, phase, prompt) => mock.manualFallback(directory, phase, prompt),
    });

    const services = new AurousServices({
      workspace,
      store,
      output,
      progressIntervalMs: 1,
      agentFactory: makeAgent(discoveryEmpty),
    });

    const plan = await services.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['ceo-context.md'],
      objective,
    });

    expect(output.logs.join('\n')).toContain('✓ Creating Life OS');
    expect(output.logs.join('\n')).not.toContain('Where should Aurous build');
    expect(output.logs.join('\n')).not.toContain('stale-deleted-hq');
    expect(plan.plannedActions[0]?.target).toBe('Life OS');
    expect(plan.plannedActions[0]?.id).toBe('action-001');
    expect(
      plan.plannedActions.every(
        (action) =>
          propertyValue(action.properties, 'notion.destination.parentPageId') ===
          NOTION_WORKSPACE_SENTINEL,
      ),
    ).toBe(true);
    expect(
      plan.plannedActions.some((action) =>
        propertyValue(action.properties, 'notion.database.properties')?.includes('"type":"status"'),
      ),
    ).toBe(false);

    const result = await services.apply(plan.runId, { confirmed: true });
    expect(result?.status).toBe('succeeded');
    expect(result?.createdObjects.some((object) => object.name === 'Life OS')).toBe(true);

    const created = result!.createdObjects;
    const lifeOs = created.find((object) => object.name === 'Life OS')!;
    const repeatDiscovery = discovery(
      [
        {
          id: lifeOs.externalId!,
          name: 'Life OS',
          kind: 'page',
          description: 'Active personal root',
          existingAurousMatch: true,
        },
      ],
      created
        .filter((object) => object.name !== 'Life OS')
        .map((object) => ({
          id: object.externalId!,
          name: object.name,
          type: object.type,
          destinationId: lifeOs.externalId!,
          parentId: lifeOs.externalId!,
        })),
    );
    const repeatServices = new AurousServices({
      workspace,
      store,
      output,
      progressIntervalMs: 1,
      agentFactory: makeAgent(repeatDiscovery),
    });
    const repeatPlan = await repeatServices.plan({
      agent: 'mock',
      tool: 'notion',
      contextPaths: ['ceo-context.md'],
      objective,
    });
    expect(output.logs.join('\n')).toContain('✓ Using Life OS');
    const creates = repeatPlan.plannedActions.filter((action) => action.operation === 'create');
    expect(
      creates.every((action) => propertyValue(action.properties, 'notion.dedupe.skipReason')),
    ).toBe(true);
    const repeatApply = await mock.executePlan({
      workspace,
      runDirectory: path.join(workspace, '.aurous', 'runs', 'repeat'),
      plan: repeatPlan,
      productivity: notion,
      timeoutMs: 5_000,
    });
    expect(repeatApply.value.status).toBe('succeeded');
    expect(repeatApply.value.createdObjects).toHaveLength(0);
  });
});
