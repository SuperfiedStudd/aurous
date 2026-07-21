import type { PlanAction, PlanProposal } from '../../domain/schemas.js';
import { normalizedObjectType, propertyValue, setProperty } from './exact-bindings.js';

/** Exact title → emoji map for the CEO / Life OS workspace and common personal roots. */
const EXACT_TITLE_ICONS: Record<string, string> = {
  'life os': '🧭',
  'executive life os': '🧭',
  'ceo home': '🏠',
  'work & leadership': '💼',
  'work and leadership': '💼',
  'mba at wharton': '🎓',
  wedding: '💍',
  'personal life': '🌱',
  'weekly review': '🔄',
  'goals & outcomes': '🎯',
  'goals and outcomes': '🎯',
  'projects & initiatives': '🚀',
  'projects and initiatives': '🚀',
  'action hub': '✅',
  'people & relationships': '🤝',
  'people and relationships': '🤝',
  'meetings & decisions': '🧠',
  'meetings and decisions': '🧠',
  'mba academic hub': '📚',
  'wedding planner': '💒',
  'personal activities & notes': '🏓',
  'personal activities and notes': '🏓',
};

const KEYWORD_ICONS: Array<{ pattern: RegExp; emoji: string }> = [
  { pattern: /\bwedding\b/, emoji: '💍' },
  { pattern: /\bmba\b|\bwharton\b|\bacademic\b|\bschool\b/, emoji: '🎓' },
  { pattern: /\bgoal|\boutcome|\bokr\b|\btarget\b/, emoji: '🎯' },
  { pattern: /\bproject|\binitiative|\blaunch\b/, emoji: '🚀' },
  { pattern: /\baction|\btask|\btodo\b|\bhub\b/, emoji: '✅' },
  { pattern: /\bpeople|\brelationship|\bcontact|\bnetwork\b/, emoji: '🤝' },
  { pattern: /\bmeeting|\bdecision|\bnotes?\b.*decision/, emoji: '🧠' },
  { pattern: /\breview|\bweekly|\bretro\b/, emoji: '🔄' },
  { pattern: /\bwork\b|\bleadership\b|\bcareer\b/, emoji: '💼' },
  { pattern: /\bhome\b|\bdashboard\b|\bcommand center\b/, emoji: '🏠' },
  { pattern: /\bpersonal\b|\blife\b|\bgarden\b/, emoji: '🌱' },
  { pattern: /\bplanner\b/, emoji: '💒' },
  { pattern: /\bnotes?\b|\bjournal\b|\bactivity/, emoji: '🏓' },
  { pattern: /\blife os\b|\bcompass\b|\bnavigate\b/, emoji: '🧭' },
];

/**
 * Deterministic emoji for a Notion page or database from its title and purpose.
 */
export function selectNotionIcon(title: string, purpose = '', objectType = ''): string {
  const normalized = normalizeTitle(title);
  if (EXACT_TITLE_ICONS[normalized]) return EXACT_TITLE_ICONS[normalized];
  const text = `${title}\n${purpose}`.toLocaleLowerCase();
  for (const entry of KEYWORD_ICONS) {
    if (entry.pattern.test(text)) return entry.emoji;
  }
  const kind = normalizedObjectType(objectType);
  if (kind === 'database') return '🗃️';
  if (kind === 'page') return '📄';
  return '✨';
}

/**
 * Attach context-aware emoji icons to Notion page/database create and configure actions.
 * Reused objects keep their existing icons (no icon property written).
 */
export function attachNotionIcons(proposal: PlanProposal): PlanProposal {
  const warnings: string[] = [];
  const assumptions: string[] = [];
  let databaseIconCount = 0;
  let pageIconCount = 0;
  let preservedCount = 0;

  const plannedActions = proposal.plannedActions.map((action) => {
    if (!isIconEligibleAction(action)) return action;
    if (shouldPreserveExistingIcon(action)) {
      preservedCount += 1;
      return stripIconProperties(action);
    }
    const purpose =
      propertyValue(action.properties, 'notion.page.purpose') ??
      propertyValue(action.properties, 'notion.database.purpose') ??
      action.description;
    const emoji = selectNotionIcon(action.target, purpose, action.objectType);
    const properties = action.properties.filter(
      (property) =>
        property.key !== 'notion.icon.emoji' &&
        property.key !== 'notion.icon.type' &&
        property.key !== 'notion.icon.preserveExisting',
    );
    setProperty(properties, 'notion.icon.type', 'emoji');
    setProperty(properties, 'notion.icon.emoji', emoji);
    const kind = normalizedObjectType(action.objectType);
    if (kind === 'database') databaseIconCount += 1;
    else pageIconCount += 1;
    return { ...action, properties };
  });

  if (pageIconCount > 0 || databaseIconCount > 0) {
    assumptions.push(
      'Notion page and database icons are set from context-aware emoji fields when the official MCP supports them.',
    );
  }
  if (databaseIconCount > 0) {
    warnings.push(
      'Database emoji icons are requested in the approved plan; if the connected Notion MCP cannot set database icons, continue without failing and record a compatibility note.',
    );
  }
  if (preservedCount > 0) {
    assumptions.push(
      'Existing Notion icons on reused pages/databases are preserved; Aurous will not overwrite user-selected icons.',
    );
  }

  const iconByName = new Map(
    plannedActions
      .map((action) => {
        const emoji = propertyValue(action.properties, 'notion.icon.emoji');
        return emoji ? ([normalizeTitle(action.target), emoji] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );

  const proposedWorkspaceStructure = proposal.proposedWorkspaceStructure.map((item) => {
    const emoji = iconByName.get(normalizeTitle(item.name));
    if (!emoji) return item;
    if (item.purpose.startsWith(emoji)) return item;
    return { ...item, purpose: `${emoji} ${item.purpose}` };
  });

  return {
    ...proposal,
    plannedActions,
    proposedWorkspaceStructure,
    assumptions: [...new Set([...proposal.assumptions, ...assumptions])],
    warnings: [...new Set([...proposal.warnings, ...warnings])],
  };
}

function isIconEligibleAction(action: PlanAction): boolean {
  if (action.operation !== 'create' && action.operation !== 'configure') return false;
  const kind = normalizedObjectType(action.objectType);
  return kind === 'page' || kind === 'database';
}

function shouldPreserveExistingIcon(action: PlanAction): boolean {
  if (propertyValue(action.properties, 'notion.dedupe.skipReason') === 'already-exists') {
    return true;
  }
  if (
    action.operation === 'configure' &&
    propertyValue(action.properties, 'notion.dedupe.knownExternalId')
  ) {
    // Configuring a reused object: never overwrite a user-selected icon.
    return true;
  }
  return false;
}

function stripIconProperties(action: PlanAction): PlanAction {
  const properties = action.properties.filter(
    (property) =>
      property.key !== 'notion.icon.emoji' &&
      property.key !== 'notion.icon.type' &&
      property.key !== 'notion.icon.preserveExisting',
  );
  setProperty(properties, 'notion.icon.preserveExisting', 'true');
  return { ...action, properties };
}

function normalizeTitle(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/\s+/g, ' ');
}
