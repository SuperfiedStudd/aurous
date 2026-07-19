import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AurousConfigSchema,
  AurousPlanSchema,
  ContextBundleSchema,
  DiagnosticEventSchema,
  ExecutionResultSchema,
  RunRecordSchema,
  type AurousConfig,
  type AurousPlan,
  type ContextBundle,
  type DiagnosticEvent,
  type ExecutionResult,
  type RunRecord,
  type RunStatus,
} from '../domain/schemas.js';
import { AurousError } from './errors.js';
import { redactText, redactValue } from './redact.js';
import {
  RecoveryCheckpointSchema,
  RecoveryPlanSchema,
  type RecoveryCheckpoint,
  type RecoveryPlan,
} from '../domain/recovery.js';

export interface RunStore {
  init(config?: Partial<AurousConfig>): Promise<AurousConfig>;
  loadConfig(): Promise<AurousConfig>;
  createRun(record: RunRecord, context: ContextBundle): Promise<void>;
  loadContext(runId: string): Promise<ContextBundle>;
  updateStatus(runId: string, status: RunStatus): Promise<RunRecord>;
  savePlan(plan: AurousPlan): Promise<void>;
  loadPlan(runId: string): Promise<AurousPlan>;
  saveResult(runId: string, result: ExecutionResult): Promise<void>;
  loadResult(runId: string): Promise<ExecutionResult | undefined>;
  appendEvent(runId: string, event: DiagnosticEvent): Promise<void>;
  saveCommandLog(runId: string, name: string, stdout: string, stderr: string): Promise<void>;
  getRun(runId: string): Promise<RunRecord>;
  listRuns(): Promise<RunRecord[]>;
  readEvents(runId: string): Promise<DiagnosticEvent[]>;
  readAgentFailureSummary(runId: string): Promise<string | undefined>;
  saveRecoveryPlan(plan: RecoveryPlan): Promise<void>;
  loadRecoveryPlan(runId: string): Promise<RecoveryPlan>;
  appendRecoveryCheckpoint(runId: string, checkpoint: RecoveryCheckpoint): Promise<void>;
  readRecoveryCheckpoints(runId: string): Promise<RecoveryCheckpoint[]>;
  runDirectory(runId: string): string;
}

const defaultConfig: AurousConfig = {
  schemaVersion: 1,
  defaultAgent: 'codex',
  defaultTool: 'notion',
  timeoutMs: 300_000,
};

export class LocalRunStore implements RunStore {
  readonly stateDirectory: string;

  constructor(readonly workspace: string) {
    this.stateDirectory = path.join(workspace, '.aurous');
  }

  runDirectory(runId: string): string {
    return path.join(this.stateDirectory, 'runs', this.validateRunId(runId));
  }

  async init(config: Partial<AurousConfig> = {}): Promise<AurousConfig> {
    await mkdir(path.join(this.stateDirectory, 'runs'), { recursive: true, mode: 0o700 });
    const target = path.join(this.stateDirectory, 'config.json');
    try {
      return await this.loadConfig();
    } catch (error) {
      if (!(error instanceof AurousError) || error.code !== 'AUR-STATE-002') throw error;
    }
    const next = AurousConfigSchema.parse({ ...defaultConfig, ...config, schemaVersion: 1 });
    await this.writeJson(target, next);
    return next;
  }

  async loadConfig(): Promise<AurousConfig> {
    return this.readJson(
      path.join(this.stateDirectory, 'config.json'),
      AurousConfigSchema,
      'configuration',
    );
  }

