import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';

export class LinearAdapter implements ProductivityAdapter {
  readonly name = 'linear' as const;

  planningInstructions(objective: string): string {
    return `Design a Linear-native workspace for this objective: ${objective}

Prefer a focused project with a clear description, milestones or cycles only when appropriate, actionable issues, labels, priorities, and explicit relationships. Use Linear's project and issue semantics rather than imitating a generic database. Every issue should have a purposeful title, description, priority, labels, and project/milestone relationship in action properties. Do not create anything during planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Linear MCP. The approved plan contains ${plan.plannedActions.length} actions.

LINEAR DEMO CONTRACT:
- Resolve only the approved team from linear.team. Before writes, inspect that team's statuses and resolve the assignee token. Never select a different team.
- Execute actions in dependency order. Map linear.* properties directly to the official MCP fields for project, issue label, milestone, and issue creation.
- If an action has linear.dedupe.knownExternalId, fetch that exact ID first and verify its type, title/name, approved team, and approved project where applicable. A compatible exact-ID match must be skipped and is authoritative even if same-title duplicates exist. Exclude that action from all name inventories. If exact-ID verification fails, fail the action and do not fall back to name lookup or creation.
- Label exact-ID verification uses the MCP capability that actually exists: call list_issue_labels once for the approved team with limit 250 and no name filter, locate each known label by its exact ID, then verify its exact name. This is exact-ID verification, not name fallback. If the known label ID is absent or its name differs, fail that action and never create a replacement.
- For approved targets without a known external ID, perform narrowly scoped exact-name lookup using the approved team/project. Do not browse unrelated objects.
- For issue actions without linear.dedupe.knownExternalId, deduplication is a mandatory single inventory step: call list_issues once for the approved team and project with limit 250 and no query, assignee, state, label, or ordering filters. Compare only the unguarded approved issue targets against the returned titles case-sensitively. Never use list_issues.query for deduplication. If every approved issue action has a known external ID, do not call list_issues. If one or more exact-title matches exist for an unguarded action, do not create it; skip a single compatible match and fail visibly on ambiguous or incompatible matches.
- If exactly one compatible target already exists, make no write, include the action ID in completedActionIds, and add a skippedActions entry with its exact ID and URL. If matches are ambiguous or incompatible, fail the action visibly.
- createdObjects contains only objects written by this run. Preserve the exact ID and URL returned by Linear for every created object; do not invent either value.
- Preserve project relationships, milestone relationships, descriptions, numeric priorities, states, assignee, and labels exactly when supported.
- The connected MCP supports create_issue_label, save_project, save_milestone, and save_issue. Do not substitute documents, cycles, or comments.
- If a requested field is unsupported or a workspace convention is unavailable, omit or adjust that field only when the core object can still be useful, and describe the exact adjustment in compatibilityNotes. Never silently degrade.
- Do not update, archive, delete, or create anything outside the approved actions.`;
  }
}
