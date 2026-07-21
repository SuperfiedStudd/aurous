import type { DiscoveredObject, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanAction, PlanProposal } from '../../domain/schemas.js';
import { normalizedObjectType, propertyValue, setProperty } from './exact-bindings.js';

/**
 * Capability-aware Notion plan normalization for the official MCP path.
 * Runs before preview/approval so compatibility downgrades are visible and immutable.
 */
export function normalizeNotionPlanCapabilities(
  proposal: PlanProposal,
  destination: ResolvedDestination,
): PlanProposal {
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const createById = new Map(
    proposal.plannedActions.filter((action) => action.operation === 'create').map((action) => [action.id, action]),
  );
  const plannedActions = proposal.plannedActions.map((action) =>
    normalizeNotionAction(action, createById, destination, warnings, assumptions),
  );
  return {
    ...proposal,
    plannedActions,
    assumptions: [...new Set([...proposal.assumptions, ...assumptions])],
    warnings: [...new Set([...proposal.warnings, ...warnings])],
  };
}

function normalizeNotionAction(
  action: PlanAction,
  createById: Map<string, PlanAction>,
  destination: ResolvedDestination,
  warnings: string[],
  assumptions: string[],
): PlanAction {
  let next = action;
  const propertiesJson = propertyValue(action.properties, 'notion.database.properties');
  if (propertiesJson) {
    next = normalizeDatabasePropertiesAction(next, createById, destination, warnings, assumptions);
  }
  if (propertyValue(next.properties, 'notion.page.linkedViews')) {
    next = normalizeLinkedViewsAction(next, createById, warnings, assumptions);
  }
  return next;
}

function normalizeDatabasePropertiesAction(
  action: PlanAction,
  createById: Map<string, PlanAction>,
  destination: ResolvedDestination,
  warnings: string[],
  assumptions: string[],
): PlanAction {
  const rawProperties = parseJsonArray(propertyValue(action.properties, 'notion.database.properties'));
  if (rawProperties.length === 0) return action;
  const statusFallback = parseJsonArray(propertyValue(action.properties, 'notion.database.statuses'))
    .map((entry) => (isRecord(entry) && typeof entry.name === 'string' ? entry.name : undefined))
    .filter((name): name is string => Boolean(name));
  const owningCreateId = owningDatabaseCreateId(action, createById);
  let statusConverted = false;
  let percentStripped = false;
  let relationsReplaced = 0;
  let selfRelationsRejected = 0;

  const converted = rawProperties.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.type !== 'string') {
      return entry;
    }
    if (entry.type === 'status') {
      statusConverted = true;
      const inlineOptions = Array.isArray(entry.options)
        ? entry.options.filter((option): option is string => typeof option === 'string')
        : [];
      const options = inlineOptions.length > 0 ? inlineOptions : statusFallback;
      return { name: entry.name, type: 'select', ...(options.length > 0 ? { options } : {}) };
    }
    if (entry.type === 'number' && entry.format === 'percent') {
      percentStripped = true;
      return { name: entry.name, type: 'number' };
    }
    if (entry.type === 'relation') {
      const explicitSelf = entry.selfRelation === true || entry.allowSelfRelation === true;
      const targetActionId =
        typeof entry.targetDatabaseActionId === 'string' ? entry.targetDatabaseActionId : undefined;
      const sourceId = resolveVerifiedDataSourceId(owningCreateId, createById, destination);
      const targetId = resolveVerifiedDataSourceId(targetActionId, createById, destination);
      if (targetActionId && owningCreateId && targetActionId === owningCreateId && !explicitSelf) {
        selfRelationsRejected += 1;
        relationsReplaced += 1;
        return { name: entry.name, type: 'text' };
      }
      if (sourceId && targetId && sourceId === targetId && !explicitSelf) {
        selfRelationsRejected += 1;
        relationsReplaced += 1;
        return { name: entry.name, type: 'text' };
      }
      // Official Notion MCP relation DDL is unreliable for same-plan dual inverses.
      // Keep relations only when both ends are verified, distinct, and explicitly requested;
      // otherwise use text references so preview matches a successful apply.
      if (sourceId && targetId && sourceId !== targetId && entry.emitRelation === true) {
        return { name: entry.name, type: 'relation', targetDatabaseId: targetId };
      }
      relationsReplaced += 1;
      return { name: entry.name, type: 'text' };
    }
    return entry;
  });

  if (statusConverted) {
    warnings.push(
      `${action.id}: custom Status options are unsupported by the official Notion MCP; converted to Select so the preview matches apply.`,
    );
    assumptions.push(
      'Notion Status properties that needed custom options were normalized to Select before approval.',
    );
  }
  if (percentStripped) {
    warnings.push(
      `${action.id}: number format "percent" is unsupported by the official Notion MCP; Progress uses an unformatted number.`,
    );
    assumptions.push(
      'Unsupported Notion number formats such as percent were removed before approval.',
    );
  }
  if (selfRelationsRejected > 0) {
    warnings.push(
      `${action.id}: rejected ${selfRelationsRejected} accidental self-relation(s); replaced with text reference fields.`,
    );
  }
  if (relationsReplaced > 0) {
    warnings.push(
      `${action.id}: replaced ${relationsReplaced} unverified cross-database relation(s) with text reference fields for this context-only workspace.`,
    );
    assumptions.push(
      'Cross-database relations are emitted only when distinct source and target data-source IDs are verified; otherwise text references are used.',
    );
  }

  const nextProperties = action.properties.filter(
    (property) =>
      property.key !== 'notion.database.properties' &&
      property.key !== 'notion.database.statuses' &&
      property.key !== 'notion.compatibility.statusToSelect' &&
      property.key !== 'notion.compatibility.relationToText',
  );
  nextProperties.push({
    key: 'notion.database.properties',
    value: JSON.stringify(converted),
  });
  if (statusConverted) {
    nextProperties.push({
      key: 'notion.compatibility.statusToSelect',
      value:
        'Custom workflow values use Select because the official Notion MCP cannot configure Status options.',
    });
  }
  if (relationsReplaced > 0) {
    nextProperties.push({
      key: 'notion.compatibility.relationToText',
      value:
        'Unverified or self-targeting database relations were replaced with text reference fields before approval.',
    });
  }
  return { ...action, properties: nextProperties };
}

