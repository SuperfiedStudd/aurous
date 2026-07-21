import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import { TrelloAdapter } from '../src/adapters/productivity/trello.js';
import {
  deriveTrelloBoardName,
  ensureTrelloPersonalRootPlan,
  isIgnoredTrelloDestination,
  isTrelloPersonalOnboarding,
  resolveTrelloPersonalDestination,
} from '../src/adapters/productivity/trello-onboarding.js';
import { normalizeTrelloPlanCapabilities } from '../src/adapters/productivity/trello-plan-capabilities.js';
import { propertyValue } from '../src/adapters/productivity/exact-bindings.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const inspectedAt = '2026-07-21T04:36:03.000Z';
const objective =
  'Set up my life and work in Trello using the context I provided. Show me the complete plan and preview before making changes.';

function discovery(
  candidates: DestinationDiscovery['candidates'],
  existingObjects: DestinationDiscovery['existingObjects'] = [],
): DestinationDiscovery {
  return {
    integration: 'trello',
    candidates,
    existingObjects,
    inspectedAt,
    warnings: [],
  };
}

function lifeOsProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      { kind: 'board', name: 'Life OS', purpose: 'Personal operating board.' },
      { kind: 'list', name: 'Now', purpose: 'Current focus.' },
      { kind: 'list', name: 'Next', purpose: 'Upcoming work.' },
      { kind: 'card', name: 'Clarify weekly priorities', purpose: 'Starter card.' },
      { kind: 'checklist', name: 'Weekly checklist', purpose: 'Starter checklist.' },
      { kind: 'label', name: 'Focus', purpose: 'Unsupported label create.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'trello.board',
        target: 'Life OS',
        description: 'Create the Life OS board.',
        properties: [{ key: 'trello.board', value: 'Life OS' }],
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'trello.list',
        target: 'Now',
        description: 'Create the Now list.',
        properties: [
          { key: 'trello.boardActionId', value: 'action-001' },
          { key: 'trello.board', value: 'Life OS' },
        ],
        dependsOn: ['action-001'],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'trello.list',
        target: 'Next',
        description: 'Create the Next list.',
        properties: [
          { key: 'trello.boardActionId', value: 'action-001' },
          { key: 'trello.board', value: 'Life OS' },
        ],
        dependsOn: ['action-001'],
      },
      {
        id: 'action-004',
        operation: 'create',
        objectType: 'trello.card',
        target: 'Clarify weekly priorities',
        description: 'Create a starter card.',
        properties: [
          { key: 'trello.boardActionId', value: 'action-001' },
          { key: 'trello.listActionId', value: 'action-002' },
          { key: 'trello.list', value: 'Now' },
        ],
        dependsOn: ['action-001', 'action-002'],
      },
      {
        id: 'action-005',
        operation: 'create',
        objectType: 'trello.checklist',
        target: 'Weekly checklist',
        description: 'Create a starter checklist.',
        properties: [
          { key: 'trello.cardActionId', value: 'action-004' },
          { key: 'trello.card', value: 'Clarify weekly priorities' },
        ],
        dependsOn: ['action-004'],
      },
      {
        id: 'action-006',
        operation: 'create',
        objectType: 'trello.label',
        target: 'Focus',
        description: 'Create an unsupported label.',
        properties: [{ key: 'trello.boardActionId', value: 'action-001' }],
        dependsOn: ['action-001'],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'A Trello Life OS board with useful starter structure.',
  };
}

