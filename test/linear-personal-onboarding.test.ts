import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/agents/types.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import { LinearAdapter } from '../src/adapters/productivity/linear.js';
import {
  deriveLinearProjectName,
  ensureLinearPersonalRootPlan,
  isIgnoredLinearDestination,
  isLinearPersonalOnboarding,
  resolveLinearPersonalDestination,
} from '../src/adapters/productivity/linear-onboarding.js';
import { normalizeLinearPlanCapabilities } from '../src/adapters/productivity/linear-plan-capabilities.js';
import { propertyValue } from '../src/adapters/productivity/exact-bindings.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import type { DestinationDiscovery, ResolvedDestination } from '../src/domain/destinations.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const inspectedAt = '2026-07-21T04:36:03.000Z';
const objective =
  'Set up my life and work in Linear using the context I provided. Show me the complete plan and preview before making changes.';

function discovery(
  candidates: DestinationDiscovery['candidates'],
  existingObjects: DestinationDiscovery['existingObjects'] = [],
): DestinationDiscovery {
  return {
    integration: 'linear',
    candidates,
    existingObjects,
    inspectedAt,
    warnings: [],
  };
}

function lifeOsProposal(): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      { kind: 'project', name: 'Life OS', purpose: 'Personal operating project.' },
      { kind: 'label', name: 'focus', purpose: 'Priority focus work.' },
      { kind: 'milestone', name: 'This Week', purpose: 'Near-term outcomes.' },
      { kind: 'issue', name: 'Clarify weekly priorities', purpose: 'Starter issue.' },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'project',
        target: 'Life OS',
        description: 'Create the Life OS operating project.',
        properties: [{ key: 'description', value: objective }],
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'label',
        target: 'focus',
        description: 'Create a focus label.',
        properties: [{ key: 'color', value: '#0EA5E9' }],
        dependsOn: [],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'milestone',
        target: 'This Week',
        description: 'Create a weekly milestone.',
        properties: [{ key: 'linear.project', value: 'Life OS' }],
        dependsOn: ['action-001'],
      },
      {
        id: 'action-004',
        operation: 'create',
        objectType: 'issue',
        target: 'Clarify weekly priorities',
        description: 'Create a starter issue.',
        properties: [
          { key: 'linear.project', value: 'Life OS' },
          { key: 'linear.milestone', value: 'This Week' },
          { key: 'priority', value: 'high' },
          { key: 'labels', value: JSON.stringify(['focus']) },
        ],
        dependsOn: ['action-001', 'action-002', 'action-003'],
      },
      {
        id: 'action-005',
        operation: 'create',
        objectType: 'cycle',
        target: 'Cycle 1',
        description: 'Unsupported cycle create.',
        properties: [],
        dependsOn: [],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'A Linear Life OS project with useful starter structure.',
  };
}

