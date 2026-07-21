import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';
import type {
  DestinationCandidate,
  DestinationDiscovery,
  DiscoveredObject,
  ResolvedDestination,
} from '../../domain/destinations.js';
import type { PlanProposal } from '../../domain/schemas.js';
import { AurousError } from '../../core/errors.js';
import {
  exactBindingWarnings,
  isLinearIssueUuid,
  looksLikeIssueKey,
  normalizeNullishProperties,
  normalizeRelationAction,
  normalizedObjectType,
  propertyValue,
  resolveExactObject,
  setProperty,
  stampExactExternalId,
} from './exact-bindings.js';
import {
  LINEAR_ISSUE_KEY_IDENTITY,
  discoveredIssueKey,
  isCanonicalLinearIssueIdentity,
} from './linear-identity.js';
import { ensureLinearPersonalRootPlan } from './linear-onboarding.js';
import { normalizeLinearPlanCapabilities } from './linear-plan-capabilities.js';

export class LinearAdapter implements ProductivityAdapter {
  readonly name = 'linear' as const;
  readonly destination = {
    kind: 'team',
    exactIdProperty: 'linear.teamId',
    persistenceKey: 'destinations.linear',
    friendlyLabel: 'Linear team',
    pluralLabel: 'Linear teams',
    question: 'Which team should Aurous use?',
    unavailableMessage:
      'Aurous cannot access a Linear team yet; ask a workspace admin to grant the connected account access, then try again.',
    recoveryMessage: 'Ask a Linear workspace admin to give the connected account access to a team.',
    discoveryInstructions: `Use only the official Linear MCP and perform read-only calls. Discover every accessible writable team and preserve each exact team ID and friendly name. Omit deleted, archived, inaccessible, or read-only teams from candidates.

For personal life/work onboarding, prefer an active writable team and inspect an exact operating project matching the derived name such as "Life OS". Do NOT prefer unrelated product-demo projects such as "Aurous Project" unless the user explicitly names them. For software-project onboarding, also search for an existing exact or likely project match for the supplied project name.

For each team, inspect matching projects, milestones, labels, and issues relevant to the supplied project name and objective.

LINEAR ISSUE IDENTITY CONTRACT:
- Official Linear MCP commonly exposes the human-readable issue key such as JAS-17 as the only stable fetchable issue identity.
- For every inspected issue, set existingObjects[].id to the MCP-canonical issue identity: prefer a UUID when the MCP returns a fetchable UUID; otherwise use the exact TEAM-NUMBER issue key returned by get_issue/list_issues.
- Always put the human-readable key in existingObjects[].identifier as well when known.
- Include an issue only when discovery found exactly one match for that identity in the approved team. Zero or ambiguous matches must be omitted with a warning.
- Never invent IDs. Never put prose titles in existingObjects[].id.
- Mark an existingAurousMatch only when an exact object inspection supports it. Never create, update, archive, or delete anything.`,
  } as const;

