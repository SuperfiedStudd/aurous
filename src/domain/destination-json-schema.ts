export const destinationDiscoveryJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['integration', 'candidates', 'existingObjects', 'inspectedAt', 'warnings'],
  properties: {
    integration: { type: 'string', enum: ['notion', 'linear', 'mock'] },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'kind', 'description', 'url', 'existingAurousMatch'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
          description: { type: 'string' },
          url: { type: ['string', 'null'] },
          existingAurousMatch: { type: 'boolean' },
        },
      },
    },
    existingObjects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'type', 'destinationId', 'url', 'parentId'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          destinationId: { type: 'string' },
          url: { type: ['string', 'null'] },
          parentId: { type: ['string', 'null'] },
        },
      },
    },
    inspectedAt: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;
