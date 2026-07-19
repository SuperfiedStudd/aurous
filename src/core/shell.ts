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
import { formatContextSummary, formatError, type Output } from './output.js';
import {
  formatApprovalRequest,
  formatComposerFrame,
  formatComposerPrompt,
  formatInputPrompt,
  formatOpeningHeader,
  formatPlainNotice,
  formatProgress,
  formatShellStatus,
  type ShellStatusMetadata,
} from './presentation.js';
import type { RunStore } from './run-store.js';
import type { AurousServices } from './services.js';

export interface ShellIO {
  question(prompt: string): Promise<string | undefined>;
  clear(): void;
  close(): void;
  onInterrupt(handler: () => void): void;
  forgetLastInput(value: string): void;
}

export interface ShellDependencies {
  workspace: string;
  store: RunStore;
  services: AurousServices;
  output: Output;
  io?: ShellIO;
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
  mode: string;
}

interface ShellState extends ShellSnapshot {
  project: string;
  lastRequest?: string;
}

export class AurousShell {
  private readonly io: ShellIO;
  private state?: ShellState;
  private exitRequested = false;
  private activeController?: AbortController;

  constructor(private readonly dependencies: ShellDependencies) {
    this.io = dependencies.io ?? createReadlineShellIO();
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
      mode: 'Ready',
      project: path.basename(this.dependencies.workspace),
    };
    this.io.onInterrupt(() => this.handleInterrupt());
    this.printWelcome();

