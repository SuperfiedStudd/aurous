import { z } from 'zod';
import type { ActionPropertyEntry, AurousPlan, ContextBundle, PlanAction } from './schemas.js';
import { AurousError } from '../core/errors.js';

const LinearDemoPrioritySchema = z.enum(['urgent', 'high', 'medium', 'low']);

export const LinearDemoContextSchema = z.object({
  preset: z.literal('linear-software-launch-v1'),
  projectName: z.string().min(1),
  summary: z.string().min(1).max(255),
  currentPhase: z.string().min(1),
  targetDate: z.string().date(),
  goals: z.array(z.string().min(1)).min(1),
  milestones: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
        targetDate: z.string().date(),
      }),
    )
    .min(1),
  workstreams: z
    .array(
      z.object({
        name: z.string().min(1),
        label: z.string().min(1),
        outcome: z.string().min(1),
      }),
    )
    .min(1),
  knownTasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        priority: LinearDemoPrioritySchema,
        status: z.enum(['todo', 'in-progress']),
        milestone: z.string().min(1),
        workstream: z.string().min(1),
      }),
    )
    .min(1)
    .max(8),
  risks: z.array(z.string().min(1)),
  preferredWorkflow: z.object({
    todoStatus: z.string().min(1),
    activeStatus: z.string().min(1),
    assignee: z.string().min(1),
    labelPrefix: z.string().min(1),
  }),
});
export type LinearDemoContext = z.infer<typeof LinearDemoContextSchema>;

export function parseLinearDemoContext(bundle: ContextBundle): LinearDemoContext {
  const candidates = bundle.documents.filter((document) => document.relativePath.endsWith('.json'));
  for (const candidate of candidates) {
    try {
      const parsed = LinearDemoContextSchema.safeParse(JSON.parse(candidate.content));
      if (parsed.success) return parsed.data;
    } catch {
      // Continue until a valid explicitly selected preset is found.
    }
  }
  throw new AurousError({
    code: 'AUR-LINEAR-001',
    summary: 'No valid Linear demo preset was found in the selected context.',
    probableCause: 'The --context paths did not include a linear-software-launch-v1 JSON document.',
    nextAction: 'Pass "--context demo/linear-build-week.json" or fix the preset fields.',
  });
}

