import type { AgentName, ToolName } from '../domain/schemas.js';

export const progressWords = [
  'Assaying',
  'Smelting',
  'Forging',
  'Tempering',
  'Polishing',
  'Hallmarking',
] as const;
export type ProgressWord = (typeof progressWords)[number];

export interface RenderOptions {
  width?: number;
  color?: boolean;
  unicode?: boolean;
}

export interface RuntimeMetadata {
  agent: AgentName;
  target: ToolName;
  mode: string;
  runId?: string;
  model?: string;
}

export interface ShellStatusMetadata {
  agent: AgentName;
  model: string;
  target: ToolName;
  mode: string;
  project: string;
  contextPaths: string[];
  preset?: string;
  linearTeam?: string;
  lastRunId?: string;
}

interface ResolvedRenderOptions {
  width: number;
  color: boolean;
  unicode: boolean;
}

const GOLD = '\u001b[38;5;220m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const wordmark = [
  '   █████  ██   ██ ██████   ██████  ██   ██ ███████',
  '  ██   ██ ██   ██ ██   ██ ██    ██ ██   ██ ██     ',
  '  ███████ ██   ██ ██████  ██    ██ ██   ██ ███████',
  '  ██   ██ ██   ██ ██  ██  ██    ██ ██   ██      ██',
  '  ██   ██  █████  ██   ██  ██████   █████  ███████',
];

export function formatOpeningHeader(
  metadata: RuntimeMetadata,
  options: RenderOptions = {},
): string {
  const resolved = resolveRenderOptions(options);
  const contentWidth = resolved.width - 4;
  const mark =
    Math.max(...wordmark.map((line) => line.length)) <= contentWidth
      ? wordmark
      : ['A  U  R  O  U  S'];
  const lines = [
    ...mark,
    '',
    'AUROUS · PRODUCTIVITY, RESOLVED.',
    '',
    `agent ${agentDisplayName(metadata.agent)}  ·  target ${toolDisplayName(metadata.target)}  ·  mode ${metadata.mode}`,
    ...(metadata.model ? [`model ${metadata.model}`] : []),
    ...(metadata.runId ? [`run ${metadata.runId}`] : []),
  ];
  return renderPanel('', lines, resolved, new Set(mark.map((_line, index) => index)));
}

export function renderPanel(
  title: string,
  lines: string[],
  options: RenderOptions = {},
  accentLines: ReadonlySet<number> = new Set(),
): string {
  const resolved = resolveRenderOptions(options);
  const glyphs = resolved.unicode
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  const titleText = title ? ` ${title} ` : '';
  const topPrefix = `${glyphs.tl}${title ? glyphs.h : ''}${titleText}`;
  const top = `${topPrefix}${glyphs.h.repeat(Math.max(0, resolved.width - topPrefix.length - 1))}${glyphs.tr}`;
  const bottom = `${glyphs.bl}${glyphs.h.repeat(Math.max(0, resolved.width - 2))}${glyphs.br}`;
  const contentWidth = resolved.width - 4;
  const wrapped = lines.flatMap((line, sourceIndex) =>
    splitAndWrap(line, contentWidth).map((text) => ({ text, sourceIndex })),
  );
  const body = wrapped.map(({ text, sourceIndex }) => {
    const padded = ` ${text.padEnd(contentWidth)} `;
    const content = accentLines.has(sourceIndex) ? gold(padded, resolved) : padded;
    return `${gold(glyphs.v, resolved)}${content}${gold(glyphs.v, resolved)}`;
  });
  return [gold(top, resolved, true), ...body, gold(bottom, resolved)].join('\n');
}

export function formatProgress(
  word: ProgressWord,
  detail: string,
  elapsedSeconds?: string | number,
  options: RenderOptions = {},
): string {
  const resolved = resolveRenderOptions(options);
  const elapsed = elapsedSeconds === undefined ? '' : ` · ${elapsedSeconds}s`;
  return `${gold(word.padEnd(11), resolved, true)} ${detail}${elapsed}`;
}

