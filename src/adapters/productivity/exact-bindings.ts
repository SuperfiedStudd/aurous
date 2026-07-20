import type { DiscoveredObject, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanAction, ToolName } from '../../domain/schemas.js';
import { AurousError } from '../../core/errors.js';

export type ExactBindingNamespace = 'airtable' | 'linear' | 'notion' | 'trello' | 'mock';

export function exactObjectMatches(
  destination: ResolvedDestination,
  action: Pick<PlanAction, 'objectType' | 'target'>,
  tool: ToolName = destination.integration,
  parentId?: string,
) {
  return destination.existingObjects
    .filter((object) => {
      if (object.name !== action.target) return false;
      if (!exactObjectTypeMatches(tool, object.type, action.objectType)) return false;
      if (parentId === undefined) return true;
      return (object.parentId ?? destination.id) === parentId;
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function canonicalExactObject(
  destination: ResolvedDestination,
  action: Pick<PlanAction, 'objectType' | 'target'>,
  tool: ToolName = destination.integration,
  parentId?: string,
) {
  return exactObjectMatches(destination, action, tool, parentId)[0];
}

/**
 * Resolve an inspected object for reuse/update/link using, in order:
 * 1. persisted exact external ID
 * 2. freshly discovered exact ID from structured action properties
 * 3. exact parent-scoped normalized name / identifier match
 * Ambiguous matches throw; no match returns undefined (create path or later AUR-PLAN-009).
 */
export function resolveExactObject(
  destination: ResolvedDestination,
  action: PlanAction,
  tool: ToolName = destination.integration,
  parentId?: string,
): DiscoveredObject | undefined {
  const namespace = bindingNamespace(tool);
  const persisted = propertyValue(action.properties, `${namespace}.dedupe.knownExternalId`);
  if (persisted) {
    const exact = destination.existingObjects.find((object) => object.id === persisted);
    if (
      exact &&
      exactObjectTypeMatches(tool, exact.type, action.objectType) &&
      (parentId === undefined || (exact.parentId ?? destination.id) === parentId)
    ) {
      return exact;
    }
  }

  const structuredIds = structuredCandidateIds(action, tool);
  const byStructuredId = uniqueObjects(
    structuredIds
      .map((id) => destination.existingObjects.find((object) => object.id === id))
      .filter((object): object is DiscoveredObject => Boolean(object))
      .filter(
        (object) =>
          exactObjectTypeMatches(tool, object.type, action.objectType) &&
          (parentId === undefined || (object.parentId ?? destination.id) === parentId),
      ),
  );
  if (byStructuredId.length > 1) {
    throw ambiguousExactBindingError(action, byStructuredId);
  }
  if (byStructuredId[0]) {
    if (tool === 'linear') assertLinearIssueHasUuid(byStructuredId[0], action);
    return byStructuredId[0];
  }

  const lookupNames = candidateLookupNames(action, tool);
  const byName = uniqueObjects(
    lookupNames.flatMap((name) =>
      exactObjectMatches(
        destination,
        { objectType: action.objectType, target: name },
        tool,
        parentId,
      ),
    ),
  );
  if (byName.length > 1) {
    const parentKeys = new Set(byName.map((object) => object.parentId ?? destination.id));
    if (parentKeys.size > 1 && parentId === undefined)
      throw ambiguousExactBindingError(action, byName);
  }
  if (byName[0]) {
    if (tool === 'linear') assertLinearIssueHasUuid(byName[0], action);
    return byName[0];
  }

  if (tool === 'linear') {
    const issueKeys = candidateIssueKeys(action);
    const byKey = uniqueObjects(
      issueKeys.flatMap((key) =>
        destination.existingObjects.filter(
          (object) =>
            exactObjectTypeMatches(tool, object.type, action.objectType) &&
            (parentId === undefined || (object.parentId ?? destination.id) === parentId) &&
            (object.identifier === key ||
              linearIssueKeyFromObject(object) === key ||
              object.id === key),
        ),
      ),
    );
    if (byKey.length === 0 && issueKeys.length > 0 && requiresIssueKeyResolution(action)) {
      throw unresolvedLinearIssueKeyError(action, issueKeys);
    }
    if (byKey.length > 1) throw ambiguousExactBindingError(action, byKey);
    if (byKey[0]) {
      assertLinearIssueHasUuid(byKey[0], action);
      return byKey[0];
    }
  }

  return undefined;
}

export function looksLikeIssueKey(value: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/i.test(value.trim());
}

export function isLinearIssueUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

export function linearIssueKeyFromObject(object: DiscoveredObject): string | undefined {
  if (object.identifier && looksLikeIssueKey(object.identifier)) return object.identifier;
  const fromUrl = object.url?.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)(?:\/|$)/i)?.[1];
  return fromUrl && looksLikeIssueKey(fromUrl) ? fromUrl : undefined;
}

export function assertLinearIssueHasUuid(object: DiscoveredObject, action?: PlanAction): void {
  if (!exactObjectTypeMatches('linear', object.type, 'issue')) return;
  if (isLinearIssueUuid(object.id)) return;
  throw new AurousError({
    code: 'AUR-PLAN-010',
    summary: action
      ? `Action ${action.id} matched Linear issue ${JSON.stringify(object.name)}, but discovery did not provide an immutable issue UUID.`
      : `Linear issue ${JSON.stringify(object.name)} is missing an immutable issue UUID.`,
    probableCause:
      'Discovery returned a human-readable issue key where the immutable Linear issue UUID was required.',
    nextAction:
      'No writes were attempted. Re-run Linear discovery and resolve each issue to its UUID before planning.',
  });
}

export function relationAlreadySatisfied(
  existing: DiscoveredObject,
  requiredRelatedIds: string[],
): boolean {
  if (requiredRelatedIds.length === 0) return false;
  const current = existing.linkedIds ?? [];
  if (current.length === 0) return false;
  return requiredRelatedIds.every((id) => current.includes(id));
}

export function stampAlreadySatisfiedRelation(
  action: PlanAction,
  namespace: ExactBindingNamespace,
): PlanAction {
  const properties = action.properties.filter(
    (property) => property.key !== `${namespace}.dedupe.skipReason`,
  );
  properties.push({
    key: `${namespace}.dedupe.skipReason`,
    value: 'already-satisfied-relation',
  });
  return {
    ...action,
    description: `Skip no-op: the exact relation is already satisfied on the verified object. ${action.description}`,
    properties,
  };
}

export function parseRelatedIdList(value: string | undefined): string[] {
  if (!value || isNullishPropertyValue(value)) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Single ID string.
  }
  return [value];
}

