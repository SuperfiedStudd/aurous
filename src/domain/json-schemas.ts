/**
 * Codex `--output-schema` accepts the OpenAI Structured Outputs subset of JSON Schema.
 * Every object is closed and requires every declared property. Optional application fields are
 * represented as required nullable values, then normalized by the Zod schemas at the boundary.
 * Runtime-only constraints (patterns, formats, minimum lengths/items) stay in Zod.
 */
export const planProposalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'proposedWorkspaceStructure',
    'plannedActions',
    'assumptions',
    'warnings',
    'destructiveActions',
    'expectedResult',
  ],
  properties: {
    proposedWorkspaceStructure: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'name', 'purpose', 'parent'],
        properties: {
          kind: { type: 'string' },
          name: { type: 'string' },
          purpose: { type: 'string' },
          parent: { type: ['string', 'null'] },
        },
      },
    },
    plannedActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'operation',
          'objectType',
          'target',
          'description',
          'properties',
          'dependsOn',
        ],
        properties: {
          id: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'update', 'link', 'configure'] },
          objectType: { type: 'string' },
          target: { type: 'string' },
          description: { type: 'string' },
          properties: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'value'],
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    destructiveActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['actionId', 'impact', 'recovery'],
        properties: {
          actionId: { type: 'string' },
          impact: { type: 'string' },
          recovery: { type: 'string' },
        },
      },
    },
    expectedResult: { type: 'string' },
  },
} as const;

export const executionResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'summary',
    'createdObjects',
    'skippedActions',
    'completedActionIds',
    'compatibilityNotes',
    'warnings',
    'failures',
    'startedAt',
    'finishedAt',
  ],
  properties: {
    status: { type: 'string', enum: ['succeeded', 'partial', 'failed', 'cancelled'] },
    summary: { type: 'string' },
    createdObjects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['actionId', 'type', 'name', 'externalId', 'url'],
        properties: {
          actionId: { type: 'string' },
          type: { type: 'string' },
          name: { type: 'string' },
          externalId: { type: ['string', 'null'] },
          url: { type: ['string', 'null'] },
        },
      },
    },
    skippedActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['actionId', 'type', 'name', 'reason', 'externalId', 'url'],
        properties: {
          actionId: { type: 'string' },
          type: { type: 'string' },
          name: { type: 'string' },
          reason: { type: 'string' },
          externalId: { type: ['string', 'null'] },
          url: { type: ['string', 'null'] },
        },
      },
    },
    completedActionIds: { type: 'array', items: { type: 'string' } },
    compatibilityNotes: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['actionId', 'code', 'summary', 'probableCause', 'nextAction', 'severity'],
        properties: {
          actionId: { type: ['string', 'null'] },
          code: {
            type: 'string',
            description:
              'Canonical Aurous code formatted AUR-<SINGLE-UPPERCASE-CATEGORY>-<3 DIGITS>, for example AUR-MCP-001 or AUR-RECOVERY-011.',
          },
          summary: { type: 'string' },
          probableCause: { type: 'string' },
          nextAction: { type: 'string' },
          severity: { type: 'string', enum: ['warning', 'recoverable', 'fatal'] },
        },
      },
    },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
  },
} as const;
