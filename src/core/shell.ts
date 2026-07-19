import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import {
  AgentNameSchema,
  ToolNameSchema,
  type AgentName,
  type ToolName,
} from '../domain/schemas.js';
import { ingestContext } from './context.js';
import { asAurousError, AurousError } from './errors.js';
import { formatError } from './output.js';
import { formatApprovalRequest, formatPlainNotice, formatShellStatus } from './presentation.js';
import type { RunStore } from './run-store.js';
import type { AurousServices } from './services.js';
import {
  DynamicShellRenderer,
  type ShellPhase,
  type ShellTerminal,
  type ShellViewState,
} from './shell-renderer.js';

export interface ShellDependencies {
  workspace: string;
  store: RunStore;
  services: AurousServices;
  renderer: DynamicShellRenderer;
  initialLinearTeam?: string;
}

export interface ShellSnapshot {
  agent: AgentName;
  model: string;
  target: ToolName;
  contextPaths: string[];
  preset?: string;
  linearTeam?: string;
  lastRunId?: string;
  history: string[];
  state: ShellPhase;
}

interface ShellState extends ShellSnapshot {
  project: string;
  lastRequest?: string;
}

type PromptKind = 'composer' | 'team' | 'approval';

export class AurousShell {
  private readonly terminal: ShellTerminal;
  private state?: ShellState;
  private exitRequested = false;
  private activeController?: AbortController;
  private activePrompt?: PromptKind;
  private promptCancelled = false;
  private lastComposerInterrupt = 0;

  constructor(private readonly dependencies: ShellDependencies) {
    this.terminal = dependencies.renderer.terminal;
  }

  async run(): Promise<void> {
    const config = await this.loadOrInitializeConfig();
    this.state = {
      agent: config.defaultAgent,
      model: defaultModel(config.defaultAgent),
      target: config.defaultTool,
      contextPaths: ['.'],
      preset: 'software-launch',
      ...(this.dependencies.initialLinearTeam || process.env.AUROUS_LINEAR_TEAM
        ? {
            linearTeam: this.dependencies.initialLinearTeam ?? process.env.AUROUS_LINEAR_TEAM ?? '',
          }
        : {}),
      history: [],
      state: 'Ready',
      project: path.basename(this.dependencies.workspace),
    };
    this.terminal.onInterrupt(() => this.handleInterrupt());
    this.dependencies.renderer.start(this.view());

    try {
      while (!this.exitRequested) {
        this.dependencies.renderer.update(this.view());
        const input = await this.ask('composer', 'aurous');
        if (input === undefined) {
          if (this.consumePromptCancellation()) continue;
          break;
        }
        const request = input.trim();
        if (!request) continue;
        this.remember(request);
        this.dependencies.renderer.dismissOverlay();
        try {
          await this.dispatch(request);
        } catch (error) {
          this.handleError(error);
        }
      }
    } finally {
      this.exitRequested = true;
      this.dependencies.renderer.close();
      this.terminal.write('Hallmarking Session closed. Local run history is preserved.\n');
    }
  }

  snapshot(): ShellSnapshot {
    const state = this.requireState();
    return {
      agent: state.agent,
      model: state.model,
      target: state.target,
      contextPaths: [...state.contextPaths],
      ...(state.preset ? { preset: state.preset } : {}),
      ...(state.linearTeam ? { linearTeam: state.linearTeam } : {}),
      ...(state.lastRunId ? { lastRunId: state.lastRunId } : {}),
      history: [...state.history],
      state: state.state,
    };
  }

  private async dispatch(input: string): Promise<void> {
    if (input.startsWith('/')) await this.dispatchSlashCommand(input);
    else await this.executeNaturalRequest(input);
  }

  private async dispatchSlashCommand(input: string): Promise<void> {
    const [command = '', ...args] = tokenize(input);
    switch (command.toLowerCase()) {
      case '/help':
        this.showHelp();
        return;
      case '/agent':
        this.selectAgent(args);
        return;
      case '/model':
        this.selectModel(args);
        return;
      case '/target':
        this.selectTarget(args);
        return;
      case '/context':
        await this.selectContext(args);
        return;
      case '/preset':
        this.selectPreset(args);
        return;
      case '/plan':
        await this.plan(args.join(' ').trim() || undefined);
        return;
      case '/apply':
        await this.apply(args[0]);
        return;
      case '/runs':
        this.dependencies.renderer.commit('Saved runs');
        await this.dependencies.services.runs();
        this.setReady('Run history listed.');
        return;
      case '/status':
        this.showStatus();
        return;
      case '/clear':
        this.dependencies.renderer.clear();
        return;
      case '/exit':
      case '/quit':
        this.exitRequested = true;
        return;
      default:
        throw shellInputError(
          'command',
          `Unknown command: ${command || input}. Type /help for available commands.`,
        );
    }
  }

