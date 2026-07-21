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

export function isLinearPersonalOnboarding(
  objective: string,
  contextText = '',
  hasSoftwareProject = false,
): boolean {
  const text = `${objective}\n${contextText}`;
  if (isPersonalLifeObjective(text)) return true;
  return !hasSoftwareProject;
}

export function deriveLinearProjectName(objective: string, contextText = ''): string {
  return deriveOperatingRootName(objective, contextText, 'Life OS');
}

export function isIgnoredLinearDestination(
  candidate: Pick<DestinationCandidate, 'name'> & { description?: string; sourceDetail?: string },
  objective: string,
): boolean {
  if (isDeletedOrInaccessible(candidate)) return true;
  if (isDemoDestinationName(candidate.name, objective)) return true;
  return false;
}

export function resolveLinearPersonalDestination(input: {
  discovery: DestinationDiscovery;
  objective: string;
  contextText?: string;
}): ResolvedDestination {
  const rootName = deriveLinearProjectName(input.objective, input.contextText ?? '');
  const candidates = input.discovery.candidates.filter(
    (candidate) => !isIgnoredLinearDestination(candidate, input.objective),
  );
  if (candidates.length === 0) {
    throw new AurousError({
      code: 'AUR-DEST-001',
      summary:
        'Aurous cannot access a Linear team yet; ask a workspace admin to grant the connected account access, then try again.',
      probableCause: 'No active writable Linear team was available for this setup.',
      nextAction: 'Ask a Linear workspace admin to give the connected account access to a team.',
      severity: 'recoverable',
    });
  }

  const team = selectDeterministicCandidate(
    candidates,
    input.objective,
    input.contextText ?? '',
    rootName,
  );
  const teamObjects = input.discovery.existingObjects.filter(
    (object) => object.destinationId === team.id,
  );
  const projects = teamObjects.filter((object) => normalizedObjectType(object.type) === 'project');
  const exact = projects.filter(
    (project) =>
      normalizeTitle(project.name) === normalizeTitle(rootName) &&
      !isDemoDestinationName(project.name, input.objective),
  );
  if (exact.length === 1) {
    return materializeLinearDestination(
      team,
      input.discovery,
      'existing-match',
      exact[0]!,
      scopedLinearObjects(teamObjects, exact[0]!),
      [
        ...(input.discovery.candidates.length > candidates.length
          ? ['Ignored deleted, archived, or unrelated Linear teams for this setup.']
          : []),
      ],
    );
  }

  const related = projects.filter(
    (project) =>
      !isDemoDestinationName(project.name, input.objective) &&
      titlesRelated(project.name, rootName),
  );
  if (related.length === 1) {
    return materializeLinearDestination(
      team,
      input.discovery,
      'existing-match',
      related[0]!,
      scopedLinearObjects(teamObjects, related[0]!),
      [],
    );
  }

  return {
    integration: 'linear',
    id: team.id,
    name: team.name,
    kind: 'team',
    ...(team.url ? { url: team.url } : {}),
    source: 'context-root-create',
    sourceDetail:
      'Selected an active writable Linear team and will create a context-appropriate operating project.',
    verifiedAt: input.discovery.inspectedAt,
    existingObjects: [],
    discoveryWarnings: [
      ...input.discovery.warnings,
      ...(input.discovery.candidates.length > candidates.length
        ? ['Ignored deleted, archived, or unrelated Linear teams for this setup.']
        : []),
    ],
    operatingRootName: rootName,
  };
}

export function ensureLinearPersonalRootPlan(
  proposal: PlanProposal,
  destination: ResolvedDestination,
): PlanProposal {
  if (destination.source !== 'context-root-create') return proposal;
  const rootName = destination.operatingRootName ?? deriveLinearProjectName('', '');
  const ensured = ensureRootCreateAction({
    proposal,
    rootName,
    objectType: 'project',
    kind: 'project',
    purpose: 'Operating Linear project created automatically from the user context.',
    rootProperties: [
      {
        key: 'description',
        value: `Operating project for ${rootName}.`,
      },
    ],
    attachChild: (action) => attachLinearRootDependency(action, rootName),
  });
  return {
    ...ensured,
    plannedActions: ensured.plannedActions.map((action, index) => {
      if (index === 0) return action;
      const properties = [...action.properties];
      setProperty(properties, 'linear.project', rootName);
      setProperty(properties, 'linear.projectActionId', 'action-001');
      return { ...action, properties };
    }),
  };
}

function attachLinearRootDependency(action: PlanAction, rootName: string): PlanAction {
  const properties = [...action.properties];
  setProperty(properties, 'linear.project', rootName);
  setProperty(properties, 'linear.projectActionId', 'action-001');
  if (action.dependsOn.includes('action-001')) return { ...action, properties };
  return { ...action, properties, dependsOn: ['action-001', ...action.dependsOn] };
}

function materializeLinearDestination(
  team: DestinationCandidate,
  discovery: DestinationDiscovery,
  source: 'existing-match',
  project: DiscoveredObject,
  existingObjects: DiscoveredObject[],
  extraWarnings: string[],
): ResolvedDestination {
  return {
    integration: 'linear',
    id: team.id,
    name: team.name,
    kind: 'team',
    ...(team.url ? { url: team.url } : {}),
    source,
    sourceDetail: `Reused the active Linear project ${JSON.stringify(project.name)} in team ${JSON.stringify(team.name)}.`,
    verifiedAt: discovery.inspectedAt,
    existingObjects,
    discoveryWarnings: [...discovery.warnings, ...extraWarnings],
    operatingRootName: project.name,
  };
}

function scopedLinearObjects(
  teamObjects: DiscoveredObject[],
  project: DiscoveredObject,
): DiscoveredObject[] {
  return teamObjects.filter(
    (object) =>
      object.id === project.id ||
      object.parentId === project.id ||
      (normalizedObjectType(object.type) === 'label' && object.destinationId === project.destinationId),
  );
}
