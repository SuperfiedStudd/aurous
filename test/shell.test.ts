import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Output } from '../src/core/output.js';
import { LocalRunStore } from '../src/core/run-store.js';
import { AurousServices } from '../src/core/services.js';
import {
  AurousShell,
  createReadlineShellIO,
  routeNaturalRequest,
  tokenize,
  type ShellIO,
} from '../src/core/shell.js';

const presetPath = new URL('../demo/linear-build-week.json', import.meta.url);

class ScriptedIO implements ShellIO {
  readonly prompts: string[] = [];
  clearCount = 0;
  closeCount = 0;
  private interrupt?: () => void;

  constructor(private readonly answers: Array<string | undefined>) {}

  question(prompt: string): Promise<string | undefined> {
    this.prompts.push(prompt);
    return Promise.resolve(this.answers.shift());
  }

  clear(): void {
    this.clearCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  onInterrupt(handler: () => void): void {
    this.interrupt = handler;
  }

  forgetLastInput(): void {}

  interruptNow(): void {
    this.interrupt?.();
  }
}

function captureOutput(): { output: Output; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    output: {
      log(message = '') {
        lines.push(message);
      },
      error(message) {
        lines.push(message);
      },
    },
  };
}

async function fixture(answers: Array<string | undefined>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aurous-shell-'));
  await writeFile(path.join(workspace, 'README.md'), '# Interactive demo\n');
  await writeFile(path.join(workspace, 'linear.json'), await readFile(presetPath, 'utf8'));
  const store = new LocalRunStore(workspace);
  await store.init({ defaultAgent: 'mock', defaultTool: 'notion' });
  const capture = captureOutput();
  const services = new AurousServices({
    workspace,
    store,
    output: capture.output,
    progressIntervalMs: 1,
  });
  const io = new ScriptedIO(answers);
  const shell = new AurousShell({ workspace, store, services, output: capture.output, io });
  return { workspace, store, capture, services, io, shell };
}

describe('interactive Aurous shell', () => {
  it('supports slash configuration, quoted arguments, status, history, clear, and exit', async () => {
    const { shell, io, capture } = await fixture([
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

    const snapshot = shell.snapshot();
    expect(snapshot).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.6',
      target: 'linear',
      contextPaths: ['linear.json'],
      preset: 'software-launch',
      linearTeam: 'Demo Team',
    });
    expect(snapshot.history).toEqual([
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
    expect(io.clearCount).toBe(1);
    expect(io.closeCount).toBe(1);
    expect(io.prompts[0]).toContain('aurous ›');
    expect(capture.lines.join('\n')).toContain('history · Ctrl+C exit');
    expect(capture.lines.join('\n')).toContain('AUROUS · PRODUCTIVITY, RESOLVED.');
    expect(capture.lines.join('\n')).toContain('Active model: gpt-5.6');
    expect(capture.lines.join('\n')).toContain('Context loaded and ready for planning.');
    expect(capture.lines.join('\n')).toContain('Session closed. Local run history is preserved.');
  });

  it('routes a natural-language Linear request through plan, approval, apply, and back to input', async () => {
    const { shell, io, store, capture } = await fixture([
      '/target linear Demo',
      '/context linear.json',
      'Set up Linear for this project using my current context',
      'apply',
      '/status',
      '/exit',
    ]);

    await shell.run();

    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent: 'mock', tool: 'linear', status: 'succeeded' });
    expect((await store.loadResult(runs[0]!.runId))?.createdObjects).toHaveLength(11);
    expect(shell.snapshot().lastRunId).toBe(runs[0]!.runId);
    expect(io.prompts.filter((prompt) => prompt.includes('aurous ›')).length).toBe(5);
    expect(io.prompts.some((prompt) => prompt.includes('approval ›'))).toBe(true);
    const rendered = capture.lines.join('\n');
    expect(rendered).toContain('Interpreting request for Linear.');
    expect(rendered).toContain('11 exact action(s) · no writes yet');
    expect(rendered).toContain('Type apply to confirm.');
    expect(rendered).toContain('Typed approval received.');
    expect(rendered).toContain('Created objects: 11');
    expect(rendered).toContain('Mock mode made no external writes.');
    expect(rendered).toContain('run-');
  });

  it('supports separate Notion plan and apply commands using the same saved run', async () => {
    const { shell, store, capture } = await fixture([
      '/context README.md',
      '/plan Build a launch command center',
      '/apply',
      'apply',
      '/exit',
    ]);

    await shell.run();

    const [run] = await store.listRuns();
    expect(run).toMatchObject({ tool: 'notion', status: 'succeeded' });
    expect((await store.loadResult(run!.runId))?.createdObjects).toHaveLength(4);
    const rendered = capture.lines.join('\n');
    expect(rendered).toContain('target Notion');
    expect(rendered).toContain('5 exact action(s) · no writes yet');
    expect(rendered).toContain('Created objects: 4');
  });

  it('returns cleanly on input close and keeps the shell available after bad commands', async () => {
    const { shell, io, capture } = await fixture(['/agent invalid', '/unknown', undefined]);

    await shell.run();

    expect(io.prompts).toHaveLength(3);
    expect(io.closeCount).toBe(1);
    expect(capture.lines.join('\n')).toContain('Invalid agent selection.');
    expect(capture.lines.join('\n')).toContain('Unknown command: /unknown');
    expect(capture.lines.join('\n')).toContain('Session closed.');
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
    const io = createReadlineShellIO(input, output);

    const pending = io.question('aurous › ');
    io.close();

    await expect(pending).resolves.toBeUndefined();
  });
});
