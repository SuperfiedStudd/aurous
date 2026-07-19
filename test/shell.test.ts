import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import {
  AurousShell,
  createReadlineShellTerminal,
  routeNaturalRequest,
  tokenize,
} from '../src/core/shell.js';
import { DynamicShellRenderer, type ShellTerminal } from '../src/core/shell-renderer.js';
import { MockAgentAdapter } from '../src/adapters/agents/mock.js';
import type { DestinationDiscovery } from '../src/domain/destinations.js';

const presetPath = new URL('../demo/linear-build-week.json', import.meta.url);
const WAIT = Symbol('wait');

class ScriptedTerminal implements ShellTerminal {
  readonly prompts: string[] = [];
  readonly writes: string[] = [];
  readonly renderOptions;
  clearCount = 0;
  closeCount = 0;
  cancelCount = 0;
  private interrupt?: () => void;
  private pending?: (value: undefined) => void;

  constructor(
    private readonly answers: Array<string | undefined | typeof WAIT>,
    readonly ansi = false,
    readonly columns = 96,
  ) {
    this.renderOptions = { width: columns, color: false, unicode: false };
  }

  question(prompt: string): Promise<string | undefined> {
    this.prompts.push(prompt);
    const answer = this.answers.shift();
    if (answer !== WAIT) return Promise.resolve(answer);
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  write(value: string): void {
    this.writes.push(value);
  }

  clear(): void {
    this.clearCount += 1;
  }

  close(): void {
    this.closeCount += 1;
    this.pending?.(undefined);
    delete this.pending;
  }

  cancelQuestion(): void {
    this.cancelCount += 1;
    this.pending?.(undefined);
    delete this.pending;
  }

  onInterrupt(handler: () => void): void {
    this.interrupt = handler;
  }

  forgetLastInput(): void {}

  interruptNow(): void {
    this.interrupt?.();
  }

  rendered(): string {
    return this.writes.join('');
  }
}

async function fixture(
  answers: Array<string | undefined | typeof WAIT>,
  options: { ansi?: boolean; columns?: number; discovery?: DestinationDiscovery } = {},
) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-shell-'));
  await writeFile(path.join(workspace, 'README.md'), '# Interactive demo\n');
  await writeFile(path.join(workspace, 'linear.json'), await readFile(presetPath, 'utf8'));
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  const terminal = new ScriptedTerminal(answers, options.ansi ?? false, options.columns ?? 96);
  const renderer = new DynamicShellRenderer(terminal);
  const mock = new MockAgentAdapter();
  const discovery = options.discovery;
  const services = new AurousServices({
    workspace,
    store,
    output: renderer,
    progressIntervalMs: 1,
    ...(discovery
      ? {
          agentFactory: () => ({
            name: 'mock',
            diagnose: () => mock.diagnose(),
            discoverDestinations: () =>
              Promise.resolve({
                value: discovery,
                command: ['mock-discovery'],
                stdout: JSON.stringify(discovery),
                stderr: '',
                durationMs: 0,
              }),
            generatePlan: (input) => mock.generatePlan(input),
            executePlan: (input) => mock.executePlan(input),
            inspectRecovery: (input) => mock.inspectRecovery(input),
            executeRecoveryAction: (input) => mock.executeRecoveryAction(input),
            manualFallback: (directory, phase, prompt) =>
              mock.manualFallback(directory, phase, prompt),
          }),
        }
      : {}),
  });
  const shell = new AurousShell({ workspace, store, services, renderer });
  return { workspace, store, terminal, renderer, services, shell };
}

