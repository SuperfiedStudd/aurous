import { AurousError } from '../../core/errors.js';
import type { PlanAction } from '../../domain/schemas.js';
import { exactObjectTypeMatches, propertyValue, setProperty } from './exact-bindings.js';
import { looksLikeActionOutputPlaceholder } from './airtable-relations.js';

/**
 * Typed same-plan / mixed Notion relation authorization.
 * Stored as JSON on property key `notion.relation`.
 * Same-plan refs use recordActionId (or legacy baseActionId).
 * Existing records use exact recordId. Never authorize `${action.output…}` strings.
 */
export const NOTION_RELATION_PROPERTY = 'notion.relation';

export type NotionRelationRecordRef =
  | { recordActionId: string; recordId?: undefined }
  | { recordId: string; recordActionId?: undefined };

export interface NotionRelationBinding {
  source: NotionRelationRecordRef;
  targets: NotionRelationRecordRef[];
  name?: string;
}

export function parseNotionRelation(value: string | undefined): NotionRelationBinding | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: 'Notion relation binding is not valid JSON.',
      probableCause: 'notion.relation must be a structured JSON object when used as a typed binding.',
      nextAction:
        'Authorize the relation with notion.relation source/targets using recordActionId or exact recordId.',
    });
  }
  if (!isRecord(parsed) || !isRecord(parsed.source) || !Array.isArray(parsed.targets)) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: 'Notion relation binding is missing source or targets.',
      probableCause: 'The typed relation object was incomplete.',
      nextAction: 'Provide notion.relation.source and a non-empty notion.relation.targets array.',
    });
  }
  if (parsed.targets.length === 0) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: 'Notion relation binding omits related targets.',
      probableCause: 'A relation mutation cannot authorize related objects without targets.',
      nextAction: 'Include at least one target with recordActionId or exact recordId.',
    });
  }
  const binding: NotionRelationBinding = {
    source: parseRecordRef(parsed.source, 'source'),
    targets: parsed.targets.map((target, index) => parseRecordRef(target, `targets[${index}]`)),
  };
  if (typeof parsed.name === 'string' && parsed.name.trim()) {
    binding.name = parsed.name.trim();
  }
  return binding;
}

export function notionRelationProperty(action: PlanAction): string | undefined {
  return propertyValue(action.properties, NOTION_RELATION_PROPERTY);
}

export function hasTypedNotionRelation(action: PlanAction): boolean {
  const raw = notionRelationProperty(action)?.trim();
  if (!raw) return false;
  if (!raw.startsWith('{')) return false;
  try {
    return Boolean(parseNotionRelation(raw));
  } catch {
    return false;
  }
}

export function notionRelationUsesSamePlanActionRefs(binding: NotionRelationBinding): boolean {
  return (
    Boolean(binding.source.recordActionId) ||
    binding.targets.some((target) => Boolean(target.recordActionId))
  );
}

export function validateNotionRelationBinding(
  action: PlanAction,
  actions: PlanAction[],
  destinationExistingIds: ReadonlySet<string>,
): void {
  const raw = notionRelationProperty(action);
  if (!raw?.trim() || !raw.trim().startsWith('{')) return;
  if (looksLikeActionOutputPlaceholder(raw)) {
    throw placeholderRelationError(action.id);
  }
  const binding = parseNotionRelation(raw);
  if (!binding) return;

  validateRecordRef(action, actions, destinationExistingIds, binding.source, 'source');
  for (const [index, target] of binding.targets.entries()) {
    validateRecordRef(action, actions, destinationExistingIds, target, `targets[${index}]`);
  }
}

/**
 * Expand typed notion.relation into exact structured IDs on a working action copy.
 */
export function materializeNotionRelationAction(
  action: PlanAction,
  resultIdByAction: ReadonlyMap<string, string>,
  options?: {
    resultTypeByAction?: ReadonlyMap<string, string>;
  },
): PlanAction {
  if (!hasTypedNotionRelation(action)) return action;
  const binding = parseNotionRelation(notionRelationProperty(action));
  if (!binding) return action;

  const sourceId = resolveRecordRef(
    action.id,
    binding.source,
    resultIdByAction,
    options?.resultTypeByAction,
    'source',
  );
  const targetIds = binding.targets.map((target, index) =>
    resolveRecordRef(
      action.id,
      target,
      resultIdByAction,
      options?.resultTypeByAction,
      `targets[${index}]`,
    ),
  );

  const properties = action.properties.filter(
    (property) =>
      property.key !== 'notion.relation.sourceRecordId' &&
      property.key !== 'notion.relation.targetRecordId' &&
      property.key !== 'notion.relation.targetRecordIds' &&
      property.key !== 'notion.dedupe.knownExternalId' &&
      property.key !== 'notion.knownExternalId',
  );
  setProperty(properties, 'notion.relation.sourceRecordId', sourceId);
  setProperty(properties, 'notion.relation.targetRecordIds', JSON.stringify(targetIds));
  setProperty(properties, 'notion.dedupe.knownExternalId', sourceId);
  if (binding.name) setProperty(properties, 'notion.relation.name', binding.name);
  // Keep the typed binding for audit; exact IDs are now authoritative.
  setProperty(
    properties,
    NOTION_RELATION_PROPERTY,
    JSON.stringify({
      ...(binding.name ? { name: binding.name } : {}),
      source: { recordId: sourceId },
      targets: targetIds.map((recordId) => ({ recordId })),
    }),
  );

  return {
    ...action,
    operation: action.operation === 'create' ? 'update' : action.operation,
    objectType: 'notion.database_record',
    properties,
  };
}

