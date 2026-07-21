import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { AurousError } from '../../core/errors.js';
import { redactText } from '../../core/redact.js';

/** Fields Codex currently fails hard on when absent from models_cache.json entries. */
export const CODEX_MODEL_CACHE_REQUIRED_FIELDS = [
  'slug',
  'display_name',
  'supports_reasoning_summaries',
] as const;

export interface CodexCacheInspection {
  path: string;
  exists: boolean;
  valid: boolean;
  issue?: string;
  modelCount?: number;
  clientVersion?: string;
}

export interface CodexCacheRepairResult {
  repaired: boolean;
  attempted: boolean;
  backupPath?: string;
  inspectionBefore: CodexCacheInspection;
  inspectionAfter?: CodexCacheInspection;
  detail: string;
  probe?: { ok: boolean; detail: string };
}

export interface CodexPreflightResult {
  installed: boolean;
  version?: string;
  cache: CodexCacheInspection;
  repair?: CodexCacheRepairResult;
  ok: boolean;
  detail: string;
}

export function codexHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

export function codexModelsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codexHomeDirectory(env), 'models_cache.json');
}

export function isCodexModelsCacheSchemaError(text: string): boolean {
  const haystack = text.toLowerCase();
  if (!haystack.includes('models_cache') && !haystack.includes('models cache')) return false;
  return (
    haystack.includes('supports_reasoning_summaries') ||
    haystack.includes('failed to load models cache') ||
    haystack.includes('missing field')
  );
}

export async function inspectCodexModelsCache(
  cachePath = codexModelsCachePath(),
): Promise<CodexCacheInspection> {
  try {
    await access(cachePath);
  } catch {
    return {
      path: cachePath,
      exists: false,
      valid: true,
      issue: 'Cache file is absent; Codex may regenerate it on the next agent call.',
    };
  }

  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch (error) {
    return {
      path: cachePath,
      exists: true,
      valid: false,
      issue: `Unable to read models cache (${error instanceof Error ? error.message : 'unknown error'}).`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      path: cachePath,
      exists: true,
      valid: false,
      issue: 'models_cache.json is not valid JSON.',
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    return {
      path: cachePath,
      exists: true,
      valid: false,
      issue: 'models_cache.json is missing a models array.',
    };
  }

  for (const [index, model] of parsed.models.entries()) {
    if (!isRecord(model)) {
      return {
        path: cachePath,
        exists: true,
        valid: false,
        issue: `models[${index}] is not an object.`,
        modelCount: parsed.models.length,
        ...(typeof parsed.client_version === 'string'
          ? { clientVersion: parsed.client_version }
          : {}),
      };
    }
    for (const field of CODEX_MODEL_CACHE_REQUIRED_FIELDS) {
      if (!(field in model)) {
        return {
          path: cachePath,
          exists: true,
          valid: false,
          issue: `models[${index}] is missing required field ${field}.`,
          modelCount: parsed.models.length,
          ...(typeof parsed.client_version === 'string'
            ? { clientVersion: parsed.client_version }
            : {}),
        };
      }
    }
  }

  return {
    path: cachePath,
    exists: true,
    valid: true,
    modelCount: parsed.models.length,
    ...(typeof parsed.client_version === 'string' ? { clientVersion: parsed.client_version } : {}),
  };
}

export async function backupIncompatibleCodexModelsCache(
  cachePath = codexModelsCachePath(),
  now: () => Date = () => new Date(),
): Promise<{ backupPath: string }> {
  // Millisecond precision plus a random suffix so two repairs within the same second
  // (common on Windows) cannot collide on the rename target.
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\./g, '');
  const backupPath = `${cachePath}.aurous-backup-${stamp}-${randomBytes(4).toString('hex')}`;
  await rename(cachePath, backupPath);
  return { backupPath };
}

/**
 * Safe one-shot repair: rename a schema-incompatible cache so Codex can regenerate it.
 * Never deletes the only copy. Never loops.
 */
export async function repairCodexModelsCache(options?: {
  cachePath?: string;
  now?: () => Date;
  runProbe?: boolean;
}): Promise<CodexCacheRepairResult> {
  const cachePath = options?.cachePath ?? codexModelsCachePath();
  const inspectionBefore = await inspectCodexModelsCache(cachePath);
  if (!inspectionBefore.exists) {
    return {
      repaired: false,
      attempted: false,
      inspectionBefore,
      detail: 'No Codex models cache present; nothing to repair.',
    };
  }
  if (inspectionBefore.valid) {
    return {
      repaired: false,
      attempted: false,
      inspectionBefore,
      detail: 'Codex models cache is schema-compatible; left untouched.',
    };
  }

  const { backupPath } = await backupIncompatibleCodexModelsCache(cachePath, options?.now);
  const inspectionAfter = await inspectCodexModelsCache(cachePath);
  const result: CodexCacheRepairResult = {
    repaired: true,
    attempted: true,
    backupPath,
    inspectionBefore,
    inspectionAfter,
    detail: `Backed up incompatible Codex models cache to ${backupPath}.`,
  };

  if (options?.runProbe) {
    result.probe = await probeCodexCacheInitialization();
    result.inspectionAfter = await inspectCodexModelsCache(cachePath);
    if (!result.probe.ok) {
      result.detail = `${result.detail} Initialization probe failed: ${result.probe.detail}`;
    } else {
      result.detail = `${result.detail} Initialization probe succeeded.`;
    }
  }

  return result;
}

