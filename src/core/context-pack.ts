import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ContextPackSchema,
  destinationFor,
  type ContextPack,
  type ResolvedDestination,
} from '../domain/destinations.js';
import type { ToolName } from '../domain/schemas.js';
import { AurousError } from './errors.js';

export class ContextPackStore {
  constructor(readonly projectRoot: string) {}

  get path(): string {
    return path.join(this.projectRoot, '.aurous', 'context.json');
  }

  async loadOrCreate(selectedPreset?: string): Promise<ContextPack> {
    try {
      const current = await this.load();
      if (
        isUsefulSummary(current.project.name, current.project.summary) &&
        current.project.summaryProvenance
      )
        return current;
      const project = await collectProjectContext(this.projectRoot);
      if (!project.summary) return current;
      const next = ContextPackSchema.parse({
        ...current,
        project: { ...current.project, ...project },
        updatedAt: new Date().toISOString(),
      });
      await this.save(next);
      return next;
    } catch (error) {
      if (!(error instanceof AurousError) || error.code !== 'AUR-CONTEXT-001') throw error;
    }
    const now = new Date().toISOString();
    const pack = ContextPackSchema.parse({
      schemaVersion: 1,
      project: {
        name: path.basename(this.projectRoot),
        root: this.projectRoot,
        ...(await collectProjectContext(this.projectRoot)),
      },
      ...(selectedPreset ? { selectedPreset, selectedPresetSource: 'explicit-user' as const } : {}),
      activeIntegrations: [],
      destinations: [],
      workspacePreferences: { verbose: false },
      updatedAt: now,
    });
    await this.save(pack);
    return pack;
  }

  async load(): Promise<ContextPack> {
    try {
      return ContextPackSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AurousError({
          code: 'AUR-CONTEXT-001',
          summary: 'No project context pack exists yet.',
          probableCause: 'This project has not completed Aurous onboarding.',
          nextAction: 'Describe the workspace you want; Aurous will create it automatically.',
        });
      }
      throw new AurousError({
        code: 'AUR-CONTEXT-002',
        summary: 'The project context pack is invalid.',
        probableCause: '.aurous/context.json does not match the supported versioned schema.',
        nextAction: 'Inspect or repair the user-controlled context file, then retry.',
        cause: error,
      });
    }
  }

  async saveDestination(
    destination: ResolvedDestination,
    selectedPreset?: string,
  ): Promise<ContextPack> {
    const current = await this.loadOrCreate(selectedPreset);
    const destinations = current.destinations.filter(
      (candidate) => candidate.integration !== destination.integration,
    );
    destinations.push(destination);
    const next = ContextPackSchema.parse({
      ...current,
      ...(selectedPreset ? { selectedPreset, selectedPresetSource: 'explicit-user' as const } : {}),
      activeIntegrations: [...new Set([...current.activeIntegrations, destination.integration])],
      destinations,
      updatedAt: new Date().toISOString(),
    });
    await this.save(next);
    return next;
  }

  async forgetDestination(integration: ToolName): Promise<ContextPack> {
    const current = await this.loadOrCreate();
    const next = ContextPackSchema.parse({
      ...current,
      activeIntegrations: current.activeIntegrations.filter((name) => name !== integration),
      destinations: current.destinations.filter(
        (destination) => destination.integration !== integration,
      ),
      updatedAt: new Date().toISOString(),
    });
    await this.save(next);
    return next;
  }

  async setPreset(selectedPreset?: string): Promise<ContextPack> {
    const current = await this.loadOrCreate();
    const next = ContextPackSchema.parse({
      ...current,
      ...(selectedPreset
        ? { selectedPreset, selectedPresetSource: 'explicit-user' as const }
        : { selectedPreset: undefined, selectedPresetSource: undefined }),
      updatedAt: new Date().toISOString(),
    });
    await this.save(next);
    return next;
  }

  /** Rebuild only bounded project-local context. Saved exact destinations and preferences remain intact. */
  async refresh(): Promise<ContextPack> {
    const current = await this.loadOrCreate();
    const project = await collectProjectContext(this.projectRoot);
    const next = ContextPackSchema.parse({
      ...current,
      project: { ...current.project, ...project },
      destinations: stableDestinations(current.destinations),
      activeIntegrations: [...new Set(current.activeIntegrations)].sort(),
      updatedAt: new Date().toISOString(),
    });
    await this.save(next);
    return next;
  }

  async export(): Promise<{ markdownPath: string; jsonPath: string; pack: ContextPack }> {
    const pack = await this.loadOrCreate();
    const exportsDirectory = path.join(this.projectRoot, '.aurous', 'exports');
    const markdownPath = path.join(exportsDirectory, 'context-pack.md');
    const jsonPath = path.join(exportsDirectory, 'context-pack.json');
    const normalized = ContextPackSchema.parse({
      ...pack,
      activeIntegrations: [...new Set(pack.activeIntegrations)].sort(),
      destinations: stableDestinations(pack.destinations),
    });
    await mkdir(exportsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(jsonPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await writeFile(markdownPath, renderContextPackMarkdown(normalized), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { markdownPath, jsonPath, pack: normalized };
  }

  private async save(pack: ContextPack): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        ContextPackSchema.parse({
          ...pack,
          activeIntegrations: [...new Set(pack.activeIntegrations)].sort(),
          destinations: stableDestinations(pack.destinations),
        }),
        null,
        2,
      )}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await rename(temporary, this.path);
  }
}

