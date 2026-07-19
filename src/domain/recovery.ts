import { z } from 'zod';
import {
  AgentNameSchema,
  CreatedObjectSchema,
  PlanActionSchema,
  ToolNameSchema,
  type AurousPlan,
  type CreatedObject,
  type ExecutionResult,
  type PlanAction,
} from './schemas.js';

export const RecoveryActionStatusSchema = z.enum([
  'completed',
  'partially_completed',
  'pending',
  'blocked',
  'drifted',
]);
export type RecoveryActionStatus = z.infer<typeof RecoveryActionStatusSchema>;

export const InspectedPropertySchema = z.object({
  name: z.string(),
  type: z.string(),
  options: z.array(z.string()),
});

export const InspectedViewSchema = z.object({
  name: z.string(),
  type: z.string(),
  filterSummary: z.string().nullish(),
});

export const RecoveryInspectionObjectSchema = z.object({
  actionId: z.string(),
  externalId: z.string(),
  url: z.string().url(),
  found: z.boolean(),
  objectType: z.string().nullish(),
  title: z.string().nullish(),
  parentId: z.string().nullish(),
  properties: z.array(InspectedPropertySchema),
  views: z.array(InspectedViewSchema),
  recordCount: z.number().int().nonnegative().nullish(),
  limitations: z.array(z.string()),
});

export const RecoveryCapabilitySchema = z.object({
  supported: z.boolean(),
  evidence: z.string(),
});

export const RecoveryInspectionSchema = z.object({
  objects: z.array(RecoveryInspectionObjectSchema),
  customStatusOptions: RecoveryCapabilitySchema,
  customSelectOptions: RecoveryCapabilitySchema,
  updateViewFilters: RecoveryCapabilitySchema,
  warnings: z.array(z.string()),
});
export type RecoveryInspection = z.infer<typeof RecoveryInspectionSchema>;

export const RecoveryClassificationSchema = z.object({
  actionId: z.string(),
  status: RecoveryActionStatusSchema,
  evidence: z.string(),
  externalId: z.string().optional(),
  recoveryOperation: z.enum(['skip', 'reuse', 'update', 'create', 'execute', 'block']),
});

export const CompatibilityDecisionSchema = z.object({
  property: z.string(),
  approvedType: z.string(),
  recoveryType: z.string(),
  reason: z.string(),
  consequences: z.array(z.string()),
});

export const RecoveryPlanSchema = z.object({
  schemaVersion: z.literal(1),
  recoveryRunId: z.string(),
  originalRunId: z.string(),
  createdAt: z.string().datetime(),
  agent: AgentNameSchema,
  tool: ToolNameSchema,
  objective: z.string(),
  inspection: RecoveryInspectionSchema,
  classifications: z.array(RecoveryClassificationSchema),
  compatibilityDecisions: z.array(CompatibilityDecisionSchema),
  verifiedObjects: z.array(CreatedObjectSchema),
  plannedActions: z.array(PlanActionSchema),
  warnings: z.array(z.string()),
  destructiveActions: z.array(z.never()).max(0),
  expectedResult: z.string(),
  isExecutable: z.boolean(),
});
export type RecoveryPlan = z.infer<typeof RecoveryPlanSchema>;

export const RecoveryCheckpointSchema = z.object({
  timestamp: z.string().datetime(),
  recoveryRunId: z.string(),
  originalRunId: z.string(),
  actionId: z.string(),
  externalId: z.string(),
  url: z.string().url().optional(),
  type: z.string(),
  name: z.string(),
  source: z.enum(['inspection', 'pre-execution-verification', 'action-result']),
});
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpointSchema>;

export interface RecoveryBuildInput {
  recoveryRunId: string;
  originalPlan: AurousPlan;
  originalResult: ExecutionResult;
  inspection: RecoveryInspection;
  createdAt: string;
}

