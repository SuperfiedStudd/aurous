import type { AurousPlan, PlanAction, PlanProposal } from '../../domain/schemas.js';
import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import {
  exactBindingWarnings,
  exactObjectMatches,
  exactObjectTypeMatches,
  normalizedObjectType,
} from './exact-bindings.js';
import type { ProductivityAdapter } from './types.js';

/** Trello uses the shared destination contract; parent-scoped IDs keep same-named cards in different lists distinct. */
export class TrelloAdapter implements ProductivityAdapter {
  readonly name = 'trello' as const;
  readonly destination = {
    kind: 'workspace',
    exactIdProperty: 'trello.workspaceId',
    persistenceKey: 'destinations.trello',
    friendlyLabel: 'Trello workspace',
    pluralLabel: 'Trello workspaces',
    question: 'Which Trello workspace should Aurous use?',
    unavailableMessage:
      'Aurous cannot access a Trello workspace yet; reconnect Trello MCP and authorize a workspace, then try again.',
    recoveryMessage:
      'Reconnect the official Trello MCP and authorize a writable workspace. Aurous never needs a workspace ID from you.',
    discoveryInstructions: `Use only the official Trello MCP and perform read-only calls. Prefer trelloReadWorkspace, trelloReadMember, trelloReadBoard, trelloReadList, trelloReadCard, trelloReadChecklist, and trelloSearch. Discover the authorized workspace and preserve its exact workspace ID and friendly name. Search and inspect boards, lists, cards, checklists, and board labels relevant to the project and objective. Put inspected boards, lists, cards, checklists, and labels in existingObjects with exact IDs, URLs when available, and parentId relationships (board→workspace, list→board, card→list, checklist→card, label→board). Mark existingAurousMatch only when an inspected board supports it. Never create, update, move, archive, or delete anything. Surface duplicate or similar-name risks in warnings. Do not invent label IDs.`,
  } as const;