    try {
      while (!this.exitRequested) {
        this.dependencies.output.log(formatComposerFrame());
        const input = await this.io.question(formatComposerPrompt());
        if (input === undefined) break;
        const request = input.trim();
        if (!request) continue;
        this.remember(request);
        try {
          await this.dispatch(request);
        } catch (error) {
          const classified = asAurousError(error, this.state.lastRunId);
          this.dependencies.output.error(
            `${formatProgress('Tempering', 'The request could not be completed.')}\n${formatPlainNotice(
              'Diagnostics',
              formatError(classified).split('\n'),
            )}`,
          );
        } finally {
          if (!this.exitRequested) this.state.mode = 'Ready';
        }
      }
    } finally {
      this.exitRequested = true;
      this.io.close();
      this.dependencies.output.log(
        formatProgress('Hallmarking', 'Session closed. Local run history is preserved.'),
      );
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
      mode: state.mode,
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
        this.printHelp();
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
        this.dependencies.output.log(formatPlainNotice('Runs', ['Saved local run history']));
        await this.dependencies.services.runs();
        return;
      case '/status':
        this.printStatus();
        return;
      case '/clear':
        this.io.clear();
        this.printWelcome();
        return;
      case '/exit':
      case '/quit':
        this.exitRequested = true;
        return;
      default:
        this.dependencies.output.error(
          formatPlainNotice('Command', [
            `Unknown command: ${command || input}`,
            'Type /help to see the available commands.',
          ]),
        );
    }
  }

  private async executeNaturalRequest(request: string): Promise<void> {
    const state = this.requireState();
    state.mode = 'Routing';
    state.lastRequest = request;
    const routedTarget = routeNaturalRequest(request, state.target);
    this.dependencies.output.log(
      formatProgress('Assaying', `Interpreting request for ${displayTarget(routedTarget)}.`),
    );
    if (routedTarget !== state.target) {
      state.target = routedTarget;
      this.dependencies.output.log(
        formatPlainNotice('Routing', [
          `Target selected from request: ${displayTarget(routedTarget)}`,
        ]),
      );
    }
    await this.plan(request);
    if (this.exitRequested) return;
    await this.apply(state.lastRunId, true);
  }

  private selectAgent(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.output.log(
        formatPlainNotice('Agent', [`Active: ${displayAgent(state.agent)}`]),
      );
      return;
    }
    const parsed = AgentNameSchema.safeParse(args[0]?.toLowerCase());
    if (!parsed.success) throw shellInputError('agent', 'Choose codex, claude, or mock.');
    state.agent = parsed.data;
    state.model = defaultModel(parsed.data);
    this.dependencies.output.log(
      formatPlainNotice('Agent', [
        `Active agent: ${displayAgent(state.agent)}`,
        `Model: ${state.model}`,
      ]),
    );
  }

  private selectModel(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.output.log(formatPlainNotice('Model', [`Active: ${state.model}`]));
      return;
    }
    const model = args.join(' ').trim();
    if (state.agent === 'mock' && model !== 'auto' && model !== 'built-in') {
      throw shellInputError(
        'model',
        'The mock agent always uses its built-in deterministic adapter.',
      );
    }
    if (model === 'auto') state.model = defaultModel(state.agent);
    else {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model))
        throw shellInputError('model', 'Use a model name without spaces or shell characters.');
      state.model = state.agent === 'mock' ? 'built-in deterministic adapter' : model;
    }
    this.dependencies.output.log(formatPlainNotice('Model', [`Active model: ${state.model}`]));
  }

  private selectTarget(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.output.log(
        formatPlainNotice('Target', [
          `Active: ${displayTarget(state.target)}`,
          ...(state.target === 'linear' && state.linearTeam
            ? [`Linear team: ${state.linearTeam}`]
            : []),
        ]),
      );
      return;
    }
    const parsed = ToolNameSchema.safeParse(args[0]?.toLowerCase());
    if (!parsed.success) throw shellInputError('target', 'Choose notion, linear, or mock.');
    state.target = parsed.data;
    if (parsed.data === 'linear' && args.length > 1) state.linearTeam = args.slice(1).join(' ');
    this.dependencies.output.log(
      formatPlainNotice('Target', [
        `Active target: ${displayTarget(state.target)}`,
        ...(state.target === 'linear'
          ? [`Linear team: ${state.linearTeam ?? 'not selected'}`]
          : []),
      ]),
    );
  }

  private async selectContext(args: string[]): Promise<void> {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.output.log(
        formatPlainNotice('Context', [
          `Project: ${state.project}`,
          `Selected paths: ${state.contextPaths.join(', ')}`,
        ]),
      );
      return;
    }
    const context = await ingestContext({ cwd: this.dependencies.workspace, paths: args });
    state.contextPaths = [...args];
    this.dependencies.output.log(formatContextSummary(context.summary));
    this.dependencies.output.log(
      formatProgress('Hallmarking', 'Context loaded and ready for planning.'),
    );
  }

  private selectPreset(args: string[]): void {
    const state = this.requireState();
    if (args.length === 0) {
      this.dependencies.output.log(
        formatPlainNotice('Preset', [`Active: ${state.preset ?? 'none'}`]),
      );
      return;
    }
    const requested = args[0]?.toLowerCase();
    if (requested === 'none') delete state.preset;
    else if (requested === 'software-launch' || requested === 'linear-software-launch-v1')
      state.preset = 'software-launch';
    else throw shellInputError('preset', 'Choose software-launch or none.');
    this.dependencies.output.log(
      formatPlainNotice('Preset', [`Active preset: ${state.preset ?? 'none'}`]),
    );
  }

  private async plan(objective?: string): Promise<void> {
    const state = this.requireState();
    state.mode = 'Planning';
    const controller = this.beginActivity();
    const model = invocationModel(state);
    try {
      if (state.target === 'linear' && state.preset === 'software-launch') {
        const team = await this.requireLinearTeam();
        if (!team) return;
        const plan = await this.dependencies.services.planLinearDemo({
          agent: state.agent,
          team,
          contextPaths: state.contextPaths,
          ...(model ? { model } : {}),
          embedded: true,
        });
        state.lastRunId = plan.runId;
      } else {
        const plan = await this.dependencies.services.plan({
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
      }
      state.mode = 'Awaiting approval';
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
    if (savedPlan.agent !== state.agent || savedPlan.tool !== state.target) {
      const agentChanged = savedPlan.agent !== state.agent;
      state.agent = savedPlan.agent;
      state.target = savedPlan.tool;
      if (agentChanged) state.model = defaultModel(savedPlan.agent);
      this.dependencies.output.log(
        formatPlainNotice('Saved plan', [
          `Using the plan's recorded agent: ${displayAgent(savedPlan.agent)}`,
          `Using the plan's recorded target: ${displayTarget(savedPlan.tool)}`,
        ]),
      );
    }
    state.mode = 'Approval';
    const controller = this.beginActivity();
    const model = invocationModel(state);
    try {
      await this.dependencies.services.apply(selectedRun, {
        confirmed: false,
        confirm: () => this.confirmApply(),
        alreadyPreviewed,
        embedded: true,
        ...(model ? { model } : {}),
        signal: controller.signal,
      });
      state.lastRunId = selectedRun;
    } finally {
      this.endActivity(controller);
    }
  }

  private async requireLinearTeam(): Promise<string | undefined> {
    const state = this.requireState();
    if (state.linearTeam) return state.linearTeam;
    this.dependencies.output.log(
      formatPlainNotice('Linear destination', [
        'Enter an existing team name, key, or UUID.',
        'No Linear write occurs until the later approval step.',
      ]),
    );
    const answer = await this.io.question(formatInputPrompt('team'));
    if (answer === undefined) {
      this.exitRequested = true;
      return undefined;
    }
    const team = answer.trim();
    this.io.forgetLastInput(answer);
    if (!team) throw shellInputError('target', 'A Linear team is required for this preset.');
    state.linearTeam = team;
    return team;
  }

  private async confirmApply(): Promise<boolean> {
    this.dependencies.output.log(
      formatApprovalRequest('Execute exactly this saved plan through the configured MCP?', 'apply'),
    );
    const answer = await this.io.question(formatInputPrompt('approval'));
    if (answer === undefined) {
      this.exitRequested = true;
      return false;
    }
    this.io.forgetLastInput(answer);
    return answer.trim().toLowerCase() === 'apply';
  }

  private printWelcome(): void {
    const state = this.requireState();
    this.dependencies.output.log(
      formatOpeningHeader({
        agent: state.agent,
        model: state.model,
        target: state.target,
        mode: 'Interactive',
      }),
    );
    this.printStatus();
  }

  private printStatus(): void {
    this.dependencies.output.log(formatShellStatus(this.shellMetadata()));
  }

  private printHelp(): void {
    this.dependencies.output.log(
      formatPlainNotice('Help', [
        'Natural language  plan, preview, approve, and execute a request',
        '/agent [codex|claude|mock]',
        '/model [name|auto]',
        '/target [notion|linear|mock] [Linear team]',
        '/context [path ...]',
        '/preset [software-launch|none]',
        '/plan [objective]',
        '/apply [run-id]',
        '/runs',
        '/status',
        '/clear',
        '/exit',
        '',
        'Input editing, Up/Down history, Home/End, and Ctrl+C are provided by the terminal.',
      ]),
    );
  }

  private shellMetadata(): ShellStatusMetadata {
    const state = this.requireState();
    return {
      agent: state.agent,
      model: state.model,
      target: state.target,
      mode: state.mode,
      project: state.project,
      contextPaths: state.contextPaths,
      ...(state.target === 'linear' && state.preset ? { preset: state.preset } : {}),
      ...(state.target === 'linear' && state.linearTeam ? { linearTeam: state.linearTeam } : {}),
      ...(state.lastRunId ? { lastRunId: state.lastRunId } : {}),
    };
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
    if (this.activeController) {
      this.activeController.abort();
      this.dependencies.output.log(
        formatProgress('Tempering', 'Cancelling the active operation and closing safely.'),
      );
    }
    this.exitRequested = true;
    this.io.close();
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

export function createReadlineShellIO(input: Readable = stdin, output: Writable = stdout): ShellIO {
  const terminalOutput = output as Writable & { isTTY?: boolean };
  const terminalInput = input as Readable & { isTTY?: boolean };
  const reader = createInterface({
    input,
    output,
    terminal: Boolean(terminalInput.isTTY && terminalOutput.isTTY),
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
    clear() {
      if (terminalOutput.isTTY) output.write('\u001b[2J\u001b[H');
      else output.write('\n');
    },
    close() {
      if (!closed) {
        closed = true;
        questionController?.abort();
        reader.close();
      }
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

function shellInputError(field: string, nextAction: string): AurousError {
  return new AurousError({
    code: 'AUR-SHELL-001',
    summary: `Invalid ${field} selection.`,
    probableCause: 'The interactive command contained a missing or unsupported argument.',
    nextAction,
  });
}
