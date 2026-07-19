import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
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
      return await this.load();
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
      ...(selectedPreset ? { selectedPreset } : {}),
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
      ...(selectedPreset ? { selectedPreset } : {}),
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
      ...(selectedPreset ? { selectedPreset } : { selectedPreset: undefined }),
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
  let current = await realpath(cwd);
  while (true) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return await realpath(cwd);
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

async function readProjectSummary(root: string): Promise<{ summary?: string }> {
  for (const file of ['README.md', 'README.txt']) {
    try {
      const first = (await readFile(path.join(root, file), 'utf8'))
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find(Boolean);
      if (first) return { summary: first.slice(0, 500) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return {};
}
