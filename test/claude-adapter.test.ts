import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import {
  classifyClaudeInvocationOutput,
  claudeMcpReadiness,
  readClaudeErrorEnvelope,
} from '../src/adapters/agents/claude.js';
import { AurousError } from '../src/core/errors.js';

const Shape = z.object({ plan: z.string() });

function classify(stdout: string): unknown {
  return classifyClaudeInvocationOutput(
    (value) => Shape.parse(value),
    'plan',
    ['claude', '--print', '--output-format', 'json'],
    stdout,
    '',
    12,
    'run-1',
  );
}

function classifyError(stdout: string): AurousError {
  try {
    classify(stdout);
  } catch (error) {
    return error as AurousError;
  }
  throw new Error('expected classifyClaudeInvocationOutput to throw');
}

describe('Claude structured-output classification', () => {
  it('parses a well-formed Claude result envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: false,
      result: JSON.stringify({ plan: 'ok' }),
      session_id: 'abc',
    });
    expect(classify(stdout)).toEqual({ plan: 'ok' });
  });

  it('fails valid-JSON-but-wrong-shape output as AUR-AGENT-005, never a ZodError', () => {
    const error = classifyError('{"wrong":"shape"}');
    expect(error).toBeInstanceOf(AurousError);
    expect(error).not.toBeInstanceOf(ZodError);
    expect(error.code).toBe('AUR-AGENT-005');
  });

  it('classifies an is_error result envelope as a failure with the envelope text', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Claude Code could not reach the requested tool.',
      session_id: 'abc',
    });
    const error = classifyError(stdout);
    expect(error).toBeInstanceOf(AurousError);
    expect(error.code).toBe('AUR-AGENT-005');
    expect(error.probableCause).toContain('could not reach the requested tool');
  });

  it('classifies a code-fenced is_error envelope with the envelope text', () => {
    const stdout = [
      '```json',
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Claude Code aborted before writing structured output.',
        session_id: 'abc',
      }),
      '```',
    ].join('\n');
    const error = classifyError(stdout);
    expect(error.code).toBe('AUR-AGENT-005');
    expect(error.probableCause).toContain('aborted before writing structured output');
  });

  it('redacts secrets carried in an is_error envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'auth failed for ntn_abc123def456ghi789 while connecting',
      session_id: 'abc',
    });
    const error = classifyError(stdout);
    expect(error.probableCause).not.toContain('ntn_abc123def456ghi789');
    expect(error.probableCause).toContain('[REDACTED_NOTION_TOKEN]');
  });

  it('does not treat an ordinary payload with an is_error field as the failure envelope', () => {
    expect(readClaudeErrorEnvelope(JSON.stringify({ is_error: true, plan: 'x' }))).toBeUndefined();
  });
});

describe('Claude MCP readiness', () => {
  it('does not treat a neighbouring server as the requested MCP', () => {
    const readiness = claudeMcpReadiness(0, 'notion-proxy: connected\n', 'notion');
    expect(readiness.status).toBe('not-ready');
    expect(readiness.detail).toContain('was not listed');
  });

  it('honors a failed status reported on the line after the server name', () => {
    const output = ['notion', '  status: failed to connect', 'linear: connected'].join('\n');
    expect(claudeMcpReadiness(0, output, 'notion').status).toBe('not-ready');
    expect(claudeMcpReadiness(0, output, 'linear').status).toBe('ready');
  });

  it('marks an exactly-named connected server ready without cross-contamination', () => {
    const output = ['notion: connected', 'linear: failed to connect'].join('\n');
    expect(claudeMcpReadiness(0, output, 'notion').status).toBe('ready');
    expect(claudeMcpReadiness(0, output, 'linear').status).toBe('not-ready');
  });

  it('reports unknown readiness when the listing command itself failed', () => {
    expect(claudeMcpReadiness(1, '', 'notion').status).toBe('unknown');
  });
});