export function stampExactExternalId(
  action: PlanAction,
  existing: DiscoveredObject,
  namespace: ExactBindingNamespace,
  reuseVerb = 'Reuse or reconcile',
): PlanAction {
  const properties = action.properties.filter(
    (property) =>
      property.key !== `${namespace}.dedupe.knownExternalId` &&
      property.key !== `${namespace}.dedupe.knownUrl`,
  );
  properties.push({ key: `${namespace}.dedupe.knownExternalId`, value: existing.id });
  if (existing.url) properties.push({ key: `${namespace}.dedupe.knownUrl`, value: existing.url });
  return {
    ...action,
    target: existing.name,
    description: action.description.startsWith(reuseVerb)
      ? action.description
      : `${reuseVerb} the exact verified existing ${action.objectType} ${JSON.stringify(existing.name)}. ${action.description}`,
    properties,
  };
}

export function normalizeNullishProperties(
  properties: PlanAction['properties'],
): PlanAction['properties'] {
  return properties.filter((property) => !isNullishPropertyValue(property.value));
}

export function isNullishPropertyValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'null' || trimmed === 'undefined';
}

export function propertyValue(
  properties: PlanAction['properties'] | { key: string; value: string }[],
  keys: string | string[],
): string | undefined {
  const wanted = Array.isArray(keys) ? keys : [keys];
  return properties.find((property) => wanted.includes(property.key))?.value;
}

export function setProperty(
  properties: PlanAction['properties'],
  key: string,
  value: string,
): void {
  const existing = properties.find((property) => property.key === key);
  if (existing) existing.value = value;
  else properties.push({ key, value });
}

export function bindingNamespace(tool: ToolName): ExactBindingNamespace {
  if (tool === 'airtable') return 'airtable';
  if (tool === 'linear') return 'linear';
  if (tool === 'notion') return 'notion';
  if (tool === 'trello') return 'trello';
  return 'mock';
}

export function normalizeRelationAction(action: PlanAction, tool: ToolName): PlanAction {
  if (tool === 'notion') return normalizeNotionRelationAction(action);
  if (tool === 'airtable') return normalizeAirtableRelationAction(action);
  if (tool === 'linear') {
    return {
      ...action,
      properties: normalizeNullishProperties(action.properties),
    };
  }
  return action;
}

export function isSyntheticRelationshipTarget(target: string): boolean {
  return /\blink\b.+\bto\b/i.test(target) || /\bexisting\b.+\band\b.+\bexisting\b/i.test(target);
}