  private async executeNaturalRequest(request: string): Promise<void> {
    const state = this.requireState();
    state.lastRequest = request;
    const routedTarget = routeNaturalRequest(request, state.target);
    if (routedTarget !== state.target) state.target = routedTarget;
    this.dependencies.renderer.commit(`› ${request}`);
    this.setPhase('Planning');
    this.dependencies.renderer.progress(
      'Assaying',
      `Interpreting request for ${displayTarget(routedTarget)}.`,
    );
    const planned = await this.plan(request);
    if (!planned || this.exitRequested) return;
    await this.apply(state.lastRunId, true);
  }

  private selectAgent(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.renderer.notice(
        `Agent ${displayAgent(state.agent)} · model ${state.model}`,
      );
      return;
    }
    const parsed = AgentNameSchema.safeParse(args[0]?.toLowerCase());
    if (!parsed.success) throw shellInputError('agent', 'Choose codex, claude, or mock.');
    state.agent = parsed.data;
    state.model = defaultModel(parsed.data);
    this.setReady(`Agent ${displayAgent(state.agent)} · model ${state.model}`);
  }

  private selectModel(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.renderer.notice(`Model ${state.model}`);
      return;
    }
    const model = args.join(' ').trim();
    if (state.agent === 'mock' && model !== 'auto' && model !== 'built-in')
      throw shellInputError(
        'model',
        'The mock agent always uses its built-in deterministic adapter.',
      );
    if (model === 'auto') state.model = defaultModel(state.agent);
    else {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model))
        throw shellInputError('model', 'Use a model name without spaces or shell characters.');
      state.model = state.agent === 'mock' ? 'built-in deterministic adapter' : model;
    }
    this.setReady(`Model ${state.model}`);
  }

  private selectTarget(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.renderer.notice(targetSummary(state));
      return;
    }
    const parsed = ToolNameSchema.safeParse(args[0]?.toLowerCase());
    if (!parsed.success) throw shellInputError('target', 'Choose notion, linear, or mock.');
    state.target = parsed.data;
    if (parsed.data === 'linear') {
      if (args.length > 1) {
        const team = validateTeam(args.slice(1).join(' '));
        if (!team.valid) throw shellInputError('team', team.message);
        state.linearTeam = team.value;
        this.setReady(`Target Linear · team ${team.value}`);
      } else {
        delete state.linearTeam;
        this.setReady('Target Linear · team not selected', 'warning');
      }
      return;
    }
    this.setReady(`Target ${displayTarget(state.target)}`);
  }

  private async selectContext(args: string[]): Promise<void> {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.renderer.notice(`Context ${state.contextPaths.join(', ')}`);
      return;
    }
    const context = await ingestContext({ cwd: this.dependencies.workspace, paths: args });
    state.contextPaths = [...args];
    this.setReady(
      `Context ${args.join(', ')} · ${context.summary.fileCount} files · ${context.summary.totalBytes} bytes`,
    );
  }

  private selectPreset(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.renderer.notice(`Preset ${state.preset ?? 'none'}`);
      return;
    }
    const requested = args[0]?.toLowerCase();
    if (requested === 'none') delete state.preset;
    else if (requested === 'software-launch' || requested === 'linear-software-launch-v1')
      state.preset = 'software-launch';
    else throw shellInputError('preset', 'Choose software-launch or none.');
    this.setReady(`Preset ${state.preset ?? 'none'}`);
  }

  private async plan(objective?: string): Promise<boolean> {
    const state = this.requireState();
    if (state.target === 'linear' && state.preset === 'software-launch') {
      const team = await this.requireLinearTeam();
      if (!team) {
        this.setReady('Pending Linear request canceled.', 'warning');
        return false;
      }
    }

    this.setPhase('Planning');
    const controller = this.beginActivity();
    const model = invocationModel(state);
    try {
      const plan =
        state.target === 'linear' && state.preset === 'software-launch'
          ? await this.dependencies.services.planLinearDemo({
              agent: state.agent,
              team: state.linearTeam!,
              contextPaths: state.contextPaths,
              ...(model ? { model } : {}),
              embedded: true,
            })
          : await this.dependencies.services.plan({
              agent: state.agent,
              tool: state.target,
              contextPaths: state.contextPaths,
              objective:
                objective ??
                state.lastRequest ??
                `Set up ${displayTarget(state.target)} for ${state.project} using the selected context.`,
              ...(model ? { model } : {}),
              embedded: true,
              signal: controller.signal,
            });
      state.lastRunId = plan.runId;
      state.state = 'Awaiting Approval';
      this.dependencies.renderer.update(this.view());
      this.dependencies.renderer.notice(
        `Plan ready · ${plan.plannedActions.length} actions · ${plan.runId}`,
      );
      return true;
    } finally {
      this.endActivity(controller);
    }
  }

  private async apply(runId?: string, alreadyPreviewed = false): Promise<void> {
    const state = this.requireState();
    const selectedRun = runId ?? state.lastRunId;
    if (!selectedRun)
      throw shellInputError('apply', 'Create a plan first with /plan or provide a saved run ID.');
    const savedPlan = await this.dependencies.store.loadPlan(selectedRun);
    if (savedPlan.agent !== state.agent) {
      state.agent = savedPlan.agent;
      state.model = defaultModel(savedPlan.agent);
    }
    state.target = savedPlan.tool;
    state.lastRunId = selectedRun;
    this.setPhase('Awaiting Approval');
    const controller = this.beginActivity();
    const model = invocationModel(state);
    try {
      const result = await this.dependencies.services.apply(selectedRun, {
        confirmed: false,
        confirm: () => this.confirmApply(),
        alreadyPreviewed,
        embedded: true,
        ...(model ? { model } : {}),
        signal: controller.signal,
      });
      if (!result) {
        this.setReady('Approval canceled. No external writes were attempted.', 'warning');
        return;
      }
      state.state = result.status === 'succeeded' ? 'Complete' : 'Error';
      this.dependencies.renderer.update(this.view());
      this.dependencies.renderer.notice(
        `Run ${result.status} · ${result.completedActionIds.length} completed · ${result.createdObjects.length} objects`,
        result.status === 'succeeded' ? 'success' : 'warning',
      );
    } finally {
      this.endActivity(controller);
    }
  }

  private async requireLinearTeam(): Promise<string | undefined> {
    const state = this.requireState();
    if (state.linearTeam) return state.linearTeam;
    while (!this.exitRequested) {
      state.state = 'Selecting Team';
      this.dependencies.renderer.update(this.view());
      const answer = await this.ask('team', 'team', true);
      if (answer === undefined) {
        if (this.consumePromptCancellation()) return undefined;
        this.exitRequested = true;
        return undefined;
      }
      const value = answer.trim();
      if (value.toLowerCase() === 'cancel') return undefined;
      const team = validateTeam(value);
      if (!team.valid) {
        this.dependencies.renderer.recoverable(team.message);
        continue;
      }
      state.linearTeam = team.value;
      this.dependencies.renderer.notice(`Linear team ${team.value}`);
      return team.value;
    }
    return undefined;
  }

  private async confirmApply(): Promise<boolean> {
    const state = this.requireState();
    state.state = 'Awaiting Approval';
    this.dependencies.renderer.update(this.view());
    this.dependencies.renderer.showOverlay(
      formatApprovalRequest(
        'Execute exactly this saved plan through the configured MCP?',
        'apply',
        this.terminal.renderOptions,
      ),
    );
    while (!this.exitRequested) {
      const answer = await this.ask('approval', 'approval', true);
      if (answer === undefined) {
        if (this.consumePromptCancellation()) return false;
        this.exitRequested = true;
        return false;
      }
      const value = answer.trim().toLowerCase();
      if (value === 'cancel') return false;
      if (value === 'apply') {
        state.state = 'Applying';
        this.dependencies.renderer.dismissOverlay();
        this.dependencies.renderer.update(this.view());
        return true;
      }
      this.dependencies.renderer.recoverable('Type apply to execute or cancel to stop.');
    }
    return false;
  }

  private showHelp(): void {
    this.dependencies.renderer.showOverlay(
      formatPlainNotice(
        'Help',
        [
          '/agent · /model · /target     runtime selection',
          '/context · /preset            planning inputs',
          '/plan · /apply                workflow control',
          '/runs · /status               local run state',
          '/clear · /exit                shell control',
        ],
        this.terminal.renderOptions,
      ),
    );
  }

  private showStatus(): void {
    this.dependencies.renderer.showOverlay(
      formatShellStatus(this.view(), this.terminal.renderOptions),
    );
  }

  private handleError(error: unknown): void {
    const classified = asAurousError(error, this.state?.lastRunId);
    const code = classified.code;
    if (code.startsWith('AUR-SHELL') || code.startsWith('AUR-CTX')) {
      this.setReady(`${classified.message} ${classified.nextAction}`, 'warning');
      return;
    }
    const internal = code.startsWith('AUR-CORE');
    this.requireState().state = 'Error';
    this.dependencies.renderer.update(this.view());
    this.dependencies.renderer.commit(
      formatPlainNotice(
        internal ? 'Fatal internal error' : 'Workflow failure',
        formatError(classified).split('\n'),
        this.terminal.renderOptions,
      ),
    );
    this.dependencies.renderer.recoverable(
      internal ? 'Aurous stopped the unsafe operation.' : 'Workflow stopped safely.',
    );
  }

  private setReady(message: string, tone: 'success' | 'warning' | 'neutral' = 'success'): void {
    this.requireState().state = 'Ready';
    this.dependencies.renderer.update(this.view());
    this.dependencies.renderer.notice(message, tone);
  }

  private setPhase(state: ShellPhase): void {
    this.requireState().state = state;
    this.dependencies.renderer.update(this.view());
  }

  private view(): ShellViewState {
    const state = this.requireState();
    return {
      agent: state.agent,
      model: state.model,
      target: state.target,
      mode: 'Interactive',
      state: state.state,
      project: state.project,
      contextPaths: state.contextPaths,
      ...(state.target === 'linear' && state.preset ? { preset: state.preset } : {}),
      ...(state.target === 'linear' && state.linearTeam ? { linearTeam: state.linearTeam } : {}),
      ...(state.lastRunId ? { lastRunId: state.lastRunId } : {}),
      hint: hintFor(state),
    };
  }

  private async ask(
    kind: PromptKind,
    label: string,
    forgetInput = false,
  ): Promise<string | undefined> {
    this.activePrompt = kind;
    this.promptCancelled = false;
    const answer = await this.terminal.question(this.dependencies.renderer.preparePrompt(label));
    delete this.activePrompt;
    if (answer !== undefined) {
      this.dependencies.renderer.acceptInput(answer, label);
      if (forgetInput) this.terminal.forgetLastInput(answer);
    }
    return answer;
  }

  private consumePromptCancellation(): boolean {
    const cancelled = this.promptCancelled;
    this.promptCancelled = false;
    return cancelled;
  }

  private remember(input: string): void {
    const history = this.requireState().history;
    if (history[0] !== input) history.unshift(input);
    if (history.length > 100) history.length = 100;
  }

  private beginActivity(): AbortController {
    const controller = new AbortController();
    this.activeController = controller;
    return controller;
  }

  private endActivity(controller: AbortController): void {
    if (this.activeController === controller) delete this.activeController;
  }

  private handleInterrupt(): void {
    if (this.activeController && !this.activePrompt) {
      this.activeController.abort();
      this.dependencies.renderer.progress('Tempering', 'Cancelling the active operation safely.');
      return;
    }
    if (this.activePrompt) {
      const now = Date.now();
      if (this.activePrompt === 'composer' && now - this.lastComposerInterrupt < 1_500) {
        this.exitRequested = true;
        this.dependencies.renderer.cancelInput();
        this.terminal.close();
        return;
      }
      this.lastComposerInterrupt = now;
      this.promptCancelled = true;
      this.terminal.cancelQuestion();
      this.dependencies.renderer.cancelInput();
      this.dependencies.renderer.recoverable(
        this.activePrompt === 'composer'
          ? 'Input canceled. Press Ctrl+C again to exit.'
          : `${this.activePrompt === 'team' ? 'Team selection' : 'Approval'} canceled.`,
      );
      return;
    }
    this.exitRequested = true;
    this.terminal.close();
  }

  private requireState(): ShellState {
    if (!this.state) throw new Error('Aurous shell has not started.');
    return this.state;
  }

  private async loadOrInitializeConfig() {
    try {
      return await this.dependencies.store.loadConfig();
    } catch (error) {
      if (error instanceof AurousError && error.code === 'AUR-STATE-002')
        return this.dependencies.store.init();
      throw error;
    }
  }
}

