import { describe, expect, it } from 'vitest';
import { AurousPlanSchema } from '../src/domain/schemas.js';

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
          properties: {},
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
