import type { AurousError } from './errors.js';
import type { AurousPlan, ContextSummary, ExecutionResult, RunRecord } from '../domain/schemas.js';
import type { RecoveryPlan } from '../domain/recovery.js';
import {
  formatProgress,
  renderPanel,
  type ProgressWord,
  type RenderOptions,
} from './presentation.js';

export interface Output {
  log(message?: string): void;
  error(message: string): void;
  progress?(word: ProgressWord, detail: string, elapsedSeconds?: string | number): void;
}

export const consoleOutput: Output = {
  log: (message = '') => console.log(message),
  error: (message) => console.error(message),
  progress: (word, detail, elapsedSeconds) =>
    console.log(formatProgress(word, detail, elapsedSeconds)),
};

export function formatContextSummary(summary: ContextSummary, options: RenderOptions = {}): string {
  const lines = [
    'Context summary (shown before agent invocation)',
    `Approved paths  ${summary.approvedPaths.join(', ')}`,
    `Included        ${summary.fileCount} files · ${summary.totalBytes} bytes`,
  ];
  if (summary.git) {
    lines.push(`Git branch      ${summary.git.branch || '(detached)'}`);
    if (summary.git.recentCommits.length > 0)
      lines.push(`Recent commits  ${summary.git.recentCommits.join(' | ')}`);
  }
  if (summary.files.length > 0) lines.push('', 'Source material');
  for (const file of summary.files)
    lines.push(`+ ${file.relativePath}  ${file.category} · ${file.bytes} B`);
  for (const skipped of summary.skipped) lines.push(`- skipped ${skipped}`);
  return renderPanel('Context', lines, options);
}

export function formatPlan(plan: AurousPlan, options: RenderOptions = {}): string {
  const planLines = [
    `Run       ${plan.runId}`,
    `Objective ${plan.objective}`,
    `Outcome   ${plan.expectedResult}`,
    '',
    'Workspace structure:',
    ...plan.proposedWorkspaceStructure.map(
      (item) => `- ${item.kind}: ${item.name} — ${item.purpose}`,
    ),
  ];
  const previewLines = [`${plan.plannedActions.length} exact action(s) · no writes yet`, ''];
  for (const action of plan.plannedActions) {
    previewLines.push(
      `${action.id}  ${action.operation.toUpperCase()} ${action.objectType}  ${action.target}`,
      `  ${action.description}`,
    );
    let exactReuseShown = false;
    for (const property of action.properties) {
      if (!options.verbose && isHiddenDestinationProperty(property.key)) {
        if (property.key.endsWith('.dedupe.knownExternalId') && !exactReuseShown) {
          previewLines.push('  reuse: exact existing object verified during read-only inspection');
          exactReuseShown = true;
        }
        continue;
      }
      previewLines.push(`  ${property.key}: ${property.value}`);
    }
    if (action.dependsOn.length > 0)
      previewLines.push(`  depends on: ${action.dependsOn.join(', ')}`);
    previewLines.push('');
  }
  if (plan.assumptions.length > 0)
    previewLines.push('Assumptions', ...plan.assumptions.map((item) => `- ${item}`), '');
  if (plan.warnings.length > 0)
    previewLines.push('Warnings', ...plan.warnings.map((item) => `! ${item}`), '');
  if (plan.destructiveActions.length > 0) {
    previewLines.push('DESTRUCTIVE ACTIONS');
    for (const item of plan.destructiveActions)
      previewLines.push(`! ${item.actionId}: ${item.impact}`, `  recovery: ${item.recovery}`);
  } else {
    previewLines.push('Destructive actions  none');
  }
  return `${renderPanel('Plan', planLines, options)}\n${renderPanel('Preview', trimBlankEnd(previewLines), options)}`;
}

function isHiddenDestinationProperty(key: string): boolean {
  return (
    key === 'notion.destination.parentPageId' ||
    key === 'linear.teamId' ||
    key === 'mock.workspaceId' ||
    key.endsWith('.dedupe.knownExternalId') ||
    key.endsWith('.dedupe.knownUrl')
  );
}

export function formatExecutionResult(
  result: ExecutionResult,
  context: { runId?: string; plan?: AurousPlan } = {},
  options: RenderOptions = {},
): string {
  const operationByAction = new Map(
    context.plan?.plannedActions.map((action) => [action.id, action.operation]) ?? [],
  );
  const updatedCount = result.createdObjects.filter(
    (object) => operationByAction.get(object.actionId) === 'update',
  ).length;
  const createdCount = result.createdObjects.length - updatedCount;
  const lines = [
    `Status              ${result.status.toUpperCase()}`,
    ...(context.runId ? [`Run                 ${context.runId}`] : []),
    `Summary             ${result.summary}`,
    '',
    `Completed actions: ${result.completedActionIds.length}`,
    `Created objects: ${createdCount}`,
    `Updated objects: ${updatedCount}`,
    `Skipped actions: ${result.skippedActions?.length ?? 0}`,
    `Compatibility notes: ${result.compatibilityNotes?.length ?? 0}`,
  ];
  if (result.createdObjects.length > 0) lines.push('', 'Objects');
  for (const object of result.createdObjects) {
    const operation = operationByAction.get(object.actionId) ?? 'create';
    lines.push(`+ ${operation} ${object.type}: ${object.name}`);
    lines.push(`  ID: ${object.externalId ?? '(not returned)'}`);
    lines.push(`  URL: ${object.url ?? '(not returned)'}`);
  }
  if ((result.skippedActions?.length ?? 0) > 0) lines.push('', 'Skipped');
  for (const action of result.skippedActions ?? []) {
    lines.push(`= ${action.type}: ${action.name} — ${action.reason}`);
    if (action.externalId) lines.push(`  Existing ID: ${action.externalId}`);
    if (action.url) lines.push(`  Existing URL: ${action.url}`);
  }
  if ((result.compatibilityNotes?.length ?? 0) > 0) lines.push('', 'Compatibility');
  for (const note of result.compatibilityNotes ?? []) lines.push(`~ ${note}`);
  if (result.warnings.length > 0 || result.failures.length > 0) lines.push('', 'Diagnostics');
  for (const warning of result.warnings) lines.push(`! ${warning}`);
  for (const failure of result.failures)
    lines.push(
      `X ${failure.code}: ${failure.summary}`,
      `  Cause: ${failure.probableCause}`,
      `  Next: ${failure.nextAction}`,
    );
  if (result.warnings.length === 0 && result.failures.length === 0)
    lines.push('', 'Diagnostics  none');
  return renderPanel('Results', lines, options);
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

function trimBlankEnd(lines: string[]): string[] {
  while (lines.at(-1) === '') lines.pop();
  return lines;
}
