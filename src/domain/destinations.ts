import { z } from 'zod';
import { ToolNameSchema, type ToolName } from './schemas.js';

export const DestinationSourceSchema = z.enum([
  'explicit-instruction',
  'saved-project',
  'existing-match',
  'only-choice',
  'user-choice',
  'advanced-override',
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
  name: z.string().min(1),
  type: z.string().min(1),
  destinationId: z.string().min(1),
  url: z.string().url().nullish(),
  parentId: z.string().nullish(),
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
});
export type ResolvedDestination = z.infer<typeof ResolvedDestinationSchema>;

export const ContextPackSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    root: z.string().min(1),
    summary: z.string().optional(),
    summaryProvenance: z
      .object({
        kind: z.literal('repository-files'),
        sources: z.array(z.string().min(1)).max(5),
        generatedAt: z.string().datetime(),
        maxSourceBytes: z.number().int().positive(),
      })
      .optional(),
  }),
  selectedPreset: z.string().optional(),
  selectedPresetSource: z.literal('explicit-user').optional(),
  activeIntegrations: z.array(ToolNameSchema),
  destinations: z.array(ResolvedDestinationSchema),
  workspacePreferences: z.object({
    verbose: z.boolean().default(false),
  }),
  updatedAt: z.string().datetime(),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

export function destinationFor(
  pack: ContextPack,
  integration: ToolName,
): ResolvedDestination | undefined {
  return pack.destinations.find((destination) => destination.integration === integration);
}