  rankDestinationCandidates(candidates: DestinationCandidate[]): DestinationCandidate[] {
    return [...candidates].sort((a, b) => {
      if (a.existingAurousMatch !== b.existingAurousMatch) return a.existingAurousMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  destinationPlanningInstructions(destination: ResolvedDestination): string {
    return `The exact approved Linear team ID is ${JSON.stringify(destination.id)} (${destination.name}). Put linear.teamId=${JSON.stringify(destination.id)} and linear.team=${JSON.stringify(destination.name)} on every action. Existing projects, milestones, labels, and issues may be reused only by exact identities from the discovery snapshot. When reusing an issue discovered by UUID, set both linear.issueId and linear.dedupe.knownExternalId to that UUID. When reusing an issue discovered only by its MCP issue key, set linear.identityType=${JSON.stringify(LINEAR_ISSUE_KEY_IDENTITY)}, linear.issueKey to that key, and linear.dedupe.knownExternalId to the same key—never invent a UUID. Names and prose alone never authorize mutation. When an issue belongs to an inspected existing project, include both linear.project (friendly display name) and linear.projectId (its exact discovered ID). Likewise pair existing milestone and label names with linear.milestoneId and linear.labelIds.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    const withRoot = ensureLinearPersonalRootPlan(proposal, destination);
    const capabilityNormalized = normalizeLinearPlanCapabilities(withRoot);
    return {
      ...capabilityNormalized,
      plannedActions: capabilityNormalized.plannedActions.map((action) => {
        const normalized = normalizeRelationAction(action, 'linear');
        const projectId = propertyValue(normalized.properties, 'linear.projectId');
        const existing = resolveExactObject(
          destination,
          normalized,
          'linear',
          projectId ?? undefined,
        );
        const properties = normalizeNullishProperties(
          normalized.properties.filter((property) => {
            if (property.key === 'linear.team' || property.key === 'linear.teamId') return false;
            if (property.key === 'linear.dedupe.identitySource') return false;
            if (
              existing &&
              (property.key === 'linear.dedupe.knownExternalId' ||
                property.key === 'linear.dedupe.knownUrl' ||
                property.key === 'linear.issueId' ||
                property.key === 'linear.issueKey' ||
                property.key === 'linear.identityType')
            )
              return false;
            return true;
          }),
        );
        properties.push(
          { key: 'linear.team', value: destination.name },
          { key: 'linear.teamId', value: destination.id },
        );
        let bound = { ...normalized, properties };
        if (existing) {
          bound = stampExactExternalId(bound, existing, 'linear', 'Reuse');
          const issueKey =
            discoveredIssueKey(existing) ??
            [
              propertyValue(action.properties, ['linear.issueKey', 'issueKey']),
              propertyValue(action.properties, ['linear.issueId', 'issueId']),
              action.target,
            ].find((value) => value && looksLikeIssueKey(value));
          if (looksLikeIssueKey(existing.id) && !isLinearIssueUuid(existing.id)) {
            const key = issueKey ?? existing.id;
            setProperty(bound.properties, 'linear.identityType', LINEAR_ISSUE_KEY_IDENTITY);
            setProperty(bound.properties, 'linear.issueKey', key);
            setProperty(bound.properties, 'linear.dedupe.knownExternalId', key);
            setProperty(bound.properties, 'linear.issueId', key);
          } else {
            if (issueKey) setProperty(bound.properties, 'linear.issueKey', issueKey);
            setProperty(bound.properties, 'linear.issueId', existing.id);
          }
        }
        bindLinearRelationshipIds(bound.properties, destination);
        return bound;
      }),
      assumptions: [
        ...capabilityNormalized.assumptions,
        `The exact verified Linear team is ${destination.name}; its internal ID is embedded in every action.`,
        ...(destination.operatingRootName
          ? [
              `Operating project ${destination.operatingRootName} is selected automatically from the current request.`,
            ]
          : []),
      ],
      warnings: [
        ...new Set([
          ...capabilityNormalized.warnings,
          ...exactBindingWarnings(destination, capabilityNormalized.plannedActions),
        ]),
      ],
    };
  }

  planningInstructions(objective: string): string {
    return `Design a Linear-native workspace for this objective: ${objective}

Prefer a focused project with a clear description, milestones or cycles only when appropriate, actionable issues, labels, priorities, and explicit relationships. Use Linear's project and issue semantics rather than imitating a generic database. Every issue should have a purposeful title, description, priority, labels, and project/milestone relationship in action properties. Do not create anything during planning.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Use only the configured official Linear MCP. The approved plan contains ${plan.plannedActions.length} actions.

LINEAR DEMO CONTRACT:
- Resolve only the exact approved team ID from linear.teamId. linear.team is display-only. Before writes, inspect that team's statuses and resolve the assignee token. Never select a different team.
- Resolve project, milestone, and label relationships from linear.projectId, linear.milestoneId, and linear.labelIds when present. Their friendly-name properties are display-only and cannot authorize a relationship.
- Execute actions in dependency order. Map linear.* properties directly to the official MCP fields for project, issue label, milestone, and issue creation.
- If an action has linear.dedupe.knownExternalId, fetch that exact MCP identity first (UUID, or TEAM-NUMBER key when linear.identityType=linear-issue-key) and verify its type, title/name, approved team, and approved project where applicable. A compatible exact-ID match must be skipped and is authoritative even if same-title duplicates exist. Exclude that action from all name inventories. If exact-ID verification fails, fail the action and do not fall back to name lookup or creation. Never invent a UUID when only an issue key is present.
- Label exact-ID verification uses the MCP capability that actually exists: call list_issue_labels once for the approved team with limit 250 and no name filter, locate each known label by its exact ID, then verify its exact name. This is exact-ID verification, not name fallback. If the known label ID is absent or its name differs, fail that action and never create a replacement.
- For approved targets without a known external ID, perform narrowly scoped exact-name lookup using the approved team/project. Do not browse unrelated objects.
- For issue actions without linear.dedupe.knownExternalId, deduplication is a mandatory single inventory step: call list_issues once for the approved team and project with limit 250 and no query, assignee, state, label, or ordering filters. Compare only the unguarded approved issue targets against the returned titles case-sensitively. Never use list_issues.query for deduplication. If every approved issue action has a known external ID, do not call list_issues. If one or more exact-title matches exist for an unguarded action, do not create it; skip a single compatible match and fail visibly on ambiguous or incompatible matches.
- If exactly one compatible target already exists, make no write, include the action ID in completedActionIds, and add a skippedActions entry with its exact ID and URL. If matches are ambiguous or incompatible, fail the action visibly.
- createdObjects contains only objects written by this run. For every created or skipped Linear issue, set externalId to the MCP-canonical fetchable identity: prefer a UUID when the MCP returns one; otherwise use the TEAM-NUMBER issue key. Always set identifier to the human-readable key such as JAS-17 when known.
- After save_issue (or equivalent create), call get_issue on the returned key. Prefer persisting a UUID when the payload exposes a fetchable UUID-shaped issue identity. If the MCP exposes only the issue key, persist that key as externalId and identifier—do not invent a UUID.
- Preserve the exact URL returned by Linear when available; do not invent IDs or URLs.
- Preserve project relationships, milestone relationships, descriptions, numeric priorities, states, assignee, and labels exactly when supported.
- The connected MCP supports create_issue_label, save_project, save_milestone, and save_issue. Do not substitute documents, cycles, or comments.
- If a requested field is unsupported or a workspace convention is unavailable, omit or adjust that field only when the core object can still be useful, and describe the exact adjustment in compatibilityNotes. Never silently degrade.
- Do not update, archive, delete, or create anything outside the approved actions.`;
  }
}

/** Accept Linear MCP issue identities: fetchable UUID or uniquely verified TEAM-NUMBER key. */
export function validateLinearDiscoveryIssues(discovery: DestinationDiscovery): void {
  const issues = discovery.existingObjects.filter((object) => exactObjectTypeMatchesIssue(object));
  for (const issue of issues) {
    if (!isCanonicalLinearIssueIdentity(issue)) {
      throw new AurousError({
        code: 'AUR-DEST-010',
        summary: `Linear discovery reported issue ${JSON.stringify(issue.name)} without a usable MCP issue identity.`,
        probableCause:
          'The inspected issue ID was neither a Linear issue UUID nor a well-formed TEAM-NUMBER issue key.',
        nextAction:
          'No writes occurred. Re-run discovery and set each issue id to its MCP-canonical identity (UUID or issue key).',
      });
    }
    if (!issue.destinationId) {
      throw new AurousError({
        code: 'AUR-DEST-010',
        summary: `Linear discovery reported issue ${JSON.stringify(issue.name)} without a team destinationId.`,
        probableCause: 'Issue identity cannot be scoped to the connected Linear team.',
        nextAction:
          'No writes occurred. Re-run discovery and attach the approved team ID to each issue.',
      });
    }
    const candidateIds = new Set(discovery.candidates.map((candidate) => candidate.id));
    if (candidateIds.size > 0 && !candidateIds.has(issue.destinationId)) {
      throw new AurousError({
        code: 'AUR-DEST-010',
        summary: `Linear discovery reported issue ${JSON.stringify(issue.name)} on team ${JSON.stringify(issue.destinationId)} outside the discovered candidates.`,
        probableCause:
          'Issue identity was not scoped to an accessible Linear team in this discovery.',
        nextAction:
          'No writes occurred. Re-run discovery and keep each issue within an inspected team.',
      });
    }
    const key = discoveredIssueKey(issue);
    if (key) {
      const collisions = issues.filter(
        (candidate) =>
          candidate.id !== issue.id &&
          discoveredIssueKey(candidate)?.toLocaleUpperCase() === key.toLocaleUpperCase(),
      );
      if (collisions.length > 0) {
        throw new AurousError({
          code: 'AUR-DEST-010',
          summary: `Linear discovery mapped issue key ${JSON.stringify(key)} to multiple issues.`,
          probableCause: 'Issue-key lookup would be ambiguous before planning authorization.',
          nextAction:
            'No writes occurred. Narrow discovery or resolve the duplicate key mapping before planning.',
        });
      }
    }
  }
}

function exactObjectTypeMatchesIssue(object: DiscoveredObject): boolean {
  return normalizedObjectType(object.type) === 'issue';
}

function bindLinearRelationshipIds(
  properties: PlanProposal['plannedActions'][number]['properties'],
  destination: ResolvedDestination,
): void {
  bindSingleRelationship(properties, destination, ['linear.project', 'project'], 'project');
  bindSingleRelationship(properties, destination, ['linear.milestone', 'milestone'], 'milestone');
  const labels = propertyValue(properties, ['linear.labels', 'labels']);
  if (!labels) return;
  let names: string[];
  try {
    const parsed = JSON.parse(labels) as unknown;
    names = Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    names = [];
  }
  const ids = names.map(
    (name) =>
      destination.existingObjects.find(
        (object) => normalizedObjectType(object.type) === 'label' && object.name === name,
      )?.id,
  );
  if (ids.length === names.length && ids.every(Boolean))
    setProperty(properties, 'linear.labelIds', JSON.stringify(ids));
}

function bindSingleRelationship(
  properties: PlanProposal['plannedActions'][number]['properties'],
  destination: ResolvedDestination,
  nameKeys: string[],
  type: string,
): void {
  const name = propertyValue(properties, nameKeys);
  if (!name) return;
  const matches = destination.existingObjects
    .filter((object) => normalizedObjectType(object.type) === type && object.name === name)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  if (matches[0]) setProperty(properties, `linear.${type}Id`, matches[0].id);
}