function parseRecordRef(value: unknown, label: string): NotionRelationRecordRef {
  if (!isRecord(value)) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: `Notion relation ${label} must be an object.`,
      probableCause: 'The typed relation reference was not structured.',
      nextAction: 'Use { "recordActionId": "action-…" } or { "recordId": "<uuid>" }.',
    });
  }
  const recordActionId =
    typeof value.recordActionId === 'string' ? value.recordActionId.trim() : undefined;
  const recordId = typeof value.recordId === 'string' ? value.recordId.trim() : undefined;
  const legacyActionId =
    typeof value.baseActionId === 'string' ? value.baseActionId.trim() : undefined;
  const actionId = recordActionId || legacyActionId;
  if (actionId && recordId) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: `Notion relation ${label} cannot mix recordActionId and recordId.`,
      probableCause:
        'A single reference must authorize either a same-plan dependency or an exact ID.',
      nextAction: 'Choose exactly one of recordActionId or recordId.',
    });
  }
  if (actionId) {
    rejectPlaceholder(label, actionId, 'recordActionId');
    return { recordActionId: actionId };
  }
  if (recordId) {
    rejectPlaceholder(label, recordId, 'recordId');
    return { recordId };
  }
  throw new AurousError({
    code: 'AUR-PLAN-011',
    summary: `Notion relation ${label} is missing recordActionId or recordId.`,
    probableCause: 'The typed relation reference did not authorize a dependency or exact ID.',
    nextAction: 'Set recordActionId for same-plan creates or recordId for discovered records.',
  });
}

function validateRecordRef(
  action: PlanAction,
  actions: PlanAction[],
  destinationExistingIds: ReadonlySet<string>,
  ref: NotionRelationRecordRef,
  label: string,
): void {
  if (ref.recordActionId) {
    validateActionDependency(action, actions, ref.recordActionId, label);
    return;
  }
  if (ref.recordId) {
    rejectPlaceholder(action.id, ref.recordId, label);
    if (!destinationExistingIds.has(ref.recordId)) {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Notion action ${action.id} references an uninspected record ID in notion.relation.`,
        probableCause: 'Exact record IDs must come from read-only discovery.',
        nextAction: 'Bind an inspected recordId or a same-plan recordActionId.',
      });
    }
  }
}

function validateActionDependency(
  action: PlanAction,
  actions: PlanAction[],
  requiredActionId: string,
  label: string,
): void {
  rejectPlaceholder(action.id, requiredActionId, label);
  const dependency = actions.find((candidate) => candidate.id === requiredActionId);
  if (
    !dependency ||
    dependency.operation !== 'create' ||
    !isNotionRecordCreate(dependency) ||
    !dependsOnAction(action, requiredActionId, actions)
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-012',
      summary: `Notion action ${action.id} has an invalid ${label} dependency ${JSON.stringify(requiredActionId)}.`,
      probableCause:
        'A relation dependency must reference an immutable approved same-plan record create and list it in dependsOn.',
      nextAction:
        'Regenerate the plan with explicit dependsOn and recordActionId / baseActionId bindings.',
    });
  }
}

function isNotionRecordCreate(action: PlanAction): boolean {
  const kind = action.objectType.toLocaleLowerCase();
  return (
    kind.includes('record') ||
    kind.includes('page') ||
    exactObjectTypeMatches('notion', action.objectType, 'database_record') ||
    exactObjectTypeMatches('notion', action.objectType, 'record')
  );
}

function dependsOnAction(
  action: PlanAction,
  requiredActionId: string,
  actions: PlanAction[],
): boolean {
  const byId = new Map(actions.map((candidate) => [candidate.id, candidate]));
  const pending = [...action.dependsOn];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === requiredActionId) return true;
    visited.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

function resolveRecordRef(
  actionId: string,
  ref: NotionRelationRecordRef,
  resultIdByAction: ReadonlyMap<string, string>,
  resultTypeByAction: ReadonlyMap<string, string> | undefined,
  label: string,
): string {
  if (ref.recordId) return ref.recordId;
  const dependencyId = ref.recordActionId!;
  const resolved = resultIdByAction.get(dependencyId);
  if (!resolved) {
    throw new AurousError({
      code: 'AUR-APPLY-005',
      summary: `Notion action ${actionId} could not resolve ${label} dependency ${JSON.stringify(dependencyId)}.`,
      probableCause:
        'The dependency create result was missing, skipped without an ID, or failed before the relation write.',
      nextAction: 'Re-run apply after the dependency create succeeds with an exact external ID.',
      severity: 'recoverable',
    });
  }
  const type = resultTypeByAction?.get(dependencyId);
  if (
    type &&
    !exactObjectTypeMatches('notion', type, 'database_record') &&
    !exactObjectTypeMatches('notion', type, 'record') &&
    !exactObjectTypeMatches('notion', type, 'page')
  ) {
    throw new AurousError({
      code: 'AUR-APPLY-005',
      summary: `Notion action ${actionId} dependency ${JSON.stringify(dependencyId)} resolved to incompatible type ${JSON.stringify(type)}.`,
      probableCause: 'The approved dependency did not produce a Notion database record.',
      nextAction: 'Regenerate the plan with a record create dependency.',
      severity: 'recoverable',
    });
  }
  return resolved;
}

function rejectPlaceholder(actionId: string, value: string, label: string): void {
  if (looksLikeActionOutputPlaceholder(value)) {
    throw placeholderRelationError(actionId, label);
  }
}

function placeholderRelationError(actionId: string, label = 'relation'): AurousError {
  return new AurousError({
    code: 'AUR-PLAN-009',
    summary: `Action ${actionId} authorizes a Notion ${label} with an unsupported \${action.output…} placeholder.`,
    probableCause: 'Future IDs and output placeholders are not exact structured authorization.',
    nextAction:
      'No writes were attempted. Use notion.relation with recordActionId / exact recordId, never ${action.output} strings.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
