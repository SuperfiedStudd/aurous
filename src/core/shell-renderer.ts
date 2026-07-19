import type { Output } from './output.js';
import {
  formatInputPrompt,
  formatInteractiveHeader,
  formatInlineNotice,
  formatProgress,
  stripAnsi,
  type ProgressWord,
  type RenderOptions,
  type ShellStatusMetadata,
} from './presentation.js';

export type ShellPhase =
  'Ready' | 'Selecting Team' | 'Planning' | 'Awaiting Approval' | 'Applying' | 'Complete' | 'Error';

export interface ShellViewState extends ShellStatusMetadata {
  state: ShellPhase;
  hint: string;
}

export interface ShellTerminal {
  readonly ansi: boolean;
  readonly columns: number;
  readonly renderOptions: RenderOptions;
  question(prompt: string): Promise<string | undefined>;
  write(value: string): void;
  clear(): void;
  close(): void;
  cancelQuestion(): void;
  onInterrupt(handler: () => void): void;
  forgetLastInput(value: string): void;
}

export class DynamicShellRenderer implements Output {
  private view?: ShellViewState;
  private activity?: string;
  private overlay?: string;
  private surfaceLines = 0;
  private fallbackHint?: string;
  private started = false;

  constructor(readonly terminal: ShellTerminal) {}

  start(view: ShellViewState): void {
    this.view = view;
    this.started = true;
    if (!this.terminal.ansi) {
      this.writeBlock(formatInteractiveHeader(view, this.terminal.renderOptions));
      this.writeFallbackHint(view.hint);
    }
  }

  update(view: ShellViewState): void {
    this.view = view;
    if (this.terminal.ansi && this.surfaceLines > 0) this.renderSurface(false);
    else if (!this.terminal.ansi) this.writeFallbackHint(view.hint);
  }

  notice(message: string, tone: 'success' | 'warning' | 'neutral' = 'success'): void {
    this.activity = formatInlineNotice(message, tone, this.terminal.renderOptions);
    if (this.terminal.ansi) {
      if (this.surfaceLines > 0) this.renderSurface(false);
    } else this.writeBlock(this.activity);
  }

  recoverable(message: string): void {
    this.notice(message, 'warning');
  }

  showOverlay(content: string): void {
    this.overlay = content;
    if (this.terminal.ansi) {
      if (this.surfaceLines > 0) this.renderSurface(false);
    } else this.writeBlock(content);
  }

  dismissOverlay(): void {
    delete this.overlay;
  }

  progress(word: ProgressWord, detail: string, elapsedSeconds?: string | number): void {
    this.activity = formatProgress(word, detail, elapsedSeconds, this.terminal.renderOptions);
    if (this.terminal.ansi) this.renderSurface(false);
    else this.writeBlock(this.activity);
  }

  preparePrompt(label = 'aurous'): string {
    if (!this.view) throw new Error('Dynamic shell renderer has not started.');
    if (this.terminal.ansi) {
      this.renderSurface(true);
    } else {
      this.writeFallbackHint(this.view.hint);
    }
    return formatInputPrompt(label, this.terminal.renderOptions);
  }

  acceptInput(input: string, promptLabel = 'aurous'): void {
    if (!this.terminal.ansi) return;
    const promptWidth = stripAnsi(
      formatInputPrompt(promptLabel, this.terminal.renderOptions),
    ).length;
    const wrappedRows = Math.floor(
      Math.max(0, promptWidth + input.length - 1) / this.terminal.columns,
    );
    this.eraseSurface(wrappedRows);
  }

  cancelInput(): void {
    if (!this.terminal.ansi || this.surfaceLines === 0) return;
    const rows = Math.max(0, this.surfaceLines - 1);
    this.terminal.write(`\r${rows > 0 ? `\u001b[${rows}A` : ''}\u001b[J`);
    this.surfaceLines = 0;
  }

  log(message = ''): void {
    if (!message) return;
    this.commit(message);
  }

  error(message: string): void {
    this.commit(message);
  }

  commit(message: string): void {
    if (this.terminal.ansi) this.eraseSurface();
    this.writeBlock(message);
  }

  clear(): void {
    this.eraseSurface();
    this.terminal.clear();
    this.surfaceLines = 0;
    delete this.overlay;
    delete this.fallbackHint;
    if (!this.terminal.ansi && this.view) {
      this.writeBlock(formatInteractiveHeader(this.view, this.terminal.renderOptions));
      if (this.activity) this.writeBlock(this.activity);
      this.writeFallbackHint(this.view.hint);
    }
  }

  close(): void {
    this.eraseSurface();
    this.terminal.close();
  }

  private renderSurface(includePrompt: boolean): void {
    if (!this.view || !this.started) return;
    this.eraseSurface();
    const blocks = [formatInteractiveHeader(this.view, this.terminal.renderOptions)];
    if (this.overlay) blocks.push(this.overlay);
    else if (this.activity) blocks.push(this.activity);
    blocks.push(this.view.hint);
    const surface = blocks.join('\n');
    this.terminal.write(`${surface}\n`);
    this.surfaceLines = lineCount(surface) + (includePrompt ? 1 : 0);
  }

  private eraseSurface(extraRows = 0): void {
    if (!this.terminal.ansi || this.surfaceLines === 0) return;
    const rows = this.surfaceLines + extraRows;
    this.terminal.write(`\r\u001b[${rows}A\u001b[J`);
    this.surfaceLines = 0;
  }

  private writeFallbackHint(hint: string): void {
    if (this.terminal.ansi || this.fallbackHint === hint) return;
    this.fallbackHint = hint;
    this.writeBlock(hint);
  }

  private writeBlock(value: string): void {
    this.terminal.write(`${value.replace(/^\n+|\n+$/g, '')}\n`);
  }
}

function lineCount(value: string): number {
  return stripAnsi(value).split('\n').length;
}
