const capabilitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['supported', 'evidence'],
  properties: {
    supported: { type: 'boolean' },
    evidence: { type: 'string' },
  },
} as const;

const filterFingerprintSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'kind', 'property', 'operator', 'value'],
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['and', 'or', 'condition'] },
          property: { type: ['string', 'null'] },
          operator: { type: ['string', 'null'] },
          value: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

const filterStateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'conditionCount', 'fingerprint'],
  properties: {
    kind: { type: 'string', enum: ['none', 'configured', 'unknown'] },
    conditionCount: { type: ['number', 'null'] },
    fingerprint: {
      anyOf: [filterFingerprintSchema, { type: 'null' }],
    },
  },
} as const;

export const recoveryInspectionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'objects',
    'customStatusOptions',
    'customSelectOptions',
    'updateViewFilters',
    'warnings',
  ],
  properties: {
    objects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'actionId',
          'externalId',
          'url',
          'found',
          'objectType',
          'title',
          'parentId',
          'properties',
          'views',
          'recordCount',
          'limitations',
        ],
        properties: {
          actionId: { type: 'string' },
          externalId: { type: 'string' },
          url: { type: 'string' },
          found: { type: 'boolean' },
          objectType: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          parentId: { type: ['string', 'null'] },
          properties: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type', 'options'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          views: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type', 'filterState'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                filterState: filterStateSchema,
              },
            },
          },
          recordCount: { type: ['number', 'null'] },
          limitations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    customStatusOptions: capabilitySchema,
    customSelectOptions: capabilitySchema,
    updateViewFilters: capabilitySchema,
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;
