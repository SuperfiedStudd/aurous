import type {
  DestinationCandidate,
  DestinationDiscovery,
  DiscoveredObject,
  ResolvedDestination,
} from '../../domain/destinations.js';
import type { PlanAction, PlanProposal } from '../../domain/schemas.js';
import { AurousError } from '../../core/errors.js';
import { normalizedObjectType, setProperty } from './exact-bindings.js';
import { isPersonalLifeObjective } from './notion-onboarding.js';
import {
  deriveOperatingRootName,
  ensureRootCreateAction,
  isDeletedOrInaccessible,
  isDemoDestinationName,
  normalizeTitle,
  selectDeterministicCandidate,
  titlesRelated,
} from './onboarding-shared.js';

export function isTrelloPersonalOnboarding(
  objective: string,
  contextText = '',
  hasSoftwareProject = false,
): boolean {
  const text = `${objective}\n${contextText}`;
  if (isPersonalLifeObjective(text)) return true;
  return !hasSoftwareProject;
}

export function deriveTrelloBoardName(objective: string, contextText = ''): string {
  return deriveOperatingRootName(objective, contextText, 'Life OS');
}

export function isIgnoredTrelloDestination(
  candidate: Pick<DestinationCandidate, 'name'> & { description?: string; sourceDetail?: string },
  objective: string,
): boolean {
  if (isDeletedOrInaccessible(candidate)) return true;
  if (isDemoDestinationName(candidate.name, objective)) return true;
  return false;
}

export function isIgnoredTrelloBoard(
  object: Pick<DiscoveredObject, 'name' | 'type'> & { description?: string },
  objective: string,
): boolean {
  if (normalizedObjectType(object.type) !== 'board') return false;
  if (
    isDeletedOrInaccessible({
      name: object.name,
      ...(object.description ? { description: object.description } : {}),
    })
  ) {
    return true;
  }
  return isDemoDestinationName(object.name, objective);
}

export function resolveTrelloPersonalDestination(input: {
  discovery: DestinationDiscovery;
  objective: string;
  contextText?: string;
}): ResolvedDestination {
  const rootName = deriveTrelloBoardName(input.objective, input.contextText ?? '');
  const candidates = input.discovery.candidates.filter(
    (candidate) => !isIgnoredTrelloDestination(candidate, input.objective),
  );
  if (candidates.length === 0) {
    throw new AurousError({
      code: 'AUR-DEST-001',
      summary:
        'Aurous cannot access a Trello workspace yet; reconnect Trello MCP and authorize a workspace, then try again.',
      probableCause: 'No active writable Trello workspace was available for this setup.',
      nextAction:
        'Reconnect the official Trello MCP and authorize a writable workspace. Aurous never needs a workspace ID from you.',
      severity: 'recoverable',
    });
  }

  const workspace = selectDeterministicCandidate(
    candidates,
    input.objective,
    input.contextText ?? '',
    rootName,
  );
  const workspaceObjects = input.discovery.existingObjects.filter(
    (object) => object.destinationId === workspace.id,
  );
  const boards = workspaceObjects.filter(
    (object) =>
      normalizedObjectType(object.type) === 'board' &&
      !isIgnoredTrelloBoard(object, input.objective),
  );
  const exact = boards.filter((board) => normalizeTitle(board.name) === normalizeTitle(rootName));
  if (exact.length === 1) {
    return materializeTrelloDestination(
      workspace,
      input.discovery,
      'existing-match',
      exact[0]!,
      scopedTrelloObjects(workspaceObjects, exact[0]!),
      ignoredWarning(input.discovery.candidates.length, candidates.length, boards.length, workspaceObjects),
    );
  }

  const related = boards.filter((board) => titlesRelated(board.name, rootName));
  if (related.length === 1) {
    return materializeTrelloDestination(
      workspace,
      input.discovery,
      'existing-match',
      related[0]!,
      scopedTrelloObjects(workspaceObjects, related[0]!),
      [],
    );
  }

  return {
    integration: 'trello',
    id: workspace.id,
    name: workspace.name,
    kind: 'workspace',
    ...(workspace.url ? { url: workspace.url } : {}),
    source: 'context-root-create',
    sourceDetail:
      'Selected the authenticated Trello workspace and will create a context-appropriate board.',
    verifiedAt: input.discovery.inspectedAt,
    existingObjects: [],
    discoveryWarnings: [
      ...input.discovery.warnings,
      ...ignoredWarning(
        input.discovery.candidates.length,
        candidates.length,
        boards.length,
        workspaceObjects,
      ),
    ],
    operatingRootName: rootName,
  };
}

