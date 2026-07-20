import type {
  AgentName,
  AurousPlan,
  ContextBundle,
  ExecutionBoundaryDiagnostic,
  ExecutionResult,
  PlanProposal,
  ToolName,
} from '../../domain/schemas.js';
import type { ProductivityAdapter } from '../productivity/types.js';
import type { RecoveryInspection, RecoveryPlan } from '../../domain/recovery.js';
import type { CreatedObject, PlanAction } from '../../domain/schemas.js';
import type {
  DestinationDiscovery,
  ResolvedDestination,
  SanitizedDiscoveryTrace,
} from '../../domain/destinations.js';
import type { ContextPack } from '../../domain/destinations.js';

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
  boundaryDiagnostics?: ExecutionBoundaryDiagnostic[];
  discoveryTrace?: SanitizedDiscoveryTrace;
}

export interface PlanGenerationInput {
  runId: string;
  workspace: string;
  runDirectory: string;
  objective: string;
  context: ContextBundle;
  contextPack: ContextPack;
  productivity: ProductivityAdapter;
  destination: ResolvedDestination;
  timeoutMs: number;
  model?: string;
  signal?: AbortSignal;
}

export interface DestinationDiscoveryInput {
  discoveryId: string;
  workspace: string;
  runDirectory: string;
  objective: string;
  projectName: string;
  context: ContextBundle;
  contextPack: ContextPack;
  productivity: ProductivityAdapter;
  timeoutMs: number;
  model?: string;
  signal?: AbortSignal;
}

export interface PlanExecutionInput {
  workspace: string;
  runDirectory: string;
  plan: AurousPlan;
  productivity: ProductivityAdapter;
  timeoutMs: number;
  model?: string;
  signal?: AbortSignal;
}

export interface RecoveryInspectionInput {
  recoveryRunId: string;
  workspace: string;
  runDirectory: string;
  originalPlan: AurousPlan;
  originalResult: ExecutionResult;
  productivity: ProductivityAdapter;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RecoveryActionExecutionInput {
  workspace: string;
  runDirectory: string;
  recoveryPlan: RecoveryPlan;
  action: PlanAction;
  knownObjects: CreatedObject[];
  productivity: ProductivityAdapter;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentAdapter {
  readonly name: AgentName;
  diagnose(): Promise<AgentDiagnostic>;
  discoverDestinations?(
    input: DestinationDiscoveryInput,
  ): Promise<InvocationRecord<DestinationDiscovery>>;
  generatePlan(input: PlanGenerationInput): Promise<InvocationRecord<PlanProposal>>;
  executePlan(input: PlanExecutionInput): Promise<InvocationRecord<ExecutionResult>>;
  inspectRecovery(input: RecoveryInspectionInput): Promise<InvocationRecord<RecoveryInspection>>;
  executeRecoveryAction(
    input: RecoveryActionExecutionInput,
  ): Promise<InvocationRecord<ExecutionResult>>;
  manualFallback(
    runDirectory: string,
    phase: 'destination-discover' | 'plan' | 'apply' | 'recover-inspect' | 'recover-apply',
    prompt: string,
  ): Promise<string>;
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
