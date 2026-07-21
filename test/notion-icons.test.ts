import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import { NotionAdapter } from '../src/adapters/productivity/notion.js';
import {
  attachNotionIcons,
  selectNotionIcon,
} from '../src/adapters/productivity/notion-icons.js';
import { propertyValue } from '../src/adapters/productivity/exact-bindings.js';
import { NOTION_WORKSPACE_SENTINEL } from '../src/adapters/productivity/notion-onboarding.js';
import { formatPlan } from '../src/core/output.js';
import type { ResolvedDestination } from '../src/domain/destinations.js';
import type { AurousPlan, PlanProposal } from '../src/domain/schemas.js';

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const EXPECTED_ICONS: Record<string, string> = {
  'Life OS': '🧭',
  'CEO Home': '🏠',
  'Work & Leadership': '💼',
  'MBA at Wharton': '🎓',
  Wedding: '💍',
  'Personal Life': '🌱',
  'Weekly Review': '🔄',
  'Goals & Outcomes': '🎯',
  'Projects & Initiatives': '🚀',
  'Action Hub': '✅',
  'People & Relationships': '🤝',
  'Meetings & Decisions': '🧠',
  'MBA Academic Hub': '📚',
  'Wedding Planner': '💒',
  'Personal Activities & Notes': '🏓',
};

async function loadCeoProposal(): Promise<PlanProposal> {
  return JSON.parse(
    await readFile(path.join(fixtureDirectory, 'notion-ceo-life-workspace-proposal.json'), 'utf8'),
  ) as PlanProposal;
}

async function loadExistingDestination(): Promise<ResolvedDestination> {
  const payload = JSON.parse(
    await readFile(
      path.join(fixtureDirectory, 'notion-ceo-life-workspace-existing-objects.json'),
      'utf8',
    ),
  ) as {
    destinationId: string;
    destinationName: string;
    existingObjects: ResolvedDestination['existingObjects'];
  };
  return {
    integration: 'notion',
    id: payload.destinationId,
    name: payload.destinationName,
    kind: 'page',
    source: 'existing-match',
    sourceDetail: 'Partial CEO life-workspace run objects for idempotent retry.',
    verifiedAt: '2026-07-21T04:36:03.000Z',
    existingObjects: payload.existingObjects,
    discoveryWarnings: [],
  };
}

function freshDestination(name = 'Life OS'): ResolvedDestination {
  return {
    integration: 'notion',
    id: NOTION_WORKSPACE_SENTINEL,
    name,
    kind: 'page',
    source: 'context-root-create',
    sourceDetail: 'Fresh personal Notion root.',
    verifiedAt: '2026-07-21T04:36:03.000Z',
    existingObjects: [],
    discoveryWarnings: [],
  };
}

function toPlan(bound: PlanProposal, runId: string): AurousPlan {
  return {
    schemaVersion: 1,
    runId,
    createdAt: '2026-07-21T04:36:03.000Z',
    agent: 'mock',
    tool: 'notion',
    objective: 'Set up my life and work in Notion using the context I provided.',
    contextSummary: {
      approvedPaths: ['ceo-context.md'],
      files: [],
      fileCount: 1,
      totalBytes: 100,
      skipped: [],
    },
    proposedWorkspaceStructure: bound.proposedWorkspaceStructure,
    plannedActions: bound.plannedActions,
    assumptions: bound.assumptions,
    warnings: bound.warnings,
    destructiveActions: bound.destructiveActions,
    expectedResult: bound.expectedResult,
  };
}

