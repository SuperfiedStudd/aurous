import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AurousCommandError, AurousError } from '../../core/errors.js';
import { redactText } from '../../core/redact.js';

export async function writeManualPrompt(
  runDirectory: string,
  phase: 'plan' | 'apply',
  prompt: string,
): Promise<string> {
  const target = path.join(runDirectory, `${phase}-manual-prompt.txt`);
  await writeFile(target, prompt, { encoding: 'utf8', mode: 0o600 });
  return target;
}

export function parseJsonPayload(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    throw invalidOutput('The agent returned no structured output.');
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(withoutFence) as unknown;
    if (isRecord(parsed) && typeof parsed.result === 'string')
      return parseJsonPayload(parsed.result);
    return parsed;
  } catch (error) {
    const first = withoutFence.indexOf('{');
    const last = withoutFence.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(withoutFence.slice(first, last + 1)) as unknown;
      } catch {
        // The classified error below is more useful than a raw JSON exception.
      }
    }
    throw invalidOutput('The agent response was not valid JSON.', error);
  }
}

export function commandFailure(
  agent: string,
  phase: 'plan' | 'apply',
  command: string[],
  stdout: string,
  stderr: string,
  timedOut: boolean,
  cancelled: boolean,
  durationMs: number,
  runId?: string,
): AurousCommandError {
  const summary = cancelled
    ? `${agent} was cancelled during ${phase}.`
    : timedOut
      ? `${agent} timed out during ${phase}.`
      : `${agent} exited unsuccessfully during ${phase}.`;
  return new AurousCommandError({
    code: cancelled ? 'AUR-AGENT-007' : timedOut ? 'AUR-AGENT-003' : 'AUR-AGENT-004',
    summary,
    probableCause: cancelled
      ? 'The user or calling process requested cancellation.'
      : redactText(stderr.trim()).slice(0, 500) ||
        'The local agent CLI returned a non-zero exit code.',
    nextAction: cancelled
      ? 'Review the run diagnostics, then create a new plan or retry apply when ready.'
      : runId
        ? `Run "aurous diagnose ${runId} --verbose", address the reported readiness issue, then retry.`
        : 'Run "aurous doctor --verbose", address the reported readiness issue, then retry.',
    severity: cancelled ? 'recoverable' : 'fatal',
    ...(runId ? { runId } : {}),
    command,
    stdout,
    stderr,
    durationMs,
  });
}

export function structuredOutputFailure(
  agent: string,
  phase: 'plan' | 'apply',
  command: string[],
  stdout: string,
  stderr: string,
  durationMs: number,
  cause: unknown,
  runId?: string,
): AurousCommandError {
  return new AurousCommandError({
    code: 'AUR-AGENT-005',
    summary: `${agent} returned an invalid or unavailable structured response during ${phase}.`,
    probableCause:
      'The agent process finished, but neither its response file nor captured stdout contained a response that matched the transport contract.',
    nextAction: runId
      ? `Run "aurous diagnose ${runId} --verbose" and retry after reviewing the terminal error.`
      : 'Run "aurous doctor --verbose" and retry.',
    ...(runId ? { runId } : {}),
    command,
    stdout,
    stderr,
    durationMs,
    cause,
  });
}

function invalidOutput(summary: string, cause?: unknown): AurousError {
  return new AurousError({
    code: 'AUR-AGENT-005',
    summary,
    probableCause: 'The agent did not honor the structured response contract.',
    nextAction:
      'Retry once. If it repeats, use the generated manual prompt and report the redacted diagnostic output.',
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
