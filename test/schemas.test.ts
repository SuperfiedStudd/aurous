import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { executionResultJsonSchema, planProposalJsonSchema } from '../src/domain/json-schemas.js';
import { recoveryInspectionJsonSchema } from '../src/domain/recovery-json-schemas.js';
import {
  AurousPlanSchema,
  ExecutionResultResponseSchema,
  ExecutionResultSchema,
  parseExecutionResultResponse,
  PlanProposalResponseSchema,
  PlanProposalSchema,
} from '../src/domain/schemas.js';

const unsupportedStructuredOutputKeywords = new Set([
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'patternProperties',
  'unevaluatedProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
]);

describe('Codex structured-output JSON schemas', () => {
  it.each([
    ['planning', planProposalJsonSchema],
    ['execution', executionResultJsonSchema],
    ['recovery inspection', recoveryInspectionJsonSchema],
  ])('keeps every nested %s object closed, complete, and supported', (_name, schema) => {
    auditStructuredOutputSchema(schema, '$');
  });

  it('normalizes nullable planning fields and preserves strict property detail', () => {
    const response = {
      proposedWorkspaceStructure: [
        { kind: 'page', name: 'Product HQ', purpose: 'Project home', parent: null },
        { kind: 'database', name: 'Tasks', purpose: 'Work tracking', parent: 'Product HQ' },
      ],
      plannedActions: [
        {
          id: 'action-001',
          operation: 'create',
          objectType: 'database',
          target: 'Tasks',
          description: 'Create a detailed task database.',
          properties: [
            { key: 'field.Name', value: 'title' },
            { key: 'field.Status.options', value: '["Backlog","In Progress","Done"]' },
          ],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'A Product HQ with a task database.',
    };
    const proposal = PlanProposalSchema.parse(PlanProposalResponseSchema.parse(response));

    expect(proposal.proposedWorkspaceStructure[0]).not.toHaveProperty('parent');
    expect(proposal.proposedWorkspaceStructure[1]).toHaveProperty('parent', 'Product HQ');
    expect(proposal.plannedActions[0]?.properties).toHaveLength(2);
    expect(() =>
      PlanProposalResponseSchema.parse({
        ...response,
        plannedActions: [{ ...response.plannedActions[0], properties: { arbitrary: true } }],
      }),
    ).toThrow();
  });

  it('normalizes nullable execution fields into clean persisted objects', () => {
    const response = {
      status: 'partial',
      summary: 'One run-wide failure.',
      createdObjects: [
        {
          actionId: 'action-001',
          type: 'page',
          name: 'Product HQ',
          externalId: null,
          url: null,
        },
      ],
      completedActionIds: ['action-001'],
      warnings: [],
      failures: [
        {
          actionId: null,
          code: 'AUR-MCP-001',
          summary: 'MCP unavailable.',
          probableCause: 'The MCP connection closed.',
          nextAction: 'Retry after checking MCP readiness.',
          severity: 'recoverable',
        },
      ],
      startedAt: '2026-07-19T01:00:00.000Z',
      finishedAt: '2026-07-19T01:00:01.000Z',
    } as const;
    const result = ExecutionResultSchema.parse(ExecutionResultResponseSchema.parse(response));

    expect(result.createdObjects[0]).toEqual({
      actionId: 'action-001',
      type: 'page',
      name: 'Product HQ',
    });
    expect(result.failures[0]).not.toHaveProperty('actionId');
  });

  it('normalizes the captured malformed action-003 failure without discarding its result', async () => {
    const captured = JSON.parse(
      await readFile(
        new URL('./fixtures/recovery-action-003-malformed.json', import.meta.url),
        'utf8',
      ),
    ) as unknown;

    const parsed = parseExecutionResultResponse(captured);

    expect(parsed.result).toMatchObject({
      status: 'cancelled',
      completedActionIds: [],
      createdObjects: [
        {
          actionId: 'action-003',
          externalId: '7f965334-0f81-4d4c-966b-6b3d9d969fa2',
        },
      ],
      failures: [{ actionId: 'action-003', code: 'AUR-AGENT-005' }],
    });
    expect(parsed.diagnostics).toEqual([
      {
        kind: 'malformed-failure-code',
        validationPath: ['failures', 0, 'code'],
        actionId: 'action-003',
        originalMalformedCode: 'AUR-RECOVERY-CANCELLED',
        canonicalCode: 'AUR-AGENT-005',
      },
    ]);
  });

  it('preserves canonical failure codes and fails closed for genuinely invalid results', () => {
    const canonical = {
      status: 'failed',
      summary: 'Canonical failure.',
      createdObjects: [],
      completedActionIds: [],
      warnings: [],
      failures: [
        {
          actionId: 'action-003',
          code: 'AUR-MCP-123',
          summary: 'MCP failed.',
          probableCause: 'Test.',
          nextAction: 'Inspect.',
          severity: 'recoverable',
        },
      ],
      startedAt: '2026-07-19T02:57:24Z',
      finishedAt: '2026-07-19T02:57:24Z',
    };

    expect(parseExecutionResultResponse(canonical)).toMatchObject({
      result: { failures: [{ code: 'AUR-MCP-123' }] },
      diagnostics: [],
    });
    expect(() =>
      parseExecutionResultResponse({ ...canonical, completedActionIds: undefined }),
    ).toThrow();
  });

  it('documents the canonical failure-code contract without unsupported JSON Schema patterns', () => {
    const serialized = JSON.stringify(executionResultJsonSchema);
    expect(serialized).toContain('AUR-<SINGLE-UPPERCASE-CATEGORY>-<3 DIGITS>');
    expect(serialized).not.toContain('"pattern"');
  });

  it('uses typed filter state in the recovery inspection transport contract', () => {
    const serialized = JSON.stringify(recoveryInspectionJsonSchema);
    expect(serialized).toContain('filterState');
    expect(serialized).toContain('conditionCount');
    expect(serialized).toContain('fingerprint');
    expect(serialized).not.toContain('filterSummary');
  });
});

describe('AurousPlan schema', () => {
  it('rejects unstructured or incomplete plans', () => {
    expect(() => AurousPlanSchema.parse({ runId: 'run-anything' })).toThrow();
  });

  it('requires stable action IDs', () => {
    const parsed = AurousPlanSchema.safeParse({
      schemaVersion: 1,
      runId: 'run-20260718T120000Z-abcdef',
      createdAt: '2026-07-18T12:00:00.000Z',
      agent: 'mock',
      tool: 'mock',
      objective: 'Test',
      contextSummary: {
        approvedPaths: ['/tmp/project'],
        files: [],
        fileCount: 0,
        totalBytes: 0,
        skipped: [],
      },
      proposedWorkspaceStructure: [{ kind: 'workspace', name: 'Test', purpose: 'Test' }],
      plannedActions: [
        {
          id: 'wrong-id',
          operation: 'create',
          objectType: 'workspace',
          target: 'Test',
          description: 'Test',
          properties: [],
          dependsOn: [],
        },
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Test result',
    });
    expect(parsed.success).toBe(false);
  });
});

function auditStructuredOutputSchema(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  for (const keyword of unsupportedStructuredOutputKeywords) {
    expect(value, `${path} contains unsupported keyword ${keyword}`).not.toHaveProperty(keyword);
  }

  const isObjectSchema = value.type === 'object' || isRecord(value.properties);
  if (isObjectSchema) {
    expect(value.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(Array.isArray(value.required), `${path}.required must be an array`).toBe(true);
    const propertyKeys = isRecord(value.properties) ? Object.keys(value.properties) : [];
    expect([...(value.required as string[])].sort(), `${path}.required`).toEqual(
      propertyKeys.sort(),
    );
  }

  if ('additionalProperties' in value) {
    expect(value.additionalProperties, `${path}.additionalProperties must be false`).toBe(false);
  }
  if (isRecord(value.properties)) {
    for (const [key, child] of Object.entries(value.properties))
      auditStructuredOutputSchema(child, `${path}.properties.${key}`);
  }
  if ('items' in value) auditStructuredOutputSchema(value.items, `${path}.items`);
  if (Array.isArray(value.anyOf))
    value.anyOf.forEach((child, index) =>
      auditStructuredOutputSchema(child, `${path}.anyOf[${index}]`),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
