import type { DiscoveredObject, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanAction } from '../../domain/schemas.js';
import {
  exactObjectTypeMatches,
  normalizedObjectType,
  relationAlreadySatisfied,
} from './exact-bindings.js';

export const AIRTABLE_ALREADY_EXISTS_SKIP = 'already-exists';

/**
 * When the planner returns plannedActions:[] for an already-complete Airtable workflow,
 * materialize deterministic skip/no-op actions bound to exact inspected IDs.
 * Leaves unsafe empty proposals unchanged so schema validation still fails.
 */
export function materializeAirtableCompletedNoOpProposal(
  value: unknown,
  destination: ResolvedDestination,
): unknown {
  if (!isRecord(value)) return value;
  if (!Array.isArray(value.plannedActions) || value.plannedActions.length > 0) return value;
  if (!Array.isArray(value.proposedWorkspaceStructure)) return value;

  const recordItems = value.proposedWorkspaceStructure.filter(
    (item): item is { kind: string; name: string; purpose: string; parent?: string | null } =>
      isRecord(item) &&
      typeof item.kind === 'string' &&
      typeof item.name === 'string' &&
      typeof item.purpose === 'string' &&
      normalizedObjectType(item.kind) === 'record',
  );
  if (recordItems.length === 0) return value;

  const matched: { name: string; purpose: string; exact: DiscoveredObject }[] = [];
  for (const item of recordItems) {
    const exact = resolveExactRecord(destination, item.name, item.purpose);
    if (!exact) return value;
    matched.push({ name: item.name, purpose: item.purpose, exact });
  }

  const plannedActions: PlanAction[] = matched.map((entry, index) => ({
    id: actionId(index + 1),
    operation: 'update' as const,
    objectType: 'airtable.record',
    target: entry.exact.name,
    description: `Skip no-op: exact inspected record ${JSON.stringify(entry.exact.name)} already exists. Do not create a duplicate.`,
    properties: [
      { key: 'airtable.recordId', value: entry.exact.id },
      { key: 'airtable.dedupe.knownExternalId', value: entry.exact.id },
      { key: 'airtable.dedupe.skipReason', value: AIRTABLE_ALREADY_EXISTS_SKIP },
      ...(entry.exact.parentId ? [{ key: 'airtable.tableId', value: entry.exact.parentId }] : []),
    ],
    dependsOn: [],
  }));

  const relationAction = buildSatisfiedRelationAction(matched, plannedActions.length + 1);
  if (relationAction) plannedActions.push(relationAction);

  return {
    ...value,
    plannedActions,
    assumptions: [
      ...(Array.isArray(value.assumptions)
        ? value.assumptions.filter((item): item is string => typeof item === 'string')
        : []),
      'Empty plannedActions were normalized into explicit already-satisfied Airtable skip actions bound by exact inspected IDs.',
    ],
  };
}

export function isAirtableSkipNoOpAction(action: PlanAction): boolean {
  return action.properties.some(
    (property) =>
      property.key === 'airtable.dedupe.skipReason' &&
      (property.value === AIRTABLE_ALREADY_EXISTS_SKIP ||
        property.value === 'already-satisfied-relation'),
  );
}

function buildSatisfiedRelationAction(
  matched: { exact: DiscoveredObject }[],
  nextIndex: number,
): PlanAction | undefined {
  for (const source of matched) {
    const linked = source.exact.linkedIds ?? [];
    if (linked.length === 0) continue;
    const targets = matched.filter(
      (candidate) => candidate.exact.id !== source.exact.id && linked.includes(candidate.exact.id),
    );
    if (targets.length === 0) continue;
    const targetIds = targets.map((target) => target.exact.id);
    if (!relationAlreadySatisfied(source.exact, targetIds)) continue;
    return {
      id: actionId(nextIndex),
      operation: 'link',
      objectType: 'airtable.record',
      target: `Link ${source.exact.name} to ${targets.map((target) => target.exact.name).join(', ')}`,
      description:
        'Skip no-op: the exact book-to-category relation is already satisfied on the verified records.',
      properties: [
        { key: 'airtable.recordId', value: source.exact.id },
        { key: 'airtable.linkedRecordIds', value: JSON.stringify(targetIds) },
        { key: 'airtable.dedupe.knownExternalId', value: source.exact.id },
        { key: 'airtable.dedupe.skipReason', value: 'already-satisfied-relation' },
        {
          key: 'airtable.relation',
          value: JSON.stringify({
            source: { recordId: source.exact.id },
            targets: targetIds.map((recordId) => ({ recordId })),
          }),
        },
        ...(source.exact.parentId
          ? [{ key: 'airtable.tableId', value: source.exact.parentId }]
          : []),
      ],
      dependsOn: matched.map((_, index) => actionId(index + 1)),
    };
  }
  return undefined;
}

function resolveExactRecord(
  destination: ResolvedDestination,
  name: string,
  purpose: string,
): DiscoveredObject | undefined {
  const idFromPurpose = extractAirtableRecordId(purpose);
  if (idFromPurpose) {
    const byId = destination.existingObjects.find((object) => object.id === idFromPurpose);
    if (byId && exactObjectTypeMatches('airtable', byId.type, 'record')) return byId;
  }
  const byName = destination.existingObjects.filter(
    (object) =>
      exactObjectTypeMatches('airtable', object.type, 'record') &&
      normalizeName(object.name) === normalizeName(name),
  );
  if (byName.length === 1) return byName[0];
  return undefined;
}

function extractAirtableRecordId(value: string): string | undefined {
  const match = value.match(/\b(rec[A-Za-z0-9]{14,})\b/);
  return match?.[1];
}

function actionId(index: number): string {
  return `action-${String(index).padStart(3, '0')}`;
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
