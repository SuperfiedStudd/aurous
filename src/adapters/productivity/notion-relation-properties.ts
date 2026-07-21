import { AurousError } from '../../core/errors.js';
import type { DiscoveredObject, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanAction } from '../../domain/schemas.js';
import {
  normalizeNotionIdentity,
  normalizedObjectType,
  parseRelatedIdList,
  propertyValue,
  setProperty,
} from './exact-bindings.js';
import { hasTypedNotionRelation, parseNotionRelation } from './notion-relations.js';
import { isNotionRelationShape } from './notion-identity.js';

/**
 * Bind notion.relation.name / notion.relation.propertyId from read-only discovered
 * database schema. Never invent property names; never use non-relation properties.
 */
export function bindNotionRelationProperty(
  action: PlanAction,
  destination: ResolvedDestination,
  options?: {
    actions?: PlanAction[];
    objective?: string;
  },
): PlanAction {
  if (!isNotionRelationAction(action)) return action;

  const sourceRecordId = resolveSourceRecordId(action);
  const targetRecordIds = resolveTargetRecordIds(action);
  if (!sourceRecordId || targetRecordIds.length === 0) {
    // Incomplete relation shape — leave for exact-ID validators (AUR-PLAN-009/011).
    return action;
  }

  const sourceRecord = destination.existingObjects.find((object) => object.id === sourceRecordId);
  const sourceDatabaseId =
    sourceRecord?.parentId ??
    resolveCreateDatabaseId(options?.actions ?? [], sourceRecordId) ??
    propertyValue(action.properties, 'notion.databaseId') ??
    undefined;
  if (!sourceDatabaseId) {
    // Source identity is unresolved here; exact-ID validators fail closed later.
    return action;
  }

  const targetDatabaseIds = new Set<string>();
  for (const targetId of targetRecordIds) {
    const target = destination.existingObjects.find((object) => object.id === targetId);
    const targetDatabaseId =
      target?.parentId ?? resolveCreateDatabaseId(options?.actions ?? [], targetId);
    if (!targetDatabaseId) {
      // Target identity unresolved; leave for exact-ID validation.
      return action;
    }
    targetDatabaseIds.add(targetDatabaseId);
  }

  const candidates = discoveredRelationProperties(destination, sourceDatabaseId).filter(
    (property) => relationPropertyAcceptsTargets(property, targetDatabaseIds, destination),
  );

  const requestedName =
    propertyValue(action.properties, 'notion.relation.name') ??
    typedRelationName(action) ??
    undefined;
  const selected = selectRelationProperty(action.id, candidates, requestedName, options?.objective);

  const properties = action.properties.filter(
    (property) =>
      property.key !== 'notion.relation.name' && property.key !== 'notion.relation.propertyId',
  );
  setProperty(properties, 'notion.relation.name', selected.name);
  setProperty(properties, 'notion.relation.propertyId', selected.id);

  // Keep typed JSON name in sync when present.
  const typedRaw = propertyValue(properties, 'notion.relation');
  if (typedRaw?.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(typedRaw) as Record<string, unknown>;
      parsed.name = selected.name;
      setProperty(properties, 'notion.relation', JSON.stringify(parsed));
    } catch {
      // Malformed typed JSON is validated elsewhere.
    }
  }

  return { ...action, properties };
}

export function isDiscoveredNotionRelationProperty(object: DiscoveredObject): boolean {
  const kind = normalizedObjectType(object.type);
  if (kind === 'relation_property' || kind === 'database_relation_property') return true;
  if (kind === 'property' || kind === 'field') {
    return normalizedPropertyType(object.identifier) === 'relation';
  }
  return false;
}

export function discoveredRelationProperties(
  destination: ResolvedDestination,
  sourceDatabaseId: string,
): DiscoveredObject[] {
  return destination.existingObjects
    .filter(
      (object) =>
        isDiscoveredNotionRelationProperty(object) &&
        (object.parentId ?? undefined) === sourceDatabaseId,
    )
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function selectRelationProperty(
  actionId: string,
  candidates: DiscoveredObject[],
  requestedName: string | undefined,
  objective: string | undefined,
): DiscoveredObject {
  if (candidates.length === 0) {
    throw relationPropertyError(
      actionId,
      'No discovered Notion relation property can authorize this link.',
      'Discovery did not inspect a relation-typed property on the exact source database that accepts the target database.',
      'Re-run read-only discovery and include database properties with identifier="relation" and linkedIds to the related database.',
    );
  }

  const normalizedRequested = requestedName ? normalizeName(requestedName) : undefined;
  if (normalizedRequested) {
    const exact = candidates.filter(
      (candidate) => normalizeName(candidate.name) === normalizedRequested,
    );
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) {
      throw relationPropertyError(
        actionId,
        `Multiple discovered relation properties match ${JSON.stringify(requestedName)}.`,
        'Exact property-name matching is ambiguous across inspected relation properties.',
        'Authorize one exact notion.relation.propertyId from discovery.',
      );
    }
  }

  const objectiveNames = extractExplicitPropertyNames(objective);
  const objectiveMatches = candidates.filter((candidate) =>
    objectiveNames.has(normalizeName(candidate.name)),
  );
  if (objectiveMatches.length === 1) return objectiveMatches[0]!;
  if (objectiveMatches.length > 1) {
    throw relationPropertyError(
      actionId,
      'Multiple discovered relation properties were named by the objective.',
      'The objective named more than one valid relation property for this source database.',
      'Name exactly one discovered relation property or authorize notion.relation.propertyId.',
    );
  }

  if (candidates.length === 1) return candidates[0]!;

  throw relationPropertyError(
    actionId,
    `Notion relation property binding is ambiguous across ${candidates.length} discovered relation properties.`,
    'Zero exact name matches and more than one compatible relation property were inspected.',
    'Name one discovered relation property exactly, or reduce discovery to a single valid relation property.',
  );
}

