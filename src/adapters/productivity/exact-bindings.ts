import type { ResolvedDestination } from '../../domain/destinations.js';
import type { PlanAction, ToolName } from '../../domain/schemas.js';

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
  const unprefixed = normalized.replace(/^(?:airtable|trello)[_.]/, '');
  if (unprefixed === 'issue_label') return 'label';
  if (unprefixed === 'data_source') return 'database';
  if (unprefixed === 'records') return 'record';
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