describe('Linear personal onboarding', () => {
  it('derives a Life OS project and ignores stale demo teams', () => {
    expect(deriveLinearProjectName(objective)).toBe('Life OS');
    expect(
      isIgnoredLinearDestination(
        { name: 'Demo Team', description: 'deleted / archived team' },
        objective,
      ),
    ).toBe(true);
    expect(isLinearPersonalOnboarding(objective, '', true)).toBe(true);
    expect(isLinearPersonalOnboarding('Set up Linear for this project', '', true)).toBe(false);
  });

  it('selects the only writable team and creates a fresh operating project', () => {
    const resolved = resolveLinearPersonalDestination({
      discovery: discovery([
        {
          id: 'team-eng',
          name: 'Engineering',
          kind: 'team',
          existingAurousMatch: false,
          description: 'Active writable team',
        },
        {
          id: 'team-dead',
          name: 'Old Team',
          kind: 'team',
          description: 'deleted inaccessible team',
          existingAurousMatch: true,
        },
      ]),
      objective,
    });
    expect(resolved).toMatchObject({
      id: 'team-eng',
      name: 'Engineering',
      source: 'context-root-create',
      operatingRootName: 'Life OS',
    });
  });

  it('picks a deterministic team when multiple writable teams exist', () => {
    const resolved = resolveLinearPersonalDestination({
      discovery: discovery([
        { id: 'team-b', name: 'Beta', kind: 'team', description: 'Writable', existingAurousMatch: false },
        { id: 'team-a', name: 'Alpha', kind: 'team', description: 'Writable', existingAurousMatch: false },
      ]),
      objective,
    });
    expect(resolved.id).toBe('team-a');
    expect(resolved.name).toBe('Alpha');
    expect(resolved.operatingRootName).toBe('Life OS');
  });

  it('reuses an exact Life OS project inside the selected team only', () => {
    const resolved = resolveLinearPersonalDestination({
      discovery: discovery(
        [
          {
            id: 'team-eng',
            name: 'Engineering',
            kind: 'team',
          existingAurousMatch: false,
            description: 'Active writable team',
          },
        ],
        [
          {
            id: 'proj-life',
            name: 'Life OS',
            type: 'project',
            destinationId: 'team-eng',
            parentId: 'team-eng',
          },
          {
            id: 'proj-demo',
            name: 'Aurous Project',
            type: 'project',
            destinationId: 'team-eng',
            parentId: 'team-eng',
          },
          {
            id: 'issue-1',
            name: 'Clarify weekly priorities',
            type: 'issue',
            destinationId: 'team-eng',
            parentId: 'proj-life',
            identifier: 'ENG-1',
          },
        ],
      ),
      objective,
    });
    expect(resolved).toMatchObject({
      id: 'team-eng',
      source: 'existing-match',
      operatingRootName: 'Life OS',
    });
    expect(resolved.existingObjects.map((object) => object.name).sort()).toEqual([
      'Clarify weekly priorities',
      'Life OS',
    ]);
  });

  it('injects Life OS as action-001 and normalizes unsupported capabilities before preview', () => {
    const destination: ResolvedDestination = {
      integration: 'linear',
      id: 'team-eng',
      name: 'Engineering',
      kind: 'team',
      source: 'context-root-create',
      sourceDetail: 'Fresh project',
      verifiedAt: inspectedAt,
      existingObjects: [],
      discoveryWarnings: [],
      operatingRootName: 'Life OS',
    };
    const ensured = ensureLinearPersonalRootPlan(lifeOsProposal(), destination);
    expect(ensured.plannedActions[0]).toMatchObject({
      id: 'action-001',
      operation: 'create',
      target: 'Life OS',
    });
    const normalized = normalizeLinearPlanCapabilities(ensured);
    expect(normalized.plannedActions.some((action) => action.objectType === 'cycle')).toBe(false);
    expect(normalized.warnings.join(' ')).toMatch(/unsupported Linear cycle/i);
    const bound = new LinearAdapter().bindDestination(lifeOsProposal(), destination);
    expect(propertyValue(bound.plannedActions[0]!.properties, 'linear.teamId')).toBe('team-eng');
    expect(bound.plannedActions.some((action) => action.objectType === 'cycle')).toBe(false);
    expect(propertyValue(bound.plannedActions[0]!.properties, 'linear.team')).toBe('Engineering');
  });

  it('plans and applies a full Life OS setup under an automatic team with zero duplicate reruns', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-linear-life-'));
    await writeFile(path.join(workspace, 'life-context.md'), '# Life OS\nLife and work.\n');
    const store = new LocalRunStore(workspace);
    await store.init({ defaultAgent: 'mock', defaultTool: 'linear' });
    await writeFile(
      path.join(workspace, '.aurous', 'context.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        project: { name: path.basename(workspace), root: workspace, technology: [], commands: [] },
        activeIntegrations: ['linear'],
        destinations: [
          {
            integration: 'linear',
            id: 'stale-deleted-team',
            name: 'Old Demo Team',
            kind: 'team',
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
    const linear = new LinearAdapter();
    const proposal = lifeOsProposal();
    const discoveryEmpty = discovery(
      [
        {
          id: 'stale-deleted-team',
          name: 'Old Demo Team',
          kind: 'team',
          description: 'deleted previous demo team',
          existingAurousMatch: true,
        },
        {
          id: 'team-eng',
          name: 'Engineering',
          kind: 'team',
          existingAurousMatch: false,
          description: 'Active writable team',
        },
      ],
      [
        {
          id: 'proj-demo',
          name: 'Aurous Project',
          type: 'project',
          destinationId: 'team-eng',
          parentId: 'team-eng',
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
      tool: 'linear',
      contextPaths: ['life-context.md'],
      objective,
    });

    expect(output.logs.join('\n')).toContain('✓ Creating Life OS');
    expect(output.logs.join('\n')).not.toContain('Which team should Aurous use');
    expect(output.logs.join('\n')).not.toContain('stale-deleted-team');
    expect(plan.plannedActions[0]?.target).toBe('Life OS');
    expect(plan.plannedActions[0]?.id).toBe('action-001');
    expect(
      plan.plannedActions.every(
        (action) => propertyValue(action.properties, 'linear.teamId') === 'team-eng',
      ),
    ).toBe(true);
    expect(plan.plannedActions.some((action) => action.objectType === 'cycle')).toBe(false);
    expect(plan.warnings.join(' ')).toMatch(/unsupported Linear cycle/i);

    const result = await services.apply(plan.runId, { confirmed: true });
    expect(result?.status).toBe('succeeded');
    expect(result?.createdObjects.some((object) => object.name === 'Life OS')).toBe(true);

    const created = result!.createdObjects;
    const lifeOs = created.find((object) => object.name === 'Life OS')!;
    let issueSerial = 1;
    const repeatDiscovery = discovery(
      [
        {
          id: 'team-eng',
          name: 'Engineering',
          kind: 'team',
          existingAurousMatch: false,
          description: 'Active writable team',
        },
      ],
      created.map((object) => {
        const isIssue = /issue/i.test(object.type);
        const id = isIssue ? `ENG-${issueSerial++}` : object.externalId!;
        return {
          id,
          name: object.name,
          type: object.type,
          destinationId: 'team-eng',
          parentId: object.name === 'Life OS' ? 'team-eng' : lifeOs.externalId!,
          ...(isIssue ? { identifier: id } : {}),
        };
      }),
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
      tool: 'linear',
      contextPaths: ['life-context.md'],
      objective,
    });
    expect(output.logs.join('\n')).toContain('✓ Using Life OS');
    const creates = repeatPlan.plannedActions.filter((action) => action.operation === 'create');
    expect(
      creates.every((action) => propertyValue(action.properties, 'linear.dedupe.skipReason')),
    ).toBe(true);
    const repeatApply = await mock.executePlan({
      workspace,
      runDirectory: path.join(workspace, '.aurous', 'runs', 'repeat'),
      plan: repeatPlan,
      productivity: linear,
      timeoutMs: 5_000,
    });
    expect(repeatApply.value.status).toBe('succeeded');
    expect(repeatApply.value.createdObjects).toHaveLength(0);
  });
});