export function buildRecoveryPlan(input: RecoveryBuildInput): RecoveryPlan {
  const { originalPlan, originalResult, inspection } = input;
  const recordedByAction = new Map(
    originalResult.createdObjects.map((object) => [object.actionId, object]),
  );
  const inspectedByAction = new Map(inspection.objects.map((object) => [object.actionId, object]));
  const completed = new Set(originalResult.completedActionIds);
  const failuresByAction = new Map(
    originalResult.failures.flatMap((failure) =>
      failure.actionId ? [[failure.actionId, failure] as const] : [],
    ),
  );
  const targetToRecorded = new Map(
    originalResult.createdObjects.map((object) => [object.name, object]),
  );
  const classifications: z.infer<typeof RecoveryClassificationSchema>[] = [];
  const verifiedObjects: CreatedObject[] = [];

  for (const action of originalPlan.plannedActions) {
    const recorded = recordedByAction.get(action.id);
    if (!recorded) {
      if (completed.has(action.id) && !['create', 'update'].includes(action.operation)) {
        classifications.push({
          actionId: action.id,
          status: 'completed',
          evidence:
            'The original result reports this non-creating action completed; no external object identity is expected.',
          recoveryOperation: 'skip',
        });
        continue;
      }
      const failure = failuresByAction.get(action.id);
      if (failure && failureConfirmsNoWrite(failure)) {
        classifications.push({
          actionId: action.id,
          status: 'pending',
          evidence: `The original result explicitly reports no external write: ${failure.summary}`,
          recoveryOperation: action.operation === 'create' ? 'create' : 'execute',
        });
        continue;
      }
      if (completed.has(action.id) || failure) {
        classifications.push({
          actionId: action.id,
          status: 'blocked',
          evidence:
            'The original result shows this action was attempted but did not persist a stable external object ID; replay would risk duplication.',
          recoveryOperation: 'block',
        });
        continue;
      }
      classifications.push({
        actionId: action.id,
        status: 'pending',
        evidence: 'No external object was recorded for this action.',
        recoveryOperation: action.operation === 'create' ? 'create' : 'execute',
      });
      continue;
    }
    if (!recorded.externalId) {
      classifications.push({
        actionId: action.id,
        status: 'drifted',
        evidence: 'The original result did not persist an external ID for this object.',
        recoveryOperation: 'block',
      });
      continue;
    }
    const inspected = inspectedByAction.get(action.id);
    const expectedParentName = propertyValue(action, 'notion.parent');
    const expectedParentId = expectedParentName
      ? targetToRecorded.get(expectedParentName)?.externalId
      : undefined;
    const typeMatches = objectTypeMatches(action.objectType, inspected?.objectType);
    const parentMatches =
      expectedParentId === undefined || inspected?.parentId === expectedParentId;
    const verified =
      inspected?.found === true &&
      inspected.externalId === recorded.externalId &&
      inspected.title === action.target &&
      typeMatches &&
      parentMatches;
    if (!verified) {
      classifications.push({
        actionId: action.id,
        status: 'drifted',
        evidence:
          'The recorded external ID could not be verified with the expected title, type, and parent relationship.',
        externalId: recorded.externalId,
        recoveryOperation: 'block',
      });
      continue;
    }
    verifiedObjects.push(recorded);
    classifications.push({
      actionId: action.id,
      status: completed.has(action.id) ? 'completed' : 'partially_completed',
      evidence: `Verified by exact external ID ${recorded.externalId}; title, type, and parent match the approved action.`,
      externalId: recorded.externalId,
      recoveryOperation: completed.has(action.id) ? 'skip' : 'update',
    });
  }

  const statusActions = originalPlan.plannedActions.filter(actionUsesCustomStatus);
  const needsSelectCompatibility =
    statusActions.length > 0 && !inspection.customStatusOptions.supported;
  const compatibilityDecisions = needsSelectCompatibility
    ? [
        {
          property: 'Status',
          approvedType: 'Notion Status',
          recoveryType: 'Notion Select',
          reason:
            'The available Notion MCP can assign existing Status values but cannot define custom Status options or groups; it explicitly supports Select options.',
          consequences: [
            'Custom workflow values remain explicit and filterable.',
            'Status groups and Notion Status-specific workflow semantics are not available.',
            'Boards may group by Select, but Select options are flat rather than grouped.',
          ],
        },
      ]
    : [];

  if (needsSelectCompatibility && !inspection.customSelectOptions.supported) {
    for (const classification of classifications) {
      if (statusActions.some((action) => action.id === classification.actionId)) {
        classification.status = 'blocked';
        classification.recoveryOperation = 'block';
        classification.evidence =
          'Neither custom Status options nor explicit Select options are supported by the inspected MCP.';
      }
    }
  }

  if (!inspection.updateViewFilters.supported) {
    for (const classification of classifications) {
      const action = originalPlan.plannedActions.find(
        (candidate) => candidate.id === classification.actionId,
      );
      const inspected = inspectedByAction.get(classification.actionId);
      if (
        action &&
        classification.status === 'partially_completed' &&
        requiresExistingViewFilterRepair(action, inspected)
      ) {
        classification.status = 'blocked';
        classification.recoveryOperation = 'block';
        classification.evidence =
          'The existing database has an approved filtered view without its filter, and the inspected MCP cannot update existing view filters.';
      }
    }
  }

  const blockedIds = new Set(
    classifications
      .filter((item) => item.status === 'blocked' || item.status === 'drifted')
      .map((item) => item.actionId),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const action of originalPlan.plannedActions) {
      const classification = classifications.find((item) => item.actionId === action.id)!;
      if (
        classification.status !== 'completed' &&
        classification.status !== 'drifted' &&
        classification.status !== 'blocked' &&
        action.dependsOn.some((dependency) => blockedIds.has(dependency))
      ) {
        classification.status = 'blocked';
        classification.recoveryOperation = 'block';
        classification.evidence = 'A required dependency is blocked or drifted.';
        blockedIds.add(action.id);
        changed = true;
      }
    }
  }

  const completedIds = new Set(
    classifications.filter((item) => item.status === 'completed').map((item) => item.actionId),
  );
  const plannedActions = originalPlan.plannedActions
    .filter((action) => {
      const state = classifications.find((item) => item.actionId === action.id)!;
      return state.status === 'partially_completed' || state.status === 'pending';
    })
    .map((action) => {
      const recorded = recordedByAction.get(action.id);
      let revised = needsSelectCompatibility ? convertCustomStatusToSelect(action) : action;
      if (recorded) {
        const externalId = recorded.externalId;
        if (!externalId) return revised;
        revised = {
          ...revised,
          operation: 'update',
          properties: [
            ...revised.properties,
            { key: 'notion.recovery.mode', value: 'update-existing' },
            { key: 'notion.recovery.externalId', value: externalId },
          ],
        };
      }
      return {
        ...revised,
        dependsOn: revised.dependsOn.filter((dependency) => !completedIds.has(dependency)),
      };
    });

  const isExecutable = blockedIds.size === 0 && plannedActions.length > 0;
  return RecoveryPlanSchema.parse({
    schemaVersion: 1,
    recoveryRunId: input.recoveryRunId,
    originalRunId: originalPlan.runId,
    createdAt: input.createdAt,
    agent: originalPlan.agent,
    tool: originalPlan.tool,
    objective: `Recover partial run ${originalPlan.runId} without duplicating verified objects.`,
    inspection,
    classifications,
    compatibilityDecisions,
    verifiedObjects,
    plannedActions,
    warnings: [
      ...inspection.warnings,
      'No object is considered reusable from its name alone; every reuse requires the recorded external ID.',
      'Recovery never deletes partial objects automatically.',
      ...(needsSelectCompatibility
        ? [
            'This recovery revises approved Status properties to Select and therefore requires fresh explicit approval.',
          ]
        : []),
    ],
    destructiveActions: [],
    expectedResult: originalPlan.expectedResult,
    isExecutable,
  });
}

