import { describe, expect, it } from 'vitest';
import { formatExecutionResult, formatPlan } from '../src/core/output.js';
import {
  formatApprovalPrompt,
  formatComposerPrompt,
  formatContextPathsLabel,
  formatInteractiveHeader,
  formatOpeningHeader,
  formatProgress,
  progressWords,
  formatShellStatus,
  stripAnsi,
  visibleDisplayWidth,
  visibleWrappedRowCount,
} from '../src/core/presentation.js';
import type { AurousPlan, ExecutionResult } from '../src/domain/schemas.js';
import { PASTED_CONTEXT_LABEL } from '../src/core/context.js';

const plan: AurousPlan = {
  schemaVersion: 1,
  runId: 'run-20260719T120000Z-abcdef',
  createdAt: '2026-07-19T12:00:00.000Z',
  agent: 'codex',
  tool: 'linear',
  objective: 'Ship a context-specific Build Week launch workspace.',
  contextSummary: {
    approvedPaths: ['/demo/linear-build-week.json'],
    files: [],
    fileCount: 1,
    totalBytes: 3583,
    skipped: [],
  },
  proposedWorkspaceStructure: [
    {
      kind: 'project',
      name: 'Aurous — Build Week Launch',
      purpose: 'Keep integration and recording work visible before the launch deadline.',
    },
  ],
  plannedActions: [
    {
      id: 'action-001',
      operation: 'create',
      objectType: 'project',
      target: 'Aurous — Build Week Launch',
      description: 'Create the approved project in the selected Linear team.',
      properties: [
        { key: 'linear.team', value: 'JasjyotSingh' },
        { key: 'linear.teamId', value: 'team-exact-internal-id' },
        {
          key: 'linear.description',
          value:
            'A deliberately long description that must wrap cleanly in narrow terminals without changing the persisted plan.',
        },
      ],
      dependsOn: [],
    },
    {
      id: 'action-002',
      operation: 'update',
      objectType: 'issue',
      target: 'Record the launch walkthrough',
      description: 'Move the approved issue into the recording-ready state.',
      properties: [
        { key: 'linear.teamId', value: 'team-exact-internal-id' },
        { key: 'linear.state', value: 'In Progress' },
      ],
      dependsOn: ['action-001'],
    },
  ],
  assumptions: ['The selected team is the approved destination.'],
  warnings: ['Unsupported fields must be reported as compatibility notes.'],
  destructiveActions: [],
  expectedResult: 'One project and one launch issue configured for the demo.',
};

const result: ExecutionResult = {
  status: 'succeeded',
  summary: 'The approved Linear setup is ready.',
  createdObjects: [
    {
      actionId: 'action-001',
      type: 'project',
      name: 'Aurous — Build Week Launch',
      externalId: 'project-123',
      url: 'https://linear.app/example/project/project-123',
    },
    {
      actionId: 'action-002',
      type: 'issue',
      name: 'Record the launch walkthrough',
      externalId: 'issue-456',
      url: 'https://linear.app/example/issue/JAS-10',
    },
  ],
  skippedActions: [
    {
      actionId: 'action-003',
      type: 'label',
      name: 'Aurous: Demo',
      reason: 'An exact approved match already exists.',
      externalId: 'label-789',
      url: 'https://linear.app/example/label/label-789',
    },
  ],
  completedActionIds: ['action-001', 'action-002'],
  compatibilityNotes: ['Linear did not return a URL for one team-scoped label lookup.'],
  warnings: ['The configured status was mapped to the workspace equivalent.'],
  failures: [],
  startedAt: '2026-07-19T12:00:00.000Z',
  finishedAt: '2026-07-19T12:00:01.000Z',
};

