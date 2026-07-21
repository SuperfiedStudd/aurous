import type { AurousPlan, PlanProposal } from '../../domain/schemas.js';
import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import {
  exactBindingWarnings,
  normalizeRelationAction,
  parseRelatedIdList,
  propertyValue,
  relationAlreadySatisfied,
  resolveExactObject,
  stampAlreadySatisfiedRelation,
  stampExactExternalId,
} from './exact-bindings.js';
import {
  airtableRelationProperty,
  hasTypedAirtableRelation,
  parseAirtableRelation,
} from './airtable-relations.js';
import { ensureAirtablePersonalRootPlan } from './airtable-onboarding.js';
import { normalizeAirtablePlanCapabilities } from './airtable-plan-capabilities.js';
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
    discoveryInstructions: `Use only the official Airtable MCP and perform read-only calls. List accessible writable workspaces, then bases in each workspace. Omit deleted, archived, inaccessible, or read-only workspaces from candidates.

For personal life/work onboarding, prefer the authenticated default workspace and search for an exact base matching the derived name such as "Life OS". Do NOT prefer unrelated product-demo bases such as "Aurous Build Week HQ" or "Aurous Product HQ" unless the user explicitly names them. For software-project onboarding, also search for an exact existing base relevant to the supplied project and objective.

Inspect relevant bases, tables, fields, records, and interfaces when exposed. Return workspace candidates with exact workspace IDs. Put inspected bases, tables, fields, and records in existingObjects with exact IDs and parentId relationships. A base object's destinationId must be its workspace ID; table, field, and record objects must retain the workspace ID as destinationId and their exact base/table parent in parentId. Mark existingAurousMatch only when an inspected base supports it. Never create, update, delete, or configure anything. Surface duplicate or similar-name risks in warnings.`,
  } as const;

  rankDestinationCandidates(candidates: DestinationCandidate[]): DestinationCandidate[] {
    return [...candidates].sort((a, b) => {
      if (a.existingAurousMatch !== b.existingAurousMatch) return a.existingAurousMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  destinationPlanningInstructions(destination: ResolvedDestination): string {
    return `The exact approved Airtable workspace is ${JSON.stringify(destination.id)} (${destination.name}). Put airtable.workspaceId=${JSON.stringify(destination.id)} and airtable.workspace=${JSON.stringify(destination.name)} on every action. Existing bases, tables, fields, and records may be reused only by exact IDs in the discovery snapshot.

RELATION UPDATES: To link records that already exist in discovery, emit an update or link on the exact source record with airtable.baseId, airtable.tableId, airtable.recordId, airtable.fieldId, and airtable.linkedRecordIds as a JSON array of exact related record IDs. Never authorize a relation from prose that only embeds IDs. Never invent a synthetic record whose name describes the relationship. Never use \${action-….output…} placeholders.

SAME-PLAN RELATIONS: When the source or related records are created earlier in this same immutable plan, do not invent future IDs and do not write \${action.output} strings. Authorize a typed dependency on property airtable.relation as JSON: {"source":{"baseActionId":"action-00N"},"targets":[{"baseActionId":"action-00M"}]} (recordActionId is equivalent). Exact discovered records use {"recordId":"rec…"}. Put every referenced create/reuse action in dependsOn. Planning authorizes only the typed dependency; apply resolves exact record IDs from that approved action's persisted result.

NEW-BASE CONTRACT: The official Airtable create_base tool requires at least one table. For a new base, action-001 must be the single base create action and must include airtable.base.initialTables as a JSON array of the exact requested initial tables. Each entry must contain a name and its primary field definition. For the requested launch setup, include exactly Workstreams, Tasks, and Integrations in that one property—no separate create-table actions for those bootstrap tables. Dependent field and record actions must use airtable.baseActionId=action-001 plus airtable.bootstrapTableName set to one exact table name from airtable.base.initialTables. The executor resolves returned table IDs from action-001; never fabricate one. A linked-record field must use airtable.linkedBootstrapTableName for another exact bootstrap table or an inspected exact table ID. For an existing base use airtable.baseId; use airtable.tableId / airtable.tableActionId only for inspected or separately created tables. Names are display-only and never authorize reuse.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    const withRoot = ensureAirtablePersonalRootPlan(proposal, destination);
    const capabilityNormalized = normalizeAirtablePlanCapabilities(withRoot);
    return {
      ...capabilityNormalized,
      plannedActions: capabilityNormalized.plannedActions.map((action) => {
        const normalized = normalizeRelationAction(action, 'airtable');
        const parentId = propertyValue(normalized.properties, 'airtable.tableId');
        const existing = resolveExactObject(destination, normalized, 'airtable', parentId);
        const properties = normalized.properties.filter(
          (property) =>
            ![
              'airtable.workspaceId',
              'airtable.workspace',
              'airtable.dedupe.knownExternalId',
              'airtable.dedupe.knownUrl',
            ].includes(property.key),
        );
        let bound = {
          ...normalized,
          properties: [
            ...properties,
            { key: 'airtable.workspaceId', value: destination.id },
            { key: 'airtable.workspace', value: destination.name },
          ],
        };
        if (existing) bound = stampExactExternalId(bound, existing, 'airtable');
        const linkedIds = parseRelatedIdList(
          propertyValue(bound.properties, 'airtable.linkedRecordIds'),
        );
        if (existing && relationAlreadySatisfied(existing, linkedIds, 'airtable')) {
          bound = stampAlreadySatisfiedRelation(bound, 'airtable');
        } else if (hasTypedAirtableRelation(bound)) {
          const binding = parseAirtableRelation(airtableRelationProperty(bound));
          if (
            binding?.source.recordId &&
            binding.targets.every((target) => Boolean(target.recordId))
          ) {
            const source =
              existing ??
              destination.existingObjects.find((object) => object.id === binding.source.recordId);
            const typedLinkedIds = binding.targets.map((target) => target.recordId!);
            if (source && relationAlreadySatisfied(source, typedLinkedIds, 'airtable')) {
              bound = stampExactExternalId(bound, source, 'airtable');
              bound = stampAlreadySatisfiedRelation(bound, 'airtable');
            }
          }
        }
        return bound;
      }),
      assumptions: [
        ...capabilityNormalized.assumptions,
        `The exact verified Airtable workspace is ${destination.name}; its internal ID is embedded in every action.`,
        ...(destination.operatingRootName
          ? [
              `Operating base ${destination.operatingRootName} is selected automatically from the current request.`,
            ]
          : []),
      ],
      warnings: [
        ...new Set([
          ...capabilityNormalized.warnings,
          ...exactBindingWarnings(destination, capabilityNormalized.plannedActions, 'airtable'),
        ]),
      ],
    };
  }

  planningInstructions(objective: string): string {
    return `Design a small, useful Airtable workspace for this objective: ${objective}

Use native Airtable base, table, field, record, and linked-record semantics. Keep the requested quantity and negative constraints binding. Do not add customary objects. When creating a new base, use one immutable base action with its required bootstrap tables and primary fields in airtable.base.initialTables, then explicit dependent actions for non-primary fields and records. Same-plan record links must use typed airtable.relation dependencies, never \${action.output} placeholders.

ALREADY-SATISFIED RERUNS: plannedActions must never be an empty array. When discovery already contains the exact requested records and relation by inspected IDs, emit explicit update/link skip actions with airtable.dedupe.knownExternalId and airtable.dedupe.skipReason set to already-exists or already-satisfied-relation. A complete no-op is represented by those skip actions, not by plannedActions:[]. Do not create anything while planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Airtable MCP. The approved plan contains ${plan.plannedActions.length} actions.

AIRTABLE EXECUTION CONTRACT:
- Inspect and operate only in the exact workspace from airtable.workspaceId. Do not substitute a workspace.
- Before every action with airtable.dedupe.knownExternalId, fetch the exact ID and verify type, name, and approved parent. A compatible match is skipped; failure never falls back to a name search or creation.
- For relation/link updates with exact airtable.recordId and airtable.linkedRecordIds, mutate only that target and set the exact linked-record field. If the relationship is already present, skip as a no-op reuse.
- For actions with airtable.relation, resolve source and target record IDs only from that approved dependency's persisted exact create/reuse result (or from the exact recordId already bound). Validate each resolved ID before writing the relation. Missing, failed, skipped-without-ID, mismatched, or wrong-type dependencies must stop safely before any relation write. Never invent IDs and never interpret \${action.output} strings.
- For unguarded create targets, do narrow exact-name inventories within the approved workspace/base/table. If one compatible exact match exists, skip it; if several exist, report an ambiguity and do not write.
- Create a new base only through its approved create action and capture its returned exact base ID, URL, and bootstrap table IDs. The official create_base operation requires its non-empty tables payload to come from airtable.base.initialTables; it must contain no table beyond the approved action. Dependent actions resolve airtable.baseActionId and airtable.bootstrapTableName from that create result. Never invent or prefill an ID.
- Likewise resolve table and field action references only from exact approved action results. Create non-primary fields before records, and use exact returned table IDs for linked-record relationships when supported by the official MCP schema.
- Do not create interfaces, views, automations, extra fields, or extra records unless an explicit approved action requires one. Never delete.
- Report every created or reused object with its exact returned ID and URL when available. State unsupported capabilities in compatibilityNotes; never silently degrade.`;
  }
}