function actionUsesCustomStatus(action: PlanAction): boolean {
  const properties = parseJsonArray(propertyValue(action, 'notion.database.properties'));
  return properties.some(
    (property) => isRecord(property) && property.name === 'Status' && property.type === 'status',
  );
}

function failureConfirmsNoWrite(failure: ExecutionResult['failures'][number]): boolean {
  return (
    failure.code === 'AUR-APPLY-001' ||
    /\b(?:was|were) not (?:created|updated|configured|linked)\b/i.test(failure.summary)
  );
}

function requiresExistingViewFilterRepair(
  action: PlanAction,
  inspected: RecoveryInspection['objects'][number] | undefined,
): boolean {
  if (!inspected) return false;
  const desiredViews = parseJsonArray(propertyValue(action, 'notion.database.views')).filter(
    isRecord,
  );
  return desiredViews.some((view) => {
    if (typeof view.name !== 'string' || !isRecord(view.filter)) return false;
    const existing = inspected.views.find((candidate) => candidate.name === view.name);
    return Boolean(existing && isMissingFilter(existing.filterSummary));
  });
}

function isMissingFilter(summary: string | null | undefined): boolean {
  if (!summary?.trim()) return true;
  return /^(?:none|no filter|unfiltered)$|empty(?:\s+and)?\s+filter/i.test(summary.trim());
}

function convertCustomStatusToSelect(action: PlanAction): PlanAction {
  const properties = parseJsonArray(propertyValue(action, 'notion.database.properties'));
  if (properties.length === 0) return action;
  const statusOptions = parseJsonArray(propertyValue(action, 'notion.database.statuses'))
    .filter(isRecord)
    .map((status) => status.name)
    .filter((name): name is string => typeof name === 'string');
  const converted = properties.map((property) => {
    if (!isRecord(property) || property.name !== 'Status' || property.type !== 'status')
      return property;
    return { name: 'Status', type: 'select', options: statusOptions };
  });
  return {
    ...action,
    properties: [
      ...action.properties.filter(
        (property) =>
          property.key !== 'notion.database.statuses' &&
          property.key !== 'notion.database.properties',
      ),
      {
        key: 'notion.database.properties',
        value: JSON.stringify(converted),
      },
      {
        key: 'notion.compatibility.statusToSelect',
        value: 'Custom workflow values use Select because the MCP cannot configure Status options.',
      },
    ],
  };
}

function propertyValue(action: PlanAction, key: string): string | undefined {
  return action.properties.find((property) => property.key === key)?.value;
}

function parseJsonArray(value: string | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function objectTypeMatches(planned: string, inspected: string | null | undefined): boolean {
  if (!inspected) return false;
  if (planned === 'page') return inspected === 'page';
  if (planned === 'database') return inspected === 'database';
  return planned === inspected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
