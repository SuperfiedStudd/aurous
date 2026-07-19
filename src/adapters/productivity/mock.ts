import type { AurousPlan } from '../../domain/schemas.js';
import type { ProductivityAdapter } from './types.js';

export class MockProductivityAdapter implements ProductivityAdapter {
  readonly name = 'mock' as const;

  planningInstructions(objective: string): string {
    return `Create a deterministic mock productivity workspace plan for: ${objective}. No external calls are available.`;
  }

  executionInstructions(plan: AurousPlan): string {
    return `Simulate exactly ${plan.plannedActions.length} approved actions without external writes.`;
  }
}
