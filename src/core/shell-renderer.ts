import type { Output } from './output.js';
import {
  formatInputPrompt,
  formatInteractiveHeader,
  formatInlineNotice,
  formatProgress,
  stripAnsi,
  visibleWrappedRowCount,
  type ProgressWord,
  type RenderOptions,
  type ShellStatusMetadata,
} from './presentation.js';

export type ShellPhase =
  | 'Ready'
  | 'Selecting Destination'
  | 'Planning'
  | 'Awaiting Approval'
  | 'Applying'
  | 'Complete'
  | 'Error';

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
  private pasteMode = false;
  private pastePromptShown = false;
  /** Counts full dashboard surface paints (header + activity/overlay + hint). */
  surfaceRenderCount = 0;

  constructor(readonly terminal: ShellTerminal) {}

  get isPasteMode(): boolean {
    return this.pasteMode;
  }

  start(view: ShellViewState): void {
    this.view = view;
    this.started = true;
    if (!this.terminal.ansi) {
      this.writeBlock(formatInteractiveHeader(view, this.terminal.renderOptions));
      this.surfaceRenderCount += 1;
      this.writeFallbackHint(view.hint);
    }
  }

  update(view: ShellViewState): void {
    this.view = view;
    if (this.pasteMode) return;
    if (this.terminal.ansi && this.surfaceLines > 0) this.renderSurface(false);
    else if (!this.terminal.ansi) this.writeFallbackHint(view.hint);
  }

  notice(message: string, tone: 'success' | 'warning' | 'neutral' = 'success'): void {
    this.activity = formatInlineNotice(message, tone, this.terminal.renderOptions);
    if (this.pasteMode) return;
    if (this.terminal.ansi) {
      if (this.surfaceLines > 0) this.renderSurface(false);
    } else this.writeBlock(this.activity);
  }

  recoverable(message: string): void {
    this.notice(message, 'warning');
  }

  showOverlay(content: string): void {
    if (this.pasteMode) return;
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
    if (this.pasteMode) return;
    if (this.terminal.ansi) this.renderSurface(false);
    else this.writeBlock(this.activity);
  }

  /**
   * Enter append-only paste capture: freeze the dashboard, show one instruction,
   * and let subsequent readline lines arrive without header redraws.
   */
  beginPasteMode(instruction: string): void {
    if (this.terminal.ansi) this.eraseSurface();
    this.pasteMode = true;
    this.pastePromptShown = false;
    delete this.overlay;
    delete this.activity;
    delete this.fallbackHint;
    this.writeBlock(instruction);
  }

  /**
   * Leave paste mode with one clean viewport clear and a single dashboard paint.
   */
  endPasteMode(
    view: ShellViewState,
    notice?: { message: string; tone?: 'success' | 'warning' | 'neutral' },
  ): void {
    this.pasteMode = false;
    this.pastePromptShown = false;
    this.view = view;
    this.surfaceLines = 0;
    delete this.overlay;
    delete this.fallbackHint;
    if (notice) {
      this.activity = formatInlineNotice(
        notice.message,
        notice.tone ?? 'success',
        this.terminal.renderOptions,
      );
    } else {
      delete this.activity;
    }
    this.clearViewport();
    if (this.terminal.ansi) this.renderSurface(false);
    else {
      this.writeBlock(formatInteractiveHeader(view, this.terminal.renderOptions));
      this.surfaceRenderCount += 1;
      if (this.activity) this.writeBlock(this.activity);
      this.writeFallbackHint(view.hint);
    }
  }

  preparePrompt(label = 'aurous'): string {
    if (!this.view) throw new Error('Dynamic shell renderer has not started.');
    if (this.pasteMode) {
      if (!this.pastePromptShown) {
        this.pastePromptShown = true;
        return formatInputPrompt(label, this.terminal.renderOptions);
      }
      // Subsequent paste lines: empty prompt keeps append-only readline output stable.
      return '';
    }
    if (this.terminal.ansi) {
      this.renderSurface(true);
    } else {
      this.writeFallbackHint(this.view.hint);
    }
    return formatInputPrompt(label, this.terminal.renderOptions);
  }

  acceptInput(input: string, promptLabel = 'aurous'): void {
    if (this.pasteMode || !this.terminal.ansi) return;
    const prompt = formatInputPrompt(promptLabel, this.terminal.renderOptions);
    const typed = `${stripAnsi(prompt)}${input}`;
    const wrappedRows = Math.max(0, visibleWrappedRowCount(typed, this.terminalColumns()) - 1);
    this.eraseSurface(wrappedRows);
  }

  cancelInput(): void {
    if (this.pasteMode) {
      this.terminal.write('\r\u001b[K');
      return;
    }
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
    if (this.pasteMode) {
      this.writeBlock(message);
      return;
    }
    if (this.terminal.ansi) this.eraseSurface();
    this.writeBlock(message);
  }

  clear(): void {
    if (this.pasteMode) return;
    this.eraseSurface();
    this.clearViewport();
    this.surfaceLines = 0;
    delete this.overlay;
    delete this.fallbackHint;
    if (!this.terminal.ansi && this.view) {
      this.writeBlock(formatInteractiveHeader(this.view, this.terminal.renderOptions));
      this.surfaceRenderCount += 1;
      if (this.activity) this.writeBlock(this.activity);
      this.writeFallbackHint(this.view.hint);
    }
  }

  close(): void {
    if (!this.pasteMode) this.eraseSurface();
    this.terminal.close();
  }

  private renderSurface(includePrompt: boolean): void {
    if (!this.view || !this.started || this.pasteMode) return;
    this.eraseSurface();
    const blocks = [formatInteractiveHeader(this.view, this.terminal.renderOptions)];
    if (this.overlay) blocks.push(this.overlay);
    else if (this.activity) blocks.push(this.activity);
    blocks.push(this.view.hint);
    const surface = blocks.join('\n');
    this.terminal.write(`${surface}\n`);
    this.surfaceRenderCount += 1;
    const promptRows = includePrompt
      ? visibleWrappedRowCount(
          formatInputPrompt('aurous', this.terminal.renderOptions),
          this.terminalColumns(),
        )
      : 0;
    this.surfaceLines = visibleWrappedRowCount(surface, this.terminalColumns()) + promptRows;
  }

  private eraseSurface(extraRows = 0): void {
    if (!this.terminal.ansi || this.surfaceLines === 0) return;
    const rows = this.surfaceLines + extraRows;
    this.terminal.write(`\r\u001b[${rows}A\u001b[J`);
    this.surfaceLines = 0;
  }

  private clearViewport(): void {
    this.terminal.clear();
    this.surfaceLines = 0;
  }

  private terminalColumns(): number {
    return Math.max(1, this.terminal.columns || 1);
  }

  private writeFallbackHint(hint: string): void {
    if (this.terminal.ansi || this.pasteMode || this.fallbackHint === hint) return;
    this.fallbackHint = hint;
    this.writeBlock(hint);
  }

  private writeBlock(value: string): void {
    this.terminal.write(`${value.replace(/^\n+|\n+$/g, '')}\n`);
  }
}
