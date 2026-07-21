import { describe, expect, it } from 'vitest';
import {
  buildCodexInvocationArgs,
  extractCodexJsonLastMessage,
  mcpReadiness,
  safeCodexDiscoveryTrace,
} from '../src/adapters/agents/codex.js';
import { buildCodexDiscoveryTrace } from '../src/adapters/agents/discovery-trace.js';

describe('Codex invocation permissions', () => {
  it.each(['plan', 'recover-inspect'] as const)(
    'keeps %s invocations read-only without MCP write approval',
    (phase) => {
      const args = buildCodexInvocationArgs(phase, '/tmp/schema.json', '/tmp/output.json');

      expect(args.join(' ')).toContain('--sandbox read-only');
      expect(args).not.toContain('--strict-config');
      expect(args.join(' ')).not.toContain('default_tools_approval_mode');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    },
  );

  it('pre-approves only the selected MCP after Aurous has explicit apply approval', () => {
    const args = buildCodexInvocationArgs(
      'apply',
      '/tmp/schema.json',
      '/tmp/output.json',
      'linear',
    );

    expect(args.join(' ')).toContain('--sandbox read-only');
    expect(args).toContain('--strict-config');
    expect(args.join(' ')).toContain(
      '--config mcp_servers.linear.default_tools_approval_mode="approve"',
    );
    expect(args.join(' ')).not.toContain('mcp_servers.notion');
  });

  it('passes an explicitly selected shell model as one argv value', () => {
    const args = buildCodexInvocationArgs(
      'plan',
      '/tmp/schema.json',
      '/tmp/output.json',
      undefined,
      'gpt-5.6',
    );

    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6');
    expect(args).not.toContain('--strict-config');
  });

  it('never substitutes a different model when --model is provided', () => {
    const requested = 'gpt-5.6-terra';
    const args = buildCodexInvocationArgs(
      'destination-discover',
      '/tmp/schema.json',
      '/tmp/output.json',
      'airtable',
      requested,
    );
    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(args[modelIndex + 1]).toBe(requested);
    expect(args.filter((part) => part === '--model')).toHaveLength(1);
  });

  it.each(['notion', 'linear'] as const)(
    'pre-approves only the selected %s MCP for one approved recovery action',
    (tool) => {
      const args = buildCodexInvocationArgs(
        'recover-apply',
        '/tmp/schema.json',
        '/tmp/output.json',
        tool,
      );

      expect(args.join(' ')).toContain('--sandbox read-only');
      expect(args).toContain('--strict-config');
      expect(args.join(' ')).toContain(
        `--config mcp_servers.${tool}.default_tools_approval_mode="approve"`,
      );
      expect(args.join(' ')).not.toContain(
        `mcp_servers.${tool === 'notion' ? 'linear' : 'notion'}`,
      );
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--ask-for-approval');
    },
  );

  it('emits JSON events only for auditable destination discovery', () => {
    const discovery = buildCodexInvocationArgs(
      'destination-discover',
      '/tmp/schema.json',
      '/tmp/output.json',
      'notion',
    );
    const plan = buildCodexInvocationArgs('plan', '/tmp/schema.json', '/tmp/output.json');

    expect(discovery).toContain('--json');
    expect(plan).not.toContain('--json');
  });

  it('reduces Codex MCP events to a sanitized discovery audit trace', () => {
    const id = '3a2c0122-d292-8130-bde0-f68012dac01a';
    const stdout = [
      JSON.stringify({
        timestamp: '2026-07-19T20:00:00.000Z',
        type: 'item.started',
        item: {
          id: 'call-1',
          type: 'mcp_tool_call',
          server: 'notion',
          tool: 'notion-search',
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-19T20:00:01.000Z',
        type: 'item.completed',
        item: {
          id: 'call-1',
          type: 'mcp_tool_call',
          server: 'notion',
          tool: 'notion-search',
          status: 'completed',
          result: {
            content: [{ text: JSON.stringify({ results: [{ id, token: 'ntn_secret-value' }] }) }],
          },
        },
      }),
    ].join('\n');

    const trace = buildCodexDiscoveryTrace({
      stdout,
      discoveryId: 'discovery-20260719T200000Z-abc123',
      integration: 'notion',
      startedAt: '2026-07-19T20:00:00.000Z',
      completedAt: '2026-07-19T20:00:01.000Z',
    });

    expect(trace).toMatchObject({ success: true, sanitized: true });
    expect(trace.operations).toHaveLength(1);
    expect(trace.operations[0]).toMatchObject({
      operation: 'notion-search',
      purpose: 'Find accessible Notion destinations and exact project-object matches.',
      success: true,
      returnedObjectIds: [id],
    });
    expect(JSON.stringify(trace)).not.toContain('ntn_secret-value');
  });

  it('does not treat a neighbouring server as the requested MCP', () => {
    const readiness = mcpReadiness(0, 'notion-proxy: connected\n', 'notion');
    expect(readiness.status).toBe('not-ready');
    expect(readiness.detail).toContain('was not listed');
  });

  it('honors a failed status reported on the line after the server name', () => {
    const output = ['notion', '  status: failed to connect', 'linear: connected'].join('\n');
    expect(mcpReadiness(0, output, 'notion').status).toBe('not-ready');
    expect(mcpReadiness(0, output, 'linear').status).toBe('ready');
  });

  it('marks an exactly-named connected server ready without cross-contamination', () => {
    const output = ['notion: connected', 'linear: failed to connect'].join('\n');
    expect(mcpReadiness(0, output, 'notion').status).toBe('ready');
    expect(mcpReadiness(0, output, 'linear').status).toBe('not-ready');
  });

  it('reports unknown readiness when the listing command itself failed', () => {
    expect(mcpReadiness(1, '', 'notion').status).toBe('unknown');
  });

  it('returns the valid discovery trace when the event stream can be reduced', () => {
    const trace = safeCodexDiscoveryTrace({
      stdout: '',
      discoveryId: 'discovery-1',
      integration: 'notion',
      startedAt: '2026-07-19T20:00:00.000Z',
      completedAt: '2026-07-19T20:00:01.000Z',
    });
    expect(trace.discoveryId).toBe('discovery-1');
    expect(trace.sanitized).toBe(true);
  });

  it('degrades to a placeholder trace instead of throwing when trace construction fails', () => {
    const trace = safeCodexDiscoveryTrace({
      stdout: '',
      discoveryId: 'discovery-2',
      integration: 'linear',
      startedAt: 'not-a-timestamp',
      completedAt: 'not-a-timestamp',
    });
    expect(trace.integration).toBe('linear');
    expect(trace.discoveryId).toBe('discovery-2');
    expect(trace.success).toBe(false);
    expect(trace.operations).toHaveLength(0);
    expect(trace.warnings.join(' ')).toMatch(/audit is unavailable/i);
  });

  it('recovers the structured final message from a Codex JSON event stream', () => {
    const expected = JSON.stringify({ integration: 'notion', candidates: [] });
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: expected },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');

    expect(extractCodexJsonLastMessage(stdout)).toBe(expected);
  });
});
