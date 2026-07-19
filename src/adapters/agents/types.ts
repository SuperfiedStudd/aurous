import type {
  AgentName,
  AurousPlan,
  ContextBundle,
  ExecutionResult,
  PlanProposal,
  ToolName,
} from '../../domain/schemas.js';
import type { ProductivityAdapter } from '../productivity/types.js';

export type Readiness = 'ready' | 'not-ready' | 'unknown';

export interface AgentDiagnostic {
  name: AgentName;
  installed: boolean;
  version?: string;
  supportsNonInteractive: boolean;
  authentication: { status: Readiness; detail: string };
  mcp: Record<'notion' | 'linear', { status: Readiness; detail: string }>;
  warnings: string[];
}

export interface InvocationRecord<T> {
  value: T;
  command: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface PlanGenerationInput {
  runId: string;
  workspace: string;
  runDirectory: string;
  objective: string;
  context: ContextBundle;
  productivity: ProductivityAdapter;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PlanExecutionInput {
  workspace: string;
  runDirectory: string;
  plan: AurousPlan;
  productivity: ProductivityAdapter;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentAdapter {
  readonly name: AgentName;
  diagnose(): Promise<AgentDiagnostic>;
  generatePlan(input: PlanGenerationInput): Promise<InvocationRecord<PlanProposal>>;
  executePlan(input: PlanExecutionInput): Promise<InvocationRecord<ExecutionResult>>;
  manualFallback(runDirectory: string, phase: 'plan' | 'apply', prompt: string): Promise<string>;
}

export function emptyMcpDiagnostic(): AgentDiagnostic['mcp'] {
  return {
    notion: { status: 'unknown', detail: 'Not checked.' },
    linear: { status: 'unknown', detail: 'Not checked.' },
  };
}

export function targetMcpStatus(diagnostic: AgentDiagnostic, tool: ToolName): Readiness {
  return tool === 'mock' ? 'ready' : diagnostic.mcp[tool].status;
}
