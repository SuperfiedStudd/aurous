import { describe, expect, it } from 'vitest';
import {
  analyzeObjective,
  formatIntentContract,
  validateObjectiveIntent,
} from '../src/core/intent.js';
import type { PlanProposal } from '../src/domain/schemas.js';

const broadObjective =
  'Set up Linear with work covering integration stability, demo preparation, README and submission materials.';

describe('natural-language intent preservation', () => {
  it('extracts and retains README and submission requirements', () => {
    expect(analyzeObjective(broadObjective).materialRequirements).toEqual([
      'integration stability',
      'demo preparation',
      'README',
      'submission materials',
    ]);
    expect(formatIntentContract(broadObjective)).toContain('README');
    expect(formatIntentContract(broadObjective)).toContain('submission materials');
    expect(() => validateObjectiveIntent(broadObjective, completeProposal())).not.toThrow();
  });

  it('rejects a plan that silently drops README and submission work', () => {
    const missing = completeProposal();
    missing.plannedActions = missing.plannedActions.slice(0, 2);
    missing.proposedWorkspaceStructure = missing.proposedWorkspaceStructure.slice(0, 2);
    missing.expectedResult = 'Integration stability and demo preparation are ready.';

    expect(() => validateObjectiveIntent(broadObjective, missing)).toThrowError(
      /omitted material user requirements/,
    );
  });

  it('enforces an explicit two-issue-only request', () => {
    const objective =
      'Create two issues only: one for completing the README and one for preparing the Devpost submission materials before July 21.';
    const exact: PlanProposal = {
      proposedWorkspaceStructure: [
        { kind: 'issue', name: 'Complete README', purpose: 'Complete the README.' },
        {
          kind: 'issue',
          name: 'Prepare Devpost submission materials',
          purpose: 'Prepare Devpost submission materials.',
        },
      ],
      plannedActions: [
        action('action-001', 'Complete the README', 'Complete the README before launch.'),
        action(
          'action-002',
          'Prepare Devpost submission materials',
          'Prepare the Devpost submission materials before July 21.',
        ),
      ],
      assumptions: [],
      warnings: [],
      destructiveActions: [],
      expectedResult: 'Two launch issues for the README and Devpost submission materials.',
    };
    expect(analyzeObjective(objective).exactCreateScope).toEqual({ count: 2, objectType: 'issue' });
    expect(() => validateObjectiveIntent(objective, exact)).not.toThrow();

    exact.plannedActions.unshift({
      ...action('action-000', 'Launch project', 'Create a customary project.'),
      objectType: 'project',
    });
    expect(() => validateObjectiveIntent(objective, exact)).toThrowError(
      /violates the explicit scope/,
    );
  });

  it('treats an explicit do-not clause as material intent', () => {
    const objective = 'Add launch work. Do not recreate existing integration or demo tasks.';
    const proposal = completeProposal();
    proposal.warnings.push('Do not recreate existing integration or demo tasks.');
    expect(() => validateObjectiveIntent(objective, proposal)).not.toThrow();

    proposal.warnings = [];
    expect(() => validateObjectiveIntent(objective, proposal)).toThrowError(
      /omitted material user requirements/,
    );
  });
});

function completeProposal(): PlanProposal {
  const requirements = [
    ['Stabilize integrations', 'Complete integration stability work.'],
    ['Prepare the demo', 'Finish demo preparation.'],
    ['Complete README', 'Complete the README.'],
    ['Prepare submission materials', 'Prepare submission materials.'],
  ] as const;
  return {
    proposedWorkspaceStructure: requirements.map(([name, purpose]) => ({
      kind: 'issue',
      name,
      purpose,
    })),
    plannedActions: requirements.map(([name, description], index) =>
      action(`action-${String(index + 1).padStart(3, '0')}`, name, description),
    ),
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: requirements.map(([name]) => name).join(', '),
  };
}

function action(id: string, target: string, description: string) {
  return {
    id,
    operation: 'create' as const,
    objectType: 'issue',
    target,
    description,
    properties: [],
    dependsOn: [],
  };
}
