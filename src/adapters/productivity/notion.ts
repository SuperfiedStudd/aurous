import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';

export class NotionAdapter implements ProductivityAdapter {
  readonly name = 'notion' as const;

  planningInstructions(objective: string): string {
    return `Design a Notion-native workspace for this objective: ${objective}

Prefer a useful hierarchy of landing pages, project databases, task databases, statuses, typed properties, relations, rollups only when valuable, views, and linked project documentation. Every database property and status must be explicit in action properties. Avoid generic tables that ignore Notion's relations and views. Do not create anything during planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Notion MCP. Execute the approved actions in dependency order. Preserve the exact names and properties in the plan. Record each created page/database URL and ID when the MCP returns it. Do not discover or add extra scope. The approved plan contains ${plan.plannedActions.length} actions.`;
  }
}
