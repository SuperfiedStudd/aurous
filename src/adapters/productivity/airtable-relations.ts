import { AurousError } from '../../core/errors.js';
import type { PlanAction } from '../../domain/schemas.js';
import { exactObjectTypeMatches, propertyValue } from './exact-bindings.js';

/**
 * Typed same-plan / mixed Airtable relation authorization.
 * Stored as JSON on property key `airtable.relation`.
 * Same-plan refs use recordActionId (existing *ActionId framework).
 * Existing records use exact recordId. Never authorize `${action.output…}` strings.
 */
export const AIRTABLE_RELATION_PROPERTY = 'airtable.relation';

export type AirtableRelationRecordRef =
  | { recordActionId: string; recordId?: undefined }
  | { recordId: string; recordActionId?: undefined };

export interface AirtableRelationBinding {
  source: AirtableRelationRecordRef;
  targets: AirtableRelationRecordRef[];
  fieldActionId?: string;
  fieldId?: string;
}

export function looksLikeActionOutputPlaceholder(value: string): boolean {
  return /\$\{[\s\S]*action-\d+/i.test(value) || /\$\{[\s\S]*\.output\./i.test(value);
}

export function parseAirtableRelation(
  value: string | undefined,
): AirtableRelationBinding | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: 'Airtable relation binding is not valid JSON.',
      probableCause: 'airtable.relation must be a structured JSON object.',
      nextAction:
        'Authorize the relation with airtable.relation source/targets using recordActionId or exact recordId.',
    });
  }
  if (!isRecord(parsed) || !isRecord(parsed.source) || !Array.isArray(parsed.targets)) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: 'Airtable relation binding is missing source or targets.',
      probableCause: 'The typed relation object was incomplete.',
      nextAction:
        'Provide airtable.relation.source and a non-empty airtable.relation.targets array.',
    });
  }
  if (parsed.targets.length === 0) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: 'Airtable relation binding omits related targets.',
      probableCause: 'A relation mutation cannot authorize related objects without targets.',
      nextAction: 'Include at least one target with recordActionId or exact recordId.',
    });
  }
  const source = parseRecordRef(parsed.source, 'source');
  const targets = parsed.targets.map((target, index) =>
    parseRecordRef(target, `targets[${index}]`),
  );
  const binding: AirtableRelationBinding = { source, targets };
  if (typeof parsed.fieldActionId === 'string' && parsed.fieldActionId.trim()) {
    binding.fieldActionId = parsed.fieldActionId.trim();
  }
  if (typeof parsed.fieldId === 'string' && parsed.fieldId.trim()) {
    binding.fieldId = parsed.fieldId.trim();
  }
  return binding;
}

export function airtableRelationProperty(action: PlanAction): string | undefined {
  return propertyValue(action.properties, AIRTABLE_RELATION_PROPERTY);
}

export function hasTypedAirtableRelation(action: PlanAction): boolean {
  return Boolean(airtableRelationProperty(action)?.trim());
}

export function relationUsesSamePlanActionRefs(binding: AirtableRelationBinding): boolean {
  return (
    Boolean(binding.source.recordActionId) ||
    binding.targets.some((target) => Boolean(target.recordActionId))
  );
}

/**
 * Plan-time validation for airtable.relation against the immutable action list.
 * Does not authorize future record IDs — only typed dependencies.
 */
