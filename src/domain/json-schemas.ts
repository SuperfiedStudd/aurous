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
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'name', 'purpose'],
        properties: {
          kind: { type: 'string' },
          name: { type: 'string' },
          purpose: { type: 'string' },
          parent: { type: 'string' },
        },
      },
    },
    plannedActions: {
      type: 'array',
      minItems: 1,
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
          id: { type: 'string', pattern: '^action-[0-9]{3}$' },
          operation: { enum: ['create', 'update', 'link', 'configure'] },
          objectType: { type: 'string' },
          target: { type: 'string' },
          description: { type: 'string' },
          properties: { type: 'object', additionalProperties: true },
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
    'completedActionIds',
    'warnings',
    'failures',
    'startedAt',
    'finishedAt',
  ],
  properties: {
    status: { enum: ['succeeded', 'partial', 'failed', 'cancelled'] },
    summary: { type: 'string' },
    createdObjects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['actionId', 'type', 'name'],
        properties: {
          actionId: { type: 'string' },
          type: { type: 'string' },
          name: { type: 'string' },
          externalId: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    completedActionIds: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'summary', 'probableCause', 'nextAction', 'severity'],
        properties: {
          actionId: { type: 'string' },
          code: { type: 'string', pattern: '^AUR-[A-Z]+-[0-9]{3}$' },
          summary: { type: 'string' },
          probableCause: { type: 'string' },
          nextAction: { type: 'string' },
          severity: { enum: ['warning', 'recoverable', 'fatal'] },
        },
      },
    },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: 'string', format: 'date-time' },
  },
} as const;
