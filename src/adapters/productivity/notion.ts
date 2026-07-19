import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';
import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import type { PlanProposal } from '../../domain/schemas.js';

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
    discoveryInstructions: `Use only the official Notion MCP and perform read-only calls. List or search accessible pages that can safely contain a project workspace. Prefer human-recognizable top-level pages and private workspace locations. Search for an existing exact or likely project match, including "Aurous Product HQ", "Product HQ", and the supplied project name. Inspect exact matching pages and relevant child pages/databases. Never create, update, move, archive, or delete anything.`,
  } as const;

  rankDestinationCandidates(candidates: DestinationCandidate[]): DestinationCandidate[] {
    return [...candidates].sort((a, b) => {
      if (a.existingAurousMatch !== b.existingAurousMatch) return a.existingAurousMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  destinationPlanningInstructions(destination: ResolvedDestination): string {
    return `The exact approved Notion parent is ${JSON.stringify(destination.id)} (${destination.name}). Put ${this.destination.exactIdProperty}=${JSON.stringify(destination.id)} on every action. Existing objects listed in the discovery snapshot may be reused only by their supplied exact IDs. Never emit a placeholder parent or ask for a page URL.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    return bindExactDestination(proposal, destination, this.destination.exactIdProperty, 'notion');
  }

  planningInstructions(objective: string): string {
    return `Design a Notion-native workspace for this objective: ${objective}

Prefer a useful hierarchy of landing pages, project databases, task databases, statuses, typed properties, relations, rollups only when valuable, views, and linked project documentation. Every database property and status must be explicit in action properties. Avoid generic tables that ignore Notion's relations and views. Do not create anything during planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Notion MCP. Execute the approved actions in dependency order. Every action is scoped by notion.destination.parentPageId; never substitute a different parent. For an action with notion.dedupe.knownExternalId, fetch and verify that exact object and its parent before deciding to reuse, update, or skip it. Never reuse by name alone. Preserve the exact names and properties in the plan. Record each created or reused page/database URL and ID when the MCP returns it. Do not discover or add extra scope. The approved plan contains ${plan.plannedActions.length} actions.`;
  }
}

function bindExactDestination(
  proposal: PlanProposal,
  destination: ResolvedDestination,
  propertyKey: string,
  namespace: string,
): PlanProposal {
  return {
    ...proposal,
    plannedActions: proposal.plannedActions.map((action) => {
      const existing = destination.existingObjects.find(
        (object) => object.name === action.target && object.type === action.objectType,
      );
      const properties = action.properties.filter(
        (property) =>
          property.key !== propertyKey &&
          property.key !== 'notion.destination.name' &&
          property.key !== `${namespace}.dedupe.knownExternalId` &&
          property.key !== `${namespace}.dedupe.knownUrl`,
      );
      properties.push({ key: propertyKey, value: destination.id });
      properties.push({ key: 'notion.destination.name', value: destination.name });
      if (existing) {
        properties.push({ key: `${namespace}.dedupe.knownExternalId`, value: existing.id });
        if (existing.url)
          properties.push({ key: `${namespace}.dedupe.knownUrl`, value: existing.url });
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
      `The exact verified destination is ${destination.name}; its internal ID is embedded in every action.`,
    ],
  };
}