export async function runCodexPreflight(options?: {
  repair?: boolean;
  runProbe?: boolean;
  cachePath?: string;
  now?: () => Date;
}): Promise<CodexPreflightResult> {
  const version = await execa('codex', ['--version'], { reject: false, timeout: 15_000 }).catch(
    () => undefined,
  );
  if (!version || version.exitCode !== 0) {
    return {
      installed: false,
      cache: await inspectCodexModelsCache(options?.cachePath),
      ok: false,
      detail: 'Codex CLI is not installed or not on PATH.',
    };
  }
  const versionText = (version.stdout.trim() || version.stderr.trim()).replace(
    /^WARNING:.*\n/gm,
    '',
  );
  const cache = await inspectCodexModelsCache(options?.cachePath);
  if (cache.valid) {
    return {
      installed: true,
      version: versionText,
      cache,
      ok: true,
      detail: cache.exists
        ? 'Codex is installed and the local models cache is schema-compatible.'
        : 'Codex is installed; models cache is absent and will regenerate on demand.',
    };
  }

  if (!options?.repair) {
    return {
      installed: true,
      version: versionText,
      cache,
      ok: false,
      detail:
        cache.issue ??
        'Codex models cache is schema-incompatible. Run "aurous doctor --agent codex --repair".',
    };
  }

  const repair = await repairCodexModelsCache({
    ...(options?.cachePath ? { cachePath: options.cachePath } : {}),
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.runProbe ? { runProbe: options.runProbe } : {}),
  });
  const ok = repair.repaired && (!options?.runProbe || Boolean(repair.probe?.ok));
  return {
    installed: true,
    version: versionText,
    cache: repair.inspectionAfter ?? (await inspectCodexModelsCache(options?.cachePath)),
    repair,
    ok,
    detail: repair.detail,
  };
}

export async function writeCodexCacheRepairDiagnostic(
  runDirectory: string,
  repair: CodexCacheRepairResult,
): Promise<string> {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(runDirectory, 'codex-cache-repair.json');
  const payload = {
    schemaVersion: 1,
    sanitized: true,
    repaired: repair.repaired,
    attempted: repair.attempted,
    backupPath: repair.backupPath,
    issueBefore: repair.inspectionBefore.issue,
    modelCountBefore: repair.inspectionBefore.modelCount,
    clientVersionBefore: repair.inspectionBefore.clientVersion,
    detail: repair.detail,
    probe: repair.probe,
    // Never include raw cache contents.
  };
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return target;
}

export function codexCacheSchemaFailureError(options: {
  detail: string;
  backupPath?: string;
  runId?: string;
  requestedModel?: string;
}): AurousError {
  return new AurousError({
    code: 'AUR-AGENT-009',
    summary: 'Codex models cache is schema-incompatible and could not be recovered.',
    probableCause: redactText(options.detail).slice(0, 500),
    nextAction: options.backupPath
      ? `Inspect the backup at ${options.backupPath}, run "aurous doctor --agent codex --repair", then retry${
          options.requestedModel ? ` with --model ${options.requestedModel}` : ''
        }.`
      : 'Run "aurous doctor --agent codex --repair", then retry the original request.',
    ...(options.runId ? { runId: options.runId } : {}),
  });
}

async function probeCodexCacheInitialization(): Promise<{ ok: boolean; detail: string }> {
  const help = await execa('codex', ['exec', '--help'], { reject: false, timeout: 15_000 });
  if (help.exitCode !== 0) {
    return {
      ok: false,
      detail:
        redactText(`${help.stdout}\n${help.stderr}`.trim()).slice(0, 300) ||
        'codex exec --help failed.',
    };
  }
  // Prefer Codex's local doctor probe when available; it is non-writing.
  const doctor = await execa('codex', ['doctor', '--summary'], {
    reject: false,
    timeout: 45_000,
  });
  if (doctor.exitCode === 0) {
    return { ok: true, detail: 'codex doctor --summary succeeded after cache repair.' };
  }
  const combined = `${doctor.stdout}\n${doctor.stderr}`;
  if (isCodexModelsCacheSchemaError(combined)) {
    return {
      ok: false,
      detail: 'Codex still reports a models-cache schema error after backup.',
    };
  }
  // Doctor may fail for unrelated reasons; version+help already passed.
  return {
    ok: true,
    detail:
      'codex exec --help succeeded after cache repair; doctor reported non-cache issues that do not block regeneration.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
