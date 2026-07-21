import { z } from 'zod';
import { AgentNameSchema, ToolNameSchema, type ToolName } from './schemas.js';

export const DestinationSourceSchema = z.enum([
  'explicit-instruction',
  'saved-project',
  'existing-match',
  'only-choice',
  'user-choice',
  'advanced-override',
  'context-root-create',
]);
export type DestinationSource = z.infer<typeof DestinationSourceSchema>;

export const DestinationCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  description: z.string().default(''),
  url: z.string().url().nullish(),
  existingAurousMatch: z.boolean().default(false),
});
export type DestinationCandidate = z.infer<typeof DestinationCandidateSchema>;

export const DiscoveredObjectSchema = z.object({
  id: z.string().min(1),
  name: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '(unnamed)';
  }, z.string().min(1)),
  type: z.string().min(1),
  destinationId: z.string().min(1),
  url: z.string().url().nullish(),
  parentId: z.string().nullish(),
  /** Human-readable Linear issue key (e.g. JAS-17). Never authorizes mutation. */
  identifier: z.string().min(1).nullish(),
  /** Currently linked related object IDs when discovery inspected them. */
  linkedIds: z.array(z.string().min(1)).nullish(),
});
export type DiscoveredObject = z.infer<typeof DiscoveredObjectSchema>;

export const DestinationDiscoverySchema = z.object({
  integration: ToolNameSchema,
  candidates: z.array(DestinationCandidateSchema),
  existingObjects: z.array(DiscoveredObjectSchema).default([]),
  inspectedAt: z.string().datetime(),
  warnings: z.array(z.string()).default([]),
});
export type DestinationDiscovery = z.infer<typeof DestinationDiscoverySchema>;

export const DiscoveryReadOperationSchema = z.object({
  sequence: z.number().int().positive(),
  server: z.string().min(1),
  operation: z.string().min(1),
  purpose: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  success: z.boolean(),
  returnedObjectIds: z.array(z.string().min(1)),
  errorCode: z.string().min(1).optional(),
});
export type DiscoveryReadOperation = z.infer<typeof DiscoveryReadOperationSchema>;

export const SanitizedDiscoveryTraceSchema = z.object({
  schemaVersion: z.literal(1),
  discoveryId: z.string().min(1),
  integration: ToolNameSchema,
  agent: AgentNameSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  success: z.boolean(),
  sanitized: z.literal(true),
  operations: z.array(DiscoveryReadOperationSchema),
  warnings: z.array(z.string()),
});
export type SanitizedDiscoveryTrace = z.infer<typeof SanitizedDiscoveryTraceSchema>;

export const ResolvedDestinationSchema = z.object({
  integration: ToolNameSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  url: z.string().url().optional(),
  source: DestinationSourceSchema,
  sourceDetail: z.string().min(1),
  verifiedAt: z.string().datetime(),
  existingObjects: z.array(DiscoveredObjectSchema).default([]),
  discoveryWarnings: z.array(z.string()).default([]),
  /** Human-readable project/base/board created or reused under a team/workspace destination. */
  operatingRootName: z.string().min(1).optional(),
});
export type ResolvedDestination = z.infer<typeof ResolvedDestinationSchema>;

export const ContextPackSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    root: z.string().min(1),
    summary: z.string().optional(),
    purpose: z.string().optional(),
    currentObjective: z.string().optional(),
    technology: z.array(z.string().min(1)).max(20).default([]),
    commands: z.array(z.string().min(1)).max(20).default([]),
    summaryProvenance: z
      .object({
        kind: z.literal('repository-files'),
        sources: z.array(z.string().min(1)).max(5),
        generatedAt: z.string().datetime(),
        maxSourceBytes: z.number().int().positive(),
        maxSources: z.number().int().positive().default(5),
      })
      .optional(),
  }),
  selectedPreset: z.string().optional(),
  selectedPresetSource: z.literal('explicit-user').optional(),
  activeIntegrations: z.array(ToolNameSchema).default([]),
  destinations: z.array(ResolvedDestinationSchema).default([]),
  workspacePreferences: z
    .object({
      verbose: z.boolean().default(false),
    })
    .default({ verbose: false }),
  updatedAt: z.string().datetime(),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

export function destinationFor(
  pack: ContextPack,
  integration: ToolName,
): ResolvedDestination | undefined {
  return pack.destinations.find((destination) => destination.integration === integration);
}