describe('CLI presentation', () => {
  it('hides internal destination IDs normally and reveals them in verbose previews', () => {
    expect(formatPlan(plan, { color: false })).not.toContain('team-exact-internal-id');
    expect(formatPlan(plan, { color: false, verbose: true })).toContain('team-exact-internal-id');
  });

  it.each([80, 120])('renders the complete experience within %i columns', (width) => {
    const rendered = [
      formatOpeningHeader(
        {
          agent: 'codex',
          model: 'gpt-5',
          target: 'linear',
          mode: 'Approval',
          runId: plan.runId,
        },
        { width, color: true, unicode: true },
      ),
      formatPlan(plan, { width, color: true, unicode: true }),
      formatExecutionResult(
        result,
        { runId: plan.runId, plan },
        {
          width,
          color: true,
          unicode: true,
        },
      ),
    ].join('\n');

    const plain = stripAnsi(rendered);
    expect(plain).toContain('PRODUCTIVITY, RESOLVED.');
    expect(plain).toContain('agent Codex  ·  target Linear  ·  mode Approval');
    expect(plain).toContain('Preview');
    expect(plain).toContain('project-123');
    expect(plain).toContain('https://linear.app/example/issue/JAS-10');
    expect(plain).toContain('Compatibility');
    expect(Math.max(...plain.split('\n').map((line) => line.length))).toBeLessThanOrEqual(
      Math.min(width, 108),
    );
  });

  it('keeps redirected and no-color output readable', () => {
    const rendered = formatOpeningHeader(
      { agent: 'claude', target: 'notion', mode: 'Planning', runId: plan.runId },
      { width: 80, color: false, unicode: false },
    );
    const approval = formatApprovalPrompt('Execute this exact plan?', 'apply', {
      width: 80,
      color: false,
      unicode: false,
    });

    expect(rendered).not.toContain('\u001b');
    expect(rendered).toContain('+');
    expect(rendered).toContain('agent Claude Code  ·  target Notion  ·  mode Planning');
    expect(approval).toContain('Type apply to confirm.');
  });

  it.each([80, 120])('keeps shell status and the composer within %i columns', (width) => {
    const rendered = [
      formatShellStatus(
        {
          agent: 'codex',
          model: 'gpt-5.6',
          target: 'linear',
          mode: 'Ready',
          project: 'aurous',
          contextPaths: ['demo/linear-build-week.json'],
          preset: 'software-launch',
          linearTeam: 'JasjyotSingh',
          lastRunId: plan.runId,
        },
        { width, color: false, unicode: false },
      ),
      formatComposerPrompt({ width, color: false, unicode: false }),
    ].join('\n');

    expect(rendered).not.toContain('\u001b');
    expect(rendered).toContain('agent    Codex  ·  model gpt-5.6');
    expect(rendered).toContain('aurous ›');
    expect(Math.max(...rendered.split('\n').map((line) => line.length))).toBeLessThanOrEqual(
      Math.min(width, 108),
    );
  });

  it.each([80, 120, 200])('keeps the dynamic shell header within %i columns', (width) => {
    const rendered = formatInteractiveHeader(
      {
        agent: 'codex',
        model: 'gpt-5.6',
        target: 'linear',
        mode: 'Interactive',
        state: 'Applying',
        project: 'aurous',
        contextPaths: ['demo/linear-build-week.json'],
        preset: 'software-launch',
        linearTeam: 'JasjyotSingh',
        lastRunId: plan.runId,
      },
      { width, color: false, unicode: false },
    );

    expect(rendered).toContain('state Applying');
    expect(rendered).toContain('team JasjyotSingh');
    expect(rendered).toContain(plan.runId);
    expect(Math.max(...rendered.split('\n').map((line) => line.length))).toBeLessThanOrEqual(
      Math.min(width, 108),
    );
  });

  it('summarizes pasted and multi-path context labels for the shell header', () => {
    expect(formatContextPathsLabel([])).toBe('none');
    expect(formatContextPathsLabel([PASTED_CONTEXT_LABEL])).toBe('pasted');
    expect(formatContextPathsLabel(['notes.md'])).toBe('notes.md');
    expect(formatContextPathsLabel(['docs/a.md', 'docs/b.md', 'docs/c.md'])).toBe('a.md, +2 more');
    expect(
      formatInteractiveHeader(
        {
          agent: 'mock',
          model: 'built-in deterministic adapter',
          target: 'notion',
          mode: 'Interactive',
          state: 'Ready',
          project: 'No project selected',
          contextPaths: [PASTED_CONTEXT_LABEL],
        },
        { width: 96, color: false, unicode: false },
      ),
    ).toContain('project No project selected  ·  context pasted');
  });

  it('calculates ANSI-safe visible display width and wrapped terminal rows', () => {
    const styled = `\u001b[38;5;220m\u001b[1mcontext ›\u001b[0m `;
    expect(visibleDisplayWidth(styled)).toBe(visibleDisplayWidth('context › '));
    expect(visibleDisplayWidth(styled)).toBeLessThan(styled.length);
    expect(visibleWrappedRowCount('short', 80)).toBe(1);
    expect(visibleWrappedRowCount('a'.repeat(100), 40)).toBe(3);
    expect(visibleWrappedRowCount(`${'a'.repeat(50)}\n${'b'.repeat(50)}`, 40)).toBe(4);
    expect(visibleWrappedRowCount(styled + 'x'.repeat(70), 40)).toBe(
      visibleWrappedRowCount(`context › ${'x'.repeat(70)}`, 40),
    );
    expect(visibleWrappedRowCount('', 40)).toBe(1);
  });

  it('uses only the approved one-word refinement vocabulary for progress states', () => {
    expect(progressWords).toEqual([
      'Assaying',
      'Smelting',
      'Forging',
      'Tempering',
      'Polishing',
      'Hallmarking',
    ]);
    for (const word of progressWords) {
      expect(word).toMatch(/^[A-Za-z]+ing$/);
      expect(formatProgress(word, 'Working.', 1, { color: false })).toMatch(
        new RegExp(`^${word}\\s+Working\\. · 1s$`),
      );
    }
  });

  it('shows created, updated, skipped, compatibility, diagnostics, IDs, URLs, and run ID', () => {
    const rendered = formatExecutionResult(
      result,
      { runId: plan.runId, plan },
      { width: 120, color: false },
    );

    expect(rendered).toContain('Created objects: 1');
    expect(rendered).toContain('Updated objects: 1');
    expect(rendered).toContain('Skipped actions: 1');
    expect(rendered).toContain('Compatibility notes: 1');
    expect(rendered).toContain('Diagnostics');
    expect(rendered).toContain('label-789');
    expect(rendered).toContain(plan.runId);
  });
});