  rankDestinationCandidates(candidates: DestinationCandidate[]): DestinationCandidate[] {
    return [...candidates].sort((a, b) => {
      if (a.existingAurousMatch !== b.existingAurousMatch) return a.existingAurousMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  destinationPlanningInstructions(destination: ResolvedDestination): string {
    return `The exact approved Trello workspace is ${JSON.stringify(destination.id)} (${destination.name}). Put trello.workspaceId=${JSON.stringify(destination.id)} and trello.workspace=${JSON.stringify(destination.name)} on every action. Existing boards, lists, cards, checklists, and labels may be reused only by exact IDs in the discovery snapshot.

TRELLO DEPENDENCY CONTRACT:
- Do not create a Trello workspace. Operate only in the authorized discovered workspace.
- Create a board with an explicit create action. Dependent lists must use trello.boardActionId=<board-action-id> and dependOn that action, or trello.boardId for an inspected exact board.
- Dependent cards must use trello.listActionId=<list-action-id> (or trello.listId for an inspected list) plus the board reference, and dependOn the list action. A card title alone is not globally unique; the same title in two lists must stay under its exact list parent.
- Dependent checklists must use trello.cardActionId=<card-action-id> (or trello.cardId) and dependOn the card action.
- Attach an existing label only with trello.labelId set to an exact discovered label ID. Never create labels. Never archive or delete.
- Names are display-only and never authorize reuse. Never fabricate future Trello IDs or leave unresolved placeholders in the saved plan.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    const boundActions = proposal.plannedActions.map((action) => {
      const parentId = resolveTrelloParentId(action, destination, proposal.plannedActions);
      const matches = exactObjectMatches(destination, action, 'trello', parentId);
      const existing = matches.length === 1 ? matches[0] : undefined;
      const properties = action.properties.filter(
        (property) =>
          ![
            'trello.workspaceId',
            'trello.workspace',
            'trello.dedupe.knownExternalId',
            'trello.dedupe.knownUrl',
          ].includes(property.key),
      );
      properties.push(
        { key: 'trello.workspaceId', value: destination.id },
        { key: 'trello.workspace', value: destination.name },
      );
      if (existing) {
        properties.push({ key: 'trello.dedupe.knownExternalId', value: existing.id });
        if (existing.url) properties.push({ key: 'trello.dedupe.knownUrl', value: existing.url });
      }
      bindTrelloRelationshipIds(properties, destination, action);
      return {
        ...action,
        description: existing
          ? `Reuse or reconcile the exact verified existing ${action.objectType} ${JSON.stringify(existing.name)}. ${action.description}`
          : action.description,
        properties,
      };
    });

    return {
      ...proposal,
      plannedActions: boundActions,
      assumptions: [
        ...proposal.assumptions,
        `The exact verified Trello workspace is ${destination.name}; its internal ID is embedded in every action.`,
      ],
      warnings: [
        ...new Set([
          ...proposal.warnings,
          ...exactBindingWarnings(destination, boundActions, 'trello'),
          ...parentAmbiguityWarnings(destination, boundActions),
        ]),
      ],
    };
  }

  planningInstructions(objective: string): string {
    return `Design a small, useful Trello board for this objective: ${objective}

Use native Trello board, list, card, and checklist semantics. Keep the requested quantity and negative constraints binding. Do not add customary boards, lists, cards, labels, or checklists. Represent create order with immutable dependsOn edges: board → lists → cards → checklists. Attach existing labels only when an exact discovered label ID is available. Do not create labels. Do not archive or delete. Do not create anything while planning. When existing inspected state already satisfies the request, plan exact-ID reuse or skips instead of duplicate creates.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Trello MCP (trelloRead* for verification and trelloWriteBoard, trelloWriteList, trelloWriteCard, trelloWriteChecklist for approved writes). The approved plan contains ${plan.plannedActions.length} actions.

TRELLO EXECUTION CONTRACT:
- Inspect and operate only in the exact workspace from trello.workspaceId. Do not substitute a workspace.
- Before every action with trello.dedupe.knownExternalId, fetch the exact ID and verify type, name, and approved parent. A compatible match is skipped; failure never falls back to a name search or creation.
- For unguarded create targets, do narrow exact-name inventories under the exact approved parent (workspace→board, board→list, list→card, card→checklist). If one compatible exact match exists, skip it; if several exist, report an ambiguity and do not write.
- Execute in dependency order. Resolve trello.boardActionId, trello.listActionId, and trello.cardActionId only from exact approved create results. Never invent or prefill an ID.
- Create boards with trelloWriteBoard, lists with trelloWriteList, cards with trelloWriteCard, and checklists with trelloWriteChecklist. Card updates use trelloWriteCard against an exact card ID. Attach existing labels only via trello.labelId on an approved card action.
- Do not create labels. Do not archive, delete, move, or create anything outside the approved actions.
- Report every created or reused object with its exact returned ID and URL when available. State unsupported capabilities in compatibilityNotes; never silently degrade.`;
  }
}

function resolveTrelloParentId(
  action: PlanAction,
  destination: ResolvedDestination,
  actions: PlanAction[],
): string | undefined {
  const kind = normalizedObjectType(action.objectType);
  if (kind === 'board' || kind === 'workspace') return destination.id;

  const exactParent =
    propertyValue(action.properties, 'trello.listId') ??
    propertyValue(action.properties, 'trello.cardId') ??
    propertyValue(action.properties, 'trello.boardId');
  if (kind === 'list') {
    return (
      propertyValue(action.properties, 'trello.boardId') ??
      resolveActionTargetId(
        propertyValue(action.properties, 'trello.boardActionId'),
        actions,
        destination,
        'board',
      ) ??
      findNamedParentId(destination, propertyValue(action.properties, 'trello.board'), 'board')
    );
  }
  if (kind === 'card') {
    return (
      propertyValue(action.properties, 'trello.listId') ??
      resolveActionTargetId(
        propertyValue(action.properties, 'trello.listActionId'),
        actions,
        destination,
        'list',
      ) ??
      findNamedParentId(destination, propertyValue(action.properties, 'trello.list'), 'list')
    );
  }
  if (kind === 'checklist') {
    return (
      propertyValue(action.properties, 'trello.cardId') ??
      resolveActionTargetId(
        propertyValue(action.properties, 'trello.cardActionId'),
        actions,
        destination,
        'card',
      ) ??
      findNamedParentId(destination, propertyValue(action.properties, 'trello.card'), 'card')
    );
  }
  if (kind === 'label') {
    return (
      propertyValue(action.properties, 'trello.boardId') ??
      resolveActionTargetId(
        propertyValue(action.properties, 'trello.boardActionId'),
        actions,
        destination,
        'board',
      ) ??
      findNamedParentId(destination, propertyValue(action.properties, 'trello.board'), 'board') ??
      exactParent
    );
  }
  return exactParent;
}

function resolveActionTargetId(
  actionId: string | undefined,
  actions: PlanAction[],
  destination: ResolvedDestination,
  type: string,
): string | undefined {
  if (!actionId) return undefined;
  const dependency = actions.find((candidate) => candidate.id === actionId);
  if (!dependency || !exactObjectTypeMatches('trello', dependency.objectType, type))
    return undefined;
  const known = dependency.properties.find(
    (property) => property.key === 'trello.dedupe.knownExternalId',
  )?.value;
  if (known) return known;
  const matches = exactObjectMatches(destination, dependency, 'trello');
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function findNamedParentId(
  destination: ResolvedDestination,
  name: string | undefined,
  type: string,
): string | undefined {
  if (!name) return undefined;
  const matches = destination.existingObjects.filter(
    (object) => object.name === name && exactObjectTypeMatches('trello', object.type, type),
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function bindTrelloRelationshipIds(
  properties: PlanAction['properties'],
  destination: ResolvedDestination,
  action: PlanAction,
): void {
  const kind = normalizedObjectType(action.objectType);
  if (kind === 'list' || kind === 'label') {
    bindSingleId(properties, destination, ['trello.board'], 'board', 'trello.boardId');
  }
  if (kind === 'card') {
    bindSingleId(properties, destination, ['trello.list'], 'list', 'trello.listId');
    bindSingleId(properties, destination, ['trello.board'], 'board', 'trello.boardId');
  }
  if (kind === 'checklist') {
    bindSingleId(properties, destination, ['trello.card'], 'card', 'trello.cardId');
  }
  const labelName = propertyValue(properties, 'trello.label');
  if (labelName && !propertyValue(properties, 'trello.labelId')) {
    const matches = destination.existingObjects.filter(
      (object) =>
        object.name === labelName && exactObjectTypeMatches('trello', object.type, 'label'),
    );
    if (matches.length === 1 && matches[0]) {
      setProperty(properties, 'trello.labelId', matches[0].id);
    }
  }
}

function bindSingleId(
  properties: PlanAction['properties'],
  destination: ResolvedDestination,
  nameKeys: string[],
  type: string,
  idKey: string,
): void {
  if (propertyValue(properties, idKey)) return;
  const name = propertyValue(properties, nameKeys);
  if (!name) return;
  const matches = destination.existingObjects.filter(
    (object) => object.name === name && exactObjectTypeMatches('trello', object.type, type),
  );
  if (matches.length === 1 && matches[0]) setProperty(properties, idKey, matches[0].id);
}

function parentAmbiguityWarnings(
  destination: ResolvedDestination,
  actions: PlanAction[],
): string[] {
  const warnings: string[] = [];
  for (const action of actions) {
    const parentId = resolveTrelloParentId(action, destination, actions);
    const unscoped = exactObjectMatches(destination, action, 'trello');
    if (unscoped.length <= 1) continue;
    if (parentId === undefined) {
      warnings.push(
        `Ambiguous ${action.objectType} ${JSON.stringify(action.target)}: ${unscoped.length} inspected objects share that name under different parents. Provide an exact parent list/board/card before reuse.`,
      );
      continue;
    }
    const scoped = exactObjectMatches(destination, action, 'trello', parentId);
    if (scoped.length === 0) {
      warnings.push(
        `Ambiguous ${action.objectType} ${JSON.stringify(action.target)}: ${unscoped.length} inspected objects share that name under different parents. Provide an exact parent list/board/card before reuse.`,
      );
    }
  }
  return warnings;
}

function propertyValue(
  properties: PlanAction['properties'] | { key: string; value: string }[],
  keys: string | string[],
): string | undefined {
  const wanted = Array.isArray(keys) ? keys : [keys];
  return properties.find((property) => wanted.includes(property.key))?.value;
}

function setProperty(properties: PlanAction['properties'], key: string, value: string): void {
  const existing = properties.find((property) => property.key === key);
  if (existing) existing.value = value;
  else properties.push({ key, value });
}
