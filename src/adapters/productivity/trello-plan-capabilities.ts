import type { PlanAction, PlanProposal } from '../../domain/schemas.js';
import { normalizedObjectType, propertyValue, setProperty } from './exact-bindings.js';

/**
 * Normalize Trello plans to official MCP capabilities before preview/approval.
 * Labels are attach-only; create-label actions are dropped unless an exact ID already exists.
 */
export function normalizeTrelloPlanCapabilities(proposal: PlanProposal): PlanProposal {
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const removedIds = new Set<string>();
  const plannedActions: PlanAction[] = [];

  for (const action of proposal.plannedActions) {
    const kind = normalizedObjectType(action.objectType);
    if (action.operation === 'create' && kind === 'label') {
      const knownId = propertyValue(action.properties, 'trello.labelId');
      if (knownId) {
        const properties = [...action.properties];
        setProperty(properties, 'trello.dedupe.knownExternalId', knownId);
        // Attaching a label is a real write needing approval; not a no-op skip.
        plannedActions.push({
          ...action,
          operation: 'update',
          description: `Attach existing Trello label ${JSON.stringify(action.target)}.`,
          properties,
        });
        assumptions.push(
          `Trello label ${JSON.stringify(action.target)} is attached by exact ID; labels are never created.`,
        );
        continue;
      }
      removedIds.add(action.id);
      warnings.push(
        `Removed Trello label create for ${JSON.stringify(action.target)}; official MCP attaches existing labels only.`,
      );
      assumptions.push('Trello labels must already exist on the board; Aurous does not create them.');
      continue;
    }
    if (action.operation === 'create' && (kind === 'workspace' || kind === 'organization')) {
      removedIds.add(action.id);
      warnings.push(
        `Removed Trello workspace create for ${JSON.stringify(action.target)}; Aurous operates only in the authorized workspace.`,
      );
      continue;
    }
    plannedActions.push(action);
  }

  const cleaned = plannedActions.map((action) => ({
    ...action,
    dependsOn: action.dependsOn.filter((id) => !removedIds.has(id)),
    // Drop a trello.labelId that points at a removed label action; the reference is now dangling.
    properties: action.properties.filter(
      (property) => !(property.key === 'trello.labelId' && removedIds.has(property.value)),
    ),
  }));

  return {
    ...proposal,
    plannedActions: cleaned,
    assumptions: [...new Set([...proposal.assumptions, ...assumptions])],
    warnings: [...new Set([...proposal.warnings, ...warnings])],
  };
}
