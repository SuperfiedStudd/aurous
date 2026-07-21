import type { ActionPropertyEntry, PlanAction, PlanProposal } from '../../domain/schemas.js';
import type {
  AgentAdapter,
  AgentDiagnostic,
  DestinationDiscoveryInput,
  PlanExecutionInput,
  PlanGenerationInput,
  RecoveryActionExecutionInput,
  RecoveryInspectionInput,
} from './types.js';
import { writeManualPrompt } from './helpers.js';
import {
  hasTypedAirtableRelation,
  materializeAirtableRelationAction,
} from '../productivity/airtable-relations.js';
import {
  hasTypedNotionRelation,
  materializeNotionRelationAction,
} from '../productivity/notion-relations.js';

export class MockAgentAdapter implements AgentAdapter {
  readonly name = 'mock' as const;

  diagnose(): Promise<AgentDiagnostic> {
    return Promise.resolve({
      name: this.name,
      installed: true,
      version: 'built-in',
      supportsNonInteractive: true,
      authentication: { status: 'ready', detail: 'No authentication required.' },
      mcp: {
        notion: { status: 'ready', detail: 'Simulated by mock adapter.' },
        linear: { status: 'ready', detail: 'Simulated by mock adapter.' },
        airtable: { status: 'ready', detail: 'Simulated by mock adapter.' },
        trello: { status: 'ready', detail: 'Simulated by mock adapter.' },
      },
      warnings: [],
    });
  }

  generatePlan(input: PlanGenerationInput) {
    const started = Date.now();
    const value = createMockProposal(input.productivity.name, input.objective);
    return Promise.resolve({
      value,
      command: ['aurous-internal-mock', 'plan'],
      stdout: JSON.stringify(value),
      stderr: '',
      durationMs: Date.now() - started,
    });
  }

  discoverDestinations(input: DestinationDiscoveryInput) {
    const inspectedAt = new Date().toISOString();
    const candidate =
      input.productivity.name === 'notion'
        ? {
            id: 'mock-notion-private-page',
            name: 'Private workspace',
            kind: 'page',
            description: 'Private Notion workspace page',
            url: 'https://notion.so/mock-private-page',
            existingAurousMatch: false,
          }
        : input.productivity.name === 'linear'
          ? {
              id: 'mock-linear-team-id',
              name: 'Product team',
              kind: 'team',
              description: 'Product delivery team',
              url: null,
              existingAurousMatch: false,
            }
          : input.productivity.name === 'airtable'
            ? {
                id: 'mock-airtable-workspace-id',
                name: 'Build Week workspace',
                kind: 'workspace',
                description: 'Writable Airtable workspace',
                url: null,
                existingAurousMatch: false,
              }
            : input.productivity.name === 'trello'
              ? {
                  id: 'mock-trello-workspace-id',
                  name: 'Aurous Workspace',
                  kind: 'workspace',
                  description: 'Authorized Trello workspace',
                  url: null,
                  existingAurousMatch: false,
                }
              : {
                  id: 'mock-workspace-id',
                  name: 'Local workspace',
                  kind: 'workspace',
                  description: 'Local deterministic workspace',
                  url: null,
                  existingAurousMatch: false,
                };
    const value = {
      integration: input.productivity.name,
      candidates: [candidate],
      existingObjects: [],
      inspectedAt,
      warnings: ['Mock discovery made no external reads.'],
    };
    return Promise.resolve({
      value,
      command: ['aurous-internal-mock', 'destination-discover'],
      stdout: JSON.stringify(value),
      stderr: '',
      durationMs: 0,
    });
  }

