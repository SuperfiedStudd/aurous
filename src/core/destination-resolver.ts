import type { ProductivityAdapter } from '../adapters/productivity/types.js';
import {
  DestinationDiscoverySchema,
  ResolvedDestinationSchema,
  type DestinationCandidate,
  type DestinationDiscovery,
  type DestinationSource,
  type ResolvedDestination,
} from '../domain/destinations.js';
import type { ToolName } from '../domain/schemas.js';
import { AurousError } from './errors.js';

export interface DestinationChoiceRequest {
  integration: ToolName;
  question: string;
  candidates: DestinationCandidate[];
}

export type DestinationChooser = (request: DestinationChoiceRequest) => Promise<number | undefined>;

export interface ResolveDestinationInput {
  adapter: ProductivityAdapter;
  discovery: DestinationDiscovery;
  objective: string;
  projectName: string;
  saved?: ResolvedDestination;
  choose?: DestinationChooser;
  explicitOverride?: { id: string; name: string };
}

export async function resolveDestination(
  input: ResolveDestinationInput,
): Promise<ResolvedDestination | undefined> {
  const discovery = DestinationDiscoverySchema.parse(input.discovery);
  const { adapter } = input;
  if (input.explicitOverride) {
    const verified = discovery.candidates.find(
      (candidate) =>
        candidate.id === input.explicitOverride?.id || candidate.url === input.explicitOverride?.id,
    );
    if (!verified) {
      throw new AurousError({
        code: 'AUR-DEST-007',
        summary: 'The advanced destination override could not be verified.',
        probableCause: 'The supplied ID or URL was not returned by current read-only discovery.',
        nextAction: 'Check the override or remove it and choose a friendly destination name.',
        severity: 'recoverable',
      });
    }
    return resolved(
      adapter,
      verified,
      discovery,
      'advanced-override',
      'Explicit advanced override command.',
    );
  }

  const candidates = adapter.rankDestinationCandidates(
    discovery.candidates,
    input.objective,
    input.projectName,
  );
  const explicit = candidates.filter((candidate) =>
    containsFriendlyName(input.objective, candidate.name),
  );
  if (explicit.length === 1)
    return resolved(
      adapter,
      explicit[0]!,
      discovery,
      'explicit-instruction',
      'Matched the destination name in the user request.',
    );

  if (input.saved) {
    const verified = candidates.find((candidate) => candidate.id === input.saved?.id);
    if (verified)
      return resolved(
        adapter,
        verified,
        discovery,
        'saved-project',
        `Reverified the destination stored for this project (${input.saved.source}).`,
      );
  }

  const matching = candidates.filter((candidate) => candidate.existingAurousMatch);
  if (matching.length === 1)
    return resolved(
      adapter,
      matching[0]!,
      discovery,
      'existing-match',
      'Read-only inspection found one existing Aurous workspace match.',
    );

  if (candidates.length === 1)
    return resolved(
      adapter,
      candidates[0]!,
      discovery,
      'only-choice',
      'Read-only discovery returned one available destination.',
    );

  if (candidates.length === 0) {
    throw new AurousError({
      code: 'AUR-DEST-001',
      summary: adapter.destination.unavailableMessage,
      probableCause: 'The connected integration returned no accessible destination.',
      nextAction: adapter.destination.recoveryMessage,
      severity: 'recoverable',
    });
  }

  if (!input.choose) {
    throw new AurousError({
      code: 'AUR-DEST-002',
      summary: `Aurous found ${candidates.length} possible ${adapter.destination.pluralLabel}.`,
      probableCause: 'More than one safe destination is accessible.',
      nextAction: 'Open the Aurous shell to choose one by name.',
      severity: 'recoverable',
    });
  }
  const choice = await input.choose({
    integration: adapter.name,
    question: adapter.destination.question,
    candidates,
  });
  if (choice === undefined) return undefined;
  const candidate = candidates[choice];
  if (!candidate) {
    throw new AurousError({
      code: 'AUR-DEST-003',
      summary: 'That destination choice is not available.',
      probableCause: 'The selection was outside the displayed numbered range.',
      nextAction: `Choose a number from 1 to ${candidates.length}, or type cancel.`,
      severity: 'recoverable',
    });
  }
  return resolved(
    adapter,
    candidate,
    discovery,
    'user-choice',
    'Selected from the friendly numbered destination list.',
  );
}

function resolved(
  adapter: ProductivityAdapter,
  candidate: DestinationCandidate,
  discovery: DestinationDiscovery,
  source: DestinationSource,
  sourceDetail: string,
): ResolvedDestination {
  return ResolvedDestinationSchema.parse({
    integration: adapter.name,
    id: candidate.id,
    name: candidate.name,
    kind: candidate.kind,
    ...(candidate.url ? { url: candidate.url } : {}),
    source,
    sourceDetail,
    verifiedAt: discovery.inspectedAt,
    existingObjects: discovery.existingObjects.filter(
      (object) => object.destinationId === candidate.id,
    ),
  });
}

function containsFriendlyName(objective: string, name: string): boolean {
  const normalizedName = name.trim();
  if (normalizedName.length < 2) return false;
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:in|under|inside|within|use|using)\\s+(?:my\\s+|the\\s+)?${escaped}\\b`,
    'i',
  ).test(objective);
}
