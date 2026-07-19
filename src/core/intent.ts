import type { PlanProposal } from '../domain/schemas.js';
import { AurousError } from './errors.js';

export interface ObjectiveIntent {
  materialRequirements: string[];
  exactCreateScope?: { count: number; objectType: string };
}

export function analyzeObjective(objective: string): ObjectiveIntent {
  const requirements: string[] = [];
  for (const match of objective.matchAll(/\b(?:covering|including)\s+([^.!?]+)/gi))
    requirements.push(...splitRequirementList(match[1] ?? ''));
  for (const match of objective.matchAll(
    /\bone\s+for\s+(.+?)\s+and\s+one\s+for\s+(.+?)(?=\.|$)/gi,
  )) {
    requirements.push(cleanRequirement(match[1] ?? ''), cleanRequirement(match[2] ?? ''));
  }
  for (const match of objective.matchAll(/\bdo\s+not\s+([^.!?]+)/gi))
    requirements.push(`Do not ${cleanRequirement(match[1] ?? '')}`);
  if (/\breadme\b/i.test(objective) && !requirements.some((item) => /\breadme\b/i.test(item)))
    requirements.push('README');
  if (
    /\b(?:devpost\s+)?submission(?:\s+materials?)?\b/i.test(objective) &&
    !requirements.some((item) => /\bsubmission\b/i.test(item))
  )
    requirements.push(
      objective.match(/\b(?:Devpost\s+)?submission(?:\s+materials?)?\b/i)?.[0] ?? 'submission',
    );

  const scope = objective.match(
    /\b(?:create|add)\s+(?:exactly\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+([a-z][a-z_-]*?)s?\s+only\b/i,
  );
  const count = scope ? parseCount(scope[1]!) : undefined;
  return {
    materialRequirements: [
      ...new Map(
        requirements
          .map(cleanRequirement)
          .filter(Boolean)
          .map((item) => [item.toLocaleLowerCase(), item]),
      ).values(),
    ],
    ...(count !== undefined && scope?.[2]
      ? { exactCreateScope: { count, objectType: singular(scope[2]) } }
      : {}),
  };
}

export function formatIntentContract(objective: string): string {
  const intent = analyzeObjective(objective);
  const lines = [
    '- Preserve the user objective as the binding source of scope. A preset may organize that scope but must never replace it.',
    '- Represent every material requirement in an action or state it explicitly in warnings as unsupported.',
    '- Preserve explicit quantities and "only" constraints exactly. Do not add setup actions merely because they are customary.',
    '- Preserve negative constraints such as "do not recreate" as hard limits.',
  ];
  if (intent.materialRequirements.length > 0)
    lines.push(
      'Material requirement checklist (retain these phrases in actions or explicit unsupported warnings):',
      ...intent.materialRequirements.map((requirement) => `  - ${requirement}`),
    );
  if (intent.exactCreateScope)
    lines.push(
      `Explicit action scope: exactly ${intent.exactCreateScope.count} create ${intent.exactCreateScope.objectType} action(s), with no other planned actions. Existing parent objects belong in exact-ID relationship properties, not separate actions.`,
    );
  return lines.join('\n');
}

export function validateObjectiveIntent(objective: string, proposal: PlanProposal): void {
  const intent = analyzeObjective(objective);
  const planText = searchablePlanText(proposal);
  const missing = intent.materialRequirements.filter(
    (requirement) => !requirementCovered(requirement, planText),
  );
  if (missing.length > 0) {
    throw new AurousError({
      code: 'AUR-PLAN-007',
      summary: `The generated plan omitted material user requirements: ${missing.join('; ')}.`,
      probableCause:
        'The planning response replaced or compressed explicit user intent instead of representing it or reporting it unsupported.',
      nextAction:
        'No writes were attempted. Regenerate a plan that preserves every listed requirement.',
    });
  }
  if (intent.exactCreateScope) {
    const actions = proposal.plannedActions;
    const matching = actions.filter(
      (action) =>
        action.operation === 'create' &&
        singular(action.objectType.toLocaleLowerCase()) === intent.exactCreateScope?.objectType,
    );
    if (actions.length !== intent.exactCreateScope.count || matching.length !== actions.length) {
      throw new AurousError({
        code: 'AUR-PLAN-008',
        summary: `The generated plan violates the explicit scope: expected exactly ${intent.exactCreateScope.count} create ${intent.exactCreateScope.objectType} action(s), received ${actions.length} total action(s) with ${matching.length} matching.`,
        probableCause:
          'The planning response added customary setup work outside the requested scope.',
        nextAction:
          'No writes were attempted. Regenerate the plan with only the explicitly requested actions.',
      });
    }
  }
}

export function uncoveredRequirements(objective: string, proposal: PlanProposal): string[] {
  const planText = searchablePlanText(proposal);
  return analyzeObjective(objective).materialRequirements.filter(
    (requirement) => !requirementCovered(requirement, planText),
  );
}

function searchablePlanText(proposal: PlanProposal): string {
  return [
    ...proposal.proposedWorkspaceStructure.flatMap((item) => [item.name, item.purpose]),
    ...proposal.plannedActions.flatMap((action) => [
      action.target,
      action.description,
      ...action.properties.flatMap((property) => [property.key, property.value]),
    ]),
    ...proposal.assumptions,
    ...proposal.warnings,
    proposal.expectedResult,
  ].join('\n');
}

function requirementCovered(requirement: string, planText: string): boolean {
  const planTokens = new Set(tokens(planText));
  const requirementTokens = tokens(requirement).filter((token) => !stopWords.has(token));
  return requirementTokens.length > 0 && requirementTokens.every((token) => planTokens.has(token));
}

function tokens(value: string): string[] {
  return (
    value
      .toLocaleLowerCase()
      .match(/[a-z0-9]+/g)
      ?.map(canonicalToken) ?? []
  );
}

function canonicalToken(token: string): string {
  if (/^(stable|stability|stabilize|stabilizing)$/.test(token)) return 'stability';
  if (/^(prepare|prepared|preparing|preparation)$/.test(token)) return 'prepare';
  if (/^(complete|completed|completing|completion)$/.test(token)) return 'complete';
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function splitRequirementList(value: string): string[] {
  return value
    .replace(/\s+and\s+/gi, ',')
    .split(',')
    .map(cleanRequirement)
    .filter(Boolean);
}

function cleanRequirement(value: string): string {
  return value
    .replace(/^\s*(?:one\s+for\s+)?/i, '')
    .replace(/\s+before\s+(?:the\s+)?[A-Z]?[a-z]+\s+\d{1,2}(?:,\s*\d{4})?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function singular(value: string): string {
  return value.endsWith('ies')
    ? `${value.slice(0, -3)}y`
    : value.endsWith('s')
      ? value.slice(0, -1)
      : value;
}

function parseCount(value: string): number | undefined {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  return {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  }[value.toLocaleLowerCase() as 'one'];
}

const stopWords = new Set(['a', 'an', 'and', 'for', 'of', 'one', 'the', 'to', 'work']);
