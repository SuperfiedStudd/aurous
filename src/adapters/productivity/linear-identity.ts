import { AurousError } from '../../core/errors.js';
import type { CreatedObject, ExecutionResult, SkippedAction } from '../../domain/schemas.js';
import { isLinearIssueUuid, looksLikeIssueKey, normalizedObjectType } from './exact-bindings.js';

export interface LinearIssueLookupMatch {
  id: string;
  identifier?: string;
  name?: string;
  url?: string;
}

export interface LinearIssueIdentityInput {
  externalId?: string | null;
  identifier?: string | null;
  url?: string | null;
  name?: string;
  /** Optional exact key→UUID lookup results for key-only create responses. */
  lookupMatches?: LinearIssueLookupMatch[];
}

export interface LinearIssueIdentity {
  externalId: string;
  identifier?: string;
  url?: string;
}

/**
 * Resolve immutable Linear issue UUID vs display key from a create/skip result payload.
 * Never returns a KEY-shaped value as externalId.
 */
export function resolveLinearIssueIdentity(input: LinearIssueIdentityInput): LinearIssueIdentity {
  const externalId = trim(input.externalId);
  const identifier = trim(input.identifier);
  const url = trim(input.url);
  const keyFromUrl = issueKeyFromUrl(url);

  const uuidCandidate = [externalId, identifier].find((value) => value && isLinearIssueUuid(value));
  const keyCandidate = [identifier, externalId, keyFromUrl].find(
    (value) => value && looksLikeIssueKey(value),
  );

  if (uuidCandidate && (!keyCandidate || !looksLikeIssueKey(uuidCandidate))) {
    return {
      externalId: uuidCandidate,
      ...(keyCandidate ? { identifier: keyCandidate } : {}),
      ...(url ? { url } : {}),
    };
  }

  if (keyCandidate) {
    const matches = input.lookupMatches ?? [];
    const exact = matches.filter((match) => {
      const matchKey = trim(match.identifier) ?? issueKeyFromUrl(match.url);
      const idIsUuid = isLinearIssueUuid(match.id);
      if (!idIsUuid) return false;
      if (matchKey) return matchKey.toLocaleUpperCase() === keyCandidate.toLocaleUpperCase();
      if (input.name && match.name) {
        return match.name.trim() === input.name.trim();
      }
      return false;
    });
    if (exact.length === 1) {
      const match = exact[0]!;
      return {
        externalId: match.id,
        identifier: keyCandidate,
        ...(url || match.url ? { url: url ?? match.url } : {}),
      };
    }
    if (exact.length === 0) {
      throw linearIdentityError(
        `Linear issue key ${JSON.stringify(keyCandidate)} could not be resolved to exactly one immutable UUID.`,
        matches.length === 0
          ? 'Create/lookup returned only a human-readable issue key, or zero UUID matches.'
          : 'Lookup matches existed but none paired the issue key with an immutable UUID.',
      );
    }
    throw linearIdentityError(
      `Linear issue key ${JSON.stringify(keyCandidate)} resolved to ${exact.length} immutable UUIDs.`,
      'Issue-key lookup was ambiguous before persistence.',
    );
  }

  if (externalId && !isLinearIssueUuid(externalId) && !looksLikeIssueKey(externalId)) {
    throw linearIdentityError(
      `Linear issue identity ${JSON.stringify(externalId)} is neither a UUID nor an issue key.`,
      'The create response did not include a usable immutable issue UUID.',
    );
  }

  throw linearIdentityError(
    'Linear issue create/skip result omitted an immutable issue UUID.',
    'The MCP response did not expose a UUID and no exact key lookup was available.',
  );
}

export function assertLinearAuthorizationId(value: string, label: string): void {
  if (looksLikeIssueKey(value) || !isLinearIssueUuid(value)) {
    throw linearIdentityError(
      `${label} cannot use ${JSON.stringify(value)}; an immutable Linear issue UUID is required.`,
      'A KEY-shaped or non-UUID value entered an authorization ID field.',
    );
  }
}

export function normalizeLinearExecutionIdentities(result: ExecutionResult): ExecutionResult {
  return {
    ...result,
    createdObjects: result.createdObjects.map((object) =>
      normalizeLinearResultObject(object, 'created'),
    ),
    skippedActions: (result.skippedActions ?? []).map((object) =>
      normalizeLinearResultObject(object, 'skipped'),
    ),
  };
}

function normalizeLinearResultObject<T extends CreatedObject | SkippedAction>(
  object: T,
  kind: 'created' | 'skipped',
): T {
  if (normalizedObjectType(object.type) !== 'issue') return object;
  const externalId = trim(object.externalId);
  const identifier = trim(object.identifier);
  const keyFromUrl = issueKeyFromUrl(object.url);
  const hasKeyShape = [externalId, identifier, keyFromUrl].some(
    (value) => value && looksLikeIssueKey(value),
  );
  const hasUuid = [externalId, identifier].some((value) => value && isLinearIssueUuid(value));
  // Enforce UUID/key separation only for live-style Linear identities. Mock IDs stay untouched.
  if (!hasKeyShape && !hasUuid) return object;

  const resolved = resolveLinearIssueIdentity({
    ...(object.externalId !== undefined ? { externalId: object.externalId } : {}),
    ...(object.identifier !== undefined ? { identifier: object.identifier } : {}),
    ...(object.url !== undefined ? { url: object.url } : {}),
    name: object.name,
  });
  assertLinearAuthorizationId(resolved.externalId, `${kind} object externalId`);
  return {
    ...object,
    externalId: resolved.externalId,
    ...(resolved.identifier ? { identifier: resolved.identifier } : { identifier: undefined }),
    ...(resolved.url ? { url: resolved.url } : {}),
  };
}

function linearIdentityError(summary: string, probableCause: string): AurousError {
  return new AurousError({
    code: 'AUR-APPLY-005',
    summary,
    probableCause,
    nextAction:
      'Stop before persisting identity. Re-fetch the issue by exact key, require exactly one UUID, then retry reporting externalId as the UUID and identifier as the issue key.',
    severity: 'recoverable',
  });
}

function issueKeyFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)\b/i);
  return match?.[1]?.toLocaleUpperCase();
}

function trim(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
