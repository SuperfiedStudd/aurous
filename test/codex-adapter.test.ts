import { describe, expect, it } from 'vitest';
import { buildCodexInvocationArgs } from '../src/adapters/agents/codex.js';

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
});
