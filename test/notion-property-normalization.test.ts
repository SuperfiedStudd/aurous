import { describe, expect, it } from 'vitest';
import { normalizeNotionPlanPropertyEntries } from '../src/adapters/productivity/notion-property-normalization.js';
import type { PlanProposal } from '../src/domain/schemas.js';

function proposal(properties: PlanProposal['plannedActions'][number]['properties']): PlanProposal {
  return {
    proposedWorkspaceStructure: [{ kind: 'notion.page', name: 'CEO Home', purpose: 'Home' }],
    plannedActions: [
      {
        id: 'action-001',
        operation: 'create',
        objectType: 'notion.page',
        target: 'CEO Home',
        description: 'Create CEO Home.',
        properties,
        dependsOn: [],
      },
    ],
    assumptions: [],
    warnings: [],
    destructiveActions: [],
    expectedResult: 'A normalized CEO Home.',
  };
}

describe('Notion plan property normalization', () => {
  it('normalizes action-002-style duplicate keys deterministically before validation', () => {
    const normalized = normalizeNotionPlanPropertyEntries(
      proposal([
        { key: 'notion.page.sections', value: '["Today"]' },
        { key: ' notion.page.sections ', value: '["Today"]' },
        { key: 'NOTION.PAGE.SECTIONS', value: '["Today", "Meetings"]' },
        { key: 'notion.icon.emoji', value: '🏠' },
        { key: ' NOTION.ICON.EMOJI ', value: '💼' },
      ]),
    );
    const action = normalized.plannedActions[0]!;
    expect(action.properties).toEqual([
      { key: 'notion.page.sections', value: '["Today","Meetings"]' },
      { key: 'notion.icon.emoji', value: '🏠' },
    ]);
    expect(normalized.warnings.join('\n')).toContain('normalized duplicate Notion property');
    expect(normalized.warnings.join('\n')).toContain('regenerated the conflicting Notion property');
  });

  it('deduplicates Notion database property and view payload entries without changing first order', () => {
    const normalized = normalizeNotionPlanPropertyEntries(
      proposal([
        {
          key: 'notion.database.properties',
          value:
            '[{"name":"Owner","type":"person"},{"name":" owner ","type":"person"},{"name":"Tags","type":"multi_select","options":["A"]}]',
        },
        {
          key: 'NOTION.DATABASE.PROPERTIES',
          value: '[{"name":"Tags","type":"multi_select","options":["B"]}]',
        },
        {
          key: 'notion.database.views',
          value: '[{"name":"Active","filter":"open"},{"name":" active ","filter":"open"}]',
        },
      ]),
    );
    const properties = normalized.plannedActions[0]!.properties;
    expect(JSON.parse(properties[0]!.value)).toEqual([
      { name: 'Owner', type: 'person' },
      { name: 'Tags', type: 'multi_select', options: ['A', 'B'] },
    ]);
    expect(JSON.parse(properties[1]!.value)).toEqual([{ name: 'Active', filter: 'open' }]);
  });
});
