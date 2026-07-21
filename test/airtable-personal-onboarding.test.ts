import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import { AirtableAdapter } from '../src/adapters/productivity/airtable.js';
import {
  deriveAirtableBaseName,
  ensureAirtablePersonalRootPlan,
  isIgnoredAirtableDestination,
  isAirtablePersonalOnboarding,
  resolveAirtablePersonalDestination,
} from '../src/adapters/productivity/airtable-onboarding.js';
import { normalizeAirtablePlanCapabilities } from '../src/adapters/productivity/airtable-plan-capabilities.js';
import { propertyValue } from '../src/adapters/productivity/exact-bindings.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const inspectedAt = '2026-07-21T04:36:03.000Z';
const objective =
  'Set up my life and work in Airtable using the context I provided. Show me the complete plan and preview before making changes.';

function discovery(
  candidates: DestinationDiscovery['candidates'],
  existingObjects: DestinationDiscovery['existingObjects'] = [],
): DestinationDiscovery {
  return {
    integration: 'airtable',
    candidates,
    existingObjects,
    inspectedAt,
    warnings: [],
  };
}

function lifeOsProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      { kind: 'base', name: 'Life OS', purpose: 'Personal operating base.' },
      { kind: 'table', name: 'Goals', purpose: 'Track goals.' },
      { kind: 'record', name: 'Clarify weekly priorities', purpose: 'Starter record.' },
      { kind: 'view', name: 'Active Goals', purpose: 'Unsupported view.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'airtable.base',
        target: 'Life OS',
        description: 'Create the Life OS base.',
        properties: [
          {
            key: 'airtable.base.initialTables',
            value: JSON.stringify([
              { name: 'Goals', primaryField: { name: 'Name', type: 'singleLineText' } },
              { name: 'Projects', primaryField: { name: 'Name', type: 'singleLineText' } },
              { name: 'Tasks', primaryField: { name: 'Name', type: 'singleLineText' } },
            ]),
          },
        ],
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'airtable.record',
        target: 'Clarify weekly priorities',
        description: 'Create a starter Goals record.',
        properties: [
          { key: 'airtable.baseActionId', value: 'action-001' },
          { key: 'airtable.bootstrapTableName', value: 'Goals' },
        ],
        dependsOn: ['action-001'],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'airtable.view',
        target: 'Active Goals',
        description: 'Create an unsupported view.',
        properties: [
          { key: 'airtable.baseActionId', value: 'action-001' },
          { key: 'airtable.view.type', value: 'grid' },
        ],
        dependsOn: ['action-001'],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'An Airtable Life OS base with useful starter structure.',
  };
}

