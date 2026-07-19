import type { DestinationCandidate, ResolvedDestination } from '../../domain/destinations.js';
import type { AurousPlan, PlanProposal } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';

export class MockProductivityAdapter implements ProductivityAdapter {
  readonly name = 'mock' as const;
  readonly destination = {
    kind: 'workspace',
    exactIdProperty: 'mock.workspaceId',
    persistenceKey: 'destinations.mock',
    friendlyLabel: 'mock workspace',
    pluralLabel: 'mock workspaces',
    question: 'Which workspace should Aurous use?',
    unavailableMessage: 'Aurous could not find a mock workspace.',
    recoveryMessage: 'Reset the deterministic mock fixture and retry.',
    discoveryInstructions:
      'Return deterministic local-only destinations. Perform no external calls.',
  } as const;

  rankDestinationCandidates(candidates: DestinationCandidate[]): DestinationCandidate[] {
    return [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  }

  destinationPlanningInstructions(destination: ResolvedDestination): string {
    return `Use exact local mock workspace ${destination.id}.`;
  }

  bindDestination(proposal: PlanProposal, destination: ResolvedDestination): PlanProposal {
    return {
      ...proposal,
      plannedActions: proposal.plannedActions.map((action) => ({
        ...action,
        properties: [
          ...action.properties.filter((property) => property.key !== 'mock.workspaceId'),
          { key: 'mock.workspaceId', value: destination.id },
        ],
      })),
    };
  }

  planningInstructions(objective: string): string {
    return `Create a deterministic mock productivity workspace plan for: ${objective}. No external calls are available.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Simulate exactly ${plan.plannedActions.length} approved actions without external writes.`;
  }
}
