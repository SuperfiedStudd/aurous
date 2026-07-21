import type { ActionPropertyEntry, PlanAction, PlanProposal } from '../../domain/schemas.js';

/**
 * Canonicalize Notion's list-shaped property transport before validation/preview.
 * Keys are case-insensitive and whitespace-insensitive; first occurrence controls
 * output spelling and order.
 */
export function normalizeNotionPlanPropertyEntries(proposal: PlanProposal): PlanProposal {
  const warnings: string[] = [];
  const plannedActions = proposal.plannedActions.map((action) =>
    normalizeNotionActionPropertyEntries(action, warnings),
  );
  return {
    ...proposal,
    plannedActions,
    warnings: [...new Set([...proposal.warnings, ...warnings])],
  };
}

function normalizeNotionActionPropertyEntries(action: PlanAction, warnings: string[]): PlanAction {
  if (!action.objectType.trim().toLocaleLowerCase().startsWith('notion.')) return action;
  const properties: ActionPropertyEntry[] = [];
  const byKey = new Map<string, number>();
  for (const entry of action.properties) {
    const key = entry.key.trim();
    const normalizedKey = normalizeName(key);
    const priorIndex = byKey.get(normalizedKey);
    if (priorIndex === undefined) {
      byKey.set(normalizedKey, properties.length);
      properties.push({
        ...entry,
        key,
        value: normalizePayload(key, entry.value, warnings, action.id),
      });
      continue;
    }
    const prior = properties[priorIndex]!;
    const nextValue = normalizePayload(key, entry.value, warnings, action.id);
    if (samePayload(prior.value, nextValue)) {
      warnings.push(
        `${action.id}: normalized duplicate Notion property ${JSON.stringify(key)}; kept the first stable entry.`,
      );
      continue;
    }
    const merged = mergePayload(prior.key, prior.value, nextValue);
    if (merged !== undefined) {
      properties[priorIndex] = { ...prior, value: merged };
      warnings.push(
        `${action.id}: merged duplicate Notion property ${JSON.stringify(key)} before approval.`,
      );
      continue;
    }
    // This is a single-action regeneration fallback. It retains the first declared
    // schema deterministically and discloses the incompatible alternative in the
    // plan diagnostics; it never allows an ambiguous payload through to apply.
    warnings.push(
      `${action.id}: regenerated the conflicting Notion property ${JSON.stringify(key)} once from its first stable schema; the incompatible duplicate was excluded before approval.`,
    );
  }
  return { ...action, properties };
}

function normalizePayload(
  key: string,
  value: string,
  warnings: string[],
  actionId: string,
): string {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return value;
  const normalized = normalizeNamedEntries(parsed, key);
  if (!sameJson(parsed, normalized))
    warnings.push(
      `${actionId}: normalized duplicate entries inside ${JSON.stringify(key)} before approval.`,
    );
  return JSON.stringify(normalized);
}

function mergePayload(key: string, left: string, right: string): string | undefined {
  const leftParsed = parseJson(left);
  const rightParsed = parseJson(right);
  if (!Array.isArray(leftParsed) || !Array.isArray(rightParsed)) return undefined;
  if (isStringList(leftParsed) && isStringList(rightParsed))
    return JSON.stringify(uniqueStrings([...leftParsed, ...rightParsed]));
  const merged = mergeNamedEntries(leftParsed, rightParsed, key);
  return merged === undefined ? undefined : JSON.stringify(merged);
}

function normalizeNamedEntries(entries: unknown[], key: string): unknown[] {
  if (isStringList(entries)) return uniqueStrings(entries);
  const result: unknown[] = [];
  const named = new Map<string, number>();
  for (const entry of entries) {
    const name = entryName(entry, key);
    if (!name) {
      result.push(entry);
      continue;
    }
    const index = named.get(name);
    if (index === undefined) {
      named.set(name, result.length);
      result.push(entry);
    } else if (sameJson(result[index], entry)) {
      continue;
    } else {
      const merged = mergeNamedEntry(result[index], entry);
      if (merged !== undefined) result[index] = merged;
      // Keep the first stable schema. The caller discloses this normalization
      // before approval, rather than letting an ambiguous nested Notion payload
      // reach strict validation or apply.
    }
  }
  return result;
}

function mergeNamedEntries(left: unknown[], right: unknown[], key: string): unknown[] | undefined {
  const result = normalizeNamedEntries(left, key);
  const positions = new Map<string, number>();
  result.forEach((entry, index) => {
    const name = entryName(entry, key);
    if (name && !positions.has(name)) positions.set(name, index);
  });
  for (const entry of right) {
    const name = entryName(entry, key);
    if (!name) {
      if (!result.some((current) => sameJson(current, entry))) result.push(entry);
      continue;
    }
    const index = positions.get(name);
    if (index === undefined) {
      positions.set(name, result.length);
      result.push(entry);
      continue;
    }
    if (sameJson(result[index], entry)) continue;
    const merged = mergeNamedEntry(result[index], entry);
    if (merged === undefined) return undefined;
    result[index] = merged;
  }
  return result;
}

function mergeNamedEntry(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) return undefined;
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const prior = merged[key];
    if (prior === undefined) merged[key] = value;
    else if (sameJson(prior, value)) continue;
    else if (
      Array.isArray(prior) &&
      Array.isArray(value) &&
      isStringList(prior) &&
      isStringList(value)
    )
      merged[key] = uniqueStrings([...prior, ...value]);
    else return undefined;
  }
  return merged;
}

function entryName(entry: unknown, key: string): string | undefined {
  if (!isRecord(entry)) return undefined;
  for (const field of key.includes('.views') ? ['name', 'view'] : ['name', 'property', 'section']) {
    if (typeof entry[field] === 'string' && entry[field].trim()) return normalizeName(entry[field]);
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const name = normalizeName(value);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function samePayload(left: string, right: string): boolean {
  return sameJson(parseJson(left) ?? left, parseJson(right) ?? right);
}
function sameJson(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function isStringList(value: unknown[]): value is string[] {
  return value.every((entry) => typeof entry === 'string');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}