  executePlan(input: PlanExecutionInput) {
    const started = new Date();
    const resultIdByAction = new Map<string, string>();
    const resultTypeByAction = new Map<string, string>();
    for (const action of input.plan.plannedActions) {
      const knownId = action.properties.find((property) =>
        property.key.endsWith('.dedupe.knownExternalId'),
      )?.value;
      if (knownId) {
        resultIdByAction.set(action.id, knownId);
        resultTypeByAction.set(action.id, action.objectType);
      }
    }

    const skippedActions: {
      actionId: string;
      type: string;
      name: string;
      reason: string;
      externalId: string;
      url: string;
    }[] = [];
    const createdObjects: {
      actionId: string;
      type: string;
      name: string;
      externalId: string;
      url: string;
    }[] = [];
    const completedActionIds: string[] = [];

    for (const action of input.plan.plannedActions) {
      const skipReason = action.properties.find(
        (property) =>
          property.key.endsWith('.dedupe.skipReason') &&
          (property.value === 'already-satisfied-relation' || property.value === 'already-exists'),
      );
      if (skipReason) {
        const externalId =
          action.properties.find((property) => property.key.endsWith('.dedupe.knownExternalId'))
            ?.value ??
          resultIdByAction.get(action.id) ??
          `mock-${action.id}`;
        skippedActions.push({
          actionId: action.id,
          type: action.objectType,
          name: action.target,
          reason:
            skipReason.value === 'already-satisfied-relation'
              ? 'Already-satisfied relation; no write required.'
              : 'Already-existing object; no write required.',
          externalId,
          url: `https://mock.aurous.local/${input.plan.runId}/${action.id}`,
        });
        resultIdByAction.set(action.id, externalId);
        resultTypeByAction.set(action.id, action.objectType);
        completedActionIds.push(action.id);
        continue;
      }

      if (input.plan.tool === 'airtable' && hasTypedAirtableRelation(action)) {
        const materialized = materializeAirtableRelationAction(action, resultIdByAction, {
          resultTypeByAction,
        });
        const externalId =
          materialized.properties.find((property) => property.key === 'airtable.recordId')?.value ??
          `mock-${action.id}`;
        skippedActions.push({
          actionId: action.id,
          type: materialized.objectType,
          name: materialized.target,
          reason: 'Mock resolved typed airtable.relation from exact approved action results.',
          externalId,
          url: `https://mock.aurous.local/${input.plan.runId}/${action.id}`,
        });
        resultIdByAction.set(action.id, externalId);
        resultTypeByAction.set(action.id, materialized.objectType);
        completedActionIds.push(action.id);
        continue;
      }

      if (input.plan.tool === 'notion' && hasTypedNotionRelation(action)) {
        const materialized = materializeNotionRelationAction(action, resultIdByAction, {
          resultTypeByAction,
        });
        const externalId =
          materialized.properties.find(
            (property) => property.key === 'notion.dedupe.knownExternalId',
          )?.value ?? `mock-${action.id}`;
        skippedActions.push({
          actionId: action.id,
          type: materialized.objectType,
          name: materialized.target,
          reason: 'Mock resolved typed notion.relation from exact approved action results.',
          externalId,
          url: `https://mock.aurous.local/${input.plan.runId}/${action.id}`,
        });
        resultIdByAction.set(action.id, externalId);
        resultTypeByAction.set(action.id, materialized.objectType);
        completedActionIds.push(action.id);
        continue;
      }

      if (action.operation === 'create') {
        const externalId = resultIdByAction.get(action.id) ?? `mock-${action.id}`;
        createdObjects.push({
          actionId: action.id,
          type: action.objectType,
          name: action.target,
          externalId,
          url: `https://mock.aurous.local/${input.plan.runId}/${action.id}`,
        });
        resultIdByAction.set(action.id, externalId);
        resultTypeByAction.set(action.id, action.objectType);
        completedActionIds.push(action.id);
        continue;
      }

      completedActionIds.push(action.id);
    }

    const finished = new Date();
    const value = {
      status: 'succeeded' as const,
      summary: `Mock execution completed all ${input.plan.plannedActions.length} approved actions.`,
      createdObjects,
      skippedActions,
      completedActionIds,
      compatibilityNotes: [],
      warnings: ['Mock mode made no external writes.'],
      failures: [],
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
    };
    return Promise.resolve({
      value,
      command: ['aurous-internal-mock', 'apply'],
      stdout: JSON.stringify(value),
      stderr: '',
      durationMs: finished.getTime() - started.getTime(),
    });
  }

