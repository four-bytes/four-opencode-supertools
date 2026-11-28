// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { termRunTool } from '../src/tools/term-run';
import { TmuxSession, type TmuxResult, type TmuxRunner } from '../src/lib/termlab/tmux';
import { toolObject } from './helpers';

const hasTmux = Bun.which('tmux') !== null;

function mockCtx(extra: Record<string, unknown> = {}) {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: '/tmp',
    worktree: '/tmp',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...extra,
  };
}

type TermRunArgs = Parameters<typeof termRunTool.execute>[0];

function run(args: Partial<TermRunArgs>, context: unknown) {
  return termRunTool.execute(args as TermRunArgs, context as never);
}

function parse<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

interface CapturedCall {
  args: string[];
  timeoutMs: number;
}

function fakeRunner(captures: string[]): { runner: TmuxRunner; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let captureIndex = 0;

  const runner: TmuxRunner = async (args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    const ok = (stdout = ''): TmuxResult => ({ exitCode: 0, stdout, stderr: '' });

    if (args.includes('capture-pane')) {
      const stdout = captures[captureIndex] ?? '';
      captureIndex += 1;
      return ok(stdout);
    }
    return ok();
  };

  return { runner, calls };
}

describe('term_run tool — argv seam', () => {
  it('starts a detached session, sends literal text and keys, then kills the server', async () => {
    const { runner, calls } = fakeRunner(['', 'GOT:hi\n', 'GOT:hi\n']);
    const ctx = mockCtx({ tmuxRunner: runner, skipTmuxCheck: true });

    const result = toolObject(
      await run(
        {
          command: 'sh',
          steps: [{ send: 'hi' }, { key: 'Enter' }],
          settleMs: 0,
        },
        ctx
      )
    );
    const out = parse<{
      ok: boolean;
      initial: { rows: string[] };
      steps: Array<{ action: string; summary: string; changed: Array<{ text: string }> }>;
    }>(result);

    expect(out.ok).toBe(true);
    expect(out.initial.rows).toEqual([]);
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0]).toMatchObject({ action: 'send', summary: 'send "hi"' });
    expect(out.steps[0].changed.map((row) => row.text)).toContain('GOT:hi');
    expect(out.steps[1]).toMatchObject({ action: 'key', summary: 'key Enter' });

    const newSession = calls.find((call) => call.args.includes('new-session'));
    expect(newSession).toBeDefined();
    expect(newSession?.args).toContain('-d');
    expect(newSession?.args).toContain('-s');
    expect(newSession?.args[newSession.args.length - 1]).toBe('sh');

    const literal = calls.find(
      (call) => call.args.includes('send-keys') && call.args.includes('-l')
    );
    expect(literal?.args[literal.args.length - 1]).toBe('hi');

    const key = calls.find((call) => call.args.includes('send-keys') && !call.args.includes('-l'));
    expect(key?.args[key.args.length - 1]).toBe('Enter');

    const kill = calls.find((call) => call.args.includes('kill-server'));
    expect(kill).toBeDefined();
  });

  it('rejects a step with more than one action', async () => {
    const { runner } = fakeRunner(['']);
    const ctx = mockCtx({ tmuxRunner: runner, skipTmuxCheck: true });

    const result = toolObject(
      await run({ command: 'sh', steps: [{ send: 'a', key: 'Enter' }] }, ctx)
    );
    const out = parse<{ available: boolean; error: string }>(result);
    expect(out.available).toBe(true);
    expect(out.error).toContain('exactly one action');
  });

  it('returns available:false when tmux is missing', async () => {
    const unavailable: TmuxRunner = async () => ({ exitCode: 127, stdout: '', stderr: 'missing' });
    const ctx = mockCtx({ tmuxRunner: unavailable });
    const result = toolObject(await run({ command: 'sh', steps: [] }, ctx));
    const out = parse<{ available: boolean; error: string; hint: string }>(result);
    expect(out.available).toBe(false);
    expect(out.error).toBe('tmux not found');
    expect(out.hint).toContain('Install tmux');
  });
});

const LOOP_COMMAND = 'sh -c \'while IFS= read -r l; do printf "GOT:%s\\r\\n" "$l"; done\'';

describe('term_run tool — real tmux', () => {
  it.skipIf(!hasTmux)(
    'captures the response to sent text inside a real session',
    async () => {
      const result = toolObject(
        await run(
          {
            command: LOOP_COMMAND,
            steps: [{ send: 'hi' }, { key: 'Enter' }],
            settleMs: 400,
            timeoutMs: 20000,
          },
          mockCtx()
        )
      );
      const out = parse<{
        ok: boolean;
        steps: Array<{ changed: Array<{ text: string }> }>;
      }>(result);

      expect(out.ok).toBe(true);
      const texts = out.steps.flatMap((step) => step.changed.map((row) => row.text));
      expect(texts.some((text) => text.includes('GOT:hi'))).toBe(true);
    },
    30000
  );

  it.skipIf(!hasTmux)(
    'kill-server leaves no session behind',
    async () => {
      const socket = `supertools-test-${process.pid}-${Date.now()}`;
      const session = new TmuxSession({
        command: 'sleep 30',
        width: 20,
        height: 5,
        socket,
        timeoutMs: 5000,
      });

      try {
        await session.start();
        const before = Bun.spawn(['tmux', '-L', socket, 'has-session', '-t', 't'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await before.exited).toBe(0);

        await session.kill();

        const after = Bun.spawn(['tmux', '-L', socket, 'has-session', '-t', 't'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await after.exited).not.toBe(0);
      } finally {
        await session.kill();
      }
    },
    30000
  );
});
