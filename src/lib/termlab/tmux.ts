// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmuxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxRunOptions {
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
}

export type TmuxRunner = (args: string[], opts: TmuxRunOptions) => Promise<TmuxResult>;

/** Spawn a tmux client, kill it on timeout, never throw on a non-zero exit. */
export const defaultTmuxRunner: TmuxRunner = async (args, opts) => {
  const argv = args[0] === 'tmux' ? args : ['tmux', ...args];
  const env = { ...(process.env as Record<string, string>), ...(opts.env ?? {}) };
  const spawn = () =>
    Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (err) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    proc.kill();
    killTimer = setTimeout(() => {
      proc.kill(9);
    }, 1000);
  }, opts.timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }
};

/**
 * True when a tmux binary is present. With an injected runner the `tmux -V`
 * probe is executed through it; without one the local PATH is consulted.
 */
export async function isTmuxAvailable(runner?: TmuxRunner): Promise<boolean> {
  if (!runner) return Bun.which('tmux') !== null;
  try {
    const result = await runner(['tmux', '-V'], { timeoutMs: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export type MouseAction = 'press' | 'release' | 'drag' | 'move' | 'wheel';
export type MouseButton = 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';

export interface MouseEventInput {
  action: MouseAction;
  x: number;
  y: number;
  button?: MouseButton;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

const BUTTON_CODES: Record<MouseButton, number> = {
  left: 0,
  middle: 1,
  right: 2,
  'wheel-up': 64,
  'wheel-down': 65,
};

/** Encode an SGR (1006) mouse event. Coordinates are 0-based cells. */
export function encodeMouseSgr(event: MouseEventInput): string {
  const button = event.button ?? 'left';
  const base = BUTTON_CODES[button];
  let code: number;
  let final = 'M';

  switch (event.action) {
    case 'release':
      code = base;
      final = 'm';
      break;
    case 'drag':
      code = base + 32;
      break;
    case 'move':
      code = 35;
      break;
    case 'wheel':
    case 'press':
      code = base;
      break;
    default:
      code = base;
  }

  if (event.shift) code += 4;
  if (event.alt) code += 8;
  if (event.ctrl) code += 16;

  return `\x1b[<${code};${event.x + 1};${event.y + 1}${final}`;
}

export interface CapturedPane {
  width: number;
  height: number;
  rows: string[];
  raw: string;
}

export interface TmuxSessionOptions {
  command: string | string[];
  width: number;
  height: number;
  cwd?: string;
  env?: Record<string, string>;
  runner?: TmuxRunner;
  socket?: string;
  timeoutMs?: number;
}

const SESSION_NAME = 't';
/** Allowed named-key names; shared with the tool-level upfront validation. */
export const KEY_PATTERN = /^[A-Za-z0-9-]+$/;
const DEFAULT_TIMEOUT_MS = 20000;
const KILL_TIMEOUT_MS = 5000;

let randomCounter = 0;

function randomId(): string {
  randomCounter += 1;
  return `${Date.now().toString(36)}${randomCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * A detached tmux server on a private socket, used as an independent terminal
 * emulator. Every command runs against `tmux -L <socket> -f /dev/null`.
 */
export class TmuxSession {
  readonly socket: string;
  private readonly command: string | string[];
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly runner: TmuxRunner;
  private readonly timeoutMs: number;
  private width: number;
  private height: number;

  constructor(options: TmuxSessionOptions) {
    this.command = options.command;
    this.width = options.width;
    this.height = options.height;
    this.cwd = options.cwd;
    this.env = options.env;
    this.runner = options.runner ?? defaultTmuxRunner;
    this.socket = options.socket ?? `supertools-term-${process.pid}-${randomId()}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private argv(...rest: string[]): string[] {
    return ['tmux', '-L', this.socket, '-f', '/dev/null', ...rest];
  }

  private run(args: string[], timeoutMs = this.timeoutMs): Promise<TmuxResult> {
    return this.runner(args, { timeoutMs, cwd: this.cwd, env: this.env });
  }

  private fail(command: string, result: TmuxResult): Error {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    return new Error(`tmux ${command} failed: ${detail}`);
  }

  async start(): Promise<void> {
    const args = this.argv(
      'new-session',
      '-d',
      '-s',
      SESSION_NAME,
      '-x',
      String(this.width),
      '-y',
      String(this.height)
    );
    if (this.cwd) args.push('-c', this.cwd);
    if (Array.isArray(this.command)) args.push(...this.command);
    else args.push(this.command);

    const result = await this.run(args);
    if (result.exitCode !== 0) throw this.fail('new-session', result);

    await this.run(this.argv('set-option', '-t', SESSION_NAME, 'status', 'off'));
    await this.run(this.argv('set-option', '-t', SESSION_NAME, 'remain-on-exit', 'off'));
    await this.run(this.argv('set-option', '-t', SESSION_NAME, 'escape-time', '0'));
    await this.run(this.argv('set-option', '-g', 'default-terminal', 'tmux-256color'));
  }

  async sendLiteral(text: string): Promise<void> {
    const result = await this.run(this.argv('send-keys', '-t', SESSION_NAME, '-l', '--', text));
    if (result.exitCode !== 0) throw this.fail('send-keys', result);
  }

  async sendKey(key: string): Promise<void> {
    if (!KEY_PATTERN.test(key)) throw new Error(`invalid tmux key name: ${key}`);
    const result = await this.run(this.argv('send-keys', '-t', SESSION_NAME, '--', key));
    if (result.exitCode !== 0) throw this.fail('send-keys', result);
  }

  /** Binary-safe frame feeding through load-buffer → paste-buffer. */
  async sendBytes(bytes: Uint8Array): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'supertools-tmux-'));
    const file = join(dir, 'frame.bin');
    const buffer = `supertools-${randomId()}`;
    try {
      writeFileSync(file, bytes);
      const load = await this.run(this.argv('load-buffer', '-b', buffer, file));
      if (load.exitCode !== 0) throw this.fail('load-buffer', load);
      const paste = await this.run(
        this.argv('paste-buffer', '-d', '-b', buffer, '-t', SESSION_NAME)
      );
      if (paste.exitCode !== 0) throw this.fail('paste-buffer', paste);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  async sendMouse(event: MouseEventInput): Promise<void> {
    await this.sendLiteral(encodeMouseSgr(event));
  }

  async capture(options: { attributes?: boolean } = {}): Promise<CapturedPane> {
    const args = this.argv('capture-pane', '-t', SESSION_NAME, '-p');
    if (options.attributes) args.push('-e');
    const result = await this.run(args);
    if (result.exitCode !== 0) throw this.fail('capture-pane', result);

    const rows = this.normalizeRows(result.stdout);
    return { width: this.width, height: this.height, rows, raw: result.stdout };
  }

  private normalizeRows(raw: string): string[] {
    const lines = raw.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const rows: string[] = [];
    for (let index = 0; index < this.height; index++) {
      const line = lines[index] ?? '';
      rows.push(line.length >= this.width ? line : line + ' '.repeat(this.width - line.length));
    }
    return rows;
  }

  async resize(width: number, height: number): Promise<void> {
    this.width = width;
    this.height = height;
    const result = await this.run(
      this.argv('resize-window', '-t', SESSION_NAME, '-x', String(width), '-y', String(height))
    );
    if (result.exitCode !== 0) throw this.fail('resize-window', result);
  }

  /** Idempotent, never throws: callers rely on try/finally teardown. */
  async kill(): Promise<void> {
    try {
      await this.run(this.argv('kill-server'), Math.min(this.timeoutMs, KILL_TIMEOUT_MS));
    } catch {
      // server already gone or never started
    }
  }
}

/** SGR mouse test helper: a readable hex form of an encoded event. */
export function mouseEventHex(event: MouseEventInput): string {
  return hexOf(new TextEncoder().encode(encodeMouseSgr(event)));
}
