import { z } from 'zod';

export const AgentNameSchema = z.enum(['codex', 'claude', 'mock']);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const ToolNameSchema = z.enum(['notion', 'linear', 'mock']);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const SeveritySchema = z.enum(['warning', 'recoverable', 'fatal']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ContextFileSchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  category: z.enum(['readme', 'documentation', 'manifest', 'source', 'configuration']),
});
export type ContextFile = z.infer<typeof ContextFileSchema>;

export const GitSummarySchema = z.object({
  branch: z.string(),
  recentCommits: z.array(z.string()).max(10),
});

export const ContextSummarySchema = z.object({
  approvedPaths: z.array(z.string()).min(1),
  files: z.array(ContextFileSchema),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  skipped: z.array(z.string()),
  git: GitSummarySchema.optional(),
});
export type ContextSummary = z.infer<typeof ContextSummarySchema>;

export const ContextDocumentSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  content: z.string(),
});

export const ContextBundleSchema = z.object({
  summary: ContextSummarySchema,
  documents: z.array(ContextDocumentSchema),
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

export const WorkspaceItemSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  parent: z.string().optional(),
});

export const PlanActionSchema = z.object({
  id: z.string().regex(/^action-[0-9]{3}$/),
  operation: z.enum(['create', 'update', 'link', 'configure']),
  objectType: z.string().min(1),
  target: z.string().min(1),
  description: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
});
export type PlanAction = z.infer<typeof PlanActionSchema>;

export const DestructiveActionSchema = z.object({
  actionId: z.string(),
  impact: z.string().min(1),
  recovery: z.string().min(1),
});

export const PlanProposalSchema = z.object({
  proposedWorkspaceStructure: z.array(WorkspaceItemSchema).min(1),
  plannedActions: z.array(PlanActionSchema).min(1),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  destructiveActions: z.array(DestructiveActionSchema),
  expectedResult: z.string().min(1),
});
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export const AurousPlanSchema = PlanProposalSchema.extend({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^run-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$/),
  createdAt: z.string().datetime(),
  agent: AgentNameSchema,
  tool: ToolNameSchema,
  objective: z.string().min(1),
  contextSummary: ContextSummarySchema,
});
export type AurousPlan = z.infer<typeof AurousPlanSchema>;

export const CreatedObjectSchema = z.object({
  actionId: z.string(),
  type: z.string(),
  name: z.string(),
  externalId: z.string().optional(),
  url: z.string().url().optional(),
});

export const ExecutionFailureSchema = z.object({
  actionId: z.string().optional(),
  code: z.string().regex(/^AUR-[A-Z]+-[0-9]{3}$/),
  summary: z.string(),
  probableCause: z.string(),
  nextAction: z.string(),
  severity: SeveritySchema,
});

export const ExecutionResultSchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed', 'cancelled']),
  summary: z.string(),
  createdObjects: z.array(CreatedObjectSchema),
  completedActionIds: z.array(z.string()),
  warnings: z.array(z.string()),
  failures: z.array(ExecutionFailureSchema),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const RunStatusSchema = z.enum([
  'planning',
  'planned',
  'applying',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z.object({
  runId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: RunStatusSchema,
  agent: AgentNameSchema,
  tool: ToolNameSchema,
  objective: z.string(),
  approvedContextPaths: z.array(z.string()),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const DiagnosticEventSchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export const AurousConfigSchema = z.object({
  schemaVersion: z.literal(1),
  defaultAgent: AgentNameSchema,
  defaultTool: ToolNameSchema,
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
});
export type AurousConfig = z.infer<typeof AurousConfigSchema>;