  inspectRecovery(input: RecoveryInspectionInput) {
    const started = Date.now();
    const recordedByTarget = new Map(
      input.originalResult.createdObjects.map((object) => [object.name, object]),
    );
    const value = {
      objects: input.originalResult.createdObjects.map((object) => {
        const action = input.originalPlan.plannedActions.find(
          (candidate) => candidate.id === object.actionId,
        );
        const parentName = action?.properties.find(
          (property) => property.key === 'notion.parent',
        )?.value;
        return {
          actionId: object.actionId,
          externalId: object.externalId ?? `mock-${object.actionId}`,
          url:
            object.url ??
            `https://mock.aurous.local/${input.originalPlan.runId}/${object.actionId}`,
          found: true,
          objectType: action?.objectType ?? object.type,
          title: action?.target ?? object.name,
          parentId: parentName ? (recordedByTarget.get(parentName)?.externalId ?? null) : null,
          properties: [],
          views: [],
          recordCount: 0,
          limitations: ['Mock inspection simulates exact-ID verification.'],
        };
      }),
      customStatusOptions: {
        supported: false,
        evidence: 'Mock recovery simulates an MCP without custom Status option support.',
      },
      customSelectOptions: {
        supported: true,
        evidence: 'Mock recovery simulates explicit Select option support.',
      },
      updateViewFilters: {
        supported: true,
        evidence: 'Mock recovery simulates view-filter updates.',
      },
      warnings: ['Mock mode made no external reads.'],
    };
    return Promise.resolve({
      value,
      command: ['aurous-internal-mock', 'recover-inspect'],
      stdout: JSON.stringify(value),
      stderr: '',
      durationMs: Date.now() - started,
    });
  }

  executeRecoveryAction(input: RecoveryActionExecutionInput) {
    const started = new Date();
    const externalId =
      input.action.properties.find((property) => property.key === 'notion.recovery.externalId')
        ?.value ?? `mock-${input.action.id}`;
    const value = {
      status: 'succeeded' as const,
      summary: `Mock recovery completed ${input.action.id}.`,
      createdObjects: [
        {
          actionId: input.action.id,
          type: input.action.objectType,
          name: input.action.target,
          externalId,
          url: `https://mock.aurous.local/${input.recoveryPlan.recoveryRunId}/${input.action.id}`,
        },
      ],
      skippedActions: [],
      completedActionIds: [input.action.id],
      compatibilityNotes: [],
      warnings: ['Mock mode made no external writes.'],
      failures: [],
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
    };
    return Promise.resolve({
      value,
      command: ['aurous-internal-mock', 'recover-apply'],
      stdout: JSON.stringify(value),
      stderr: '',
      durationMs: Date.now() - started.getTime(),
    });
  }

  manualFallback(
    runDirectory: string,
    phase: 'destination-discover' | 'plan' | 'apply' | 'recover-inspect' | 'recover-apply',
    prompt: string,
  ): Promise<string> {
    return writeManualPrompt(runDirectory, phase, prompt);
  }
}

function createMockProposal(
  tool: 'notion' | 'linear' | 'airtable' | 'trello' | 'mock',
  objective: string,
): PlanProposal {
  if (tool === 'linear') return linearProposal(objective);
  if (tool === 'notion') return notionProposal(objective);
  if (tool === 'trello') return trelloProposal(objective);
  const action: PlanAction = {
    id: 'action-001',
    operation: 'create',
    objectType: 'workspace',
    target: 'Aurous Mock Workspace',
    description: 'Create a deterministic local-only representation of the requested workspace.',
    properties: propertyEntries({ objective }),
    dependsOn: [],
  };
  return {
    proposedWorkspaceStructure: [
      {
        kind: 'workspace',
        name: 'Aurous Mock Workspace',
        purpose: 'Exercise the complete workflow.',
      },
    ],
    plannedActions: [action],
    assumptions: ['Mock mode is being used for local verification.'],
    warnings: ['No productivity tool will be changed.'],
    destructiveActions: [],
    expectedResult: 'A successful local-only execution result.',
  };
}