export function createReadlineShellTerminal(
  input: Readable = stdin,
  output: Writable = stdout,
): ShellTerminal {
  const terminalInput = input as Readable & { isTTY?: boolean };
  const terminalOutput = output as Writable & { isTTY?: boolean; columns?: number };
  const isTerminal = Boolean(terminalInput.isTTY && terminalOutput.isTTY);
  const color =
    isTerminal &&
    process.env.NO_COLOR === undefined &&
    process.env.FORCE_COLOR !== '0' &&
    process.env.TERM !== 'dumb';
  const ansi = color;
  const columns = terminalOutput.columns ?? (Number(process.env.COLUMNS) || 96);
  const reader = createInterface({
    input,
    output,
    terminal: ansi,
    historySize: 100,
    removeHistoryDuplicates: true,
  });
  let closed = false;
  let questionController: AbortController | undefined;
  reader.on('close', () => {
    closed = true;
    questionController?.abort();
  });
  return {
    ansi,
    columns,
    renderOptions: { width: columns, color, unicode: process.env.TERM !== 'dumb' },
    async question(prompt) {
      if (closed) return undefined;
      const controller = new AbortController();
      questionController = controller;
      try {
        return await reader.question(prompt, { signal: controller.signal });
      } catch (error) {
        if (closed || (error instanceof Error && error.name === 'AbortError')) return undefined;
        throw error;
      } finally {
        if (questionController === controller) questionController = undefined;
      }
    },
    write(value) {
      output.write(value);
    },
    clear() {
      if (ansi) output.write('\u001b[2J\u001b[H');
      else output.write('\n');
    },
    close() {
      if (!closed) {
        closed = true;
        questionController?.abort();
        reader.close();
      }
    },
    cancelQuestion() {
      questionController?.abort();
    },
    onInterrupt(handler) {
      reader.on('SIGINT', handler);
    },
    forgetLastInput(value) {
      const history = (reader as typeof reader & { history?: string[] }).history;
      if (history?.[0] === value) history.shift();
    },
  };
}

