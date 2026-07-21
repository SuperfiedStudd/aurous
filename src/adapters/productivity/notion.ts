import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';
import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanProposal } from '../../domain/schemas.js';
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
import { normalizeNotionKnownExternalIdAlias } from './notion-identity.js';
import {
  hasTypedNotionRelation,
  notionRelationProperty,
  parseNotionRelation,
} from './notion-relations.js';
import { bindNotionRelationProperty } from './notion-relation-properties.js';

export class NotionAdapter implements ProductivityAdapter {
  readonly name = 'notion' as const;
  readonly destination = {
    kind: 'page',
    exactIdProperty: 'notion.destination.parentPageId',
    persistenceKey: 'destinations.notion',
    friendlyLabel: 'Notion location',
    pluralLabel: 'Notion locations',
    question: 'Where should Aurous build this workspace?',
    unavailableMessage:
      'Aurous cannot access a suitable Notion page yet; share or create one page for Aurous, then try again.',
    recoveryMessage:
      'Share or create one Notion page for Aurous, then ask Aurous to inspect Notion again.',
    discoveryInstructions: `Use only the official Notion MCP and perform read-only calls. List or search accessible pages that can safely contain a project workspace. Prefer human-recognizable top-level pages and private workspace locations. Search for an existing exact or likely project match, including "Aurous Product HQ", "Product HQ", and the supplied project name. Inspect exact matching pages and relevant child pages/databases.

For every inspected database that may participate in relations, fetch its schema/properties. Emit each relation-typed property as an existingObject with:
- type "notion.property" (or "notion.relation_property")
- identifier "relation" (the Notion property type; never text/select/status)
- parentId set to the exact owning database ID
- linkedIds set to the exact related database page ID(s) and/or data-source/collection UUID(s) that property can target (include both when MCP returns both forms)
- id set to the exact property ID when the MCP returns one
Never invent property names. Never create, update, move, archive, or delete anything.`,
  } as const;

