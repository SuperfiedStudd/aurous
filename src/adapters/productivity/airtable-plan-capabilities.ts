import type { PlanAction, PlanProposal } from '../../domain/schemas.js';
import { normalizedObjectType, propertyValue } from './exact-bindings.js';

const UNSUPPORTED = new Set(['interface', 'view', 'automation', 'form', 'sync']);

/**
 * Normalize Airtable plans to official MCP capabilities before preview/approval.
 */
export function normalizeAirtablePlanCapabilities(proposal: PlanProposal): PlanProposal {
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const removedIds = new Set<string>();
  const plannedActions: PlanAction[] = [];

  for (const action of proposal.plannedActions) {
    const kind = normalizedObjectType(action.objectType);
    if (action.operation === 'create' && UNSUPPORTED.has(kind)) {
      removedIds.add(action.id);
      warnings.push(
        `Removed unsupported Airtable ${kind} create for ${JSON.stringify(action.target)}; official MCP focuses on bases, tables, fields, and records.`,
      );
      assumptions.push(
        `Airtable ${kind} objects are omitted because the connected MCP cannot create them.`,
      );
      continue;
    }
    let next = action;
    if (propertyValue(action.properties, 'airtable.view.type')) {
      const properties = action.properties.filter(
        (property) => !property.key.startsWith('airtable.view.'),
      );
      warnings.push(
        `Dropped Airtable view configuration on ${JSON.stringify(action.target)}; views are not created through the official MCP path.`,
      );
      assumptions.push('Airtable views must be added manually after the base is created.');
      next = { ...action, properties };
    }
    plannedActions.push(next);
  }

  const cleaned = plannedActions.map((action) => ({
    ...action,
    dependsOn: action.dependsOn.filter((id) => !removedIds.has(id)),
  }));

  return {
    ...proposal,
    plannedActions: cleaned,
    assumptions: [...new Set([...proposal.assumptions, ...assumptions])],
    warnings: [...new Set([...proposal.warnings, ...warnings])],
  };
}