export function buildLinearDemoPlan(input: {
  runId: string;
  createdAt: string;
  agent: AurousPlan['agent'];
  team: string;
  teamId: string;
  context: ContextBundle;
  preset: LinearDemoContext;
}): AurousPlan {
  const { preset, team, teamId } = input;
  const workstreams = new Map(preset.workstreams.map((item) => [item.name, item]));
  const milestones = new Set(preset.milestones.map((item) => item.name));
  for (const task of preset.knownTasks) {
    if (!workstreams.has(task.workstream) || !milestones.has(task.milestone)) {
      throw new AurousError({
        code: 'AUR-LINEAR-002',
        summary: `Linear preset task has an unknown workstream or milestone: ${task.title}`,
        probableCause: 'The structured demo context contains an inconsistent reference.',
        nextAction: 'Match every knownTasks workstream and milestone to a declared item.',
      });
    }
  }

  const actions: PlanAction[] = [];
  const add = (action: Omit<PlanAction, 'id'>): string => {
    const id = `action-${String(actions.length + 1).padStart(3, '0')}`;
    actions.push({ id, ...action });
    return id;
  };
  const projectAction = add({
    operation: 'create',
    objectType: 'project',
    target: preset.projectName,
    description: 'Create the context-specific launch project in the selected Linear team.',
    properties: properties({
      'linear.team': team,
      'linear.teamId': teamId,
      'linear.summary': preset.summary,
      'linear.description': projectDescription(preset),
      'linear.priority': '2',
      'linear.targetDate': preset.targetDate,
      'linear.dedupe': 'exact-name-in-selected-team',
    }),
    dependsOn: [],
  });

  const labelActions = new Map<string, string>();
  for (const workstream of preset.workstreams) {
    const labelName = `${preset.preferredWorkflow.labelPrefix}: ${workstream.label}`;
    labelActions.set(
      workstream.name,
      add({
        operation: 'create',
        objectType: 'label',
        target: labelName,
        description: `Create a namespaced label for the ${workstream.name} workstream.`,
        properties: properties({
          'linear.team': team,
          'linear.teamId': teamId,
          'linear.color': workstreamColor(labelActions.size),
          'linear.description': workstream.outcome,
          'linear.dedupe': 'exact-name-in-selected-team',
        }),
        dependsOn: [],
      }),
    );
  }

  const milestoneActions = new Map<string, string>();
  for (const milestone of preset.milestones) {
    milestoneActions.set(
      milestone.name,
      add({
        operation: 'create',
        objectType: 'milestone',
        target: milestone.name,
        description: `Create the ${milestone.name} milestone under the launch project.`,
        properties: properties({
          'linear.project': preset.projectName,
          'linear.description': milestone.description,
          'linear.targetDate': milestone.targetDate,
          'linear.dedupe': 'exact-name-in-approved-project',
        }),
        dependsOn: [projectAction],
      }),
    );
  }

  for (const task of preset.knownTasks) {
    const workstream = workstreams.get(task.workstream)!;
    add({
      operation: 'create',
      objectType: 'issue',
      target: task.title,
      description: task.description,
      properties: properties({
        'linear.team': team,
        'linear.teamId': teamId,
        'linear.project': preset.projectName,
        'linear.milestone': task.milestone,
        'linear.priority': String(priorityNumber(task.priority)),
        'linear.state':
          task.status === 'in-progress'
            ? preset.preferredWorkflow.activeStatus
            : preset.preferredWorkflow.todoStatus,
        'linear.assignee': preset.preferredWorkflow.assignee,
        'linear.labels': JSON.stringify([
          `${preset.preferredWorkflow.labelPrefix}: ${workstream.label}`,
        ]),
        'linear.description': issueDescription(task, preset),
        'linear.dedupe': 'single-unfiltered-project-inventory-exact-title',
      }),
      dependsOn: [
        projectAction,
        labelActions.get(task.workstream)!,
        milestoneActions.get(task.milestone)!,
      ],
    });
  }

  return {
    schemaVersion: 1,
    runId: input.runId,
    createdAt: input.createdAt,
    agent: input.agent,
    tool: 'linear',
    objective: `Configure ${preset.projectName} in Linear from the approved structured context.`,
    contextSummary: input.context.summary,
    proposedWorkspaceStructure: [
      {
        kind: 'project',
        name: preset.projectName,
        purpose: preset.summary,
      },
      ...preset.milestones.map((milestone) => ({
        kind: 'milestone',
        name: milestone.name,
        purpose: milestone.description,
        parent: preset.projectName,
      })),
      ...preset.workstreams.map((workstream) => ({
        kind: 'issue-set',
        name: workstream.name,
        purpose: workstream.outcome,
        parent: preset.projectName,
      })),
    ],
    plannedActions: actions,
    assumptions: [
      `The existing Linear team "${team}" is the approved destination.`,
      `The assignee token "${preset.preferredWorkflow.assignee}" resolves in that workspace.`,
    ],
    warnings: [
      'Aurous will perform only exact-name lookups for approved targets before writes.',
      'Existing exact matches will be skipped and recorded; ambiguous matches will fail visibly.',
      'Unsupported fields will be omitted only when the result includes an explicit compatibility note.',
    ],
    destructiveActions: [],
    expectedResult: `${preset.projectName} with ${preset.milestones.length} milestones, ${preset.workstreams.length} labels, and ${preset.knownTasks.length} prioritized issues.`,
  };
}

function properties(values: Record<string, string>): ActionPropertyEntry[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

function priorityNumber(priority: z.infer<typeof LinearDemoPrioritySchema>): number {
  return { urgent: 1, high: 2, medium: 3, low: 4 }[priority];
}

function workstreamColor(index: number): string {
  return ['#5E6AD2', '#F2994A', '#26B5CE', '#BB87FC'][index % 4]!;
}

function projectDescription(preset: LinearDemoContext): string {
  return [
    `## ${preset.currentPhase}`,
    preset.summary,
    '',
    '### Goals',
    ...preset.goals.map((goal) => `- ${goal}`),
    '',
    '### Known risks',
    ...preset.risks.map((risk) => `- ${risk}`),
  ].join('\n');
}

function issueDescription(
  task: LinearDemoContext['knownTasks'][number],
  preset: LinearDemoContext,
): string {
  return [
    task.description,
    '',
    `**Phase:** ${preset.currentPhase}`,
    `**Workstream:** ${task.workstream}`,
    `**Milestone:** ${task.milestone}`,
    '',
    '### Done when',
    '- The outcome is demonstrable in the Build Week screen recording.',
    '- IDs, URLs, and any compatibility adjustments are captured by the Aurous run.',
  ].join('\n');
}