function notionProposal(objective: string): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      {
        kind: 'page',
        name: 'Project Command Center',
        purpose: 'A concise landing page for project work.',
      },
      {
        kind: 'database',
        name: 'Projects',
        purpose: 'Track project outcomes and health.',
        parent: 'Project Command Center',
      },
      {
        kind: 'database',
        name: 'Tasks',
        purpose: 'Track actionable work related to projects.',
        parent: 'Project Command Center',
      },
      {
        kind: 'page',
        name: 'Project Documentation',
        purpose: 'Link approved project references.',
        parent: 'Project Command Center',
      },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'page',
        target: 'Project Command Center',
        description: 'Create the workspace landing page with an objective summary.',
        properties: propertyEntries({ objective }),
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'database',
        target: 'Projects',
        description: 'Create a project database under the command center.',
        properties: propertyEntries({
          parent: 'Project Command Center',
          fields: [
            'Name:title',
            'Status:status',
            'Owner:person',
            'Target Date:date',
            'Health:select',
          ],
          statuses: ['Planned', 'Active', 'Blocked', 'Complete'],
        }),
        dependsOn: ['action-001'],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'database',
        target: 'Tasks',
        description: 'Create a task database related to Projects.',
        properties: propertyEntries({
          parent: 'Project Command Center',
          fields: [
            'Name:title',
            'Status:status',
            'Priority:select',
            'Due:date',
            'Project:relation',
          ],
          statuses: ['Backlog', 'Next', 'In Progress', 'Blocked', 'Done'],
          relation: 'Tasks.Project -> Projects',
        }),
        dependsOn: ['action-001', 'action-002'],
      },
      {
        id: 'action-004',
        operation: 'create',
        objectType: 'page',
        target: 'Project Documentation',
        description: 'Create a documentation index linked from the command center.',
        properties: propertyEntries({
          parent: 'Project Command Center',
          sourcePolicy: 'approved-context-only',
        }),
        dependsOn: ['action-001'],
      },
      {
        id: 'action-005',
        operation: 'link',
        objectType: 'page-section',
        target: 'Project Command Center overview',
        description: 'Link Projects, Tasks, and Project Documentation from the landing page.',
        properties: propertyEntries({
          links: ['Projects', 'Tasks', 'Project Documentation'],
        }),
        dependsOn: ['action-002', 'action-003', 'action-004'],
      },
    ],
    assumptions: [
      'A single workspace command center is appropriate for the supplied project context.',
    ],
    warnings: ['Mock planning does not inspect existing Notion objects for name collisions.'],
    destructiveActions: [],
    expectedResult:
      'A linked Notion command center with project, task, and documentation surfaces.',
  };
}

function linearProposal(objective: string): PlanProposal {
  return {
    proposedWorkspaceStructure: [
      {
        kind: 'project',
        name: 'Aurous Project',
        purpose: 'Coordinate delivery against the stated objective.',
      },
      {
        kind: 'milestone',
        name: 'Foundation',
        purpose: 'Group initial delivery work.',
        parent: 'Aurous Project',
      },
      {
        kind: 'issue-set',
        name: 'Foundation issues',
        purpose: 'Turn the objective into prioritized work.',
        parent: 'Foundation',
      },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'project',
        target: 'Aurous Project',
        description: 'Create a focused Linear project with the user objective as its description.',
        properties: propertyEntries({ description: objective, priority: 'high' }),
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'label',
        target: 'foundation',
        description: 'Create a label for foundation delivery work.',
        properties: propertyEntries({ color: '#8B5CF6' }),
        dependsOn: [],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'milestone',
        target: 'Foundation',
        description: 'Create the initial delivery milestone in the project.',
        properties: propertyEntries({ project: 'Aurous Project' }),
        dependsOn: ['action-001'],
      },
      {
        id: 'action-004',
        operation: 'create',
        objectType: 'issue',
        target: 'Define the project operating model',
        description:
          'Create a high-priority issue describing ownership, workflow, and completion criteria.',
        properties: propertyEntries({
          project: 'Aurous Project',
          milestone: 'Foundation',
          priority: 'high',
          labels: ['foundation'],
        }),
        dependsOn: ['action-001', 'action-002', 'action-003'],
      },
    ],
    assumptions: ['An initial milestone is useful for the supplied project objective.'],
    warnings: ['Mock planning does not inspect existing Linear projects or labels for duplicates.'],
    destructiveActions: [],
    expectedResult:
      'A Linear project with a foundation milestone, label, and prioritized starter issue.',
  };
}