  async createRun(record: RunRecord, context: ContextBundle): Promise<void> {
    const validated = RunRecordSchema.parse(record);
    const validatedContext = ContextBundleSchema.parse(context);
    const directory = this.runDirectory(record.runId);
    await mkdir(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
    await Promise.all([
      this.writeJson(path.join(directory, 'run.json'), validated),
      this.writeJson(path.join(directory, 'context.json'), validatedContext),
    ]);
  }

  async loadContext(runId: string): Promise<ContextBundle> {
    return this.readJson(
      path.join(this.runDirectory(runId), 'context.json'),
      ContextBundleSchema,
      `context ${runId}`,
    );
  }

  async updateStatus(runId: string, status: RunStatus): Promise<RunRecord> {
    const current = await this.getRun(runId);
    const next = RunRecordSchema.parse({ ...current, status, updatedAt: new Date().toISOString() });
    await this.writeJson(path.join(this.runDirectory(runId), 'run.json'), next);
    return next;
  }

  async savePlan(plan: AurousPlan): Promise<void> {
    const validated = AurousPlanSchema.parse(plan);
    await this.writeJson(path.join(this.runDirectory(plan.runId), 'plan.json'), validated);
  }

  async loadPlan(runId: string): Promise<AurousPlan> {
    return this.readJson(
      path.join(this.runDirectory(runId), 'plan.json'),
      AurousPlanSchema,
      `plan ${runId}`,
    );
  }

  async saveResult(runId: string, result: ExecutionResult): Promise<void> {
    await this.writeJson(
      path.join(this.runDirectory(runId), 'result.json'),
      ExecutionResultSchema.parse(result),
    );
  }

  async loadResult(runId: string): Promise<ExecutionResult | undefined> {
    try {
      return await this.readJson(
        path.join(this.runDirectory(runId), 'result.json'),
        ExecutionResultSchema,
        `result ${runId}`,
      );
    } catch (error) {
      if (error instanceof AurousError && error.code === 'AUR-STATE-002') return undefined;
      throw error;
    }
  }

  async appendEvent(runId: string, event: DiagnosticEvent): Promise<void> {
    const validated = DiagnosticEventSchema.parse(redactValue(event));
    const handle = await open(path.join(this.runDirectory(runId), 'events.jsonl'), 'a', 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(validated)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async saveCommandLog(runId: string, name: string, stdout: string, stderr: string): Promise<void> {
    const safeName = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const body = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        command: safeName,
        stdout: redactText(stdout),
        stderr: redactText(stderr),
      },
      null,
      2,
    );
    await writeFile(path.join(this.runDirectory(runId), 'logs', `${safeName}.json`), `${body}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.readJson(
      path.join(this.runDirectory(runId), 'run.json'),
      RunRecordSchema,
      `run ${runId}`,
    );
  }

  async listRuns(): Promise<RunRecord[]> {
    const runsDirectory = path.join(this.stateDirectory, 'runs');
    let entries;
    try {
      entries = await readdir(runsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
        .map(async (entry) => {
          try {
            return await this.getRun(entry.name);
          } catch {
            return undefined;
          }
        }),
    );
    return records
      .filter((record): record is RunRecord => record !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readEvents(runId: string): Promise<DiagnosticEvent[]> {
    try {
      const content = await readFile(path.join(this.runDirectory(runId), 'events.jsonl'), 'utf8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => DiagnosticEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async readAgentFailureSummary(runId: string): Promise<string | undefined> {
    const logsDirectory = path.join(this.runDirectory(runId), 'logs');
    let entries;
    try {
      entries = await readdir(logsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const logs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /agent-failed\.json$/.test(entry.name))
        .map(async (entry) => {
          try {
            const value = JSON.parse(
              await readFile(path.join(logsDirectory, entry.name), 'utf8'),
            ) as unknown;
            if (!isCommandLog(value)) return undefined;
            return value;
          } catch {
            return undefined;
          }
        }),
    );
    const latest = logs
      .filter((log): log is AgentCommandLog => log !== undefined)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!latest) return undefined;
    return extractTerminalErrorSummary(latest.stderr || latest.stdout);
  }

  async saveRecoveryPlan(plan: RecoveryPlan): Promise<void> {
    const validated = RecoveryPlanSchema.parse(plan);
    await this.writeJson(
      path.join(this.runDirectory(plan.recoveryRunId), 'recovery-plan.json'),
      validated,
    );
  }

  async loadRecoveryPlan(runId: string): Promise<RecoveryPlan> {
    return this.readJson(
      path.join(this.runDirectory(runId), 'recovery-plan.json'),
      RecoveryPlanSchema,
      `recovery plan ${runId}`,
    );
  }

  async appendRecoveryCheckpoint(runId: string, checkpoint: RecoveryCheckpoint): Promise<void> {
    const validated = RecoveryCheckpointSchema.parse(redactValue(checkpoint));
    const handle = await open(
      path.join(this.runDirectory(runId), 'recovery-checkpoints.jsonl'),
      'a',
      0o600,
    );
    try {
      await handle.appendFile(`${JSON.stringify(validated)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async readRecoveryCheckpoints(runId: string): Promise<RecoveryCheckpoint[]> {
    try {
      const content = await readFile(
        path.join(this.runDirectory(runId), 'recovery-checkpoints.jsonl'),
        'utf8',
      );
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => RecoveryCheckpointSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private validateRunId(runId: string): string {
    if (!/^run-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$/.test(runId)) {
      throw new AurousError({
        code: 'AUR-STATE-001',
        summary: `Invalid run ID: ${runId}`,
        probableCause: 'The run ID was mistyped or is not an Aurous run ID.',
        nextAction: 'Run "aurous runs" and copy an existing run ID.',
      });
    }
    return runId;
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(redactValue(value), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  private async readJson<T>(
    target: string,
    schema: { parse(value: unknown): T },
    label: string,
  ): Promise<T> {
    try {
      return schema.parse(JSON.parse(await readFile(target, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AurousError({
          code: 'AUR-STATE-002',
          summary: `Could not find ${label}.`,
          probableCause: 'Aurous has not initialized this state yet, or the run ID does not exist.',
          nextAction:
            label === 'configuration'
              ? 'Run "aurous init".'
              : 'Run "aurous runs" to list saved runs.',
          cause: error,
        });
      }
      throw new AurousError({
        code: 'AUR-STATE-003',
        summary: `Could not read a valid ${label}.`,
        probableCause:
          'The local state file is malformed or was written by an incompatible version.',
        nextAction: 'Inspect the redacted file under .aurous and re-run the command.',
        cause: error,
      });
    }
  }
}

interface AgentCommandLog {
  timestamp: string;
  stdout: string;
  stderr: string;
}

function isCommandLog(value: unknown): value is AgentCommandLog {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === 'string' &&
    typeof record.stdout === 'string' &&
    typeof record.stderr === 'string'
  );
}

export function extractTerminalErrorSummary(output: string, maxCharacters = 4_000): string {
  const redacted = redactText(output.trim());
  const errorMarker = redacted.lastIndexOf('\nERROR:');
  const candidate = errorMarker >= 0 ? redacted.slice(errorMarker + 1) : tailLines(redacted, 24);
  return candidate.length <= maxCharacters ? candidate : candidate.slice(-maxCharacters);
}

function tailLines(value: string, count: number): string {
  return value.split('\n').slice(-count).join('\n');
}
