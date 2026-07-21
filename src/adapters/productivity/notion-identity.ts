import type { DiscoveredObject, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanAction } from '../../domain/schemas.js';
import {
  exactObjectTypeMatches,
  normalizedObjectType,
  propertyValue,
  setProperty,
} from './exact-bindings.js';

export const NOTION_KNOWN_EXTERNAL_ID_ALIAS = 'notion.knownExternalId';
export const NOTION_DEDUPE_KNOWN_EXTERNAL_ID = 'notion.dedupe.knownExternalId';

/**
 * Fold planner alias `notion.knownExternalId` into the canonical
 * `notion.dedupe.knownExternalId` only when provenance is safe:
 * - action is a Notion database-record reuse/update/link/relation shape
 * - exactly one discovered (or prior-verified) source record matches the alias ID
 * - structured sourceRecordId, when present, matches the alias
 *
 * Unsupported / invented aliases are left untouched so AUR-PLAN-009 still fails closed.
 */
export function normalizeNotionKnownExternalIdAlias(
  action: PlanAction,
  destination: ResolvedDestination,
  options?: {
    priorVerifiedIds?: ReadonlySet<string>;
  },
): PlanAction {
  const alias = propertyValue(action.properties, NOTION_KNOWN_EXTERNAL_ID_ALIAS)?.trim();
  if (!alias) return action;

  const canonical = propertyValue(action.properties, NOTION_DEDUPE_KNOWN_EXTERNAL_ID)?.trim();
  if (canonical) {
    // Canonical already present — drop the unsupported alias without rewriting authority.
    return stripAlias(action);
  }

  if (!isNotionDatabaseRecordReuseOrUpdate(action)) return action;

  const matches = matchingDiscoveredRecords(destination, alias);
  const priorVerified = options?.priorVerifiedIds?.has(alias) ?? false;
  if (matches.length > 1) return action;
  if (matches.length === 0 && !priorVerified) return action;

  const sourceRecordId = propertyValue(action.properties, 'notion.relation.sourceRecordId')?.trim();
  if (sourceRecordId && sourceRecordId !== alias) return action;

  const matched = matches[0];
  if (matched && !notionRecordTypeCompatible(action.objectType, matched)) return action;

  const properties = action.properties.filter(
    (property) => property.key !== NOTION_KNOWN_EXTERNAL_ID_ALIAS,
  );
  setProperty(properties, NOTION_DEDUPE_KNOWN_EXTERNAL_ID, alias);
  if (sourceRecordId === undefined && isNotionRelationShape(action)) {
    setProperty(properties, 'notion.relation.sourceRecordId', alias);
  }
  return { ...action, properties };
}

export function isNotionDatabaseRecordReuseOrUpdate(action: PlanAction): boolean {
  if (action.operation === 'update' || action.operation === 'link') return true;
  if (isNotionRelationShape(action)) return true;
  const kind = normalizedObjectType(action.objectType);
  return (
    (kind === 'database_record' || kind === 'record' || kind === 'page') &&
    action.operation !== 'create'
  );
}

export function isNotionRelationShape(action: PlanAction): boolean {
  if (action.objectType.toLocaleLowerCase().includes('relation')) return true;
  return action.properties.some((property) =>
    [
      'notion.relation.sourceRecordId',
      'notion.relation.targetRecordId',
      'notion.relation.targetRecordIds',
      'notion.relation.name',
      'notion.relation',
    ].includes(property.key),
  );
}

function matchingDiscoveredRecords(
  destination: ResolvedDestination,
  id: string,
): DiscoveredObject[] {
  return destination.existingObjects.filter(
    (object) =>
      object.id === id &&
      (exactObjectTypeMatches('notion', object.type, 'database_record') ||
        exactObjectTypeMatches('notion', object.type, 'record') ||
        exactObjectTypeMatches('notion', object.type, 'page')),
  );
}

function notionRecordTypeCompatible(actionType: string, object: DiscoveredObject): boolean {
  return (
    exactObjectTypeMatches('notion', object.type, actionType) ||
    exactObjectTypeMatches('notion', object.type, 'database_record') ||
    exactObjectTypeMatches('notion', object.type, 'record')
  );
}

function stripAlias(action: PlanAction): PlanAction {
  return {
    ...action,
    properties: action.properties.filter(
      (property) => property.key !== NOTION_KNOWN_EXTERNAL_ID_ALIAS,
    ),
  };
}