describe('Airtable personal onboarding', () => {
  it('derives a Life OS base and ignores stale demo workspaces', () => {
    expect(deriveAirtableBaseName(objective)).toBe('Life OS');
    expect(
      isIgnoredAirtableDestination(
        { name: 'Old Workspace', description: 'deleted / archived workspace' },
        objective,
      ),
    ).toBe(true);
    expect(isAirtablePersonalOnboarding(objective, '', true)).toBe(true);
    expect(isAirtablePersonalOnboarding('Set up Airtable for this project', '', true)).toBe(false);
  });

  it('creates a fresh base in the authenticated default workspace', () => {
    const resolved = resolveAirtablePersonalDestination({
      discovery: discovery(
        [
          {
            id: 'wsp-default',
            name: 'My First Workspace',
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
            id: 'app-demo',
            name: 'Aurous Build Week HQ',
            type: 'airtable.base',
            destinationId: 'wsp-default',
            parentId: 'wsp-default',
          },
        ],
      ),
      objective,
    });
    expect(resolved).toMatchObject({
      id: 'wsp-default',
      name: 'My First Workspace',
      source: 'context-root-create',
      operatingRootName: 'Life OS',
    });
    expect(resolved.discoveryWarnings.join(' ')).toMatch(/unrelated Airtable bases/i);
  });

  it('reuses an exact Life OS base and ignores unrelated demo bases', () => {
    const resolved = resolveAirtablePersonalDestination({
      discovery: discovery(
        [
          {
            id: 'wsp-default',
            name: 'My First Workspace',
            kind: 'workspace',
          existingAurousMatch: false,
            description: 'Authenticated default workspace',
          },
        ],
        [
          {
            id: 'app-life',
            name: 'Life OS',
            type: 'airtable.base',
            destinationId: 'wsp-default',
            parentId: 'wsp-default',
          },
          {
            id: 'app-demo',
            name: 'Aurous Build Week HQ',
            type: 'airtable.base',
            destinationId: 'wsp-default',
            parentId: 'wsp-default',
          },
          {
            id: 'tbl-goals',
            name: 'Goals',
            type: 'airtable.table',
            destinationId: 'wsp-default',
            parentId: 'app-life',
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
    expect(resolved.existingObjects.map((object) => object.name).sort()).toEqual(['Goals', 'Life OS']);
  });

  it('injects Life OS as action-001 and normalizes unsupported views before preview', () => {
    const destination: ResolvedDestination = {
      integration: 'airtable',
      id: 'wsp-default',
      name: 'My First Workspace',
      kind: 'workspace',
      source: 'context-root-create',
      sourceDetail: 'Fresh base',
      verifiedAt: inspectedAt,
      existingObjects: [],
      discoveryWarnings: [],
      operatingRootName: 'Life OS',
    };
    const ensured = ensureAirtablePersonalRootPlan(lifeOsProposal(), destination);
    expect(ensured.plannedActions[0]).toMatchObject({
      id: 'action-001',
      operation: 'create',
      target: 'Life OS',
    });
    expect(propertyValue(ensured.plannedActions[0]!.properties, 'airtable.base.initialTables')).toBeTruthy();
    const normalized = normalizeAirtablePlanCapabilities(ensured);
    expect(normalized.plannedActions.some((action) => /view/i.test(action.objectType))).toBe(false);
    expect(normalized.warnings.join(' ')).toMatch(/unsupported Airtable view/i);
    const bound = new AirtableAdapter().bindDestination(lifeOsProposal(), destination);
    expect(propertyValue(bound.plannedActions[0]!.properties, 'airtable.workspaceId')).toBe(
      'wsp-default',
    );
    expect(bound.plannedActions.some((action) => /view/i.test(action.objectType))).toBe(false);
  });

  it('plans and applies a full Life OS base with zero duplicate reruns', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-airtable-life-'));
    await writeFile(path.join(workspace, 'life-context.md'), '# Life OS\nLife and work.\n');
    const store = new LocalRunStore(workspace);
    await store.init({ defaultAgent: 'mock', defaultTool: 'airtable' });
    await writeFile(
      path.join(workspace, '.aurous', 'context.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        project: { name: path.basename(workspace), root: workspace, technology: [], commands: [] },
        activeIntegrations: ['airtable'],
        destinations: [
          {
            integration: 'airtable',
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
    const airtable = new AirtableAdapter();
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
          name: 'My First Workspace',
          kind: 'workspace',
          existingAurousMatch: false,
          description: 'Authenticated default workspace',
        },
      ],
      [
        {
          id: 'app-demo',
          name: 'Aurous Build Week HQ',
          type: 'airtable.base',
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
      tool: 'airtable',
      contextPaths: ['life-context.md'],
      objective,
    });

    expect(output.logs.join('\n')).toContain('✓ Creating Life OS');
    expect(output.logs.join('\n')).not.toContain('Which Airtable workspace');
    expect(output.logs.join('\n')).not.toContain('stale-deleted-wsp');
    expect(plan.plannedActions[0]?.target).toBe('Life OS');
    expect(plan.plannedActions[0]?.id).toBe('action-001');
    expect(
      plan.plannedActions.every(
        (action) => propertyValue(action.properties, 'airtable.workspaceId') === 'wsp-default',
      ),
    ).toBe(true);
    expect(plan.plannedActions.some((action) => /view/i.test(action.objectType))).toBe(false);

    const result = await services.apply(plan.runId, { confirmed: true });
    expect(result?.status).toBe('succeeded');
    expect(result?.createdObjects.some((object) => object.name === 'Life OS')).toBe(true);

    const created = result!.createdObjects;
    const lifeOs = created.find((object) => object.name === 'Life OS')!;
    const repeatDiscovery = discovery(
      [
        {
          id: 'wsp-default',
          name: 'My First Workspace',
          kind: 'workspace',
          existingAurousMatch: false,
          description: 'Authenticated default workspace',
        },
      ],
      created.map((object) => ({
        id: object.externalId!,
        name: object.name,
        type: object.type,
        destinationId: 'wsp-default',
        parentId: object.name === 'Life OS' ? 'wsp-default' : lifeOs.externalId!,
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
      tool: 'airtable',
      contextPaths: ['life-context.md'],
      objective,
    });
    expect(output.logs.join('\n')).toContain('✓ Using Life OS');
    const creates = repeatPlan.plannedActions.filter((action) => action.operation === 'create');
    expect(
      creates.every((action) => propertyValue(action.properties, 'airtable.dedupe.skipReason')),
    ).toBe(true);
    const repeatApply = await mock.executePlan({
      workspace,
      runDirectory: path.join(workspace, '.aurous', 'runs', 'repeat'),
      plan: repeatPlan,
      productivity: airtable,
      timeoutMs: 5_000,
    });
    expect(repeatApply.value.status).toBe('succeeded');
    expect(repeatApply.value.createdObjects).toHaveLength(0);
  });
});
