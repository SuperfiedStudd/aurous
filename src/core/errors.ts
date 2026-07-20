import type { Severity } from '../domain/schemas.js';

export interface AurousErrorOptions {
  code: string;
  summary: string;
  probableCause: string;
  nextAction: string;
  severity?: Severity;
  runId?: string;
  cause?: unknown;
}

export class AurousError extends Error {
  readonly code: string;
  readonly probableCause: string;
  readonly nextAction: string;
  readonly severity: Severity;
  readonly runId?: string;

  constructor(options: AurousErrorOptions) {
    super(options.summary, { cause: options.cause });
    this.name = 'AurousError';
    this.code = options.code;
    this.probableCause = options.probableCause;
    this.nextAction = options.nextAction;
    this.severity = options.severity ?? 'fatal';
    if (options.runId !== undefined) this.runId = options.runId;
  }
}

export interface AurousCommandErrorOptions extends AurousErrorOptions {
  command: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class AurousCommandError extends AurousError {
  readonly command: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;

  constructor(options: AurousCommandErrorOptions) {
    super(options);
    this.name = 'AurousCommandError';
    this.command = options.command;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.durationMs = options.durationMs;
  }
}

export function asAurousError(error: unknown, runId?: string): AurousError {
  if (error instanceof AurousError) {
    if (!runId || error.runId) return error;
    return new AurousError({
      code: error.code,
      summary: error.message,
      probableCause: error.probableCause,
      nextAction: error.nextAction,
      severity: error.severity,
      runId,
      cause: error.cause,
    });
  }
  return new AurousError({
    code: 'AUR-CORE-001',
    summary: error instanceof Error ? error.message : 'An unexpected error occurred.',
    probableCause: 'Aurous encountered an error it could not classify.',
    nextAction: runId
      ? `Run "aurous diagnose ${runId} --verbose" and share the redacted output.`
      : 'Re-run with --verbose, then share the redacted output.',
    ...(runId ? { runId } : {}),
    cause: error,
  });
}
