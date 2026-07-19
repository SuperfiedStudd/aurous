import { describe, expect, it } from 'vitest';
import { formatExecutionResult, formatPlan } from '../src/core/output.js';
import {
  formatApprovalPrompt,
  formatComposerPrompt,
  formatInteractiveHeader,
  formatOpeningHeader,
  formatProgress,
  progressWords,
  formatShellStatus,
  stripAnsi,
} from '../src/core/presentation.js';
import type { AurousPlan, ExecutionResult } from '../src/domain/schemas.js';

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
      properties: [{ key: 'linear.state', value: 'In Progress' }],
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
