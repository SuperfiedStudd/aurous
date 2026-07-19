import type { AurousPlan, ToolName } from '../../domain/schemas.js';

export interface ProductivityAdapter {
  readonly name: ToolName;
  planningInstructions(objective: string): string;
  executionInstructions(plan: AurousPlan): string;
}