export function validateAirtableRelationBinding(
  action: PlanAction,
  actions: PlanAction[],
  destinationExistingIds: ReadonlySet<string>,
): void {
  const raw = airtableRelationProperty(action);
  if (!raw) return;
  if (looksLikeActionOutputPlaceholder(raw)) {
    throw placeholderRelationError(action.id);
  }
  const binding = parseAirtableRelation(raw);
  if (!binding) return;

  validateRecordRef(action, actions, destinationExistingIds, binding.source, 'source');
  for (const [index, target] of binding.targets.entries()) {
    validateRecordRef(action, actions, destinationExistingIds, target, `targets[${index}]`);
  }
  if (binding.fieldActionId) {
    validateActionDependency(action, actions, binding.fieldActionId, 'field', 'fieldActionId');
  }
  if (binding.fieldId) {
    rejectPlaceholder(action.id, binding.fieldId, 'fieldId');
    if (!destinationExistingIds.has(binding.fieldId)) {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Airtable action ${action.id} references an uninspected field ID in airtable.relation.`,
        probableCause: 'Exact field IDs must come from read-only discovery.',
        nextAction: 'Bind an inspected fieldId or a fieldActionId create dependency.',
      });
    }
  }
}

/**
 * Apply-time resolution: typed dependencies → exact record IDs from persisted action results.
 */
export function resolveAirtableRelationForExecution(
  action: PlanAction,
  resultIdByAction: ReadonlyMap<string, string>,
  options?: {
    resultTypeByAction?: ReadonlyMap<string, string>;
  },
): { recordId: string; linkedRecordIds: string[]; fieldId?: string } {
  const binding = parseAirtableRelation(airtableRelationProperty(action));
  if (!binding) {
    throw new AurousError({
      code: 'AUR-APPLY-005',
      summary: `Action ${action.id} has no airtable.relation binding to resolve.`,
      probableCause: 'Execution expected a typed same-plan relation dependency.',
      nextAction: 'Create a new plan with a structured airtable.relation binding.',
      severity: 'recoverable',
    });
  }

  const recordId = resolveRecordRef(
    action.id,
    binding.source,
    resultIdByAction,
    options?.resultTypeByAction,
    'source',
  );
  const linkedRecordIds = binding.targets.map((target, index) =>
    resolveRecordRef(
      action.id,
      target,
      resultIdByAction,
      options?.resultTypeByAction,
      `targets[${index}]`,
    ),
  );

  let fieldId = binding.fieldId;
  if (binding.fieldActionId) {
    const resolved = resultIdByAction.get(binding.fieldActionId);
    if (!resolved) {
      throw dependencyFailure(
        action.id,
        binding.fieldActionId,
        'field create result was missing, skipped without an ID, or failed before the relation write.',
      );
    }
    const type = options?.resultTypeByAction?.get(binding.fieldActionId);
    if (type && !exactObjectTypeMatches('airtable', type, 'field')) {
      throw dependencyTypeFailure(action.id, binding.fieldActionId, 'field', type);
    }
    fieldId = resolved;
  }

  return {
    recordId,
    linkedRecordIds,
    ...(fieldId ? { fieldId } : {}),
  };
}

/**
 * Expand airtable.relation into exact recordId / linkedRecordIds on a working action copy.
 * Leaves the immutable saved plan unchanged; used for execution binding and tests.
 */
export function materializeAirtableRelationAction(
  action: PlanAction,
  resultIdByAction: ReadonlyMap<string, string>,
  options?: {
    resultTypeByAction?: ReadonlyMap<string, string>;
  },
): PlanAction {
  if (!hasTypedAirtableRelation(action)) return action;
  const resolved = resolveAirtableRelationForExecution(action, resultIdByAction, options);
  const properties = action.properties.filter(
    (property) =>
      property.key !== 'airtable.recordId' &&
      property.key !== 'airtable.linkedRecordIds' &&
      property.key !== 'airtable.fieldId' &&
      property.key !== 'airtable.dedupe.knownExternalId',
  );
  properties.push({ key: 'airtable.recordId', value: resolved.recordId });
  properties.push({
    key: 'airtable.linkedRecordIds',
    value: JSON.stringify(resolved.linkedRecordIds),
  });
  if (resolved.fieldId) properties.push({ key: 'airtable.fieldId', value: resolved.fieldId });
  properties.push({ key: 'airtable.dedupe.knownExternalId', value: resolved.recordId });
  return {
    ...action,
    operation: action.operation === 'create' ? 'update' : action.operation,
    objectType: 'airtable.record',
    properties,
  };
}

function parseRecordRef(value: unknown, label: string): AirtableRelationRecordRef {
  if (!isRecord(value)) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: `Airtable relation ${label} must be an object.`,
      probableCause: 'The typed relation reference was not structured.',
      nextAction: 'Use { "recordActionId": "action-…" } or { "recordId": "rec…" }.',
    });
  }
  const recordActionId =
    typeof value.recordActionId === 'string' ? value.recordActionId.trim() : undefined;
  const recordId = typeof value.recordId === 'string' ? value.recordId.trim() : undefined;
  // Preferred shape also allowed baseActionId as a legacy alias for the producing action id.
  const legacyActionId =
    typeof value.baseActionId === 'string' ? value.baseActionId.trim() : undefined;
  const actionId = recordActionId || legacyActionId;
  if (actionId && recordId) {
    throw new AurousError({
      code: 'AUR-PLAN-011',
      summary: `Airtable relation ${label} cannot mix recordActionId and recordId.`,
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
    summary: `Airtable relation ${label} is missing recordActionId or recordId.`,
    probableCause: 'The typed relation reference did not authorize a dependency or exact ID.',
    nextAction: 'Set recordActionId for same-plan creates or recordId for discovered records.',
  });
}

function validateRecordRef(
  action: PlanAction,
  actions: PlanAction[],
  destinationExistingIds: ReadonlySet<string>,
  ref: AirtableRelationRecordRef,
  label: string,
): void {
  if (ref.recordActionId) {
    validateActionDependency(action, actions, ref.recordActionId, 'record', label);
    return;
  }
  if (ref.recordId) {
    rejectPlaceholder(action.id, ref.recordId, label);
    if (!destinationExistingIds.has(ref.recordId)) {
      throw new AurousError({
        code: 'AUR-PLAN-011',
        summary: `Airtable action ${action.id} references an uninspected record ID in relation ${label}.`,
        probableCause: 'Exact record IDs must come from read-only discovery.',
        nextAction: 'Bind an inspected recordId or a same-plan recordActionId.',
      });
    }
  }
}

function validateActionDependency(
  action: PlanAction,
  actions: PlanAction[],
  dependencyId: string,
  expectedType: 'record' | 'field',
  label: string,
): void {
  rejectPlaceholder(action.id, dependencyId, label);
  const dependencyIndex = actions.findIndex((candidate) => candidate.id === dependencyId);
  const actionIndex = actions.findIndex((candidate) => candidate.id === action.id);
  const dependency = dependencyIndex >= 0 ? actions[dependencyIndex] : undefined;
  if (
    !dependency ||
    actionIndex < 0 ||
    dependencyIndex >= actionIndex ||
    (dependency.operation !== 'create' && dependency.operation !== 'update') ||
    !exactObjectTypeMatches('airtable', dependency.objectType, expectedType) ||
    !dependsOnAction(action, dependencyId, actions)
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-012',
      summary: `Airtable action ${action.id} has an invalid relation ${label} dependency on ${dependencyId}.`,
      probableCause:
        'Same-plan relation refs must point at an earlier approved create/reuse of the expected record or field type and appear in dependsOn.',
      nextAction:
        'Regenerate the plan with explicit dependsOn and recordActionId / fieldActionId / baseActionId bindings.',
    });
  }
  // Update ops used for reuse must already carry knownExternalId (authorized existing identity).
  if (
    dependency.operation === 'update' &&
    !dependency.properties.some((property) => property.key === 'airtable.dedupe.knownExternalId')
  ) {
    throw new AurousError({
      code: 'AUR-PLAN-009',
      summary: `Airtable relation dependency ${dependencyId} proposes reuse without an exact external ID.`,
      probableCause:
        'A same-plan relation target was not bound by airtable.dedupe.knownExternalId.',
      nextAction: 'Bind knownExternalId on the reused record action before relating to it.',
    });
  }
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
  ref: AirtableRelationRecordRef,
  resultIdByAction: ReadonlyMap<string, string>,
  resultTypeByAction: ReadonlyMap<string, string> | undefined,
  label: string,
): string {
  if (ref.recordId) {
    rejectPlaceholder(actionId, ref.recordId, label);
    return ref.recordId;
  }
  const dependencyId = ref.recordActionId!;
  const resolved = resultIdByAction.get(dependencyId);
  if (!resolved) {
    throw dependencyFailure(
      actionId,
      dependencyId,
      'record create/reuse result was missing, skipped without an ID, or failed before the relation write.',
    );
  }
  const type = resultTypeByAction?.get(dependencyId);
  if (type && !exactObjectTypeMatches('airtable', type, 'record')) {
    throw dependencyTypeFailure(actionId, dependencyId, 'record', type);
  }
  rejectPlaceholder(actionId, resolved, label);
  return resolved;
}

function rejectPlaceholder(actionId: string, value: string, label: string): void {
  if (looksLikeActionOutputPlaceholder(value)) {
    throw placeholderRelationError(actionId, label);
  }
}

function placeholderRelationError(actionId: string, label?: string): AurousError {
  return new AurousError({
    code: 'AUR-PLAN-009',
    summary: `Action ${actionId} proposes a relation using an unsupported action-output placeholder${
      label ? ` in ${label}` : ''
    }.`,
    probableCause:
      'Discovery found or implied an existing object, but the immutable action retained only a name-based or ${action.output} authorization.',
    nextAction:
      'No writes were attempted. Use airtable.relation with recordActionId / exact recordId, never ${action.output} strings.',
  });
}

function dependencyFailure(actionId: string, dependencyId: string, detail: string): AurousError {
  return new AurousError({
    code: 'AUR-APPLY-005',
    summary: `Action ${actionId} cannot resolve relation dependency ${dependencyId}.`,
    probableCause: detail,
    nextAction: 'Inspect the failed dependency, then create a new plan or recovery run.',
    severity: 'recoverable',
  });
}

function dependencyTypeFailure(
  actionId: string,
  dependencyId: string,
  expected: string,
  actual: string,
): AurousError {
  return new AurousError({
    code: 'AUR-APPLY-005',
    summary: `Action ${actionId} relation dependency ${dependencyId} returned ${actual}, expected ${expected}.`,
    probableCause: 'The approved dependency completed as a different object type.',
    nextAction: 'Stop before the relation write and regenerate the plan with matching types.',
    severity: 'recoverable',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