function normalizeLinkedViewsAction(
  action: PlanAction,
  createById: Map<string, PlanAction>,
  warnings: string[],
  assumptions: string[],
): PlanAction {
  const linkedViews = parseJsonArray(propertyValue(action.properties, 'notion.page.linkedViews'));
  if (linkedViews.length === 0) return action;

  const existingSections = parseJsonArray(propertyValue(action.properties, 'notion.page.sections'))
    .map((entry) => (typeof entry === 'string' ? entry : undefined))
    .filter((entry): entry is string => Boolean(entry));
  const navigationLinks: Array<{ section: string; label: string; databaseActionId?: string }> = [];
  const sections = [...existingSections];

  for (const entry of linkedViews) {
    if (!isRecord(entry)) continue;
    const section = typeof entry.section === 'string' ? entry.section : 'Links';
    const view = typeof entry.view === 'string' ? entry.view : 'Database';
    const databaseActionId =
      typeof entry.databaseActionId === 'string' ? entry.databaseActionId : undefined;
    const databaseName = databaseActionId
      ? (createById.get(databaseActionId)?.target ?? databaseActionId)
      : 'Database';
    if (!sections.includes(section)) sections.push(section);
    navigationLinks.push({
      section,
      label: `${databaseName} · ${view}`,
      ...(databaseActionId ? { databaseActionId } : {}),
    });
  }

  warnings.push(
    `${action.id}: linked database views are unsupported on this Notion MCP path; replaced with page sections and navigation links.`,
  );
  assumptions.push(
    'Unsupported linked database views were replaced with useful page sections containing navigation links before approval.',
  );

  const properties = action.properties.filter(
    (property) =>
      property.key !== 'notion.page.linkedViews' &&
      property.key !== 'notion.page.sections' &&
      property.key !== 'notion.page.navigationLinks' &&
      property.key !== 'notion.compatibility.linkedViewsToNavigation',
  );
  if (sections.length > 0) {
    properties.push({ key: 'notion.page.sections', value: JSON.stringify(sections) });
  }
  properties.push({
    key: 'notion.page.navigationLinks',
    value: JSON.stringify(navigationLinks),
  });
  properties.push({
    key: 'notion.compatibility.linkedViewsToNavigation',
    value: 'Linked views were replaced with page sections and navigation links before approval.',
  });
  return { ...action, properties };
}

function owningDatabaseCreateId(
  action: PlanAction,
  createById: Map<string, PlanAction>,
): string | undefined {
  const sameTarget = [...createById.values()].find(
    (candidate) =>
      candidate.target === action.target &&
      normalizedObjectType(candidate.objectType) === 'database',
  );
  if (sameTarget) return sameTarget.id;
  return action.dependsOn.find((dependency) => {
    const candidate = createById.get(dependency);
    return candidate && normalizedObjectType(candidate.objectType) === 'database';
  });
}

function resolveVerifiedDataSourceId(
  actionId: string | undefined,
  createById: Map<string, PlanAction>,
  destination: ResolvedDestination,
): string | undefined {
  if (!actionId) return undefined;
  const created = createById.get(actionId);
  if (!created) return undefined;
  const known = propertyValue(created.properties, 'notion.dedupe.knownExternalId');
  if (known) return known;
  const existing = destination.existingObjects.find(
    (object) =>
      object.name === created.target &&
      (normalizedObjectType(object.type) === 'database' ||
        normalizedObjectType(object.type) === 'data_source'),
  );
  return dataSourceIdFor(existing);
}

function dataSourceIdFor(object: DiscoveredObject | undefined): string | undefined {
  if (!object) return undefined;
  if (object.identifier?.startsWith('collection://')) {
    return object.identifier.slice('collection://'.length) || object.id;
  }
  if (object.identifier && /^[0-9a-f-]{36}$/i.test(object.identifier)) return object.identifier;
  return object.id;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stamp create actions that match exact-title children under the destination as already-existing. */
export function markNotionCreateReuse(action: PlanAction): PlanAction {
  if (action.operation !== 'create') return action;
  if (!propertyValue(action.properties, 'notion.dedupe.knownExternalId')) return action;
  if (propertyValue(action.properties, 'notion.dedupe.skipReason')) return action;
  const properties = [...action.properties];
  setProperty(properties, 'notion.dedupe.skipReason', 'already-exists');
  return { ...action, properties };
}