describe('dynamic interactive Aurous shell', () => {
  it('updates routine configuration without repeating framed sections in fallback output', async () => {
    const { shell, terminal } = await fixture([
      '/help',
      '/agent codex',
      '/model gpt-5.6',
      '/target linear "Demo Team"',
      '/context linear.json',
      '/preset software-launch',
      '/status',
      '/clear',
      '/exit',
    ]);

    await shell.run();

    expect(shell.snapshot()).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.6',
      target: 'linear',
      contextPaths: ['linear.json'],
      preset: 'software-launch',
    });
    expect(shell.snapshot().history).toEqual([
      '/exit',
      '/clear',
      '/status',
      '/preset software-launch',
      '/context linear.json',
      '/target linear "Demo Team"',
      '/model gpt-5.6',
      '/agent codex',
      '/help',
    ]);
    const rendered = terminal.rendered();
    expect(rendered.match(/AUROUS · PRODUCTIVITY, RESOLVED\./g)).toHaveLength(2);
    expect(rendered).toContain('/agent · /model · /target');
    expect(rendered).toContain('✓ Agent Codex · model auto');
    expect(rendered).toContain('✓ Model gpt-5.6');
    expect(rendered).toContain('✓ Target Linear');
    expect(rendered).toContain('✓ Context linear.json · 1 files');
    expect(rendered).not.toContain('Invalid target selection');
    expect(terminal.clearCount).toBe(1);
  });

  it('automatically resolves one Linear team, supports cancel, then completes', async () => {
    const { shell, store, terminal } = await fixture([
      '/target linear',
      'Set up Linear for this project using my current context',
      'cancel',
      'Set up Linear for this project using my current context',
      'apply',
      '/exit',
    ]);

    await shell.run();

    const runs = await store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status).sort()).toEqual(['planned', 'succeeded']);
    expect(shell.snapshot()).toMatchObject({
      target: 'linear',
      linearTeam: 'Product team',
      destinationName: 'Product team',
      state: 'Complete',
    });
    expect(terminal.prompts.filter((prompt) => prompt.includes('destination ›'))).toHaveLength(0);
    expect(terminal.prompts.filter((prompt) => prompt.includes('approval ›'))).toHaveLength(2);
    const rendered = terminal.rendered();
    expect(rendered).toContain('✓ Using Product team');
    expect(rendered).toContain('Approval canceled. No external writes were attempted.');
    expect(rendered).toContain('Executing approved workspace actions · 0/11');
    expect(rendered).toContain('Approved actions completed · 11/11');
    expect(rendered).toContain('Created objects: 11');
    expect(rendered).toContain('Run succeeded · 11 completed · 11 objects');
  });

  it('keeps recoverable command mistakes concise instead of printing fatal diagnostics', async () => {
    const { shell, terminal } = await fixture([
      '/agent invalid',
      '/target unsupported',
      '/apply',
      '/exit',
    ]);

    await shell.run();

    const rendered = terminal.rendered();
    expect(rendered).toContain('! Invalid agent selection. Choose codex, claude, or mock.');
    expect(rendered).toContain('! Invalid target selection. Choose notion, linear, or mock.');
    expect(rendered).toContain('! Invalid apply selection. Create a plan first');
    expect(rendered).not.toContain('Fatal internal error');
    expect(rendered).not.toContain('Probable cause:');
  });

  it('emits ANSI cursor updates for a live surface instead of append-only request frames', async () => {
    const { shell, terminal } = await fixture(
      ['/agent codex', '/target linear JasjyotSingh', '/status', '/exit'],
      { ansi: true, columns: 80 },
    );

    await shell.run();

    const rendered = terminal.rendered();
    expect(rendered).toContain('\u001b[');
    expect(rendered).toContain('agent Codex');
    expect(rendered).toContain('target Linear');
    expect(rendered).toContain('target Linear');
    expect(rendered).not.toContain('+- Request');
  });

  it('reprompts on blank and cancels a pending friendly destination choice', async () => {
    const discovery: DestinationDiscovery = {
      integration: 'linear',
      candidates: [
        {
          id: 'team-product',
          name: 'Product',
          kind: 'team',
          description: '',
          existingAurousMatch: false,
        },
        {
          id: 'team-engineering',
          name: 'Engineering',
          kind: 'team',
          description: '',
          existingAurousMatch: false,
        },
      ],
      existingObjects: [],
      inspectedAt: '2026-07-19T12:00:00.000Z',
      warnings: [],
    };
    const { shell, store, terminal } = await fixture(
      ['/target linear', 'Set up Linear for this project', '', WAIT, '/exit'],
      { discovery },
    );
    const running = shell.run();
    await vi.waitFor(() => expect(terminal.prompts.at(-1)).toContain('destination ›'));

    terminal.interruptNow();
    await running;

    expect(await store.listRuns()).toEqual([]);
    expect(terminal.cancelCount).toBe(1);
    expect(terminal.rendered()).toContain('Choose 1–2, or type cancel.');
    expect(terminal.rendered()).toContain('Destination selection canceled.');
  });

  it('stores a numbered destination choice and resumes the suspended request automatically', async () => {
    const discovery: DestinationDiscovery = {
      integration: 'linear',
      candidates: [
        {
          id: 'team-product',
          name: 'Product',
          kind: 'team',
          description: '',
          existingAurousMatch: false,
        },
        {
          id: 'team-engineering',
          name: 'Engineering',
          kind: 'team',
          description: '',
          existingAurousMatch: false,
        },
      ],
      existingObjects: [],
      inspectedAt: '2026-07-19T12:00:00.000Z',
      warnings: [],
    };
    const { shell, store, terminal } = await fixture(
      ['/target linear', 'Set up Linear for this project', '', '2', 'cancel', '/exit'],
      { discovery },
    );

    await shell.run();

    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    const plan = await store.loadPlan(runs[0]!.runId);
    expect(
      plan.plannedActions.every((action) =>
        action.properties.some(
          (property) => property.key === 'linear.teamId' && property.value === 'team-product',
        ),
      ),
    ).toBe(true);
    expect(terminal.rendered()).toContain('Choose 1–2, or type cancel.');
    expect(terminal.rendered()).toContain('✓ Using Product');
    expect(terminal.rendered()).not.toContain('team-product');
    expect(terminal.rendered()).not.toContain('team-engineering');
    expect(terminal.prompts.filter((prompt) => prompt.includes('destination ›'))).toHaveLength(2);
    expect(terminal.prompts.filter((prompt) => prompt.includes('approval ›'))).toHaveLength(1);
  });

  it('shows and forgets project destination context without changing external systems', async () => {
    const { shell, workspace, terminal } = await fixture([
      '/target linear',
      'Set up Linear for this project',
      'cancel',
      '/context show',
      '/context destinations',
      '/context forget linear',
      '/exit',
    ]);

    await shell.run();

    const context = JSON.parse(
      await readFile(path.join(workspace, '.aurous', 'context.json'), 'utf8'),
    ) as { destinations: unknown[] };
    expect(context.destinations).toEqual([]);
    expect(terminal.rendered()).toContain('Project Context');
    expect(terminal.rendered()).toContain('Resolved Destinations');
    expect(terminal.rendered()).toContain('exact ID');
    expect(terminal.rendered()).toContain('Forgot the saved Linear destination.');
  });

  it('keeps a missing accessible Notion destination concise and recoverable', async () => {
    const discovery: DestinationDiscovery = {
      integration: 'notion',
      candidates: [],
      existingObjects: [],
      inspectedAt: '2026-07-19T12:00:00.000Z',
      warnings: [],
    };
    const { shell, store, terminal } = await fixture(['Set up Notion for this project', '/exit'], {
      discovery,
    });

    await shell.run();

    expect(await store.listRuns()).toEqual([]);
    expect(terminal.rendered()).toContain(
      'Aurous cannot access a suitable Notion page yet; share or create one page for Aurous, then try again.',
    );
    expect(terminal.rendered()).not.toContain('Fatal internal error');
    expect(terminal.rendered()).not.toContain('MCP');
  });

  it('cancels composer input first and exits on a second Ctrl+C', async () => {
    const { shell, terminal } = await fixture([WAIT, WAIT]);
    const running = shell.run();
    await vi.waitFor(() => expect(terminal.prompts).toHaveLength(1));

    terminal.interruptNow();
    await vi.waitFor(() => expect(terminal.prompts).toHaveLength(2));
    terminal.interruptNow();
    await running;

    expect(terminal.cancelCount).toBe(1);
    expect(terminal.closeCount).toBeGreaterThanOrEqual(1);
    expect(terminal.rendered()).toContain('Input canceled. Press Ctrl+C again to exit.');
  });
});

describe('shell parsing and routing', () => {
  it('routes explicit integration names and otherwise preserves the active target', () => {
    expect(routeNaturalRequest('Set up Linear for this project', 'notion')).toBe('linear');
    expect(routeNaturalRequest('Create a Notion workspace', 'linear')).toBe('notion');
    expect(routeNaturalRequest('Organize my current project', 'notion')).toBe('notion');
  });

  it('tokenizes quoted slash-command arguments', () => {
    expect(tokenize('/target linear "Build Week Team"')).toEqual([
      '/target',
      'linear',
      'Build Week Team',
    ]);
    expect(tokenize("/context 'docs/product brief.md' README.md")).toEqual([
      '/context',
      'docs/product brief.md',
      'README.md',
    ]);
  });

  it('settles an active composer question when the terminal closes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const terminal = createReadlineShellTerminal(input, output);

    const pending = terminal.question('aurous › ');
    terminal.close();

    await expect(pending).resolves.toBeUndefined();
  });
});
