import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AurousCommandError, AurousError } from '../../core/errors.js';
import { redactText } from '../../core/redact.js';

export type AgentPhase =
  'destination-discover' | 'plan' | 'apply' | 'recover-inspect' | 'recover-apply';

export async function writeManualPrompt(
  runDirectory: string,
  phase: AgentPhase,
  prompt: string,
): Promise<string> {
  const target = path.join(runDirectory, `${phase}-manual-prompt.txt`);
  await writeFile(target, prompt, { encoding: 'utf8', mode: 0o600 });
  return target;
}

/**
 * Best-effort top-level JSON extraction: tolerates a ```json fence and surrounding prose via
 * brace-slicing. Returns undefined (never throws) and does not unwrap a `result` envelope, so
 * callers that must inspect the outer object (e.g. an is_error envelope) see it intact.
 */
export function extractJsonObject(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const first = withoutFence.indexOf('{');
    const last = withoutFence.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(withoutFence.slice(first, last + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
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

export interface McpServerBlock {
  entryLine: string;
  lines: string[];
}

/**
 * Groups `mcp list` output into per-server blocks keyed by an exact first-token match, so a
 * neighbour like `notion-proxy` never satisfies `notion` and a status on a following
 * (indented) line is still attributed to the server it belongs to.
 */
export function findMcpServerBlocks(output: string, name: string): McpServerBlock[] {
  const target = name.toLowerCase();
  const blocks: McpServerBlock[] = [];
  let current: McpServerBlock | undefined;
  for (const raw of output.split('\n')) {
    if (raw.trim() === '' || /^\s/.test(raw)) {
      if (current) current.lines.push(raw);
      continue;
    }
    const token = raw.trim().match(/[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0];
    if (token && token.toLowerCase() === target) {
      current = { entryLine: raw, lines: [raw] };
      blocks.push(current);
    } else {
      current = undefined;
    }
  }
  return blocks;
}

export function commandFailure(
  agent: string,
  phase: AgentPhase,
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
  const eventDetail = extractAgentEventError(stdout);
  return new AurousCommandError({
    code: cancelled ? 'AUR-AGENT-007' : timedOut ? 'AUR-AGENT-003' : 'AUR-AGENT-004',
    summary,
    probableCause: cancelled
      ? 'The user or calling process requested cancellation.'
      : redactText(stderr.trim() || eventDetail || '').slice(0, 500) ||
        'The local agent CLI returned a non-zero exit code.',
    nextAction: cancelled
      ? 'Review the run diagnostics, then create a new plan or retry apply when ready.'
      : phase === 'destination-discover'
        ? 'Check the integration connection, then repeat the original request.'
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

function extractAgentEventError(stdout: string): string {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.message === 'string' && event.message.trim()) {
        try {
          const nested = JSON.parse(event.message) as Record<string, unknown>;
          const error = isRecord(nested.error) ? nested.error : nested;
          if (typeof error.message === 'string' && error.message.trim())
            return error.message.trim();
        } catch {
          return event.message.trim();
        }
      }
      const error = isRecord(event.error) ? event.error : undefined;
      if (error && typeof error.message === 'string' && error.message.trim())
        return error.message.trim();
    } catch {
      // Ignore non-JSON stdout lines.
    }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function structuredOutputFailure(
  agent: string,
  phase: AgentPhase,
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
      ? phase === 'destination-discover'
        ? 'Check the integration connection, then repeat the original request.'
        : `Run "aurous diagnose ${runId} --verbose" and retry after reviewing the terminal error.`
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