export function ensureTrelloPersonalRootPlan(
  proposal: PlanProposal,
  destination: ResolvedDestination,
): PlanProposal {
  if (destination.source !== 'context-root-create') return proposal;
  const rootName = destination.operatingRootName ?? deriveTrelloBoardName('', '');
  const ensured = ensureRootCreateAction({
    proposal,
    rootName,
    objectType: 'trello.board',
    kind: 'board',
    purpose: 'Operating Trello board created automatically from the user context.',
    rootProperties: [{ key: 'trello.board', value: rootName }],
    attachChild: attachTrelloRootDependency,
  });
  return {
    ...ensured,
    plannedActions: ensured.plannedActions.map((action, index) => {
      if (index === 0) return action;
      const properties = [...action.properties];
      setProperty(properties, 'trello.boardActionId', 'action-001');
      setProperty(properties, 'trello.board', rootName);
      return { ...action, properties };
    }),
  };
}

function attachTrelloRootDependency(action: PlanAction): PlanAction {
  const properties = [...action.properties];
  setProperty(properties, 'trello.boardActionId', 'action-001');
  if (action.dependsOn.includes('action-001')) return { ...action, properties };
  return { ...action, properties, dependsOn: ['action-001', ...action.dependsOn] };
}

function materializeTrelloDestination(
  workspace: DestinationCandidate,
  discovery: DestinationDiscovery,
  source: 'existing-match',
  board: DiscoveredObject,
  existingObjects: DiscoveredObject[],
  extraWarnings: string[],
): ResolvedDestination {
  return {
    integration: 'trello',
    id: workspace.id,
    name: workspace.name,
    kind: 'workspace',
    ...(workspace.url ? { url: workspace.url } : {}),
    source,
    sourceDetail: `Reused the active Trello board ${JSON.stringify(board.name)} in workspace ${JSON.stringify(workspace.name)}.`,
    verifiedAt: discovery.inspectedAt,
    existingObjects,
    discoveryWarnings: [...discovery.warnings, ...extraWarnings],
    operatingRootName: board.name,
  };
}

function scopedTrelloObjects(
  workspaceObjects: DiscoveredObject[],
  board: DiscoveredObject,
): DiscoveredObject[] {
  const childIds = new Set(
    workspaceObjects
      .filter((object) => object.parentId === board.id || object.id === board.id)
      .map((object) => object.id),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of workspaceObjects) {
      if (object.parentId && childIds.has(object.parentId) && !childIds.has(object.id)) {
        childIds.add(object.id);
        grew = true;
      }
    }
  }
  return workspaceObjects.filter((object) => childIds.has(object.id));
}

function ignoredWarning(
  discoveredCandidates: number,
  keptCandidates: number,
  keptBoards: number,
  workspaceObjects: DiscoveredObject[],
): string[] {
  const warnings: string[] = [];
  if (discoveredCandidates > keptCandidates) {
    warnings.push('Ignored deleted, archived, or unrelated Trello workspaces for this setup.');
  }
  const totalBoards = workspaceObjects.filter(
    (object) => normalizedObjectType(object.type) === 'board',
  ).length;
  if (totalBoards > keptBoards) {
    warnings.push('Ignored deleted, inaccessible, or unrelated Trello boards for this setup.');
  }
  return warnings;
}
