import type { PlanAction, PlanProposal } from '../../domain/schemas.js';
import { normalizedObjectType } from './exact-bindings.js';

const UNSUPPORTED = new Set(['cycle', 'document', 'comment', 'initiative']);

/**
 * Drop Linear MCP-unsupported create targets before preview/approval.
 */
export function normalizeLinearPlanCapabilities(proposal: PlanProposal): PlanProposal {
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const removedIds = new Set<string>();
  const plannedActions: PlanAction[] = [];

  for (const action of proposal.plannedActions) {
    const kind = normalizedObjectType(action.objectType);
    if (action.operation === 'create' && UNSUPPORTED.has(kind)) {
      removedIds.add(action.id);
      warnings.push(
        `Removed unsupported Linear ${kind} create for ${JSON.stringify(action.target)}; official MCP supports projects, issues, labels, and milestones.`,
      );
      assumptions.push(
        `Linear ${kind} objects are omitted because the connected MCP cannot create them reliably.`,
      );
      continue;
    }
    plannedActions.push(action);
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
