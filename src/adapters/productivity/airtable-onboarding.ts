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

const DEFAULT_BOOTSTRAP_TABLES = [
  {
    name: 'Goals',
    primaryField: { name: 'Name', type: 'singleLineText' },
  },
  {
    name: 'Projects',
    primaryField: { name: 'Name', type: 'singleLineText' },
  },
  {
    name: 'Tasks',
    primaryField: { name: 'Name', type: 'singleLineText' },
  },
];

export function isAirtablePersonalOnboarding(
  objective: string,
  contextText = '',
  hasSoftwareProject = false,
): boolean {
  const text = `${objective}\n${contextText}`;
  if (isPersonalLifeObjective(text)) return true;
  return !hasSoftwareProject;
}

export function deriveAirtableBaseName(objective: string, contextText = ''): string {
  return deriveOperatingRootName(objective, contextText, 'Life OS');
}

export function isIgnoredAirtableDestination(
  candidate: Pick<DestinationCandidate, 'name'> & { description?: string; sourceDetail?: string },
  objective: string,
): boolean {
  if (isDeletedOrInaccessible(candidate)) return true;
  if (isDemoDestinationName(candidate.name, objective)) return true;
  return false;
}

export function isIgnoredAirtableBase(
  object: Pick<DiscoveredObject, 'name' | 'type'> & { description?: string },
  objective: string,
): boolean {
  if (normalizedObjectType(object.type) !== 'base') return false;
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

export function resolveAirtablePersonalDestination(input: {
  discovery: DestinationDiscovery;
  objective: string;
  contextText?: string;
}): ResolvedDestination {
  const rootName = deriveAirtableBaseName(input.objective, input.contextText ?? '');
  const candidates = input.discovery.candidates.filter(
    (candidate) => !isIgnoredAirtableDestination(candidate, input.objective),
  );
  if (candidates.length === 0) {
    throw new AurousError({
      code: 'AUR-DEST-001',
      summary:
        'Aurous cannot access a writable Airtable workspace yet; reconnect Airtable or ask a workspace admin for access, then try again.',
      probableCause: 'No active writable Airtable workspace was available for this setup.',
      nextAction:
        'Reconnect Airtable and ensure the connected account can access a writable workspace. Aurous never needs a workspace ID from you.',
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
  const bases = workspaceObjects.filter(
    (object) =>
      normalizedObjectType(object.type) === 'base' &&
      !isIgnoredAirtableBase(object, input.objective),
  );
  const exact = bases.filter((base) => normalizeTitle(base.name) === normalizeTitle(rootName));
  if (exact.length === 1) {
    return materializeAirtableDestination(
      workspace,
      input.discovery,
      'existing-match',
      exact[0]!,
      scopedAirtableObjects(workspaceObjects, exact[0]!),
      ignoredWarning(input.discovery.candidates.length, candidates.length, bases.length, workspaceObjects),
    );
  }

  const related = bases.filter((base) => titlesRelated(base.name, rootName));
  if (related.length === 1) {
    return materializeAirtableDestination(
      workspace,
      input.discovery,
      'existing-match',
      related[0]!,
      scopedAirtableObjects(workspaceObjects, related[0]!),
      [],
    );
  }

  return {
    integration: 'airtable',
    id: workspace.id,
    name: workspace.name,
    kind: 'workspace',
    ...(workspace.url ? { url: workspace.url } : {}),
    source: 'context-root-create',
    sourceDetail:
      'Selected the authenticated Airtable workspace and will create a context-appropriate base.',
    verifiedAt: input.discovery.inspectedAt,
    existingObjects: [],
    discoveryWarnings: [
      ...input.discovery.warnings,
      ...ignoredWarning(
        input.discovery.candidates.length,
        candidates.length,
        bases.length,
        workspaceObjects,
      ),
    ],
    operatingRootName: rootName,
  };
}

export function ensureAirtablePersonalRootPlan(
  proposal: PlanProposal,
  destination: ResolvedDestination,
): PlanProposal {
  if (destination.source !== 'context-root-create') return proposal;
  const rootName = destination.operatingRootName ?? deriveAirtableBaseName('', '');
  const ensured = ensureRootCreateAction({
    proposal,
    rootName,
    objectType: 'airtable.base',
    kind: 'base',
    purpose: 'Operating Airtable base created automatically from the user context.',
    rootProperties: [
      {
        key: 'airtable.base.initialTables',
        value: JSON.stringify(DEFAULT_BOOTSTRAP_TABLES),
      },
    ],
    attachChild: attachAirtableRootDependency,
  });
  return {
    ...ensured,
    plannedActions: ensured.plannedActions.map((action, index) => {
      if (index === 0) {
        const properties = [...action.properties];
        if (!properties.some((property) => property.key === 'airtable.base.initialTables')) {
          properties.push({
            key: 'airtable.base.initialTables',
            value: JSON.stringify(DEFAULT_BOOTSTRAP_TABLES),
          });
        }
        return { ...action, properties };
      }
      const properties = [...action.properties];
      setProperty(properties, 'airtable.baseActionId', 'action-001');
      return { ...action, properties };
    }),
  };
}

function attachAirtableRootDependency(action: PlanAction): PlanAction {
  const properties = [...action.properties];
  setProperty(properties, 'airtable.baseActionId', 'action-001');
  if (action.dependsOn.includes('action-001')) return { ...action, properties };
  return { ...action, properties, dependsOn: ['action-001', ...action.dependsOn] };
}

function materializeAirtableDestination(
  workspace: DestinationCandidate,
  discovery: DestinationDiscovery,
  source: 'existing-match',
  base: DiscoveredObject,
  existingObjects: DiscoveredObject[],
  extraWarnings: string[],
): ResolvedDestination {
  return {
    integration: 'airtable',
    id: workspace.id,
    name: workspace.name,
    kind: 'workspace',
    ...(workspace.url ? { url: workspace.url } : {}),
    source,
    sourceDetail: `Reused the active Airtable base ${JSON.stringify(base.name)} in workspace ${JSON.stringify(workspace.name)}.`,
    verifiedAt: discovery.inspectedAt,
    existingObjects,
    discoveryWarnings: [...discovery.warnings, ...extraWarnings],
    operatingRootName: base.name,
  };
}

function scopedAirtableObjects(
  workspaceObjects: DiscoveredObject[],
  base: DiscoveredObject,
): DiscoveredObject[] {
  const childIds = new Set(
    workspaceObjects
      .filter((object) => object.parentId === base.id || object.id === base.id)
      .map((object) => object.id),
  );
  // Include nested field/record objects whose parent is a table under the base.
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
  keptBases: number,
  workspaceObjects: DiscoveredObject[],
): string[] {
  const warnings: string[] = [];
  if (discoveredCandidates > keptCandidates) {
    warnings.push('Ignored deleted, archived, or unrelated Airtable workspaces for this setup.');
  }
  const totalBases = workspaceObjects.filter(
    (object) => normalizedObjectType(object.type) === 'base',
  ).length;
  if (totalBases > keptBases) {
    warnings.push('Ignored deleted, inaccessible, or unrelated Airtable bases for this setup.');
  }
  return warnings;
}
