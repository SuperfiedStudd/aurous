import type { AurousError } from './errors.js';
import type { AurousPlan, ContextSummary, ExecutionResult, RunRecord } from '../domain/schemas.js';

export interface Output {
  log(message?: string): void;
  error(message: string): void;
}

export const consoleOutput: Output = {
  log: (message = '') => console.log(message),
  error: (message) => console.error(message),
};

export function formatContextSummary(summary: ContextSummary): string {
  const lines = [
    'Context summary (shown before agent invocation)',
    `  Approved paths: ${summary.approvedPaths.join(', ')}`,
    `  Included: ${summary.fileCount} files, ${summary.totalBytes} bytes`,
  ];
  if (summary.git) {
    lines.push(`  Git branch: ${summary.git.branch || '(detached)'}`);
    if (summary.git.recentCommits.length > 0)
      lines.push(`  Recent commits: ${summary.git.recentCommits.join(' | ')}`);
  }
  for (const file of summary.files)
    lines.push(`  + ${file.relativePath} (${file.category}, ${file.bytes} B)`);
  for (const skipped of summary.skipped) lines.push(`  - skipped: ${skipped}`);
  return lines.join('\n');
}

export function formatPlan(plan: AurousPlan): string {
  const lines = [
    `Plan ${plan.runId}`,
    `  Agent/tool: ${plan.agent} + ${plan.tool}`,
    `  Objective: ${plan.objective}`,
    `  Expected result: ${plan.expectedResult}`,
    '',
    'Workspace structure:',
    ...plan.proposedWorkspaceStructure.map(
      (item) => `  - ${item.kind}: ${item.name} — ${item.purpose}`,
    ),
    '',
    'Exact approved actions:',
    ...plan.plannedActions.map(
      (action) =>
        `  ${action.id}  ${action.operation} ${action.objectType} "${action.target}" — ${action.description}`,
    ),
  ];
  if (plan.assumptions.length > 0)
    lines.push('', 'Assumptions:', ...plan.assumptions.map((item) => `  - ${item}`));
  if (plan.warnings.length > 0)
    lines.push('', 'Warnings:', ...plan.warnings.map((item) => `  ! ${item}`));
  if (plan.destructiveActions.length > 0) {
    lines.push('', 'DESTRUCTIVE ACTIONS:');
    for (const item of plan.destructiveActions)
      lines.push(`  ! ${item.actionId}: ${item.impact} (recovery: ${item.recovery})`);
  }
  return lines.join('\n');
}

export function formatExecutionResult(result: ExecutionResult): string {
  const lines = [
    `Apply ${result.status.toUpperCase()}: ${result.summary}`,
    `  Completed actions: ${result.completedActionIds.length}`,
    `  Created objects: ${result.createdObjects.length}`,
  ];
  for (const object of result.createdObjects)
    lines.push(`  + ${object.type}: ${object.name}${object.url ? ` (${object.url})` : ''}`);
  for (const warning of result.warnings) lines.push(`  ! ${warning}`);
  for (const failure of result.failures)
    lines.push(`  X ${failure.code}: ${failure.summary}\n    Next: ${failure.nextAction}`);
  return lines.join('\n');
}

export function formatRun(record: RunRecord): string {
  return `${record.runId}  ${record.status.padEnd(10)}  ${record.agent}+${record.tool}  ${record.updatedAt}  ${record.objective}`;
}

export function formatError(error: AurousError): string {
  return [
    `${error.severity.toUpperCase()} ${error.code}: ${error.message}`,
    `Probable cause: ${error.probableCause}`,
    `Next action: ${error.nextAction}`,
    ...(error.runId ? [`Run: ${error.runId}`] : []),
  ].join('\n');
}