function trelloProposal(objective: string): PlanProposal {
  const cards = [
    {
      id: 'action-005',
      listActionId: 'action-002',
      list: 'Build',
      name: 'Complete README',
      purpose: 'Finish the README for submission.',
    },
    {
      id: 'action-006',
      listActionId: 'action-003',
      list: 'Demo',
      name: 'Record demo',
      purpose: 'Record the demo walkthrough.',
    },
    {
      id: 'action-007',
      listActionId: 'action-004',
      list: 'Submit',
      name: 'Devpost submission',
      purpose: 'Prepare and submit the Devpost entry.',
    },
    {
      id: 'action-008',
      listActionId: 'action-002',
      list: 'Build',
      name: 'Notion readiness',
      purpose: 'Confirm Notion integration readiness.',
    },
    {
      id: 'action-009',
      listActionId: 'action-002',
      list: 'Build',
      name: 'Linear readiness',
      purpose: 'Confirm Linear integration readiness.',
    },
    {
      id: 'action-010',
      listActionId: 'action-002',
      list: 'Build',
      name: 'Airtable readiness',
      purpose: 'Confirm Airtable integration readiness.',
    },
    {
      id: 'action-011',
      listActionId: 'action-002',
      list: 'Build',
      name: 'Trello readiness',
      purpose: 'Confirm Trello integration readiness.',
    },
  ] as const;

  return {
    proposedWorkspaceStructure: [
      { kind: 'board', name: 'Aurous Launch HQ', purpose: 'Track Build Week launch work.' },
      { kind: 'list', name: 'Build', purpose: 'Work in progress.', parent: 'Aurous Launch HQ' },
      { kind: 'list', name: 'Demo', purpose: 'Demo preparation.', parent: 'Aurous Launch HQ' },
      { kind: 'list', name: 'Submit', purpose: 'Submission work.', parent: 'Aurous Launch HQ' },
      ...cards.map((card) => ({
        kind: 'card',
        name: card.name,
        purpose: card.purpose,
        parent: card.list,
      })),
      {
        kind: 'checklist',
        name: 'Launch checklist',
        purpose: 'Devpost launch checklist.',
        parent: 'Devpost submission',
      },
    ],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'board',
        target: 'Aurous Launch HQ',
        description: 'Create the Aurous Launch HQ board in the authorized workspace.',
        properties: propertyEntries({ 'trello.board': 'Aurous Launch HQ', objective }),
        dependsOn: [],
      },
      {
        id: 'action-002',
        operation: 'create',
        objectType: 'list',
        target: 'Build',
        description: 'Create the Build list.',
        properties: propertyEntries({
          'trello.boardActionId': 'action-001',
          'trello.board': 'Aurous Launch HQ',
        }),
        dependsOn: ['action-001'],
      },
      {
        id: 'action-003',
        operation: 'create',
        objectType: 'list',
        target: 'Demo',
        description: 'Create the Demo list.',
        properties: propertyEntries({
          'trello.boardActionId': 'action-001',
          'trello.board': 'Aurous Launch HQ',
        }),
        dependsOn: ['action-001'],
      },
      {
        id: 'action-004',
        operation: 'create',
        objectType: 'list',
        target: 'Submit',
        description: 'Create the Submit list.',
        properties: propertyEntries({
          'trello.boardActionId': 'action-001',
          'trello.board': 'Aurous Launch HQ',
        }),
        dependsOn: ['action-001'],
      },
      ...cards.map((card) => ({
        id: card.id,
        operation: 'create' as const,
        objectType: 'card',
        target: card.name,
        description: `Create the ${card.name} card in ${card.list}.`,
        properties: propertyEntries({
          'trello.boardActionId': 'action-001',
          'trello.listActionId': card.listActionId,
          'trello.list': card.list,
          'trello.board': 'Aurous Launch HQ',
        }),
        dependsOn: ['action-001', card.listActionId],
      })),
      {
        id: 'action-012',
        operation: 'create',
        objectType: 'checklist',
        target: 'Launch checklist',
        description: 'Add the launch checklist to the Devpost submission card.',
        properties: propertyEntries({
          'trello.cardActionId': 'action-007',
          'trello.card': 'Devpost submission',
        }),
        dependsOn: ['action-007'],
      },
    ],
    assumptions: [
      'The authorized Trello workspace is already connected; Aurous will not create a workspace.',
      'Only the requested board, lists, cards, and one checklist are required.',
    ],
    warnings: [
      'Do not create duplicates.',
      'Mock planning does not invent label IDs; no labels are created.',
    ],
    destructiveActions: [],
    expectedResult:
      'One Aurous Launch HQ board with Build, Demo, and Submit lists, essential launch cards, and one launch checklist on Devpost submission.',
  };
}

function propertyEntries(values: Record<string, string | string[]>): ActionPropertyEntry[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: Array.isArray(value) ? JSON.stringify(value) : value,
  }));
}
