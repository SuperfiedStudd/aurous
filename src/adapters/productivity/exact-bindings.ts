import type { ResolvedDestination } from '../../domain/destinations.js';
import type { PlanAction, ToolName } from '../../domain/schemas.js';

export function exactObjectMatches(
  destination: ResolvedDestination,
  action: Pick<PlanAction, 'objectType' | 'target'>,
  tool: ToolName = destination.integration,
) {
  return destination.existingObjects
    .filter(
      (object) =>
        object.name === action.target &&
        exactObjectTypeMatches(tool, object.type, action.objectType),
    )
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function canonicalExactObject(
  destination: ResolvedDestination,
  action: Pick<PlanAction, 'objectType' | 'target'>,
  tool: ToolName = destination.integration,
) {
  return exactObjectMatches(destination, action, tool)[0];
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
  if (normalized === 'issue_label') return 'label';
  if (normalized === 'data_source') return 'database';
  return normalized;
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
