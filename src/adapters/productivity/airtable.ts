import type { AurousPlan, PlanProposal } from '../../domain/schemas.js';
import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import { canonicalExactObject, exactBindingWarnings } from './exact-bindings.js';
import type { ProductivityAdapter } from './types.js';

/** Airtable is intentionally expressed through the same generic destination contract as Notion and Linear. */
export class AirtableAdapter implements ProductivityAdapter {
  readonly name = 'airtable' as const;
  readonly destination = {
    kind: 'workspace',
    exactIdProperty: 'airtable.workspaceId',
    persistenceKey: 'destinations.airtable',
    friendlyLabel: 'Airtable workspace',
    pluralLabel: 'Airtable workspaces',
    question: 'Which Airtable workspace should Aurous use?',
    unavailableMessage:
      'Aurous cannot access a writable Airtable workspace yet; reconnect Airtable or ask a workspace admin for access, then try again.',
    recoveryMessage:
      'Reconnect Airtable and ensure the connected account can access a writable workspace. Aurous never needs a workspace ID from you.',
    discoveryInstructions: `Use only the official Airtable MCP and perform read-only calls. List accessible workspaces, then bases in each workspace. Search for an exact existing base relevant to the supplied project and objective, including an exact requested base name when present. Inspect relevant bases, tables, fields, records, and interfaces when exposed. Return workspace candidates with exact workspace IDs. Put inspected bases, tables, fields, and records in existingObjects with exact IDs and parentId relationships. A base object's destinationId must be its workspace ID; table, field, and record objects must retain the workspace ID as destinationId and their exact base/table parent in parentId. Mark existingAurousMatch only when an inspected base supports it. Never create, update, delete, or configure anything. Surface duplicate or similar-name risks in warnings.`,
  } as const;

  rankDestinationCandidates(candidates: DestinationCandidate[]): DestinationCandidate[] {
    return [...candidates].sort((a, b) => {
      if (a.existingAurousMatch !== b.existingAurousMatch) return a.existingAurousMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  destinationPlanningInstructions(destination: ResolvedDestination): string {
    return `The exact approved Airtable workspace is ${JSON.stringify(destination.id)} (${destination.name}). Put airtable.workspaceId=${JSON.stringify(destination.id)} and airtable.workspace=${JSON.stringify(destination.name)} on every action. Existing bases, tables, fields, and records may be reused only by exact IDs in the discovery snapshot.

NEW-BASE CONTRACT: The official Airtable create_base tool requires at least one table. For a new base, action-001 must be the single base create action and must include airtable.base.initialTables as a JSON array of the exact requested initial tables. Each entry must contain a name and its primary field definition. For the requested launch setup, include exactly Workstreams, Tasks, and Integrations in that one property—no separate create-table actions for those bootstrap tables. Dependent field and record actions must use airtable.baseActionId=action-001 plus airtable.bootstrapTableName set to one exact table name from airtable.base.initialTables. The executor resolves returned table IDs from action-001; never fabricate one. A linked-record field must use airtable.linkedBootstrapTableName for another exact bootstrap table or an inspected exact table ID. For an existing base use airtable.baseId; use airtable.tableId / airtable.tableActionId only for inspected or separately created tables. Names are display-only and never authorize reuse.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    return {
      ...proposal,
      plannedActions: proposal.plannedActions.map((action) => {
        const existing = canonicalExactObject(destination, action, 'airtable');
        const properties = action.properties.filter(
          (property) =>
            ![
              'airtable.workspaceId',
              'airtable.workspace',
              'airtable.dedupe.knownExternalId',
              'airtable.dedupe.knownUrl',
            ].includes(property.key),
        );
        properties.push(
          { key: 'airtable.workspaceId', value: destination.id },
          { key: 'airtable.workspace', value: destination.name },
        );
        if (existing) {
          properties.push({ key: 'airtable.dedupe.knownExternalId', value: existing.id });
          if (existing.url)
            properties.push({ key: 'airtable.dedupe.knownUrl', value: existing.url });
        }
        return {
          ...action,
          description: existing
            ? `Reuse or reconcile the exact verified existing ${action.objectType} ${JSON.stringify(existing.name)}. ${action.description}`
            : action.description,
          properties,
        };
      }),
      assumptions: [
        ...proposal.assumptions,
        `The exact verified Airtable workspace is ${destination.name}; its internal ID is embedded in every action.`,
      ],
      warnings: [
        ...new Set([
          ...proposal.warnings,
          ...exactBindingWarnings(destination, proposal.plannedActions, 'airtable'),
        ]),
      ],
    };
  }

  planningInstructions(objective: string): string {
    return `Design a small, useful Airtable workspace for this objective: ${objective}

Use native Airtable base, table, field, record, and linked-record semantics. Keep the requested quantity and negative constraints binding. Do not add customary objects. When creating a new base, use one immutable base action with its required bootstrap tables and primary fields in airtable.base.initialTables, then explicit dependent actions for non-primary fields and records. Do not create anything while planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Airtable MCP. The approved plan contains ${plan.plannedActions.length} actions.

AIRTABLE EXECUTION CONTRACT:
- Inspect and operate only in the exact workspace from airtable.workspaceId. Do not substitute a workspace.
- Before every action with airtable.dedupe.knownExternalId, fetch the exact ID and verify type, name, and approved parent. A compatible match is skipped; failure never falls back to a name search or creation.
- For unguarded create targets, do narrow exact-name inventories within the approved workspace/base/table. If one compatible exact match exists, skip it; if several exist, report an ambiguity and do not write.
- Create a new base only through its approved create action and capture its returned exact base ID, URL, and bootstrap table IDs. The official create_base operation requires its non-empty tables payload to come from airtable.base.initialTables; it must contain no table beyond the approved action. Dependent actions resolve airtable.baseActionId and airtable.bootstrapTableName from that create result. Never invent or prefill an ID.
- Likewise resolve table and field action references only from exact approved action results. Create non-primary fields before records, and use exact returned table IDs for linked-record relationships when supported by the official MCP schema.
- Do not create interfaces, views, automations, extra fields, or extra records unless an explicit approved action requires one. Never delete.
- Report every created or reused object with its exact returned ID and URL when available. State unsupported capabilities in compatibilityNotes; never silently degrade.`;
  }
}
