import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';

export class LinearAdapter implements ProductivityAdapter {
  readonly name = 'linear' as const;

  planningInstructions(objective: string): string {
    return `Design a Linear-native workspace for this objective: ${objective}

Prefer a focused project with a clear description, milestones or cycles only when appropriate, actionable issues, labels, priorities, and explicit relationships. Use Linear's project and issue semantics rather than imitating a generic database. Every issue should have a purposeful title, description, priority, labels, and project/milestone relationship in action properties. Do not create anything during planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Linear MCP. Execute the approved actions in dependency order. Preserve exact issue, project, milestone/cycle, label, and priority fields. Record every created object URL and ID returned by the MCP. Do not discover or add extra scope. The approved plan contains ${plan.plannedActions.length} actions.`;
  }
}
