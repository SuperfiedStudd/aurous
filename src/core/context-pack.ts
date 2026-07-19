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
      const project = await readProjectSummary(this.projectRoot);
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
        ...(await readProjectSummary(this.projectRoot)),
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

  private async save(pack: ContextPack): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ContextPackSchema.parse(pack), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
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

async function readProjectSummary(root: string): Promise<{
  summary?: string;
  summaryProvenance?: {
    kind: 'repository-files';
    sources: string[];
    generatedAt: string;
    maxSourceBytes: number;
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
  const packageText = await readBoundedText(path.join(root, 'package.json'));
  if (packageText) {
    try {
      const manifest = JSON.parse(packageText) as { description?: unknown };
      if (typeof manifest.description === 'string' && manifest.description.trim()) {
        packageSummary = manifest.description.trim();
        sources.push('package.json');
      }
    } catch {
      // A malformed manifest is not useful summary provenance.
    }
  }
  const summary = (readmeSummary ?? packageSummary)?.replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!summary) return {};
  return {
    summary,
    summaryProvenance: {
      kind: 'repository-files',
      sources: [...new Set(sources)],
      generatedAt: new Date().toISOString(),
      maxSourceBytes: MAX_SUMMARY_SOURCE_BYTES,
    },
  };
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
