import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { codexHomeDirectory } from './codex-cache.js';

export type ModelAvailability = 'confirmed-local' | 'advertised-cli' | 'incomplete';

export interface DetectedModel {
  id: string;
  label?: string;
  availability: ModelAvailability;
  hidden?: boolean;
}

export interface AgentModelCatalog {
  agent: 'codex' | 'claude' | 'mock';
  installed: boolean;
  version?: string;
  defaultModel: string;
  models: DetectedModel[];
  detectionSource: string;
  complete: boolean;
  aurousExample: string;
  nativeExample: string;
  notes: string[];
}

/**
 * Local-only model catalog for help. Never makes billable model calls or touches MCP.
 */
export function detectAgentModelCatalogs(
  env: NodeJS.ProcessEnv = process.env,
): AgentModelCatalog[] {
  return [detectCodexModelCatalog(env), detectClaudeModelCatalog(env), detectMockModelCatalog()];
}

export function formatAgentModelsHelp(catalogs = detectAgentModelCatalogs()): string[] {
  const lines: string[] = ['Agent models', ''];
  for (const catalog of catalogs) {
    if (catalog.agent === 'mock') continue;
    const version = catalog.installed
      ? `${displayAgentName(catalog.agent)} ${catalog.version ?? '(version unknown)'}`.trim()
      : `${displayAgentName(catalog.agent)} (not installed)`;
    lines.push(version);
    lines.push(`  Default: ${catalog.defaultModel}`);
    if (!catalog.installed) {
      lines.push('  Detected: unavailable');
    } else if (catalog.models.length === 0) {
      lines.push(
        `  Detected: none (${catalog.complete ? 'empty listing' : 'incomplete local metadata'})`,
      );
    } else {
      const rendered = catalog.models
        .map((model) => {
          const tag =
            model.availability === 'confirmed-local'
              ? ''
              : model.availability === 'advertised-cli'
                ? ' [advertised]'
                : ' [unverified]';
          return `${model.id}${tag}`;
        })
        .join(', ');
      lines.push(`  Detected: ${rendered}`);
    }
    lines.push(`  Source: ${catalog.detectionSource}`);
    lines.push(`  Aurous: ${catalog.aurousExample}`);
    lines.push(`  Native: ${catalog.nativeExample}`);
    for (const note of catalog.notes) lines.push(`  Note: ${note}`);
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function detectCodexModelCatalog(env: NodeJS.ProcessEnv = process.env): AgentModelCatalog {
  const version = readCliVersion('codex', env);
  const defaultModel = readCodexDefaultModel(env) ?? 'auto';
  const base = {
    agent: 'codex' as const,
    aurousExample: 'aurous plan --agent codex --model <model> --context . --prompt "..."',
    nativeExample: 'codex -m <model>',
  };

  if (!version) {
    return {
      ...base,
      installed: false,
      defaultModel: 'auto',
      models: [],
      detectionSource: 'codex binary missing',
      complete: false,
      notes: ['Install Codex CLI to detect local models.'],
    };
  }

  const native = tryNativeCodexModelListing(env);
  if (native && native.models.length > 0) {
    return {
      ...base,
      installed: true,
      version,
      defaultModel,
      models: native.models,
      detectionSource: native.source,
      complete: native.complete,
      notes: native.notes,
    };
  }

  const cachePath = path.join(codexHomeDirectory(env), 'models_cache.json');
  const cacheListing = listModelsFromCodexCache(cachePath, version);
  if (cacheListing) {
    return {
      ...base,
      installed: true,
      version,
      defaultModel,
      models: cacheListing.models,
      detectionSource: cacheListing.source,
      complete: cacheListing.complete,
      notes: cacheListing.notes,
    };
  }

  const bundled = listModelsFromBundledCodexCatalog(version, env);
  if (bundled) {
    return {
      ...base,
      installed: true,
      version,
      defaultModel,
      models: bundled.models,
      detectionSource: bundled.source,
      complete: bundled.complete,
      notes: bundled.notes,
    };
  }

  return {
    ...base,
    installed: true,
    version,
    defaultModel,
    models: [
      {
        id: defaultModel,
        availability: 'incomplete',
      },
    ],
    detectionSource: 'configured/default model only',
    complete: false,
    notes: [
      'Local model listing is incomplete; only the configured/default model is shown. Account access is not confirmed.',
    ],
  };
}

export function detectClaudeModelCatalog(env: NodeJS.ProcessEnv = process.env): AgentModelCatalog {
  const version = readCliVersion('claude', env);
  const base = {
    agent: 'claude' as const,
    aurousExample: 'aurous plan --agent claude --model <model-or-alias> --context . --prompt "..."',
    nativeExample: 'claude --model <model-or-alias>',
  };
  if (!version) {
    return {
      ...base,
      installed: false,
      defaultModel: 'default',
      models: [],
      detectionSource: 'claude binary missing',
      complete: false,
      notes: ['Install Claude Code to detect local models/aliases.'],
    };
  }

  const help = readCliHelp('claude', env);
  const aliases = extractClaudeModelAliases(help);
  const configDefault = readClaudeDefaultModel(env);
  const defaultModel = configDefault ?? aliases[0] ?? 'default';

  if (aliases.length > 0) {
    return {
      ...base,
      installed: true,
      version,
      defaultModel,
      models: aliases.map((id) => ({
        id,
        availability: 'advertised-cli' as const,
      })),
      detectionSource: 'claude --help alias text',
      complete: false,
      notes: [
        'Aliases are advertised by the installed CLI help text; account access is not confirmed.',
      ],
    };
  }

  return {
    ...base,
    installed: true,
    version,
    defaultModel,
    models: [{ id: defaultModel, availability: 'incomplete' }],
    detectionSource: 'configured/default model only',
    complete: false,
    notes: [
      'Local model listing is incomplete; only the configured/default model is shown. Account access is not confirmed.',
    ],
  };
}

function detectMockModelCatalog(): AgentModelCatalog {
  return {
    agent: 'mock',
    installed: true,
    version: 'built-in',
    defaultModel: 'built-in',
    models: [{ id: 'built-in', availability: 'confirmed-local' }],
    detectionSource: 'built-in mock adapter',
    complete: true,
    aurousExample: 'aurous plan --agent mock --context . --prompt "..."',
    nativeExample: '(no native CLI)',
    notes: [],
  };
}

function listModelsFromCodexCache(
  cachePath: string,
  installedVersion: string,
): { models: DetectedModel[]; source: string; complete: boolean; notes: string[] } | undefined {
  // Use sync inspect for help formatting; avoid async in Commander help hooks.
  if (!existsSync(cachePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;

  // Reject schema-incompatible caches rather than advertising stale entries.
  for (const model of parsed.models) {
    if (!isRecord(model)) return undefined;
    if (
      typeof model.slug !== 'string' ||
      typeof model.display_name !== 'string' ||
      !('supports_reasoning_summaries' in model)
    ) {
      return undefined;
    }
  }

  const models: DetectedModel[] = [];
  for (const model of parsed.models) {
    if (!isRecord(model) || typeof model.slug !== 'string') continue;
    const visibility =
      typeof model.visibility === 'string' ? model.visibility.toLowerCase() : 'list';
    if (visibility === 'hide' || visibility === 'hidden') continue;
    const minimum = minimumClientVersion(model);
    if (minimum && compareLooseVersions(installedVersion, minimum) < 0) continue;
    models.push({
      id: model.slug,
      ...(typeof model.display_name === 'string' ? { label: model.display_name } : {}),
      availability: 'confirmed-local',
    });
  }
  if (models.length === 0) return undefined;
  return {
    models,
    source: `valid ${cachePath}`,
    complete: true,
    notes: [
      'Availability is confirmed from the local Codex models cache only, not live account access.',
    ],
  };
}

function listModelsFromBundledCodexCatalog(
  _installedVersion: string,
  env: NodeJS.ProcessEnv,
): { models: DetectedModel[]; source: string; complete: boolean; notes: string[] } | undefined {
  const candidates = [
    path.join(codexHomeDirectory(env), 'model_catalog.json'),
    path.join(codexHomeDirectory(env), 'bundled-models.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as unknown;
      const entries = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.models)
          ? parsed.models
          : [];
      const models: DetectedModel[] = [];
      for (const entry of entries) {
        if (typeof entry === 'string') {
          models.push({ id: entry, availability: 'advertised-cli' });
          continue;
        }
        if (isRecord(entry) && typeof entry.slug === 'string') {
          const visibility =
            typeof entry.visibility === 'string' ? entry.visibility.toLowerCase() : 'list';
          if (visibility === 'hide' || visibility === 'hidden') continue;
          models.push({
            id: entry.slug,
            ...(typeof entry.display_name === 'string' ? { label: entry.display_name } : {}),
            availability: 'advertised-cli',
          });
        }
      }
      if (models.length > 0) {
        return {
          models,
          source: `bundled catalog ${candidate}`,
          complete: false,
          notes: [
            'Bundled catalog entries are advertised locally; account access is not confirmed.',
          ],
        };
      }
    } catch {
      // Ignore unreadable bundled catalogs.
    }
  }
  return undefined;
}

function tryNativeCodexModelListing(
  env: NodeJS.ProcessEnv,
): { models: DetectedModel[]; source: string; complete: boolean; notes: string[] } | undefined {
  // Prefer a machine-readable listing when the installed CLI advertises one.
  const help = readCliHelp('codex', env);
  if (!/\bmodels\b/i.test(help) && !/--list-models/i.test(help)) return undefined;
  for (const args of [['models', '--json'], ['models', 'list', '--json'], ['--list-models']]) {
    try {
      const stdout = execFileSync('codex', args, {
        encoding: 'utf8',
        timeout: 8_000,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(stdout) as unknown;
      const entries = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.models)
          ? parsed.models
          : [];
      const models: DetectedModel[] = [];
      for (const entry of entries) {
        if (typeof entry === 'string') {
          models.push({ id: entry, availability: 'confirmed-local' });
          continue;
        }
        if (isRecord(entry) && typeof entry.slug === 'string') {
          models.push({
            id: entry.slug,
            ...(typeof entry.display_name === 'string' ? { label: entry.display_name } : {}),
            availability: 'confirmed-local',
          });
          continue;
        }
        if (isRecord(entry) && typeof entry.id === 'string') {
          models.push({ id: entry.id, availability: 'confirmed-local' });
        }
      }
      if (models.length > 0) {
        return {
          models,
          source: `codex ${args.join(' ')}`,
          complete: true,
          notes: ['Listing came from the installed Codex CLI; no billable model call was made.'],
        };
      }
    } catch {
      // Command unsupported or failed; fall through.
    }
  }
  return undefined;
}

function extractClaudeModelAliases(help: string): string[] {
  const aliases = new Set<string>();
  const aliasBlock = help.match(/alias[^\n]*\(([^)]+)\)/i);
  if (aliasBlock?.[1]) {
    for (const part of aliasBlock[1].split(/,|or/i)) {
      const cleaned = part.replace(/['"`]/g, '').trim();
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(cleaned)) aliases.add(cleaned);
    }
  }
  for (const match of help.matchAll(/'([A-Za-z0-9][A-Za-z0-9._:-]{0,63})'/g)) {
    const value = match[1];
    if (value && /^(opus|sonnet|haiku|fable|claude)/i.test(value)) aliases.add(value);
  }
  return [...aliases];
}

function readCodexDefaultModel(env: NodeJS.ProcessEnv): string | undefined {
  const configPath = path.join(codexHomeDirectory(env), 'config.toml');
  if (!existsSync(configPath)) return undefined;
  try {
    const text = readFileSync(configPath, 'utf8');
    const match = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function readClaudeDefaultModel(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.config', 'claude', 'settings.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as unknown;
      if (isRecord(parsed) && typeof parsed.model === 'string') return parsed.model;
      if (
        isRecord(parsed) &&
        isRecord(parsed.defaultModel) &&
        typeof parsed.defaultModel.name === 'string'
      ) {
        return parsed.defaultModel.name;
      }
    } catch {
      // Ignore.
    }
  }
  return env.ANTHROPIC_MODEL?.trim() || undefined;
}

function readCliVersion(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const stdout = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 8_000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = stdout
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith('WARNING:'));
    return line;
  } catch {
    return undefined;
  }
}

function readCliHelp(binary: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(binary, ['--help'], {
      encoding: 'utf8',
      timeout: 8_000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      return String((error as { stdout?: string }).stdout ?? '');
    }
    return '';
  }
}

function minimumClientVersion(model: Record<string, unknown>): string | undefined {
  for (const key of [
    'minimum_client_version',
    'min_client_version',
    'minimumClientVersion',
    'minClientVersion',
  ]) {
    const value = model[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function compareLooseVersions(left: string, right: string): number {
  const parse = (value: string) =>
    (value.match(/\d+/g) ?? [])
      .map((part) => Number(part))
      .concat([0, 0, 0])
      .slice(0, 3);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function displayAgentName(agent: 'codex' | 'claude' | 'mock'): string {
  if (agent === 'codex') return 'Codex';
  if (agent === 'claude') return 'Claude Code';
  return 'Mock';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
