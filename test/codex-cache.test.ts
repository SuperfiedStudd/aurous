import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectCodexModelsCache,
  isCodexModelsCacheSchemaError,
  repairCodexModelsCache,
  runCodexPreflight,
  writeCodexCacheRepairDiagnostic,
} from '../src/adapters/agents/codex-cache.js';

function validCache(
  models = [{ slug: 'gpt-test', display_name: 'Test', supports_reasoning_summaries: true }],
) {
  return {
    fetched_at: 1,
    etag: 'x',
    client_version: '0.144.6',
    models,
  };
}

describe('Codex models cache preflight', () => {
  it('backs up a malformed cache once and leaves a repair diagnostic without raw contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aurous-cache-'));
    const cachePath = path.join(root, 'models_cache.json');
    await writeFile(
      cachePath,
      JSON.stringify({
        client_version: '0.145.0',
        models: [{ slug: 'gpt-bad', display_name: 'Bad' }],
      }),
      'utf8',
    );

    const first = await repairCodexModelsCache({
      cachePath,
      now: () => new Date('2026-07-20T20:00:00.000Z'),
    });
    expect(first.repaired).toBe(true);
    expect(first.attempted).toBe(true);
    expect(first.backupPath).toBe(`${cachePath}.aurous-backup-20260720T200000Z`);
    await expect(access(cachePath)).rejects.toThrow();
    await expect(access(first.backupPath!)).resolves.toBeUndefined();

    const second = await repairCodexModelsCache({ cachePath });
    expect(second.repaired).toBe(false);
    expect(second.attempted).toBe(false);

    const diagnosticPath = await writeCodexCacheRepairDiagnostic(root, first);
    const diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(diagnostic.sanitized).toBe(true);
    expect(diagnostic.backupPath).toBe(first.backupPath);
    expect(JSON.stringify(diagnostic)).not.toMatch(/sk-|token|api[_-]?key|password/i);
    expect(JSON.stringify(diagnostic)).not.toContain('gpt-bad');
  });

  it('leaves a valid cache untouched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aurous-cache-valid-'));
    const cachePath = path.join(root, 'models_cache.json');
    const body = `${JSON.stringify(validCache(), null, 2)}\n`;
    await writeFile(cachePath, body, 'utf8');

    const result = await repairCodexModelsCache({ cachePath });
    expect(result.repaired).toBe(false);
    expect(result.attempted).toBe(false);
    expect(await readFile(cachePath, 'utf8')).toBe(body);
  });

  it('detects schema-incompatible cache errors from Codex stderr', () => {
    expect(
      isCodexModelsCacheSchemaError(
        'ERROR codex_models_manager::cache: failed to load models cache: missing field `supports_reasoning_summaries` at line 88 column 5',
      ),
    ).toBe(true);
    expect(isCodexModelsCacheSchemaError('mcp server notion failed')).toBe(false);
  });

  it('reports invalid JSON without entering a repair loop when repair is disabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aurous-cache-json-'));
    const cachePath = path.join(root, 'models_cache.json');
    await writeFile(cachePath, '{not-json', 'utf8');
    const inspection = await inspectCodexModelsCache(cachePath);
    expect(inspection.valid).toBe(false);
    const preflight = await runCodexPreflight({ cachePath, repair: false });
    expect(preflight.ok).toBe(false);
    expect(preflight.repair).toBeUndefined();
    expect(await readFile(cachePath, 'utf8')).toBe('{not-json');
  });
});
