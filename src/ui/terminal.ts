import { EventEmitter } from 'node:events';
import readline from 'node:readline';

import { FRAME_INTERVAL_MS, SPINNER_FRAMES, shimmer } from './shimmer.js';
import { accent, dim } from './colors.js';

/** How long a keystroke keeps you marked as "typing" locally. */
const TYPING_IDLE_MS = 1500;

/** Messages longer than this stream in, character by character, instead of appearing at once. */
export const STREAM_THRESHOLD = 100;
/** Characters revealed per animation tick. */
const STREAM_CHUNK = 2;
const STREAM_INTERVAL_MS = 14;

/**
 * Owns every write to stdout.
 *
 * Nothing else in the app may call process.stdout.write — an incoming chat
 * message landing mid-keystroke would otherwise smear whatever you are typing.
 * The screen is always laid out as:
 *
 *     ...scrollback...
 *     ⠹ ayuneko is thinking...      <- optional status line
 *     you › half-typed messa|       <- prompt line, cursor lives here
 */
export class Terminal extends EventEmitter {
  private readonly rl: readline.Interface;
  private readonly isTty: boolean;
  private statusText: string | null = null;
  private statusVisible = false;
  private ticker: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private phase = 0;
  private typing = false;
  private closed = false;
  /** True while a message is being revealed — the spinner ticker skips redraws so it
   *  doesn't erase characters mid-reveal, and input is paused so readline's own
   *  keystroke echo can't interleave with the stream. */
  private streaming = false;
  /** Serializes print()/printChat() calls so two outputs never interleave — a queued
   *  call waits for the previous one (including any in-progress stream) to finish. */
  private queue: Promise<void> = Promise.resolve();

  constructor(promptLabel: string) {
    super();
    this.isTty = Boolean(process.stdout.isTTY);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${accent(promptLabel)} ${dim('›')} `,
      historySize: 200,
    });

    this.rl.on('line', (line) => {
      this.stopTyping();
      const text = line.trim();
      // readline has already echoed the submitted line; wipe it so we can
      // reprint the message in our own formatting.
      if (this.isTty) {
        readline.moveCursor(process.stdout, 0, -1);
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
      }
      this.redraw();
      if (text.length > 0) this.emit('line', text);
    });

    this.rl.on('close', () => {
      if (this.closed) {
        this.emit('exit');
        return;
      }
      void this.queue.then(() => {
        this.closed = true;
        this.emit('exit');
      });
    });

    if (this.isTty) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.on('keypress', (_char, key: { name?: string } | undefined) => {
        if (key?.name === 'return' || key?.name === 'enter') return;
        this.noteKeystroke();
      });
    }
  }

  start(): void {
    this.rl.prompt(true);
  }

  /** Print a line of scrollback without disturbing the prompt or status. */
  print(line: string): void {
    this.queue = this.queue.then(() => this.printNow(line));
  }

  private printNow(line: string): void {
    if (this.closed) return;
    if (!this.isTty) {
      process.stdout.write(`${line}\n`);
      return;
    }
    this.erase();
    process.stdout.write(`${line}\n`);
    this.draw();
  }

  /**
   * Print a chat message. Short messages appear at once, like `print()`.
   * Messages over `STREAM_THRESHOLD` characters reveal progressively instead —
   * the metadata prefix (time + username) appears immediately, then the body
   * streams in. `text` must be plain (no ANSI codes) since length drives the
   * threshold and the reveal chunking.
   */
  printChat(prefix: string, text: string): void {
    this.queue = this.queue.then(() => this.printChatNow(prefix, text));
  }

  private printChatNow(prefix: string, text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.isTty || text.length <= STREAM_THRESHOLD) {
      this.printNow(`${prefix}${text}`);
      return Promise.resolve();
    }
    return this.streamNow(prefix, text);
  }

  private streamNow(prefix: string, text: string): Promise<void> {
    return new Promise((resolve) => {
      this.streaming = true;
      this.rl.pause();
      this.erase();
      process.stdout.write(prefix);

      const characters = [...text];
      let index = 0;

      const tick = (): void => {
        process.stdout.write(characters.slice(index, index + STREAM_CHUNK).join(''));
        index += STREAM_CHUNK;
        if (index < characters.length) {
          const timer = setTimeout(tick, STREAM_INTERVAL_MS);
          timer.unref();
        } else {
          process.stdout.write('\n');
          this.streaming = false;
          this.draw();
          this.rl.resume();
          resolve();
        }
      };
      tick();
    });
  }

  /** Pass null to clear the status line. */
  setStatus(text: string | null): void {
    if (this.closed || text === this.statusText) return;
    this.statusText = text;

    if (!this.isTty) return;

    if (text === null) {
      if (this.ticker) {
        clearInterval(this.ticker);
        this.ticker = null;
      }
      this.redraw();
      return;
    }

    this.phase = 0;
    this.redraw();
    if (!this.ticker) {
      this.ticker = setInterval(() => {
        this.phase += 1;
        this.redraw();
      }, FRAME_INTERVAL_MS);
      this.ticker.unref();
    }
  }

  private redraw(): void {
    // Skip while a message is streaming in — erasing here would wipe out
    // characters the stream has already written to this same row.
    if (!this.isTty || this.closed || this.streaming) return;
    this.erase();
    this.draw();
  }

  private erase(): void {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    if (this.statusVisible) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      this.statusVisible = false;
    }
  }

  private draw(): void {
    if (this.statusText) {
      const frame = SPINNER_FRAMES[this.phase % SPINNER_FRAMES.length] ?? '⠋';
      process.stdout.write(`${dim(frame)} ${shimmer(this.statusText, this.phase)}\n`);
      this.statusVisible = true;
    }
    this.rl.prompt(true);
  }

  private noteKeystroke(): void {
    if (!this.typing) {
      this.typing = true;
      this.emit('typing-start');
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopTyping(), TYPING_IDLE_MS);
    this.idleTimer.unref();
  }

  private stopTyping(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.typing) return;
    this.typing = false;
    this.emit('typing-stop');
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Flush anything already queued — including an in-progress stream —
    // before actually tearing anything down, or a fast "/quit" right after a
    // message would silently swallow that message.
    return this.queue.then(() => {
      if (this.closed) return;
      this.closed = true;
      if (this.ticker) clearInterval(this.ticker);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.isTty) {
        this.erase();
        process.stdout.write('\n');
      }
      this.rl.close();
    });
  }
}

