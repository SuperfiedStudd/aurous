import {
  SanitizedDiscoveryTraceSchema,
  type DiscoveryReadOperation,
  type SanitizedDiscoveryTrace,
} from '../../domain/destinations.js';
import type { ToolName } from '../../domain/schemas.js';
import { redactText } from '../../core/redact.js';

interface TraceInput {
  stdout: string;
  discoveryId: string;
  integration: ToolName;
  startedAt: string;
  completedAt: string;
}

interface PendingOperation {
  id: string;
  server: string;
  operation: string;
  startedAt: string;
}

export function buildCodexDiscoveryTrace(input: TraceInput): SanitizedDiscoveryTrace {
  const pending = new Map<string, PendingOperation>();
  const operations: DiscoveryReadOperation[] = [];
  let eventIndex = 0;
  for (const line of input.stdout.split('\n')) {
    const event = parseRecord(line);
    if (!event) continue;
    eventIndex += 1;
    const item = recordValue(event.item) ?? recordValue(recordValue(event.payload)?.item);
    if (!item || !isMcpItem(item, input.integration)) continue;
    const id = stringValue(item.id) ?? stringValue(item.call_id) ?? `event-${eventIndex}`;
    const server =
      stringValue(item.server) ??
      stringValue(item.server_name) ??
      stringValue(item.mcp_server) ??
      input.integration;
    const operation =
      stringValue(item.tool) ?? stringValue(item.tool_name) ?? stringValue(item.name) ?? 'read';
    const timestamp = safeTimestamp(event.timestamp, input.startedAt);
    const eventType = stringValue(event.type) ?? '';
    if (eventType.endsWith('.started')) {
      pending.set(id, { id, server, operation, startedAt: timestamp });
      continue;
    }
    if (!eventType.endsWith('.completed') && !eventType.endsWith('.failed')) continue;
    const started = pending.get(id);
    const error = item.error ?? event.error;
    const status = stringValue(item.status) ?? '';
    const success = !eventType.endsWith('.failed') && status !== 'failed' && error === undefined;
    operations.push({
      sequence: operations.length + 1,
      server: redactText(started?.server ?? server),
      operation: redactText(started?.operation ?? operation),
      purpose: discoveryPurpose(input.integration, started?.operation ?? operation),
      startedAt: started?.startedAt ?? timestamp,
      completedAt: safeTimestamp(event.timestamp, input.completedAt),
      success,
      returnedObjectIds: success
        ? extractReturnedObjectIds(item.result ?? item.output ?? item.structured_content)
        : [],
      ...(success ? {} : { errorCode: safeErrorCode(error) }),
    });
    pending.delete(id);
  }
  const warnings =
    operations.length === 0
      ? ['Codex did not expose any official MCP read operations in its JSON event stream.']
      : [];
  return SanitizedDiscoveryTraceSchema.parse({
    schemaVersion: 1,
    discoveryId: input.discoveryId,
    integration: input.integration,
    agent: 'codex',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    success: operations.length > 0 && operations.every((operation) => operation.success),
    sanitized: true,
    operations,
    warnings,
  });
}

function isMcpItem(item: Record<string, unknown>, integration: ToolName): boolean {
  const type = stringValue(item.type) ?? '';
  const server =
    stringValue(item.server) ?? stringValue(item.server_name) ?? stringValue(item.mcp_server) ?? '';
  const operation =
    stringValue(item.tool) ?? stringValue(item.tool_name) ?? stringValue(item.name) ?? '';
  return (
    type.includes('mcp') &&
    (server.toLocaleLowerCase().includes(integration) ||
      operation.toLocaleLowerCase().includes(integration))
  );
}

function discoveryPurpose(integration: ToolName, operation: string): string {
  const display =
    integration === 'notion'
      ? 'Notion'
      : integration === 'linear'
        ? 'Linear'
        : integration === 'airtable'
          ? 'Airtable'
          : integration === 'trello'
            ? 'Trello'
            : 'Mock';
  if (/search|query/i.test(operation))
    return `Find accessible ${display} destinations and exact project-object matches.`;
  if (/fetch|get|retrieve|inspect|read/i.test(operation))
    return `Inspect an exact ${display} object and its identity or relationships.`;
  if (/list|children/i.test(operation))
    return `List accessible ${display} destinations or related child objects.`;
  return `Read ${display} metadata required to verify a destination or existing object.`;
}

function extractReturnedObjectIds(value: unknown): string[] {
  const ids = new Set<string>();
  visit(value, undefined, ids);
  return [...ids].sort();
}

function visit(value: unknown, key: string | undefined, ids: Set<string>): void {
  if (typeof value === 'string') {
    const parsed = parseUnknownJson(value);
    if (parsed !== undefined) {
      visit(parsed, key, ids);
      return;
    }
    if (key && /(?:^|_)(?:id|ids)$|Id$/.test(key) && safeId(value)) ids.add(value);
    for (const match of value.matchAll(
      /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/gi,
    ))
      ids.add(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, key, ids);
    return;
  }
  const record = recordValue(value);
  if (!record) return;
  for (const [childKey, entry] of Object.entries(record)) visit(entry, childKey, ids);
}

function safeId(value: string): boolean {
  return (
    value.length <= 200 &&
    !/\s|https?:|token|secret|password|authorization|cookie/i.test(value) &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function safeErrorCode(value: unknown): string {
  const record = recordValue(value);
  const candidate = record ? (stringValue(record.code) ?? stringValue(record.type)) : undefined;
  return redactText(candidate ?? 'MCP_READ_FAILED').slice(0, 100);
}

function safeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function parseUnknownJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
