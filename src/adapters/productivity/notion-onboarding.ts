import type {
  DestinationCandidate,
  DestinationDiscovery,
  ResolvedDestination,
} from '../../domain/destinations.js';
import type { ContextBundle, PlanAction, PlanProposal } from '../../domain/schemas.js';
import { propertyValue, setProperty } from './exact-bindings.js';

/** Planning-time sentinel: apply creates the root at the authenticated Notion workspace default. */
export const NOTION_WORKSPACE_SENTINEL = 'notion-workspace-default';

const DEMO_DESTINATION_NAMES = [/^\s*aurous\s+product\s+hq\s*$/i, /^\s*product\s+hq\s*$/i];

export function isNotionPersonalOnboarding(
  objective: string,
  contextText = '',
  hasSoftwareProject = false,
): boolean {
  const text = `${objective}\n${contextText}`;
  if (isPersonalLifeObjective(text)) return true;
  return !hasSoftwareProject;
}

export function isPersonalLifeObjective(text: string): boolean {
  return /life\s*os|life and work|personal (life|workspace|setup)|set up my life|\bceo\b|executive life|wedding|mba at|travel plan/i.test(
    text,
  );
}

export function deriveNotionRootName(objective: string, contextText = ''): string {
  const text = `${objective}\n${contextText}`;
  if (/executive life os/i.test(text)) return 'Executive Life OS';
  if (/life os/i.test(text)) return 'Life OS';
  if (/life and work|set up my life|\bceo\b|executive/i.test(text)) return 'Life OS';
  const heading = contextText.match(/^#\s+(.+)$/m);
  if (heading?.[1]?.trim()) return heading[1].trim().slice(0, 80);
  return 'Life OS';
}

export function contextTextFromBundle(context: ContextBundle): string {
  return context.documents.map((document) => document.content).join('\n');
}

export function isIgnoredNotionDestination(
  candidate: Pick<DestinationCandidate, 'name'> & { description?: string; sourceDetail?: string },
  objective: string,
): boolean {
  const blob = `${candidate.name}\n${candidate.description ?? ''}\n${candidate.sourceDetail ?? ''}`;
  if (/\b(deleted|archived|inaccessible|trashed)\b/i.test(blob)) return true;
  if (DEMO_DESTINATION_NAMES.some((pattern) => pattern.test(candidate.name))) {
    return !explicitlyNamesDestination(objective, candidate.name);
  }
  return false;
}

export function resolveNotionPersonalDestination(input: {
  discovery: DestinationDiscovery;
  objective: string;
  contextText?: string;
}): ResolvedDestination {
  const rootName = deriveNotionRootName(input.objective, input.contextText ?? '');
  const candidates = input.discovery.candidates.filter(
    (candidate) => !isIgnoredNotionDestination(candidate, input.objective),
  );

  const exact = candidates.filter(
    (candidate) => normalizeTitle(candidate.name) === normalizeTitle(rootName),
  );
  if (exact.length === 1) {
    return materializeDestination(exact[0]!, input.discovery, 'existing-match', rootName);
  }

  const relevantMatches = candidates.filter(
    (candidate) =>
      candidate.existingAurousMatch &&
      !isIgnoredNotionDestination(candidate, input.objective) &&
      titlesRelated(candidate.name, rootName),
  );
  if (relevantMatches.length === 1) {
    return materializeDestination(
      relevantMatches[0]!,
      input.discovery,
      'existing-match',
      relevantMatches[0]!.name,
    );
  }

  return {
    integration: 'notion',
    id: NOTION_WORKSPACE_SENTINEL,
    name: rootName,
    kind: 'page',
    source: 'context-root-create',
    sourceDetail:
      'No active relevant Notion root was found; Aurous will create one from the user context.',
    verifiedAt: input.discovery.inspectedAt,
    existingObjects: [],
    discoveryWarnings: [
      ...input.discovery.warnings,
      ...(input.discovery.candidates.length > candidates.length
        ? ['Ignored deleted, archived, or unrelated product demo Notion pages for this setup.']
        : []),
    ],
  };
}

/**
 * Ensure action-001 creates the personal root page for fresh setups.
 * Child actions keep a shared workspace sentinel parent ID and depend on the root action.
 */
export function ensureNotionPersonalRootPlan(
  proposal: PlanProposal,
  destination: ResolvedDestination,
): PlanProposal {
  if (destination.source !== 'context-root-create') return proposal;
  const rootName = destination.name;
  const existingRootIndex = proposal.plannedActions.findIndex(
    (action) =>
      action.operation === 'create' &&
      /page/i.test(action.objectType) &&
      normalizeTitle(action.target) === normalizeTitle(rootName),
  );

  let actions: PlanAction[];
  if (existingRootIndex >= 0) {
    const reordered = [...proposal.plannedActions];
    const [root] = reordered.splice(existingRootIndex, 1);
    actions = renumberSequential([root!, ...reordered]).map((action, index) =>
      index === 0 ? action : attachRootDependency(action),
    );
  } else {
    const shifted = shiftActionIds(proposal.plannedActions, 1);
    const root: PlanAction = {
      id: 'action-001',
      operation: 'create',
      objectType: 'notion.page',
      target: rootName,
      description: `Create the ${rootName} root page in Notion.`,
      properties: [
        { key: 'notion.parent.workspace', value: 'true' },
        {
          key: 'notion.page.purpose',
          value: 'Personal root workspace created automatically from the user context.',
        },
      ],
      dependsOn: [],
    };
    actions = [root, ...shifted.map(attachRootDependency)];
  }

  actions = actions.map((action, index) => {
    const properties = [...action.properties];
    setProperty(properties, 'notion.destination.parentPageId', NOTION_WORKSPACE_SENTINEL);
    setProperty(properties, 'notion.destination.name', rootName);
    if (index === 0) {
      setProperty(properties, 'notion.parent.workspace', 'true');
    } else {
      setProperty(properties, 'notion.destination.rootActionId', 'action-001');
      if (!action.dependsOn.includes('action-001')) {
        return {
          ...action,
          properties,
          dependsOn: ['action-001', ...action.dependsOn],
        };
      }
    }
    return { ...action, properties };
  });

  const structure = proposal.proposedWorkspaceStructure.some(
    (item) => normalizeTitle(item.name) === normalizeTitle(rootName),
  )
    ? proposal.proposedWorkspaceStructure
    : [
        {
          kind: 'page',
          name: rootName,
          purpose: 'Personal Notion root workspace.',
        },
        ...proposal.proposedWorkspaceStructure,
      ];

  return {
    ...proposal,
    proposedWorkspaceStructure: structure,
    plannedActions: actions,
    assumptions: [
      ...proposal.assumptions,
      `${rootName} is created automatically as the Notion root; no parent page selection is required.`,
    ],
  };
}

function materializeDestination(
  candidate: DestinationCandidate,
  discovery: DestinationDiscovery,
  source: 'existing-match',
  displayName: string,
): ResolvedDestination {
  return {
    integration: 'notion',
    id: candidate.id,
    name: displayName || candidate.name,
    kind: candidate.kind,
    ...(candidate.url ? { url: candidate.url } : {}),
    source,
    sourceDetail: 'Reused an active Notion root that matches the current request.',
    verifiedAt: discovery.inspectedAt,
    existingObjects: discovery.existingObjects.filter(
      (object) => object.destinationId === candidate.id || object.parentId === candidate.id,
    ),
    discoveryWarnings: discovery.warnings,
  };
}

function attachRootDependency(action: PlanAction): PlanAction {
  if (action.dependsOn.includes('action-001')) return action;
  return { ...action, dependsOn: ['action-001', ...action.dependsOn] };
}

function shiftActionIds(actions: PlanAction[], offset: number): PlanAction[] {
  if (offset === 0) return renumberSequential(actions);
  const map = new Map(
    actions.map((action) => {
      const number = Number(action.id.replace(/^action-/, ''));
      const next = `action-${String(number + offset).padStart(3, '0')}`;
      return [action.id, next] as const;
    }),
  );
  const remap = (id: string) => map.get(id) ?? id;
  return rewriteRelationActionIds(
    actions.map((action) => ({
      ...action,
      id: remap(action.id),
      dependsOn: action.dependsOn.map(remap),
    })),
    remap,
  );
}

function renumberSequential(actions: PlanAction[]): PlanAction[] {
  const map = new Map(
    actions.map((action, index) => [
      action.id,
      `action-${String(index + 1).padStart(3, '0')}`,
    ] as const),
  );
  const remap = (id: string) => map.get(id) ?? id;
  return rewriteRelationActionIds(
    actions.map((action) => ({
      ...action,
      id: remap(action.id),
      dependsOn: action.dependsOn.map(remap),
    })),
    remap,
  );
}

function rewriteRelationActionIds(
  actions: PlanAction[],
  remap: (id: string) => string,
): PlanAction[] {
  return actions.map((action) => {
    const raw = propertyValue(action.properties, 'notion.database.properties');
    if (!raw) return action;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return action;
      const rewritten: Record<string, unknown>[] = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const record = { ...(entry as Record<string, unknown>) };
        if (typeof record.targetDatabaseActionId === 'string') {
          record.targetDatabaseActionId = remap(record.targetDatabaseActionId);
        }
        rewritten.push(record);
      }
      const properties = action.properties.filter(
        (property) => property.key !== 'notion.database.properties',
      );
      properties.push({
        key: 'notion.database.properties',
        value: JSON.stringify(rewritten),
      });
      return { ...action, properties };
    } catch {
      return action;
    }
  });
}

function explicitlyNamesDestination(objective: string, name: string): boolean {
  const normalizedName = name.trim();
  if (normalizedName.length < 2) return false;
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:in|under|inside|within|use|using)\\s+(?:my\\s+|the\\s+)?${escaped}\\b`,
    'i',
  ).test(objective);
}

function normalizeTitle(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function titlesRelated(left: string, right: string): boolean {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  return a === b || a.includes(b) || b.includes(a);
}