describe('Notion context-aware icons', () => {
  it('selects emojis deterministically from title and purpose', () => {
    for (const [title, emoji] of Object.entries(EXPECTED_ICONS)) {
      expect(selectNotionIcon(title)).toBe(emoji);
      expect(selectNotionIcon(title.toLowerCase())).toBe(emoji);
      expect(selectNotionIcon(title, 'unused purpose text')).toBe(emoji);
    }
    expect(selectNotionIcon('Goals and Outcomes')).toBe('🎯');
    expect(selectNotionIcon('Work and Leadership')).toBe('💼');
    expect(selectNotionIcon('Unknown Landing', 'home dashboard', 'notion.page')).toBe('🏠');
    expect(selectNotionIcon('Misc Tracker', '', 'notion.database')).toBe('🗃️');
    expect(selectNotionIcon('Misc Page', '', 'notion.page')).toBe('📄');
  });

  it('includes icons in the immutable preview for fresh creates', async () => {
    const proposal = await loadCeoProposal();
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(proposal, freshDestination());
    const plan = toPlan(bound, 'run-ceo-icons-preview');
    const preview = formatPlan(plan, { color: false });

    expect(preview).toContain('🧭 Life OS');
    expect(preview).toContain('🏠 CEO Home');
    expect(preview).toContain('notion.icon.emoji: 🎯');
    expect(preview).toContain('notion.icon.emoji: ✅');
    expect(preview).toMatch(/Database emoji icons are requested/i);

    const creates = bound.plannedActions.filter((action) => action.operation === 'create');
    for (const action of creates) {
      const expected = EXPECTED_ICONS[action.target];
      expect(expected).toBeTruthy();
      expect(propertyValue(action.properties, 'notion.icon.emoji')).toBe(expected);
      expect(propertyValue(action.properties, 'notion.icon.type')).toBe('emoji');
      expect(propertyValue(action.properties, 'notion.icon.preserveExisting')).toBeUndefined();
    }
  });

  it('applies icons successfully on a fresh mock apply', async () => {
    const proposal = await loadCeoProposal();
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(proposal, freshDestination());
    const plan = toPlan(bound, 'run-ceo-icons-apply');

    const createsWithIcons = plan.plannedActions.filter(
      (action) =>
        action.operation === 'create' &&
        propertyValue(action.properties, 'notion.icon.emoji') &&
        propertyValue(action.properties, 'notion.icon.preserveExisting') !== 'true',
    );
    expect(createsWithIcons.length).toBeGreaterThanOrEqual(14);

    const execution = await new MockAgentAdapter().executePlan({
      workspace: process.cwd(),
      runDirectory: path.join(process.cwd(), '.aurous', 'runs', plan.runId),
      plan,
      productivity: adapter,
      timeoutMs: 5_000,
    });

    expect(execution.value.status).toBe('succeeded');
    expect(execution.value.createdObjects.length).toBeGreaterThanOrEqual(14);
    expect(execution.value.failures).toHaveLength(0);
  });

  it('preserves existing icons when reusing objects', async () => {
    const proposal = await loadCeoProposal();
    const destination = await loadExistingDestination();
    const adapter = new NotionAdapter();
    const bound = adapter.bindDestination(proposal, destination);

    const creates = bound.plannedActions.filter((action) => action.operation === 'create');
    expect(creates).toHaveLength(14);
    for (const action of creates) {
      expect(propertyValue(action.properties, 'notion.dedupe.skipReason')).toBe('already-exists');
      expect(propertyValue(action.properties, 'notion.icon.preserveExisting')).toBe('true');
      expect(propertyValue(action.properties, 'notion.icon.emoji')).toBeUndefined();
    }

    const configures = bound.plannedActions.filter((action) => action.operation === 'configure');
    for (const action of configures) {
      expect(propertyValue(action.properties, 'notion.dedupe.knownExternalId')).toBeTruthy();
      expect(propertyValue(action.properties, 'notion.icon.preserveExisting')).toBe('true');
      expect(propertyValue(action.properties, 'notion.icon.emoji')).toBeUndefined();
    }

    const preview = formatPlan(toPlan(bound, 'run-ceo-icons-preserve'), { color: false });
    expect(preview).toContain('icon: preserve existing (no update)');
    expect(preview).not.toContain('notion.icon.emoji:');
  });

  it('repeated bind on reused objects does not introduce unnecessary icon updates', async () => {
    const proposal = await loadCeoProposal();
    const destination = await loadExistingDestination();
    const adapter = new NotionAdapter();
    const first = adapter.bindDestination(proposal, destination);
    const second = adapter.bindDestination(
      {
        ...proposal,
        plannedActions: first.plannedActions.map((action) => ({
          ...action,
          properties: action.properties.map((property) => ({ ...property })),
        })),
      },
      destination,
    );

    for (const action of second.plannedActions) {
      if (!/page|database/i.test(action.objectType)) continue;
      if (action.operation !== 'create' && action.operation !== 'configure') continue;
      expect(propertyValue(action.properties, 'notion.icon.emoji')).toBeUndefined();
      expect(propertyValue(action.properties, 'notion.icon.preserveExisting')).toBe('true');
    }

    const execution = await new MockAgentAdapter().executePlan({
      workspace: process.cwd(),
      runDirectory: path.join(process.cwd(), '.aurous', 'runs', 'run-ceo-icons-repeat'),
      plan: toPlan(second, 'run-ceo-icons-repeat'),
      productivity: adapter,
      timeoutMs: 5_000,
    });
    expect(execution.value.status).toBe('succeeded');
    expect(execution.value.createdObjects).toHaveLength(0);
    expect(
      execution.value.skippedActions.filter((action) =>
        second.plannedActions.some(
          (planned) =>
            planned.id === action.actionId &&
            planned.operation === 'create' &&
            propertyValue(planned.properties, 'notion.dedupe.skipReason') === 'already-exists',
        ),
      ),
    ).toHaveLength(14);
  });

  it('attachNotionIcons alone stamps the expected CEO mapping', async () => {
    const proposal = await loadCeoProposal();
    const stamped = attachNotionIcons(proposal);
    for (const action of stamped.plannedActions.filter((item) => item.operation === 'create')) {
      expect(propertyValue(action.properties, 'notion.icon.emoji')).toBe(
        EXPECTED_ICONS[action.target],
      );
    }
    expect(
      stamped.proposedWorkspaceStructure.some((item) => item.purpose.startsWith('🏠')),
    ).toBe(true);
  });
});
