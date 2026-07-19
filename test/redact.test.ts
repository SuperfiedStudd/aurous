import { describe, expect, it } from 'vitest';
import { redactText, redactValue } from '../src/core/redact.js';

describe('secret redaction', () => {
  it('redacts common token and authorization shapes', () => {
    const input =
      'OPENAI_API_KEY=sk-abcdefghijklmnop authorization: Bearer abcdef123 password=hunter2 ghp_abcdefghijklmnop';
    const result = redactText(input);
    expect(result).not.toContain('sk-abcdefghijklmnop');
    expect(result).not.toContain('abcdef123');
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('ghp_abcdefghijklmnop');
    expect(result).toContain('[REDACTED');
  });

  it('redacts nested structured values without mutating the input', () => {
    const input = { metadata: { apiKey: 'secret_abcdefghijk' } };
    const result = redactValue(input);
    expect(result.metadata.apiKey).toBe('[REDACTED_SECRET]');
    expect(input.metadata.apiKey).toBe('secret_abcdefghijk');
  });
});
