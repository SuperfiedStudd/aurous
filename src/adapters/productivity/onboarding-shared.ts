import type { PlanAction, PlanProposal } from '../../domain/schemas.js';
import { propertyValue } from './exact-bindings.js';

export const DEMO_DESTINATION_NAMES = [
  /^\s*aurous\s+product\s+hq\s*$/i,
  /^\s*product\s+hq\s*$/i,
  /^\s*aurous\s+build\s+week(?:\s+hq)?\s*$/i,
  /^\s*aurous\s+launch\s+hq\s*$/i,
  /^\s*aurous\s+project\s*$/i,
];

export function normalizeTitle(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

export function titlesRelated(left: string, right: string): boolean {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  return a === b || a.includes(b) || b.includes(a);
}

export function explicitlyNamesDestination(objective: string, name: string): boolean {
  const normalizedName = name.trim();
  if (normalizedName.length < 2) return false;
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:in|under|inside|within|use|using)\\s+(?:my\\s+|the\\s+)?${escaped}\\b`,
    'i',
  ).test(objective);
}

export function isDeletedOrInaccessible(
  candidate: Pick<{ name: string; description?: string; sourceDetail?: string }, 'name'> & {
    description?: string;
    sourceDetail?: string;
  },
): boolean {
  const blob = `${candidate.name}\n${candidate.description ?? ''}\n${candidate.sourceDetail ?? ''}`;
  return /\b(deleted|archived|inaccessible|trashed|read-?only|no write)\b/i.test(blob);
}

export function isDemoDestinationName(name: string, objective: string): boolean {
  if (!DEMO_DESTINATION_NAMES.some((pattern) => pattern.test(name))) return false;
  return !explicitlyNamesDestination(objective, name);
}

export function deriveOperatingRootName(objective: string, contextText = '', fallback = 'Life OS'): string {
  const text = `${objective}\n${contextText}`;
  if (/executive life os/i.test(text)) return 'Executive Life OS';
  if (/life os/i.test(text)) return 'Life OS';
  if (/life and work|set up my life|\bceo\b|executive/i.test(text)) return 'Life OS';
  if (/travel/i.test(text)) return 'Travel OS';
  if (/wedding/i.test(text)) return 'Wedding OS';
  const heading = contextText.match(/^#\s+(.+)$/m);
  if (heading?.[1]?.trim()) return heading[1].trim().slice(0, 80);
  const named = objective.match(
    /\b(?:set up|create|build)\s+(?:my\s+|a\s+|an\s+)?([A-Za-z0-9][\w\s-]{1,60}?)\s+(?:in|on|for)\s+(?:Linear|Airtable|Trello|Notion)\b/i,
  );
  if (named?.[1]?.trim()) return named[1].trim();
  return fallback;
}

export function selectDeterministicCandidate<T extends { name: string; existingAurousMatch?: boolean }>(
  candidates: T[],
  objective: string,
  contextText: string,
  preferredRootName?: string,
): T {
  if (candidates.length === 1) return candidates[0]!;
  const text = `${objective}\n${contextText}`;
  if (preferredRootName) {
    const related = candidates.filter((candidate) => titlesRelated(candidate.name, preferredRootName));
    if (related.length === 1) return related[0]!;
  }
  const named = candidates.filter((candidate) => containsFriendlyName(text, candidate.name));
  if (named.length === 1) return named[0]!;
  const matched = candidates.filter((candidate) => candidate.existingAurousMatch);
  if (matched.length === 1) return matched[0]!;
  return [...candidates].sort((a, b) => a.name.localeCompare(b.name))[0]!;
}

export function ensureRootCreateAction(input: {
  proposal: PlanProposal;
  rootName: string;
  objectType: string;
  kind: string;
  purpose: string;
  rootProperties?: PlanAction['properties'];
  attachChild: (action: PlanAction) => PlanAction;
}): PlanProposal {
  const { proposal, rootName, objectType, kind, purpose, rootProperties = [], attachChild } = input;
  const existingRootIndex = proposal.plannedActions.findIndex(
    (action) =>
      action.operation === 'create' &&
      new RegExp(kind, 'i').test(action.objectType) &&
      normalizeTitle(action.target) === normalizeTitle(rootName),
  );

  let actions: PlanAction[];
  if (existingRootIndex >= 0) {
    const reordered = [...proposal.plannedActions];
    const [root] = reordered.splice(existingRootIndex, 1);
    actions = renumberSequential([root!, ...reordered]).map((action, index) =>
      index === 0 ? action : attachChild(action),
    );
  } else {
    const shifted = shiftActionIds(proposal.plannedActions, 1);
    const root: PlanAction = {
      id: 'action-001',
      operation: 'create',
      objectType,
      target: rootName,
      description: `Create the ${rootName} ${kind}.`,
      properties: rootProperties,
      dependsOn: [],
    };
    actions = [root, ...shifted.map(attachChild)];
  }

  const structure = proposal.proposedWorkspaceStructure.some(
    (item) => normalizeTitle(item.name) === normalizeTitle(rootName),
  )
    ? proposal.proposedWorkspaceStructure
    : [
        {
          kind,
          name: rootName,
          purpose,
        },
        ...proposal.proposedWorkspaceStructure,
      ];

  return {
    ...proposal,
    proposedWorkspaceStructure: structure,
    plannedActions: actions,
    assumptions: [
      ...proposal.assumptions,
      `${rootName} is created automatically; no destination ID or key is required.`,
    ],
  };
}

export function shiftActionIds(actions: PlanAction[], offset: number): PlanAction[] {
  if (offset === 0) return renumberSequential(actions);
  const map = new Map(
    actions.map((action) => {
      const number = Number(action.id.replace(/^action-/, ''));
      const next = `action-${String(number + offset).padStart(3, '0')}`;
      return [action.id, next] as const;
    }),
  );
  const remap = (id: string) => map.get(id) ?? id;
  return rewriteGenericActionIds(
    actions.map((action) => ({
      ...action,
      id: remap(action.id),
      dependsOn: action.dependsOn.map(remap),
    })),
    remap,
  );
}

export function renumberSequential(actions: PlanAction[]): PlanAction[] {
  const map = new Map(
    actions.map((action, index) => [
      action.id,
      `action-${String(index + 1).padStart(3, '0')}`,
    ] as const),
  );
  const remap = (id: string) => map.get(id) ?? id;
  return rewriteGenericActionIds(
    actions.map((action) => ({
      ...action,
      id: remap(action.id),
      dependsOn: action.dependsOn.map(remap),
    })),
    remap,
  );
}

function rewriteGenericActionIds(
  actions: PlanAction[],
  remap: (id: string) => string,
): PlanAction[] {
  const actionIdKeys = [
    'notion.database.properties',
    'airtable.relation',
    'airtable.baseActionId',
    'airtable.tableActionId',
    'trello.boardActionId',
    'trello.listActionId',
    'trello.cardActionId',
    'linear.projectActionId',
  ];
  return actions.map((action) => {
    let next = action;
    for (const key of actionIdKeys) {
      const raw = propertyValue(next.properties, key);
      if (!raw) continue;
      if (key === 'notion.database.properties' || key === 'airtable.relation') {
        try {
          const parsed = JSON.parse(raw) as unknown;
          const rewritten = rewriteJsonActionIds(parsed, remap);
          const properties = next.properties.filter((property) => property.key !== key);
          properties.push({ key, value: JSON.stringify(rewritten) });
          next = { ...next, properties };
        } catch {
          /* keep original */
        }
        continue;
      }
      if (/^action-\d+$/i.test(raw)) {
        const properties = next.properties.filter((property) => property.key !== key);
        properties.push({ key, value: remap(raw) });
        next = { ...next, properties };
      }
    }
    return next;
  });
}

function rewriteJsonActionIds(value: unknown, remap: (id: string) => string): unknown {
  if (typeof value === 'string' && /^action-\d+$/i.test(value)) return remap(value);
  if (Array.isArray(value)) return value.map((entry) => rewriteJsonActionIds(entry, remap));
  if (!value || typeof value !== 'object') return value;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      /ActionId$/i.test(key) &&
      typeof entry === 'string' &&
      /^action-\d+$/i.test(entry)
    ) {
      record[key] = remap(entry);
    } else {
      record[key] = rewriteJsonActionIds(entry, remap);
    }
  }
  return record;
}

function containsFriendlyName(text: string, name: string): boolean {
  const normalizedName = name.trim();
  if (normalizedName.length < 2) return false;
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}