export function exactBindingWarnings(
  destination: ResolvedDestination,
  actions: PlanAction[],
  tool: ToolName = destination.integration,
): string[] {
  const warnings = [...destination.discoveryWarnings];
  for (const action of actions) {
    const matches = exactObjectMatches(destination, action, tool);
    if (matches.length > 1) {
      const parentKeys = new Set(matches.map((object) => object.parentId ?? destination.id));
      if (parentKeys.size > 1) continue;
      warnings.push(
        `Duplicate risk for ${action.objectType} ${JSON.stringify(action.target)}: ${matches.length} compatible exact objects were inspected. Aurous selected one canonical exact object; the other ${matches.length - 1} ${matches.length === 2 ? 'duplicate' : 'duplicates'} will remain untouched.`,
      );
      continue;
    }
    if (matches.length > 0) continue;
    const similar = destination.existingObjects.filter(
      (object) =>
        exactObjectTypeMatches(tool, object.type, action.objectType) &&
        normalizedName(object.name) !== normalizedName(action.target) &&
        isSimilarName(object.name, action.target),
    );
    if (similar.length > 0) {
      warnings.push(
        `Similar-name risk for ${action.objectType} ${JSON.stringify(action.target)}: creating it may add another object near ${similar
          .slice(0, 3)
          .map((object) => JSON.stringify(object.name))
          .join(', ')}. Those inspected objects will remain untouched.`,
      );
    }
  }
  return [...new Set(warnings)];
}

export function normalizedObjectType(type: string): string {
  const normalized = type
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/g, '_');
  const unprefixed = normalized.replace(/^(?:airtable|linear|notion|trello)[_.]/, '');
  if (unprefixed === 'issue_label') return 'label';
  if (unprefixed === 'data_source') return 'database';
  if (unprefixed === 'records') return 'record';
  if (unprefixed === 'database_record_relation' || unprefixed === 'record_relation') {
    return 'database_record';
  }
  if (unprefixed === 'boards') return 'board';
  if (unprefixed === 'lists') return 'list';
  if (unprefixed === 'cards') return 'card';
  if (unprefixed === 'checklists') return 'checklist';
  if (unprefixed === 'labels') return 'label';
  if (unprefixed === 'workspaces' || unprefixed === 'organization') return 'workspace';
  return unprefixed;
}

export function exactObjectTypeMatches(
  tool: ToolName,
  discoveredType: string,
  actionType: string,
): boolean {
  const discovered = normalizedObjectType(discoveredType);
  const planned = normalizedObjectType(actionType);
  if (discovered === planned) return true;
  return tool === 'notion' && discovered === 'page' && planned === 'database_record';
}

function normalizeNotionRelationAction(action: PlanAction): PlanAction {
  const kind = normalizedObjectType(action.objectType);
  const sourceId =
    propertyValue(action.properties, 'notion.relation.sourceRecordId') ??
    propertyValue(action.properties, 'notion.dedupe.knownExternalId');
  const targetId =
    propertyValue(action.properties, 'notion.relation.targetRecordId') ??
    propertyValue(action.properties, 'notion.relation.targetRecordIds');
  const isRelationShape =
    action.objectType.toLocaleLowerCase().includes('relation') ||
    (Boolean(sourceId) && Boolean(propertyValue(action.properties, 'notion.relation.name')));
  if (!isRelationShape && kind !== 'database_record') return action;
  if (!sourceId) return action;

  const properties = action.properties.filter(
    (property) =>
      property.key !== 'notion.relation.targetRecordId' &&
      property.key !== 'notion.relation.targetRecordIds' &&
      property.key !== 'notion.relation.sourceRecordId',
  );
  properties.push({ key: 'notion.relation.sourceRecordId', value: sourceId });
  if (targetId) {
    const parsed = parseStringOrJsonArray(targetId);
    properties.push({
      key: 'notion.relation.targetRecordIds',
      value: JSON.stringify(parsed),
    });
  }
  return {
    ...action,
    operation: action.operation === 'create' ? 'update' : action.operation,
    objectType: 'notion.database_record',
    properties,
  };
}

function normalizeAirtableRelationAction(action: PlanAction): PlanAction {
  const typedRelation = propertyValue(action.properties, 'airtable.relation');
  if (typedRelation) {
    return {
      ...action,
      operation: action.operation === 'create' ? 'update' : action.operation,
      objectType: 'airtable.record',
      properties: normalizeNullishProperties(action.properties),
    };
  }
  const recordId = propertyValue(action.properties, 'airtable.recordId');
  if (!recordId) return action;
  if (action.operation === 'link' || isSyntheticRelationshipTarget(action.target)) {
    return {
      ...action,
      operation: action.operation === 'create' ? 'update' : action.operation,
      objectType: 'airtable.record',
    };
  }
  return action;
}