export function routeNaturalRequest(request: string, currentTarget: ToolName): ToolName {
  if (/\blinear\b/i.test(request)) return 'linear';
  if (/\bnotion\b/i.test(request)) return 'notion';
  return currentTarget;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const character of input.trim()) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else current += character;
  }
  if (quote) throw shellInputError('command', 'Close the quoted argument and try again.');
  if (current) tokens.push(current);
  return tokens;
}

function hintFor(state: ShellState): string {
  switch (state.state) {
    case 'Selecting Team':
      return 'Select a Linear team before planning, or type cancel.';
    case 'Planning':
      return 'Assaying project context and generating the workspace plan.';
    case 'Awaiting Approval':
      return 'Type apply to execute or cancel to stop.';
    case 'Applying':
      return 'Forging approved workspace actions.';
    case 'Complete':
      return 'Run completed. Enter another request.';
    case 'Error':
      return 'The workflow stopped safely. Review the message, then try again.';
    default:
      return state.target === 'linear' && !state.linearTeam
        ? 'Select a Linear team before planning.'
        : 'Ask Aurous to configure a workspace or type /help.';
  }
}

function invocationModel(state: ShellState): string | undefined {
  if (state.agent === 'mock' || state.model === 'auto') return undefined;
  return state.model;
}

function defaultModel(agent: AgentName): string {
  return agent === 'mock' ? 'built-in deterministic adapter' : 'auto';
}

function displayAgent(agent: AgentName): string {
  if (agent === 'codex') return 'Codex';
  if (agent === 'claude') return 'Claude Code';
  return 'Mock';
}

function displayTarget(target: ToolName): string {
  if (target === 'linear') return 'Linear';
  if (target === 'notion') return 'Notion';
  return 'Mock';
}

function targetSummary(state: ShellState): string {
  if (state.target !== 'linear') return `Target ${displayTarget(state.target)}`;
  return `Target Linear · team ${state.linearTeam ?? 'not selected'}`;
}

type TeamValidation = { valid: true; value: string } | { valid: false; message: string };

function validateTeam(value: string): TeamValidation {
  const team = value.trim();
  if (!team) return { valid: false, message: 'Enter a team name, key, or UUID; or type cancel.' };
  if (
    team.length > 100 ||
    [...team].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return {
      valid: false,
      message: 'Unsupported team value. Enter a name, key, or UUID; or type cancel.',
    };
  return { valid: true, value: team };
}

function shellInputError(field: string, nextAction: string): AurousError {
  return new AurousError({
    code: 'AUR-SHELL-001',
    summary: `Invalid ${field} selection.`,
    probableCause: 'The interactive command contained a missing or unsupported argument.',
    nextAction,
  });
}
