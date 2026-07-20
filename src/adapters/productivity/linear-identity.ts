import type { DiscoveredObject, ResolvedDestination } from '../../domain/destinations.js';
import { AurousError } from '../../core/errors.js';
import type {
  CreatedObject,
  ExecutionResult,
  PlanAction,
  SkippedAction,
} from '../../domain/schemas.js';
import {
  isLinearIssueUuid,
  linearIssueKeyFromObject,
  looksLikeIssueKey,
  normalizedObjectType,
  propertyValue,
} from './exact-bindings.js';

/** Canonical MCP identity for Linear issues when the provider exposes only a TEAM-NUMBER key. */
export const LINEAR_ISSUE_KEY_IDENTITY = 'linear-issue-key' as const;

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
  /** Optional exact key→UUID lookup results when a UUID is available. */
  lookupMatches?: LinearIssueLookupMatch[];
}

export interface LinearIssueIdentity {
  externalId: string;
  identifier?: string;
  url?: string;
  identityType?: typeof LINEAR_ISSUE_KEY_IDENTITY;
}

/**
 * Resolve Linear issue identity from a create/skip result.
 * Prefers UUID when present; otherwise persists a well-formed MCP issue key as canonical externalId.
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
    if (exact.length > 1) {
      throw linearIdentityError(
        `Linear issue key ${JSON.stringify(keyCandidate)} resolved to ${exact.length} immutable UUIDs.`,
        'Issue-key lookup was ambiguous before persistence.',
      );
    }
    // Official Linear MCP often exposes only the fetchable issue key. Persist it as the
    // provider canonical identity (not as a UUID) when no UUID lookup succeeded.
    return {
      externalId: keyCandidate,
      identifier: keyCandidate,
      identityType: LINEAR_ISSUE_KEY_IDENTITY,
      ...(url ? { url } : {}),
    };
  }

  if (externalId && !isLinearIssueUuid(externalId) && !looksLikeIssueKey(externalId)) {
    throw linearIdentityError(
      `Linear issue identity ${JSON.stringify(externalId)} is neither a UUID nor an issue key.`,
      'The create response did not include a usable Linear issue identity.',
    );
  }

  throw linearIdentityError(
    'Linear issue create/skip result omitted a usable issue identity.',
    'The MCP response did not expose a UUID or a well-formed issue key.',
  );
}

export function assertLinearAuthorizationId(value: string, label: string): void {
  if (isLinearIssueUuid(value) || looksLikeIssueKey(value)) return;
  throw linearIdentityError(
    `${label} cannot use ${JSON.stringify(value)}; a Linear issue UUID or verified issue key is required.`,
    'A non-canonical value entered an authorization ID field.',
  );
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

/** True when the action carries a fully structured Linear issue-key identity claim. */
export function hasLinearIssueKeyIdentityClaim(action: PlanAction): boolean {
  return (
    propertyValue(action.properties, 'linear.identityType') === LINEAR_ISSUE_KEY_IDENTITY &&
    Boolean(propertyValue(action.properties, 'linear.issueKey')) &&
    Boolean(propertyValue(action.properties, 'linear.dedupe.knownExternalId'))
  );
}

/**
 * Authorize a Linear issue-key identity only when discovery uniquely verified that key
 * on the connected team. Planner/prose-only keys never pass.
 */
export function resolveVerifiedLinearIssueKey(
  action: PlanAction,
  destination: ResolvedDestination,
): DiscoveredObject | undefined {
  if (destination.integration !== 'linear') return undefined;
  if (normalizedObjectType(action.objectType) !== 'issue') return undefined;
  if (propertyValue(action.properties, 'linear.identityType') !== LINEAR_ISSUE_KEY_IDENTITY) {
    return undefined;
  }

  const issueKey = propertyValue(action.properties, 'linear.issueKey');
  const knownId = propertyValue(action.properties, 'linear.dedupe.knownExternalId');
  if (!issueKey || !knownId) return undefined;
  if (!looksLikeIssueKey(issueKey) || !looksLikeIssueKey(knownId)) {
    throw unverifiedLinearIssueKeyError(
      action,
      `Issue key fields must match Linear TEAM-NUMBER format; got ${JSON.stringify(issueKey)} / ${JSON.stringify(knownId)}.`,
    );
  }
  if (issueKey.toLocaleUpperCase() !== knownId.toLocaleUpperCase()) {
    throw unverifiedLinearIssueKeyError(
      action,
      `linear.issueKey ${JSON.stringify(issueKey)} does not match linear.dedupe.knownExternalId ${JSON.stringify(knownId)}.`,
    );
  }

  const teamId = propertyValue(action.properties, 'linear.teamId') ?? destination.id;
  if (teamId !== destination.id) {
    throw unverifiedLinearIssueKeyError(
      action,
      `linear.teamId ${JSON.stringify(teamId)} does not match the connected team ${JSON.stringify(destination.id)}.`,
    );
  }

  const matches = destination.existingObjects.filter(
    (object) =>
      normalizedObjectType(object.type) === 'issue' &&
      object.destinationId === destination.id &&
      discoveredIssueKey(object)?.toLocaleUpperCase() === issueKey.toLocaleUpperCase(),
  );
  if (matches.length === 0) {
    throw unverifiedLinearIssueKeyError(
      action,
      `Discovered Linear issues do not include verified key ${JSON.stringify(issueKey)}.`,
    );
  }
  if (matches.length > 1) {
    throw unverifiedLinearIssueKeyError(
      action,
      `Discovered Linear key ${JSON.stringify(issueKey)} matched ${matches.length} issues.`,
    );
  }
  return matches[0];
}

export function discoveredIssueKey(object: DiscoveredObject): string | undefined {
  if (looksLikeIssueKey(object.id)) return object.id;
  return linearIssueKeyFromObject(object);
}

export function isCanonicalLinearIssueIdentity(object: DiscoveredObject): boolean {
  if (normalizedObjectType(object.type) !== 'issue') return true;
  return isLinearIssueUuid(object.id) || looksLikeIssueKey(object.id);
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

function unverifiedLinearIssueKeyError(action: PlanAction, probableCause: string): AurousError {
  return new AurousError({
    code: 'AUR-PLAN-010',
    summary: `Action ${action.id} cannot authorize a Linear issue with an unverified issue key.`,
    probableCause,
    nextAction:
      'No writes were attempted. Re-run Linear discovery and bind a uniquely inspected issue key with linear.identityType=linear-issue-key.',
  });
}

function linearIdentityError(summary: string, probableCause: string): AurousError {
  return new AurousError({
    code: 'AUR-APPLY-005',
    summary,
    probableCause,
    nextAction:
      'Stop before persisting identity. Re-fetch the issue, require a usable Linear MCP identity, then retry.',
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