function relationPropertyAcceptsTargets(
  property: DiscoveredObject,
  targetDatabaseIds: ReadonlySet<string>,
  destination: ResolvedDestination,
): boolean {
  const related = property.linkedIds ?? [];
  if (related.length === 0) return false;
  const accepted = new Set(related.map(normalizeNotionIdentity).filter(Boolean));
  for (const databaseId of targetDatabaseIds) {
    const aliases = databaseIdentityAliases(destination, databaseId);
    if (![...aliases].some((alias) => accepted.has(alias))) return false;
  }
  return true;
}

/** Match related DB page IDs and Notion data-source / collection UUIDs. */
function databaseIdentityAliases(
  destination: ResolvedDestination,
  databaseId: string,
): Set<string> {
  const aliases = new Set<string>([normalizeNotionIdentity(databaseId)].filter(Boolean));
  const database = destination.existingObjects.find((object) => object.id === databaseId);
  if (!database) return aliases;
  aliases.add(normalizeNotionIdentity(database.id));
  const collectionId = collectionIdFromIdentifier(database.identifier);
  if (collectionId) aliases.add(collectionId);
  return aliases;
}

function collectionIdFromIdentifier(identifier: string | null | undefined): string | undefined {
  if (!identifier) return undefined;
  const trimmed = identifier.trim();
  const match = /^collection:\/\/([0-9a-f-]{36})$/i.exec(trimmed);
  if (match?.[1]) return normalizeNotionIdentity(match[1]);
  return normalizeNotionIdentity(trimmed) || undefined;
}

function isNotionRelationAction(action: PlanAction): boolean {
  if (hasTypedNotionRelation(action)) return true;
  if (isNotionRelationShape(action)) return true;
  return Boolean(
    propertyValue(action.properties, 'notion.relation.name') ||
    propertyValue(action.properties, 'notion.relation.targetRecordIds') ||
    propertyValue(action.properties, 'notion.relation.targetRecordId'),
  );
}

function resolveSourceRecordId(action: PlanAction): string | undefined {
  return (
    propertyValue(action.properties, 'notion.relation.sourceRecordId') ??
    propertyValue(action.properties, 'notion.dedupe.knownExternalId') ??
    typedSourceRecordId(action)
  );
}

function resolveTargetRecordIds(action: PlanAction): string[] {
  const flat =
    propertyValue(action.properties, 'notion.relation.targetRecordIds') ??
    propertyValue(action.properties, 'notion.relation.targetRecordId');
  if (flat) return parseRelatedIdList(flat);
  const typed = typedTargetRecordIds(action);
  return typed;
}

function typedRelationName(action: PlanAction): string | undefined {
  if (!hasTypedNotionRelation(action)) return undefined;
  try {
    return parseNotionRelation(propertyValue(action.properties, 'notion.relation'))?.name;
  } catch {
    return undefined;
  }
}

function typedSourceRecordId(action: PlanAction): string | undefined {
  if (!hasTypedNotionRelation(action)) return undefined;
  try {
    const binding = parseNotionRelation(propertyValue(action.properties, 'notion.relation'));
    return binding?.source.recordId;
  } catch {
    return undefined;
  }
}

function typedTargetRecordIds(action: PlanAction): string[] {
  if (!hasTypedNotionRelation(action)) return [];
  try {
    const binding = parseNotionRelation(propertyValue(action.properties, 'notion.relation'));
    return (binding?.targets ?? [])
      .map((target) => target.recordId)
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

function resolveCreateDatabaseId(
  actions: PlanAction[],
  recordOrActionId: string,
): string | undefined {
  const create = actions.find(
    (action) =>
      action.id === recordOrActionId ||
      propertyValue(action.properties, 'notion.dedupe.knownExternalId') === recordOrActionId,
  );
  if (!create) return undefined;
  return (
    propertyValue(create.properties, 'notion.databaseId') ??
    propertyValue(create.properties, 'notion.record.databaseId')
  );
}

function normalizedPropertyType(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeName(name: string): string {
  return name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractExplicitPropertyNames(objective: string | undefined): Set<string> {
  if (!objective) return new Set();
  // Conservative: quoted phrases in the objective may name a discovered property.
  const names = new Set<string>();
  for (const match of objective.matchAll(/"([^"]{1,80})"|'([^']{1,80})'/g)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value) names.add(normalizeName(value));
  }
  return names;
}

function relationPropertyError(
  actionId: string,
  summary: string,
  probableCause: string,
  nextAction: string,
): AurousError {
  return new AurousError({
    code: 'AUR-PLAN-011',
    summary: `Action ${actionId}: ${summary}`,
    probableCause,
    nextAction: `No writes were attempted. ${nextAction}`,
  });
}