export function formatApprovalPrompt(
  question: string,
  expected: string,
  options: RenderOptions = {},
): string {
  return `${formatApprovalRequest(question, expected, options)}\n${formatInputPrompt('approval', options)}`;
}

export function formatApprovalRequest(
  question: string,
  expected: string,
  options: RenderOptions = {},
): string {
  return renderPanel('Approval', [question, '', `Type ${expected} to confirm.`], options);
}

export function formatApprovalReceipt(detail: string, options: RenderOptions = {}): string {
  return renderPanel('Approval', [`✓ ${detail}`], options);
}

export function formatShellStatus(
  metadata: ShellStatusMetadata,
  options: RenderOptions = {},
): string {
  return renderPanel(
    'Session',
    [
      `agent    ${agentDisplayName(metadata.agent)}  ·  model ${metadata.model}`,
      `target   ${toolDisplayName(metadata.target)}  ·  mode ${metadata.mode}`,
      `project  ${metadata.project}`,
      `context  ${metadata.contextPaths.join(', ')}`,
      ...(metadata.preset ? [`preset   ${metadata.preset}`] : []),
      ...(metadata.linearTeam ? [`team     ${metadata.linearTeam}`] : []),
      ...(metadata.lastRunId ? [`run      ${metadata.lastRunId}`] : []),
    ],
    options,
  );
}

export function formatComposerFrame(options: RenderOptions = {}): string {
  const resolved = resolveRenderOptions(options);
  return renderPanel(
    'Request',
    [
      `Ask Aurous to set up your workspace, or type /help.  ${resolved.unicode ? '↑↓' : 'Up/Down'} history · Ctrl+C exit`,
    ],
    resolved,
  );
}

export function formatComposerPrompt(options: RenderOptions = {}): string {
  return formatInputPrompt('aurous', options);
}

export function formatInputPrompt(label: string, options: RenderOptions = {}): string {
  return `${gold(`${label} ›`, resolveRenderOptions(options), true)} `;
}

export function formatPlainNotice(
  title: string,
  lines: string[],
  options: RenderOptions = {},
): string {
  return renderPanel(title, lines, options);
}

export function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

function resolveRenderOptions(options: RenderOptions): ResolvedRenderOptions {
  const requestedWidth = options.width ?? terminalWidth();
  return {
    width: Math.max(32, Math.min(requestedWidth, 108)),
    color: options.color ?? supportsColor(),
    unicode: options.unicode ?? process.env.TERM !== 'dumb',
  };
}

function terminalWidth(): number {
  const columns = process.stdout.columns ?? Number(process.env.COLUMNS);
  return Number.isFinite(columns) && columns >= 32 ? columns : 96;
}

function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0') return false;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function splitAndWrap(value: string, width: number): string[] {
  return value.split('\n').flatMap((line) => wrapLine(line, width));
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const indent = line.match(/^\s*/)?.[0] ?? '';
  const lines: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const candidate = remaining.slice(0, width + 1);
    const breakAt = candidate.lastIndexOf(' ');
    const cut = breakAt > Math.min(indent.length + 8, width / 2) ? breakAt : width;
    lines.push(remaining.slice(0, cut).trimEnd());
    remaining = `${indent}${remaining.slice(cut).trimStart()}`;
  }
  lines.push(remaining);
  return lines;
}

function gold(value: string, options: ResolvedRenderOptions, bold = false): string {
  if (!options.color) return value;
  return `${GOLD}${bold ? BOLD : ''}${value}${RESET}`;
}

function agentDisplayName(agent: AgentName): string {
  if (agent === 'codex') return 'Codex';
  if (agent === 'claude') return 'Claude Code';
  return 'Mock';
}

function toolDisplayName(tool: ToolName): string {
  if (tool === 'notion') return 'Notion';
  if (tool === 'linear') return 'Linear';
  return 'Mock';
}