describe('Trello personal onboarding', () => {
  it('derives a Life OS board and ignores stale demo workspaces', () => {
    expect(deriveTrelloBoardName(objective)).toBe('Life OS');
    expect(
      isIgnoredTrelloDestination(
        { name: 'Old Workspace', description: 'deleted / archived workspace' },
        objective,
      ),
    ).toBe(true);
    expect(isTrelloPersonalOnboarding(objective, '', true)).toBe(true);
    expect(isTrelloPersonalOnboarding('Set up Trello for this project', '', true)).toBe(false);
  });

  it('creates a fresh board in the authenticated default workspace', () => {
    const resolved = resolveTrelloPersonalDestination({
      discovery: discovery(
        [
          {
            id: 'wsp-default',
            name: 'Personal Workspace',
            kind: 'workspace',
          existingAurousMatch: false,
            description: 'Authenticated default workspace',
          },
          {
            id: 'wsp-dead',
            name: 'Old Workspace',
            kind: 'workspace',
          description: 'deleted inaccessible workspace',
            existingAurousMatch: true,
          },
        ],
        [
          {
            id: 'board-demo',
            name: 'Aurous Launch HQ',
            type: 'trello.board',
            destinationId: 'wsp-default',
            parentId: 'wsp-default',
          },
        ],
      ),
      objective,
    });
    expect(resolved).toMatchObject({
      id: 'wsp-default',
      name: 'Personal Workspace',
      source: 'context-root-create',
      operatingRootName: 'Life OS',
    });
    expect(resolved.discoveryWarnings.join(' ')).toMatch(/unrelated Trello boards/i);
  });

  it('reuses an exact Life OS board and ignores unrelated demo boards', () => {
    const resolved = resolveTrelloPersonalDestination({
      discovery: discovery(
        [
          {
            id: 'wsp-default',
            name: 'Personal Workspace',
            kind: 'workspace',
          existingAurousMatch: false,
            description: 'Authenticated default workspace',
          },
        ],
        [
          {
            id: 'board-life',
            name: 'Life OS',
            type: 'trello.board',
            destinationId: 'wsp-default',
            parentId: 'wsp-default',
          },
          {
            id: 'board-demo',
            name: 'Aurous Launch HQ',
            type: 'trello.board',
            destinationId: 'wsp-default',
            parentId: 'wsp-default',
          },
          {
            id: 'list-now',
            name: 'Now',
            type: 'trello.list',
            destinationId: 'wsp-default',
            parentId: 'board-life',
          },
        ],
      ),
      objective,
    });
    expect(resolved).toMatchObject({
      id: 'wsp-default',
      source: 'existing-match',
      operatingRootName: 'Life OS',
    });
    expect(resolved.existingObjects.map((object) => object.name).sort()).toEqual([
      'Life OS',
      'Now',
    ]);
  });

  it('injects Life OS as action-001 and normalizes unsupported label creates before preview', () => {
    const destination: ResolvedDestination = {
      integration: 'trello',
      id: 'wsp-default',
      name: 'Personal Workspace',
      kind: 'workspace',
      source: 'context-root-create',
      sourceDetail: 'Fresh board',
      verifiedAt: inspectedAt,
      existingObjects: [],
      discoveryWarnings: [],
      operatingRootName: 'Life OS',
    };
    const ensured = ensureTrelloPersonalRootPlan(lifeOsProposal(), destination);
    expect(ensured.plannedActions[0]).toMatchObject({
      id: 'action-001',
      operation: 'create',
      target: 'Life OS',
    });
    const normalized = normalizeTrelloPlanCapabilities(ensured);
    expect(normalized.plannedActions.some((action) => /label/i.test(action.objectType))).toBe(
      false,
    );
    expect(normalized.warnings.join(' ')).toMatch(/Removed Trello label create/i);
    const bound = new TrelloAdapter().bindDestination(lifeOsProposal(), destination);
    expect(propertyValue(bound.plannedActions[0]!.properties, 'trello.workspaceId')).toBe(
      'wsp-default',
    );
    expect(bound.plannedActions.some((action) => /label/i.test(action.objectType))).toBe(false);
  });

  it('plans and applies a full Life OS board with zero duplicate reruns', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-trello-life-'));
    await writeFile(path.join(workspace, 'life-context.md'), '# Life OS\nLife and work.\n');
    const store = new LocalRunStore(workspace);
    await store.init({ defaultAgent: 'mock', defaultTool: 'trello' });
    await writeFile(
      path.join(workspace, '.aurous', 'context.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        project: { name: path.basename(workspace), root: workspace, technology: [], commands: [] },
        activeIntegrations: ['trello'],
        destinations: [
          {
            integration: 'trello',
            id: 'stale-deleted-wsp',
            name: 'Old Workspace',
            kind: 'workspace',
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
    const trello = new TrelloAdapter();
    const proposal = lifeOsProposal();
    const discoveryEmpty = discovery(
      [
        {
          id: 'stale-deleted-wsp',
          name: 'Old Workspace',
          kind: 'workspace',
          description: 'deleted previous demo workspace',
          existingAurousMatch: true,
        },
        {
          id: 'wsp-default',
          name: 'Personal Workspace',
          kind: 'workspace',
          existingAurousMatch: false,
          description: 'Authenticated default workspace',
        },
      ],
      [
        {
          id: 'board-demo',
          name: 'Aurous Launch HQ',
          type: 'trello.board',
          destinationId: 'wsp-default',
          parentId: 'wsp-default',
        },
      ],
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
          value: proposal,
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
      tool: 'trello',
      contextPaths: ['life-context.md'],
      objective,
    });

    expect(output.logs.join('\n')).toContain('✓ Creating Life OS');
    expect(output.logs.join('\n')).not.toContain('Which Trello workspace');
    expect(output.logs.join('\n')).not.toContain('stale-deleted-wsp');
    expect(plan.plannedActions[0]?.target).toBe('Life OS');
    expect(plan.plannedActions[0]?.id).toBe('action-001');
    expect(
      plan.plannedActions.every(
        (action) => propertyValue(action.properties, 'trello.workspaceId') === 'wsp-default',
      ),
    ).toBe(true);
    expect(plan.plannedActions.some((action) => /label/i.test(action.objectType))).toBe(false);

    const result = await services.apply(plan.runId, { confirmed: true });
    expect(result?.status).toBe('succeeded');
    expect(result?.createdObjects.some((object) => object.name === 'Life OS')).toBe(true);

    const created = result!.createdObjects;
    const lifeOs = created.find((object) => object.name === 'Life OS')!;
    const lists = created.filter((object) => /list/i.test(object.type));
    const cards = created.filter((object) => /card/i.test(object.type));
    const checklists = created.filter((object) => /checklist/i.test(object.type));
    const repeatDiscovery = discovery(
      [
        {
          id: 'wsp-default',
          name: 'Personal Workspace',
          kind: 'workspace',
          existingAurousMatch: false,
          description: 'Authenticated default workspace',
        },
      ],
      [
        {
          id: lifeOs.externalId!,
          name: 'Life OS',
          type: 'trello.board',
          destinationId: 'wsp-default',
          parentId: 'wsp-default',
        },
        ...lists.map((object) => ({
          id: object.externalId!,
          name: object.name,
          type: object.type,
          destinationId: 'wsp-default',
          parentId: lifeOs.externalId!,
        })),
        ...cards.map((object) => ({
          id: object.externalId!,
          name: object.name,
          type: object.type,
          destinationId: 'wsp-default',
          parentId: lists[0]?.externalId ?? lifeOs.externalId!,
        })),
        ...checklists.map((object) => ({
          id: object.externalId!,
          name: object.name,
          type: object.type,
          destinationId: 'wsp-default',
          parentId: cards[0]?.externalId ?? lifeOs.externalId!,
        })),
      ],
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
      tool: 'trello',
      contextPaths: ['life-context.md'],
      objective,
    });
    expect(output.logs.join('\n')).toContain('✓ Using Life OS');
    const creates = repeatPlan.plannedActions.filter((action) => action.operation === 'create');
    expect(
      creates.every((action) => propertyValue(action.properties, 'trello.dedupe.skipReason')),
    ).toBe(true);
    const repeatApply = await mock.executePlan({
      workspace,
      runDirectory: path.join(workspace, '.aurous', 'runs', 'repeat'),
      plan: repeatPlan,
      productivity: trello,
      timeoutMs: 5_000,
    });
    expect(repeatApply.value.status).toBe('succeeded');
    expect(repeatApply.value.createdObjects).toHaveLength(0);
  });
});