  rankDestinationCandidates(candidates: DestinationCandidate[]): DestinationCandidate[] {
    return [...candidates].sort((a, b) => {
      if (a.existingAurousMatch !== b.existingAurousMatch) return a.existingAurousMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  destinationPlanningInstructions(destination: ResolvedDestination): string {
    return `The exact approved Notion parent is ${JSON.stringify(destination.id)} (${destination.name}). Put ${this.destination.exactIdProperty}=${JSON.stringify(destination.id)} on every action. Existing objects listed in the discovery snapshot may be reused only by their supplied exact IDs.

RELATION UPDATES: For records that already exist in discovery, emit an update/link on objectType notion.database_record with notion.dedupe.knownExternalId (never notion.knownExternalId alone), notion.relation.sourceRecordId, and notion.relation.targetRecordIds as a JSON array of exact related record IDs. Choose the source record so its parent database owns a discovered relation-typed property (identifier="relation") whose linkedIds include the target record's parent database. When the objective names exact source and target record IDs that are schema-valid in that direction, preserve them; otherwise select the direction authorized by discovered schema. Set notion.relation.name only to that exact discovered property name; never invent a property name from a related database title and never create, rename, or repoint Notion properties to make a link possible. Prefer also binding notion.relation.propertyId when discovery supplied the property ID. Never authorize a mutation from a sentence that merely embeds IDs.

SAME-PLAN RELATIONS: When the source or related records are created earlier in this same immutable plan, do not invent future IDs and do not write \${action.output} strings. Authorize a typed dependency on property notion.relation as JSON: {"source":{"recordActionId":"action-00N"},"targets":[{"recordActionId":"action-00M"}]} (baseActionId is equivalent). Include "name" only when it is an exact discovered relation property name. Exact discovered records use {"recordId":"<uuid>"}. Put every referenced create/reuse action in dependsOn. Planning authorizes only the typed dependency; apply resolves exact record IDs from that approved action's persisted result.

Never emit a placeholder parent or ask for a page URL.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    return {
      ...proposal,
      plannedActions: proposal.plannedActions.map((action) => {
        const aliased = normalizeNotionKnownExternalIdAlias(action, destination);
        const normalized = normalizeRelationAction(aliased, 'notion');
        const sourceRecordId = propertyValue(
          normalized.properties,
          'notion.relation.sourceRecordId',
        );
        const parentId =
          propertyValue(normalized.properties, 'notion.parent.dataSourceId') ??
          (sourceRecordId
            ? (destination.existingObjects.find((object) => object.id === sourceRecordId)
                ?.parentId ?? undefined)
            : undefined);
        const existing = resolveExactObject(
          destination,
          {
            ...normalized,
            // Relation source IDs authorize database_record updates against inspected pages.
            objectType:
              normalized.objectType.includes('relation') || hasTypedNotionRelation(normalized)
                ? 'notion.database_record'
                : normalized.objectType,
          },
          'notion',
          parentId,
        );
        const priorKnown = propertyValue(normalized.properties, 'notion.dedupe.knownExternalId');
        const priorIdentitySource = propertyValue(
          normalized.properties,
          'notion.dedupe.identitySource',
        );
        const properties = normalized.properties.filter(
          (property) =>
            property.key !== this.destination.exactIdProperty &&
            property.key !== 'notion.destination.name' &&
            property.key !== 'notion.dedupe.knownExternalId' &&
            property.key !== 'notion.dedupe.knownUrl' &&
            property.key !== 'notion.knownExternalId',
        );
        properties.push({ key: this.destination.exactIdProperty, value: destination.id });
        properties.push({ key: 'notion.destination.name', value: destination.name });
        let bound = { ...normalized, properties };
        if (existing) {
          bound = stampExactExternalId(bound, existing, 'notion');
          if (priorIdentitySource) {
            bound = {
              ...bound,
              properties: [
                ...bound.properties.filter(
                  (property) => property.key !== 'notion.dedupe.identitySource',
                ),
                { key: 'notion.dedupe.identitySource', value: priorIdentitySource },
              ],
            };
          }
        } else if (priorKnown) {
          // Preserve prior-run / alias-normalized exact IDs when discovery has not yet
          // re-listed the object; AUR-PLAN-010 still requires identitySource or inspection.
          bound = {
            ...bound,
            properties: [
              ...bound.properties,
              { key: 'notion.dedupe.knownExternalId', value: priorKnown },
              ...(priorIdentitySource
                ? [{ key: 'notion.dedupe.identitySource', value: priorIdentitySource }]
                : []),
            ],
          };
        }

        bound = bindNotionRelationProperty(bound, destination, {
          actions: proposal.plannedActions,
        });

        const relatedIds = parseRelatedIdList(
          propertyValue(bound.properties, 'notion.relation.targetRecordIds') ??
            propertyValue(bound.properties, 'notion.relation.targetRecordId'),
        );
        if (existing && relatedIds.length > 0 && relationAlreadySatisfied(existing, relatedIds)) {
          bound = stampAlreadySatisfiedRelation(bound, 'notion');
        } else if (hasTypedNotionRelation(bound)) {
          const binding = parseNotionRelation(notionRelationProperty(bound));
          if (
            binding?.source.recordId &&
            binding.targets.every((target) => Boolean(target.recordId))
          ) {
            const source =
              existing ??
              destination.existingObjects.find((object) => object.id === binding.source.recordId);
            const typedLinkedIds = binding.targets.map((target) => target.recordId!);
            if (source && relationAlreadySatisfied(source, typedLinkedIds)) {
              bound = stampExactExternalId(bound, source, 'notion');
              bound = stampAlreadySatisfiedRelation(bound, 'notion');
            }
          }
        }
        return bound;
      }),
      assumptions: [
        ...proposal.assumptions,
        `The exact verified destination is ${destination.name}; its internal ID is embedded in every action.`,
      ],
      warnings: [
        ...new Set([
          ...proposal.warnings,
          ...exactBindingWarnings(destination, proposal.plannedActions, 'notion'),
        ]),
      ],
    };
  }

  planningInstructions(objective: string): string {
    return `Design a Notion-native workspace for this objective: ${objective}

Prefer a useful hierarchy of landing pages, project databases, task databases, statuses, typed properties, relations, rollups only when valuable, views, and linked project documentation. Every database property and status must be explicit in action properties. Avoid generic tables that ignore Notion's relations and views.

When the objective asks to relate records, always emit an explicit notion.database_record relation action (update/link) — never defer the relation to a warning. For same-plan creates, authorize the relation with typed notion.relation recordActionId dependencies; for discovered records, bind notion.dedupe.knownExternalId plus notion.relation.sourceRecordId and notion.relation.targetRecordIds. Use only discovered relation-typed property names for notion.relation.name. Do not create anything during planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Notion MCP. Execute the approved actions in dependency order. Every action is scoped by notion.destination.parentPageId; never substitute a different parent. For an action with notion.dedupe.knownExternalId, fetch and verify that exact object and its parent before deciding to reuse, update, or skip it. Never reuse by name alone. For relation updates, mutate only the exact source record from notion.dedupe.knownExternalId / notion.relation.sourceRecordId and set notion.relation.targetRecordIds on the approved notion.relation.name / notion.relation.propertyId relation property; if the relation is already satisfied, skip as a no-op. For actions with typed notion.relation JSON, resolve source/target record IDs only from that approved dependency's persisted exact create/reuse result (or from the exact recordId already bound). Never invent IDs and never interpret \${action.output} strings. Preserve the exact names and properties in the plan. Record each created or reused page/database URL and ID when the MCP returns it. Do not discover or add extra scope. The approved plan contains ${plan.plannedActions.length} actions.`;
  }
}
