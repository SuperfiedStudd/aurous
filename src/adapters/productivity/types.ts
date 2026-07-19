import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import type { AurousPlan, PlanProposal, ToolName } from '../../domain/schemas.js';

export interface DestinationRequirement {
  kind: string;
  exactIdProperty: string;
  persistenceKey: string;
  friendlyLabel: string;
  pluralLabel: string;
  question: string;
  unavailableMessage: string;
  recoveryMessage: string;
  discoveryInstructions: string;
}

export interface ProductivityAdapter {
  readonly name: ToolName;
  readonly destination: DestinationRequirement;
  rankDestinationCandidates(
    candidates: DestinationCandidate[],
    objective: string,
    projectName: string,
  ): DestinationCandidate[];
  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal;
  destinationPlanningInstructions(destination: ResolvedDestination): string;
  planningInstructions(objective: string): string;
  executionInstructions(plan: AurousPlan): string;
}
