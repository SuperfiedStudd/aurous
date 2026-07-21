const redactionRules: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(secret_[A-Za-z0-9_-]{8,})\b/gi, '[REDACTED_SECRET]'],
  [/\b(ntn_[A-Za-z0-9_-]{8,})\b/gi, '[REDACTED_NOTION_TOKEN]'],
  [/\b(lin_api_[A-Za-z0-9_-]{8,})\b/gi, '[REDACTED_LINEAR_TOKEN]'],
  [/\b(gh[opusr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"\\]+/gi, '$1[REDACTED]'],
  [
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(\s*[:=]\s*)[^\s,;"\\]+/gi,
    '$1$2[REDACTED]',
  ],
  [
    /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)"\s*:\s*")(?!\[REDACTED)((?:[^"\\]|\\.)*)(")/gi,
    '$1[REDACTED]$3',
  ],
  [
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  ],
];

export function redactText(value: string): string {
  return redactionRules.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    value,
  );
}

export function redactValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  return JSON.parse(redactText(serialized)) as T;
}
