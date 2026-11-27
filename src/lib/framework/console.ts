// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type ConsoleFailureReason =
  | 'console-unavailable'
  | 'console-failed'
  | 'timeout'
  | 'invalid-json'
  | 'db-unavailable'
  | 'unknown';

export interface RawConsoleResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ConsoleRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export type ConsoleRunner = (cmd: string[], opts: ConsoleRunOptions) => Promise<RawConsoleResult>;

export interface ConsoleOptions {
  cwd?: string;
  appEnv?: string; // default 'dev'
  extraEnv?: Record<string, string>;
  timeoutMs?: number; // default 30000
  runner?: ConsoleRunner; // injectable for tests
}

export type ConsoleResult =
  | { ok: true; exitCode: 0; stdout: string; stderr: string }
  | { ok: false; reason: ConsoleFailureReason; message: string; exitCode?: number; hint?: string };

export type ConsoleJsonResult =
  | { ok: true; data: unknown; raw: string }
  | { ok: false; reason: ConsoleFailureReason; message: string; exitCode?: number; hint?: string };

const DB_PATTERN =
  /SQLSTATE|Connection refused|could not find driver|Unknown database|database .* does not exist/i;

const DEFAULT_TIMEOUT_MS = 30000;
const TAIL_LINES = 20;

class TimeoutError extends Error {}

function tail(text: string, lines = TAIL_LINES): string {
  const parts = text.split(/\r?\n/);
  return parts.slice(-lines).join('\n').trim();
}

function failure(
  reason: ConsoleFailureReason,
  message: string,
  extra: { exitCode?: number; hint?: string } = {}
): ConsoleResult {
  return { ok: false, reason, message, ...extra };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export const defaultConsoleRunner: ConsoleRunner = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

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

export async function runConsole(
  consolePath: string | null,
  args: string[],
  options: ConsoleOptions = {}
): Promise<ConsoleResult> {
  if (!consolePath || !existsSync(consolePath)) {
    return failure('console-unavailable', `No bin/console found at ${consolePath ?? '(none)'}`, {
      hint: 'Run composer install or check the project root.',
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? dirname(consolePath);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    APP_ENV: options.appEnv ?? 'dev',
    ...options.extraEnv,
  };
  const runner = options.runner ?? defaultConsoleRunner;
  const cmd = [consolePath, ...args];

  let result: RawConsoleResult;
  try {
    result = await withTimeout(runner(cmd, { cwd, env, timeoutMs }), timeoutMs);
  } catch (error) {
    if (error instanceof TimeoutError) {
      return failure('timeout', `bin/console timed out after ${timeoutMs}ms`);
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string } | undefined)?.code;
    if (code === 'ENOENT' || code === 'EACCES' || /ENOENT|EACCES|not found/i.test(message)) {
      return failure('console-unavailable', message, {
        hint: 'Run composer install or check the project root.',
      });
    }
    if (/timed? ?out|timeout/i.test(message)) {
      return failure('timeout', message);
    }
    return failure('unknown', message);
  }

  if (result.exitCode === 0) {
    return { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const message =
    tail(result.stderr) || tail(result.stdout) || `bin/console exited with ${result.exitCode}`;

  if (DB_PATTERN.test(combined)) {
    return failure('db-unavailable', message, {
      exitCode: result.exitCode,
      hint: 'Start the database / check DATABASE_URL',
    });
  }

  return failure('console-failed', message, { exitCode: result.exitCode });
}

export async function runConsoleJson(
  consolePath: string | null,
  args: string[],
  options: ConsoleOptions = {}
): Promise<ConsoleJsonResult> {
  const hasJsonFormat =
    args.includes('--format=json') ||
    args.some((arg, index) => arg === '--format' && args[index + 1] === 'json');
  const finalArgs = hasJsonFormat ? args : [...args, '--format=json'];
  const result = await runConsole(consolePath, finalArgs, options);
  if (!result.ok) return result;

  try {
    const data: unknown = JSON.parse(result.stdout.trim());
    return { ok: true, data, raw: result.stdout };
  } catch {
    return {
      ok: false,
      reason: 'invalid-json',
      message: `Could not parse JSON from bin/console ${finalArgs.join(' ')}`,
      hint: tail(result.stdout),
    };
  }
}
