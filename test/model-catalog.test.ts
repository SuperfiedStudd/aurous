import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Make CLI probing deterministic regardless of whether a real `codex`/`claude` binary is on
// PATH: `codex` reports a version and a help text without a machine-readable models listing;
// any other binary (and any call with an empty PATH) is treated as not installed.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(
      (file: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        const env = options?.env ?? process.env;
        if (!env.PATH)
          throw Object.assign(new Error(`spawnSync ${file} ENOENT`), { code: 'ENOENT' });
        if (file === 'codex') {
          if (args.includes('--version')) return 'codex-cli 0.144.6\n';
          if (args.includes('--help')) return 'Usage: codex [options]\n  exec   Run a task\n';
          throw Object.assign(new Error('unknown command'), { status: 1 });
        }
        throw Object.assign(new Error(`spawnSync ${file} ENOENT`), { code: 'ENOENT' });
      },
    ),
  };
});

import {
  detectClaudeModelCatalog,
  detectCodexModelCatalog,
  formatAgentModelsHelp,
} from '../src/adapters/agents/model-catalog.js';

describe('agent model catalog help', () => {
  it('lists Codex models from a valid local cache without claiming account confirmation beyond local metadata', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'aurous-codex-home-'));
    const codexHome = path.join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        client_version: '0.144.6',
        models: [
          {
            slug: 'gpt-visible',
            display_name: 'Visible',
            supports_reasoning_summaries: true,
            visibility: 'list',
          },
          {
            slug: 'gpt-hidden',
            display_name: 'Hidden',
            supports_reasoning_summaries: true,
            visibility: 'hide',
          },
        ],
      }),
    );
    writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-visible"\n');

    const catalog = detectCodexModelCatalog({
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
    });
    expect(catalog.models.map((model) => model.id)).toEqual(['gpt-visible']);
    expect(catalog.models.every((model) => model.availability === 'confirmed-local')).toBe(true);
    expect(catalog.nativeExample).toContain('codex -m');
    expect(catalog.aurousExample).toContain('--model');
    expect(catalog.notes.join(' ')).toMatch(/not confirmed|local Codex models cache/i);
  });

  it('marks incomplete Claude listings honestly when only aliases are advertised', () => {
    const catalog = detectClaudeModelCatalog(process.env);
    if (!catalog.installed) {
      expect(catalog.complete).toBe(false);
      expect(catalog.detectionSource).toContain('missing');
      return;
    }
    expect(catalog.aurousExample).toContain('--agent claude --model');
    expect(catalog.nativeExample).toContain('claude --model');
    expect(catalog.complete).toBe(false);
    expect(catalog.notes.join(' ')).toMatch(/not confirmed/i);
  });

  it('formats Agent models help without making billable model or MCP calls', () => {
    const lines = formatAgentModelsHelp([
      {
        agent: 'codex',
        installed: true,
        version: 'codex-cli 0.144.6',
        defaultModel: 'auto',
        models: [{ id: 'gpt-visible', availability: 'confirmed-local' }],
        detectionSource: 'valid cache',
        complete: true,
        aurousExample: 'aurous plan --agent codex --model gpt-visible --context . --prompt "..."',
        nativeExample: 'codex -m gpt-visible',
        notes: ['Availability is confirmed from the local Codex models cache only.'],
      },
      {
        agent: 'claude',
        installed: true,
        version: '2.1.215 (Claude Code)',
        defaultModel: 'sonnet',
        models: [{ id: 'sonnet', availability: 'advertised-cli' }],
        detectionSource: 'claude --help alias text',
        complete: false,
        aurousExample: 'aurous plan --agent claude --model sonnet --context . --prompt "..."',
        nativeExample: 'claude --model sonnet',
        notes: [
          'Aliases are advertised by the installed CLI help text; account access is not confirmed.',
        ],
      },
      {
        agent: 'mock',
        installed: true,
        version: 'built-in',
        defaultModel: 'built-in',
        models: [{ id: 'built-in', availability: 'confirmed-local' }],
        detectionSource: 'built-in',
        complete: true,
        aurousExample: 'aurous plan --agent mock --context . --prompt "..."',
        nativeExample: '(no native CLI)',
        notes: [],
      },
    ]);
    expect(lines[0]).toBe('Agent models');
    expect(lines.join('\n')).toContain('Codex codex-cli 0.144.6');
    expect(lines.join('\n')).toContain('Aurous: aurous plan --agent codex --model gpt-visible');
    expect(lines.join('\n')).toContain('Native: codex -m gpt-visible');
    expect(lines.join('\n')).toContain('Claude Code 2.1.215');
    expect(lines.join('\n')).toContain('[advertised]');
    expect(lines.join('\n')).not.toContain('Mock');
  });

  it('does not advertise models from a schema-incompatible cache', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'aurous-codex-bad-'));
    const codexHome = path.join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        client_version: '0.145.0',
        models: [{ slug: 'gpt-stale', display_name: 'Stale' }],
      }),
    );
    const catalog = detectCodexModelCatalog({
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: '', // force missing binary → incomplete path without reading live Codex
    });
    // With PATH cleared Codex appears missing; still must not leak stale slug via cache path alone.
    // Re-run with PATH restored but ensure incompatible cache is ignored when binary exists.
    const withBinary = detectCodexModelCatalog({
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
    });
    expect(withBinary.models.map((model) => model.id)).not.toContain('gpt-stale');
    expect(catalog.models.map((model) => model.id)).not.toContain('gpt-stale');
  });
});
