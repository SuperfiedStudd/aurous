import type { AurousError } from './errors.js';
import type { AurousPlan, ContextSummary, ExecutionResult, RunRecord } from '../domain/schemas.js';
import type { RecoveryPlan } from '../domain/recovery.js';

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

export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const lines = [
    `Recovery plan ${plan.recoveryRunId}`,
    `  Original run: ${plan.originalRunId}`,
    `  Agent/tool: ${plan.agent} + ${plan.tool}`,
    `  Executable: ${plan.isExecutable ? 'yes' : 'no'}`,
    '',
    'Exact-ID classifications:',
    ...plan.classifications.map(
      (item) =>
        `  ${item.actionId}  ${item.status} / ${item.recoveryOperation}${item.externalId ? `  id=${item.externalId}` : ''}\n    ${item.evidence}`,
    ),
  ];
  if (plan.compatibilityDecisions.length > 0) {
    lines.push('', 'Compatibility decisions:');
    for (const decision of plan.compatibilityDecisions) {
      lines.push(
        `  ! ${decision.property}: ${decision.approvedType} -> ${decision.recoveryType}`,
        `    ${decision.reason}`,
      );
      for (const consequence of decision.consequences) lines.push(`    - ${consequence}`);
    }
  }
  lines.push('', 'Exact recovery actions:');
  if (plan.plannedActions.length === 0) lines.push('  (none)');
  for (const action of plan.plannedActions) {
    const externalId = action.properties.find(
      (property) => property.key === 'notion.recovery.externalId',
    )?.value;
    lines.push(
      `  ${action.id}  ${action.operation} ${action.objectType} "${action.target}"${externalId ? `  exact-id=${externalId}` : ''}`,
    );
  }
  lines.push('', 'Destructive actions: none');
  if (plan.warnings.length > 0)
    lines.push('', 'Warnings:', ...plan.warnings.map((warning) => `  ! ${warning}`));
  return lines.join('\n');
}

export function formatRun(record: RunRecord): string {
  const linkage = record.recoveryOf ? `  recovers=${record.recoveryOf}` : '';
  return `${record.runId}  ${record.status.padEnd(16)}  ${record.agent}+${record.tool}  ${record.updatedAt}${linkage}  ${record.objective}`;
}

export function formatError(error: AurousError): string {
  return [
    `${error.severity.toUpperCase()} ${error.code}: ${error.message}`,
    `Probable cause: ${error.probableCause}`,
    `Next action: ${error.nextAction}`,
    ...(error.runId ? [`Run: ${error.runId}`] : []),
  ].join('\n');
}
