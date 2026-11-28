// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { traceReplayTool } from '../src/tools/trace-replay';
import type { TmuxRunner } from '../src/lib/termlab/tmux';
import { toolObject } from './helpers';

const hasTmux = Bun.which('tmux') !== null;

interface FrameInput {
  number: number;
  label: string;
  width: number;
  height: number;
  bytes: string;
  back: string[];
  mods?: number[];
  links?: (string | null)[];
}

function buildTrace(frames: FrameInput[]): string {
  const parts: string[] = ['TURBO_TUI_TRACE 1\n'];

  for (const frame of frames) {
    parts.push(
      `=== turbo-tui frame ${frame.number} ${frame.label} ${frame.bytes.length} bytes ` +
        `${frame.width}x${frame.height} ===\n`
    );
    parts.push(frame.bytes);
    parts.push('\n--- back ---\n');
    for (let row = 0; row < frame.height; row++) {
      const cells: string[] = [];
      for (let col = 0; col < frame.width; col++) {
        cells.push(frame.back[row * frame.width + col] ?? ' ');
      }
      parts.push(`${cells.join('\t')}\n`);
    }
    parts.push('--- mods ---\n');
    for (let row = 0; row < frame.height; row++) {
      const cells: string[] = [];
      for (let col = 0; col < frame.width; col++) {
        const value = frame.mods?.[row * frame.width + col] ?? 0;
        cells.push(value.toString(16).padStart(4, '0'));
      }
      parts.push(`${cells.join(' ')}\n`);
    }
    parts.push('--- links ---\n');
    for (let row = 0; row < frame.height; row++) {
      const cells: string[] = [];
      for (let col = 0; col < frame.width; col++) {
        cells.push(frame.links?.[row * frame.width + col] ?? '-');
      }
      parts.push(`${cells.join(' ')}\n`);
    }
    parts.push(`=== end frame ${frame.number} ===\n`);
  }

  return parts.join('');
}

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

type ReplayArgs = Parameters<typeof traceReplayTool.execute>[0];

function run(args: Partial<ReplayArgs>, context: unknown) {
  return traceReplayTool.execute(args as ReplayArgs, context as never);
}

function parse<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

const BLANK_ROW = [' ', ' ', ' ', ' '];

describe('trace_replay tool — real tmux oracle', () => {
  it.skipIf(!hasTmux)(
    'matches a two-frame trace that writes then overwrites a cell',
    async () => {
      const text = buildTrace([
        {
          number: 1,
          label: 'write',
          width: 4,
          height: 2,
          bytes: '\x1b[1;1HAB',
          back: ['A', 'B', ' ', ' ', ...BLANK_ROW],
        },
        {
          number: 2,
          label: 'overwrite',
          width: 4,
          height: 2,
          bytes: '\x1b[1;2HX',
          back: ['A', 'X', ' ', ' ', ...BLANK_ROW],
        },
      ]);

      const result = toolObject(await run({ text, settleMs: 300 }, mockCtx()));
      const out = parse<{
        ok: boolean;
        matched: boolean;
        frames: number;
        compared: number;
        divergences: unknown[];
      }>(result);

      expect(out.ok).toBe(true);
      expect(out.matched).toBe(true);
      expect(out.frames).toBe(2);
      expect(out.compared).toBe(2);
      expect(out.divergences).toEqual([]);
    },
    60000
  );

  it.skipIf(!hasTmux)(
    'reports a divergence at the wrong expected cell',
    async () => {
      const text = buildTrace([
        {
          number: 1,
          label: 'wrong',
          width: 4,
          height: 2,
          bytes: '\x1b[1;1HAB',
          back: ['A', 'Z', ' ', ' ', ...BLANK_ROW],
        },
      ]);

      const result = toolObject(await run({ text, settleMs: 300 }, mockCtx()));
      const out = parse<{
        ok: boolean;
        matched: boolean;
        divergences: Array<{
          frame: number;
          x: number;
          y: number;
          expected: { char: string };
          actual: { char: string };
        }>;
      }>(result);

      expect(out.ok).toBe(true);
      expect(out.matched).toBe(false);
      expect(out.divergences).toHaveLength(1);
      expect(out.divergences[0]).toMatchObject({
        frame: 1,
        x: 1,
        y: 0,
        expected: { char: 'Z' },
        actual: { char: 'B' },
      });
    },
    60000
  );
});

describe('trace_replay tool — availability', () => {
  it('returns available:false when tmux is missing', async () => {
    const unavailable: TmuxRunner = async () => ({
      exitCode: 127,
      stdout: '',
      stderr: 'missing',
    });
    const text = buildTrace([
      {
        number: 1,
        label: 'x',
        width: 4,
        height: 2,
        bytes: '',
        back: ['A', ' ', ' ', ' ', ...BLANK_ROW],
      },
    ]);

    const result = toolObject(await run({ text }, mockCtx({ tmuxRunner: unavailable })));
    const out = parse<{ available: boolean; error: string; hint: string }>(result);
    expect(out.available).toBe(false);
    expect(out.error).toBe('tmux not found');
    expect(out.hint).toContain('Install tmux');
  });
});