function structuredCandidateIds(action: PlanAction, tool: ToolName): string[] {
  if (tool === 'airtable') {
    return compact([propertyValue(action.properties, 'airtable.recordId')]);
  }
  if (tool === 'linear') {
    const issueId = propertyValue(action.properties, ['linear.issueId', 'issueId']);
    // Issue keys are resolved via identifier lookup, never as structured UUID candidates.
    if (issueId && looksLikeIssueKey(issueId)) return [];
    return compact([issueId]);
  }
  if (tool === 'notion') {
    return compact([
      propertyValue(action.properties, 'notion.relation.sourceRecordId'),
      propertyValue(action.properties, 'notion.pageId'),
      propertyValue(action.properties, 'notion.recordId'),
    ]);
  }
  if (tool === 'trello') {
    return compact([
      propertyValue(action.properties, 'trello.cardId'),
      propertyValue(action.properties, 'trello.listId'),
      propertyValue(action.properties, 'trello.boardId'),
      propertyValue(action.properties, 'trello.checklistId'),
    ]);
  }
  return [];
}

function candidateLookupNames(action: PlanAction, tool: ToolName): string[] {
  const names = [action.target];
  if (tool === 'linear') {
    names.push(
      ...compact([
        propertyValue(action.properties, ['linear.title', 'title']),
        propertyValue(action.properties, ['linear.name', 'name']),
      ]),
    );
  }
  if (tool === 'airtable') {
    names.push(...compact([propertyValue(action.properties, 'airtable.recordName')]));
  }
  if (tool === 'notion') {
    names.push(
      ...compact([
        propertyValue(action.properties, 'notion.property.Title'),
        propertyValue(action.properties, 'notion.property.Name'),
      ]),
    );
  }
  return [...new Set(names.filter((name) => name && !isSyntheticRelationshipTarget(name)))];
}

function candidateIssueKeys(action: PlanAction): string[] {
  return compact([
    action.target,
    propertyValue(action.properties, ['linear.issueId', 'issueId']),
    propertyValue(action.properties, ['linear.issueKey', 'issueKey', 'linear.identifier']),
  ]).filter(looksLikeIssueKey);
}

function requiresIssueKeyResolution(action: PlanAction): boolean {
  return (
    action.operation === 'update' ||
    action.operation === 'link' ||
    /\b(?:reuse|reconcile|skip|existing)\b/i.test(action.description) ||
    Boolean(propertyValue(action.properties, ['linear.issueKey', 'issueKey']))
  );
}

function unresolvedLinearIssueKeyError(action: PlanAction, issueKeys: string[]): AurousError {
  return new AurousError({
    code: 'AUR-PLAN-010',
    summary: `Action ${action.id} could not resolve Linear issue key ${JSON.stringify(issueKeys.join(', '))} to exactly one immutable issue UUID.`,
    probableCause:
      'Issue-key lookup returned zero inspected issues, or the key was never paired with a UUID during discovery.',
    nextAction:
      'No writes were attempted. Re-run Linear discovery and bind the exact issue UUID before preview.',
  });
}

function parseStringOrJsonArray(value: string): string[] {
  return parseRelatedIdList(value);
}

function uniqueObjects(objects: DiscoveredObject[]): DiscoveredObject[] {
  const seen = new Set<string>();
  const unique: DiscoveredObject[] = [];
  for (const object of objects) {
    if (seen.has(object.id)) continue;
    seen.add(object.id);
    unique.push(object);
  }
  return unique.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string =>
    Boolean(value && !isNullishPropertyValue(value)),
  );
}

function ambiguousExactBindingError(action: PlanAction, matches: DiscoveredObject[]): AurousError {
  return new AurousError({
    code: 'AUR-PLAN-010',
    summary: `Action ${action.id} matched ${matches.length} inspected objects for ${action.objectType} ${JSON.stringify(action.target)}; exact binding is ambiguous.`,
    probableCause: 'Parent-scoped discovery found more than one compatible exact object.',
    nextAction:
      'No writes were attempted. Narrow the parent scope or authorize one exact external ID.',
  });
}

function normalizedName(name: string): string {
  return name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isSimilarName(left: string, right: string): boolean {
  const a = normalizedName(left);
  const b = normalizedName(right);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
