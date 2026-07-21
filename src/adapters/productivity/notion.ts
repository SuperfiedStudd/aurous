import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';
import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanProposal } from '../../domain/schemas.js';
import {
  exactBindingWarnings,
  normalizeRelationAction,
  normalizedObjectType,
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
import {
  markNotionCreateReuse,
  normalizeNotionPlanCapabilities,
} from './notion-plan-capabilities.js';
import { ensureNotionPersonalRootPlan } from './notion-onboarding.js';
import { attachNotionIcons } from './notion-icons.js';

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
    discoveryInstructions: `Use only the official Notion MCP and perform read-only calls. List or search accessible pages that can safely contain a project workspace. Prefer human-recognizable top-level pages and private workspace locations.

For personal life/work onboarding (Life OS, CEO life workspace, and similar), search for an exact active root matching the derived workspace name such as "Life OS" or "Executive Life OS". Do NOT prefer "Aurous Product HQ", "Product HQ", deleted pages, archived pages, or unrelated prior demo workspaces. Omit deleted/archived/inaccessible pages from candidates.

For software-project onboarding only, also search for an existing exact or likely project match, including "Aurous Product HQ", "Product HQ", and the supplied project name.

Inspect exact matching pages and relevant child pages/databases under the selected parent only.

IMPORTANT FOR IDEMPOTENT RETRIES: Under the selected parent page, list every child page and child database by exact title. Emit each as an existingObject with exact id, name, type (page or database), and parentId set to the selected parent page ID. Include data-source/collection UUIDs in identifier when the MCP returns them. This lets Aurous reuse exact-title objects from a partial prior run instead of creating duplicates. Never list children of unrelated demo pages.

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

When discovery lists an exact-title page or database under this parent, plan creates must target that exact name so Aurous can stamp notion.dedupe.knownExternalId and reuse it. Never create a second object with the same exact title under this parent. Never delete existing content.

RELATION UPDATES: For records that already exist in discovery, emit an update/link on objectType notion.database_record with notion.dedupe.knownExternalId (never notion.knownExternalId alone), notion.relation.sourceRecordId, and notion.relation.targetRecordIds as a JSON array of exact related record IDs. Choose the source record so its parent database owns a discovered relation-typed property (identifier="relation") whose linkedIds include the target record's parent database. When the objective names exact source and target record IDs that are schema-valid in that direction, preserve them; otherwise select the direction authorized by discovered schema. Set notion.relation.name only to that exact discovered property name; never invent a property name from a related database title and never create, rename, or repoint Notion properties to make a link possible. Prefer also binding notion.relation.propertyId when discovery supplied the property ID. Never authorize a mutation from a sentence that merely embeds IDs.

SAME-PLAN RELATIONS: Prefer text or URL reference fields on newly created databases instead of notion.database.properties relation DDL unless both source and target data-source IDs are already verified in discovery. Never emit accidental self-relations. Never emit dual inverseName relation pairs that can create unintended self-relations. Do not invent future IDs and do not write \${action.output} strings.

ICONS: Do not invent random icons. Aurous assigns deterministic notion.icon.emoji values from titles and purposes. Prefer leaving icon fields unset in agent proposals so the binder can stamp them.

Never emit a placeholder parent or ask for a page URL.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    const withRoot = ensureNotionPersonalRootPlan(proposal, destination);
    const capabilityNormalized = normalizeNotionPlanCapabilities(withRoot, destination);
    const boundActions = capabilityNormalized.plannedActions.map((action) => {
      const aliased = normalizeNotionKnownExternalIdAlias(action, destination);
      const normalized = normalizeRelationAction(aliased, 'notion');
      const sourceRecordId = propertyValue(
        normalized.properties,
        'notion.relation.sourceRecordId',
      );
      const kind = normalizedObjectType(normalized.objectType);
      const structural =
        (kind === 'page' || kind === 'database') &&
        !hasTypedNotionRelation(normalized) &&
        !kind.includes('record');
      const parentId =
        propertyValue(normalized.properties, 'notion.parent.dataSourceId') ??
        (sourceRecordId
          ? (destination.existingObjects.find((object) => object.id === sourceRecordId)
              ?.parentId ?? undefined)
          : undefined) ??
        (structural ? destination.id : undefined);
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
          property.key !== 'notion.knownExternalId' &&
          property.key !== 'notion.dedupe.skipReason',
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
        bound = markNotionCreateReuse(bound);
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
        bound = markNotionCreateReuse(bound);
      }

      bound = bindNotionRelationProperty(bound, destination, {
        actions: capabilityNormalized.plannedActions,
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
    });
    const withIcons = attachNotionIcons({
      ...capabilityNormalized,
      plannedActions: boundActions,
    });
    return {
      ...withIcons,
      assumptions: [
        ...withIcons.assumptions,
        `The exact verified destination is ${destination.name}; its internal ID is embedded in every action.`,
      ],
      warnings: [
        ...new Set([
          ...withIcons.warnings,
          ...exactBindingWarnings(destination, withIcons.plannedActions, 'notion'),
        ]),
      ],
    };
  }

  planningInstructions(objective: string): string {
    return `Design a Notion-native workspace for this objective: ${objective}

Prefer a useful hierarchy of landing pages, project databases, task databases, typed properties, views, and linked project documentation. Every database property must be explicit in action properties.

CAPABILITY LIMITS (official Notion MCP):
- Do not emit custom options on status properties. Use select with explicit options instead of status when custom workflow values are required.
- Do not emit number format "percent"; use an unformatted number.
- Do not emit notion.database.properties relation DDL unless both source and target data-source IDs are already verified in discovery and are distinct. Prefer text or URL reference fields for same-plan databases. Never emit accidental self-relations or dual inverseName pairs.
- Do not emit notion.page.linkedViews. Use page sections plus notion.page.navigationLinks to created databases instead.
- Do not invent random page/database icons. Leave icons unset unless the objective explicitly requires a specific emoji; Aurous stamps deterministic notion.icon.emoji values before preview.

When the objective asks to relate existing discovered records, emit an explicit notion.database_record relation action (update/link) using discovered relation-typed property names — never invent property names. For same-plan creates without verified data-source IDs, use text reference fields. Do not create anything during planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Notion MCP. Execute the approved actions in dependency order.

ROOT CREATION: When notion.parent.workspace is true on the root create action, create that page at the authenticated Notion workspace default location (or the MCP-supported equivalent). Do not ask the user for a parent page. When later actions include notion.destination.rootActionId, create those objects under the exact page ID returned by that root action — not under any other page.

Every action may include notion.destination.parentPageId. Treat the sentinel value "notion-workspace-default" as the planning-time workspace marker only; never fail because that sentinel is not a real Notion page ID. Resolve real parents from the root action result or from notion.dedupe.knownExternalId.

ICONS: When notion.icon.emoji is present and notion.icon.preserveExisting is not true, set the page or database icon through the official Notion MCP icon field (emoji character only). Never invent a different emoji. When notion.icon.preserveExisting is true, leave the existing icon unchanged and do not call an icon update. If the MCP cannot set an icon for that object type, continue the action successfully and record a compatibility note instead of failing the run.

IDEMPOTENT REUSE: For an action with notion.dedupe.knownExternalId, fetch and verify that exact object and its parent before writing. When notion.dedupe.skipReason is already-exists on a create, reuse that exact object and do not create a duplicate. When configuring a page or database that has notion.dedupe.knownExternalId, apply the approved schema/content updates to that exact object only. Never delete existing content. Never reuse by ambiguous name matches outside the approved root. Never reuse deleted or archived pages.

For relation updates, mutate only the exact source record from notion.dedupe.knownExternalId / notion.relation.sourceRecordId and set notion.relation.targetRecordIds on the approved notion.relation.name / notion.relation.propertyId relation property; if the relation is already satisfied, skip as a no-op. For actions with typed notion.relation JSON, resolve source/target record IDs only from that approved dependency's persisted exact create/reuse result (or from the exact recordId already bound). Never invent IDs and never interpret \${action.output} strings.

Preserve the exact names and properties in the approved plan (including Select-instead-of-Status and text reference fields). Do not reintroduce unsupported Status options, percent formats, linked views, or unverified relation DDL during apply. Record each created or reused page/database URL and ID when the MCP returns it. Do not discover or add extra scope. The approved plan contains ${plan.plannedActions.length} actions.`;
  }
}
