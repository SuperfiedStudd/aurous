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

export interface WorkspaceItem {
  kind: string;
  name: string;
  purpose: string;
  parent?: string;
}

export const WorkspaceItemSchema = z
  .object({
    kind: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().min(1),
    parent: z.string().min(1).nullish(),
  })
  .transform<WorkspaceItem>(({ parent, ...item }) =>
    parent === null || parent === undefined ? item : { ...item, parent },
  );

export const ActionPropertyEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type ActionPropertyEntry = z.infer<typeof ActionPropertyEntrySchema>;

export const PlanActionSchema = z.object({
  id: z.string().regex(/^action-[0-9]{3}$/),
  operation: z.enum(['create', 'update', 'link', 'configure']),
  objectType: z.string().min(1),
  target: z.string().min(1),
  description: z.string().min(1),
  properties: z.array(ActionPropertyEntrySchema).default([]),
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

const PlanResponseWorkspaceItemSchema = z
  .object({
    kind: z.string(),
    name: z.string(),
    purpose: z.string(),
    parent: z.string().nullable(),
  })
  .strict()
  .transform<WorkspaceItem>(({ parent, ...item }) =>
    parent === null ? item : { ...item, parent },
  );

const PlanResponseActionSchema = z
  .object({
    id: z.string(),
    operation: z.enum(['create', 'update', 'link', 'configure']),
    objectType: z.string(),
    target: z.string(),
    description: z.string(),
    properties: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
    dependsOn: z.array(z.string()),
  })
  .strict();

/** Matches planProposalJsonSchema exactly, then removes transport-only nulls. */
export const PlanProposalResponseSchema = z
  .object({
    proposedWorkspaceStructure: z.array(PlanResponseWorkspaceItemSchema),
    plannedActions: z.array(PlanResponseActionSchema),
    assumptions: z.array(z.string()),
    warnings: z.array(z.string()),
    destructiveActions: z.array(
      z.object({ actionId: z.string(), impact: z.string(), recovery: z.string() }).strict(),
    ),
    expectedResult: z.string(),
  })
  .strict();

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

export interface CreatedObject {
  actionId: string;
  type: string;
  name: string;
  externalId?: string;
  url?: string;
}

export const CreatedObjectSchema = z
  .object({
    actionId: z.string(),
    type: z.string(),
    name: z.string(),
    externalId: z.string().nullish(),
    url: z.string().url().nullish(),
  })
  .transform<CreatedObject>(({ externalId, url, ...object }) => ({
    ...object,
    ...(externalId === null || externalId === undefined ? {} : { externalId }),
    ...(url === null || url === undefined ? {} : { url }),
  }));

export interface SkippedAction {
  actionId: string;
  type: string;
  name: string;
  reason: string;
  externalId?: string;
  url?: string;
}

export const SkippedActionSchema = z
  .object({
    actionId: z.string(),
    type: z.string(),
    name: z.string(),
    reason: z.string(),
    externalId: z.string().nullish(),
    url: z.string().url().nullish(),
  })
  .transform<SkippedAction>(({ externalId, url, ...action }) => ({
    ...action,
    ...(externalId === null || externalId === undefined ? {} : { externalId }),
    ...(url === null || url === undefined ? {} : { url }),
  }));

export interface ExecutionFailure {
  actionId?: string;
  code: string;
  summary: string;
  probableCause: string;
  nextAction: string;
  severity: Severity;
}

export const CanonicalAurousErrorCodeSchema = z.string().regex(/^AUR-[A-Z]+-[0-9]{3}$/);

export interface ExecutionBoundaryDiagnostic {
  kind: 'malformed-failure-code';
  validationPath: Array<string | number>;
  actionId?: string;
  originalMalformedCode: string;
  canonicalCode: 'AUR-AGENT-005';
}

export interface ParsedExecutionResult {
  result: ExecutionResult;
  diagnostics: ExecutionBoundaryDiagnostic[];
}

export const ExecutionFailureSchema = z
  .object({
    actionId: z.string().nullish(),
    code: CanonicalAurousErrorCodeSchema,
    summary: z.string(),
    probableCause: z.string(),
    nextAction: z.string(),
    severity: SeveritySchema,
  })
  .transform<ExecutionFailure>(({ actionId, ...failure }) => ({
    ...failure,
    ...(actionId === null || actionId === undefined ? {} : { actionId }),
  }));

export const ExecutionResultSchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed', 'cancelled']),
  summary: z.string(),
  createdObjects: z.array(CreatedObjectSchema),
  skippedActions: z.array(SkippedActionSchema).optional(),
  completedActionIds: z.array(z.string()),
  compatibilityNotes: z.array(z.string()).optional(),
  warnings: z.array(z.string()),
  failures: z.array(ExecutionFailureSchema),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

const ExecutionResponseCreatedObjectSchema = z
  .object({
    actionId: z.string(),
    type: z.string(),
    name: z.string(),
    externalId: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict()
  .transform<CreatedObject>(({ externalId, url, ...object }) => ({
    ...object,
    ...(externalId === null ? {} : { externalId }),
    ...(url === null ? {} : { url }),
  }));

const ExecutionResponseSkippedActionSchema = z
  .object({
    actionId: z.string(),
    type: z.string(),
    name: z.string(),
    reason: z.string(),
    externalId: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict()
  .transform<SkippedAction>(({ externalId, url, ...action }) => ({
    ...action,
    ...(externalId === null ? {} : { externalId }),
    ...(url === null ? {} : { url }),
  }));

const ExecutionResponseFailureSchema = z
  .object({
    actionId: z.string().nullable(),
    code: z.string(),
    summary: z.string(),
    probableCause: z.string(),
    nextAction: z.string(),
    severity: SeveritySchema,
  })
  .strict()
  .transform<ExecutionFailure>(({ actionId, ...failure }) => ({
    ...failure,
    ...(actionId === null ? {} : { actionId }),
  }));

/** Matches executionResultJsonSchema exactly, then removes transport-only nulls. */
const ExecutionResultResponseTransportSchema = z
  .object({
    status: z.enum(['succeeded', 'partial', 'failed', 'cancelled']),
    summary: z.string(),
    createdObjects: z.array(ExecutionResponseCreatedObjectSchema),
    skippedActions: z.array(ExecutionResponseSkippedActionSchema).default([]),
    completedActionIds: z.array(z.string()),
    compatibilityNotes: z.array(z.string()).default([]),
    warnings: z.array(z.string()),
    failures: z.array(ExecutionResponseFailureSchema),
    startedAt: z.string(),
    finishedAt: z.string(),
  })
  .strict();

const ExecutionResultBoundarySchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed', 'cancelled']),
  summary: z.string(),
  createdObjects: z.array(CreatedObjectSchema),
  skippedActions: z.array(SkippedActionSchema).default([]),
  completedActionIds: z.array(z.string()),
  compatibilityNotes: z.array(z.string()).default([]),
  warnings: z.array(z.string()),
  failures: z.array(
    z
      .object({
        actionId: z.string().nullish(),
        code: z.string(),
        summary: z.string(),
        probableCause: z.string(),
        nextAction: z.string(),
        severity: SeveritySchema,
      })
      .transform<ExecutionFailure>(({ actionId, ...failure }) => ({
        ...failure,
        ...(actionId === null || actionId === undefined ? {} : { actionId }),
      })),
  ),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});

export function normalizeExecutionResultBoundary(value: unknown): ParsedExecutionResult {
  const boundary = ExecutionResultBoundarySchema.parse(value);
  const diagnostics: ExecutionBoundaryDiagnostic[] = [];
  const failures = boundary.failures.map((failure, index) => {
    if (CanonicalAurousErrorCodeSchema.safeParse(failure.code).success) return failure;
    diagnostics.push({
      kind: 'malformed-failure-code',
      validationPath: ['failures', index, 'code'],
      ...(failure.actionId ? { actionId: failure.actionId } : {}),
      originalMalformedCode: failure.code,
      canonicalCode: 'AUR-AGENT-005',
    });
    return { ...failure, code: 'AUR-AGENT-005' };
  });
  return {
    result: ExecutionResultSchema.parse({ ...boundary, failures }),
    diagnostics,
  };
}

export function parseExecutionResultResponse(value: unknown): ParsedExecutionResult {
  return normalizeExecutionResultBoundary(ExecutionResultResponseTransportSchema.parse(value));
}

export const ExecutionResultResponseSchema = ExecutionResultResponseTransportSchema.transform(
  (value) => normalizeExecutionResultBoundary(value).result,
);

export const RunStatusSchema = z.enum([
  'planning',
  'planned',
  'reconciling',
  'recovery-planned',
  'recovering',
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
  runKind: z.enum(['standard', 'recovery']).default('standard'),
  recoveryOf: z.string().optional(),
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