export async function detectProjectRoot(cwd: string): Promise<string> {
  const found = await findProjectRoot(cwd);
  if (found) return found;
  throw new AurousError({
    code: 'AUR-PROJECT-001',
    summary: 'Aurous could not find a project from this directory.',
    probableCause:
      'No .git directory, package.json, or existing .aurous/context.json was found before the home-directory boundary.',
    nextAction: 'Change into the project directory and launch Aurous again.',
    severity: 'recoverable',
  });
}

export async function findProjectRoot(
  cwd: string,
  homeDirectory = os.homedir(),
): Promise<string | undefined> {
  let current = await realpath(cwd);
  const home = await realpath(homeDirectory).catch(() => homeDirectory);
  while (true) {
    if (current === home) return undefined;
    if (
      (await exists(path.join(current, '.git'))) ||
      (await exists(path.join(current, 'package.json'))) ||
      (await exists(path.join(current, '.aurous', 'context.json')))
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export { destinationFor };

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const MAX_SUMMARY_SOURCE_BYTES = 16 * 1024;

export async function collectProjectContext(root: string): Promise<{
  summary?: string;
  purpose?: string;
  currentObjective?: string;
  technology: string[];
  commands: string[];
  summaryProvenance?: {
    kind: 'repository-files';
    sources: string[];
    generatedAt: string;
    maxSourceBytes: number;
    maxSources: number;
  };
}> {
  const sources: string[] = [];
  let readmeSummary: string | undefined;
  for (const file of ['README.md', 'README.txt']) {
    const content = await readBoundedText(path.join(root, file));
    if (!content) continue;
    const summary = firstUsefulParagraph(content);
    if (summary) {
      readmeSummary = summary;
      sources.push(file);
      break;
    }
  }
  let packageSummary: string | undefined;
  let technology: string[] = [];
  let commands: string[] = [];
  const packageText = await readBoundedText(path.join(root, 'package.json'));
  if (packageText) {
    try {
      const manifest = JSON.parse(packageText) as {
        description?: unknown;
        scripts?: Record<string, unknown>;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      if (typeof manifest.description === 'string' && manifest.description.trim()) {
        packageSummary = manifest.description.trim();
        sources.push('package.json');
      }
      commands = Object.entries(manifest.scripts ?? {})
        .filter(([, value]) => typeof value === 'string')
        .map(([name]) => `npm run ${name}`)
        .sort()
        .slice(0, 20);
      const dependencyNames = Object.keys({
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
      });
      technology = detectTechnology(dependencyNames).sort().slice(0, 20);
    } catch {
      // A malformed manifest is not useful summary provenance.
    }
  }
  const summary = sanitizeText(
    (readmeSummary ?? packageSummary)?.replace(/\s+/g, ' ').trim().slice(0, 700),
  );
  const purpose = summary;
  const objective = await readCurrentObjective(root);
  if (!summary && technology.length === 0 && commands.length === 0) return { technology, commands };
  return {
    ...(summary ? { summary } : {}),
    ...(purpose ? { purpose } : {}),
    ...(objective ? { currentObjective: objective } : {}),
    technology,
    commands,
    summaryProvenance: {
      kind: 'repository-files',
      sources: [...new Set(sources)].sort().slice(0, 5),
      generatedAt: new Date().toISOString(),
      maxSourceBytes: MAX_SUMMARY_SOURCE_BYTES,
      maxSources: 5,
    },
  };
}

async function readCurrentObjective(root: string): Promise<string | undefined> {
  for (const file of ['ROADMAP.md', 'docs/DEVELOPMENT.md', 'ARCHITECTURE.md']) {
    const content = await readBoundedText(path.join(root, file));
    const objective = content && firstUsefulParagraph(content);
    if (objective) return sanitizeText(objective.slice(0, 500));
  }
  return undefined;
}

function detectTechnology(names: string[]): string[] {
  const output = new Set<string>();
  if (names.some((name) => /typescript/.test(name))) output.add('TypeScript');
  if (names.some((name) => /^react$|react-/.test(name))) output.add('React');
  if (names.some((name) => /vitest/.test(name))) output.add('Vitest');
  if (names.some((name) => /eslint/.test(name))) output.add('ESLint');
  if (names.some((name) => /zod/.test(name))) output.add('Zod');
  return [...output];
}

function sanitizeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(
      /(?:api[_ -]?key|token|secret|password|authorization|cookie)\s*[:=]\s*\S+/gi,
      '[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function stableDestinations(
  destinations: ContextPack['destinations'],
): ContextPack['destinations'] {
  return [...destinations].sort(
    (a, b) =>
      a.integration.localeCompare(b.integration) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

export function renderContextPackMarkdown(pack: ContextPack): string {
  const destinations = stableDestinations(pack.destinations);
  const lines = [
    '# Aurous Context Pack v1',
    '',
    `Generated: ${pack.updatedAt}`,
    '',
    '## Project overview',
    '',
    `- Name: ${pack.project.name}`,
    `- Root: ${pack.project.root}`,
    `- Summary: ${pack.project.summary ?? 'Not available.'}`,
    `- Purpose: ${pack.project.purpose ?? 'Not available.'}`,
    `- Current objective: ${pack.project.currentObjective ?? 'Not available.'}`,
    '',
    '## Architecture and commands',
    '',
    `- Technology: ${pack.project.technology.join(', ') || 'Not confidently detected.'}`,
    `- Commands: ${pack.project.commands.join(', ') || 'Not confidently detected.'}`,
    '',
    '## Integration state',
    '',
    `- Active integrations: ${pack.activeIntegrations.join(', ') || 'None.'}`,
    ...(destinations.length === 0
      ? ['- No saved destinations.']
      : destinations.flatMap((destination) => [
          `- ${destination.integration}: ${destination.name} (${destination.kind})`,
          `  - Exact ID: ${destination.id}`,
          `  - URL: ${destination.url ?? 'Not returned'}`,
          `  - Resolution: ${destination.source} — ${destination.sourceDetail}`,
          `  - Verified: ${destination.verifiedAt}`,
          ...destination.existingObjects
            .slice(0, 30)
            .sort(
              (a, b) =>
                a.type.localeCompare(b.type) ||
                a.name.localeCompare(b.name) ||
                a.id.localeCompare(b.id),
            )
            .map(
              (object) =>
                `  - Inspected ${object.type}: ${object.name} (${object.id})${object.url ? ` · ${object.url}` : ''}`,
            ),
        ])),
    '',
    '## Workspace preferences',
    '',
    `- Verbose previews: ${pack.workspacePreferences.verbose ? 'yes' : 'no'}`,
    `- Preset: ${pack.selectedPreset ?? 'None'}${pack.selectedPresetSource ? ` (${pack.selectedPresetSource})` : ''}`,
    '',
    '## Provenance and freshness',
    '',
    `- Sources: ${pack.project.summaryProvenance?.sources.join(', ') || 'None'}`,
    `- Source byte limit: ${pack.project.summaryProvenance?.maxSourceBytes ?? 0}`,
    `- Last refresh: ${pack.updatedAt}`,
    '',
    '> This export is descriptive project context only. It does not authorize writes to any integration.',
    '',
  ];
  return lines.join('\n');
}

async function readBoundedText(target: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, 'r');
    const buffer = Buffer.alloc(MAX_SUMMARY_SOURCE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function firstUsefulParagraph(content: string): string | undefined {
  const paragraphs = content
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .filter(
          (line) =>
            line && !line.startsWith('![') && !line.startsWith('[![') && !line.startsWith('<'),
        )
        .join(' ')
        .trim(),
    )
    .filter(Boolean);
  return paragraphs.find((paragraph) => paragraph.length >= 40) ?? paragraphs[0];
}

function isUsefulSummary(projectName: string, summary: string | undefined): boolean {
  if (!summary) return false;
  const normalized = summary.trim().toLocaleLowerCase();
  return normalized !== projectName.trim().toLocaleLowerCase() && normalized.length >= 40;
}
