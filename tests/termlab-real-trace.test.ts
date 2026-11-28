// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceDecodeTool } from '../src/tools/trace-decode';
import { termChecksumTool } from '../src/tools/term-checksum';
import { cellHistoryTool } from '../src/tools/cell-history';
import { traceReplayTool } from '../src/tools/trace-replay';
import { toolObject } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'termlab', 'wt-trace-frame1.bin');
const hasTmux = Bun.which('tmux') !== null;

function mockCtx() {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: here,
    worktree: here,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function parse<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

type TraceArgs = Parameters<typeof traceDecodeTool.execute>[0];
type ChecksumArgs = Parameters<typeof termChecksumTool.execute>[0];
type HistoryArgs = Parameters<typeof cellHistoryTool.execute>[0];
type ReplayArgs = Parameters<typeof traceReplayTool.execute>[0];

function runTrace(args: Partial<TraceArgs>) {
  return traceDecodeTool.execute(args as TraceArgs, mockCtx() as never);
}

function runChecksum(args: Partial<ChecksumArgs>) {
  return termChecksumTool.execute(args as ChecksumArgs, mockCtx() as never);
}

function runHistory(args: Partial<HistoryArgs>) {
  return cellHistoryTool.execute(args as HistoryArgs, mockCtx() as never);
}

function runReplay(args: Partial<ReplayArgs>) {
  return traceReplayTool.execute(args as ReplayArgs, mockCtx() as never);
}

describe('termlab — real turbo-tui #68 trace fixture', () => {
  it('trace_decode reads the captured 183x52 frame', async () => {
    const out = parse<{
      ok: boolean;
      version: number;
      frameCount: number;
      width: number;
      height: number;
      frames: Array<{ frame: number; ops: string[] }>;
    }>(toolObject(await runTrace({ path: FIXTURE })));

    expect(out.ok).toBe(true);
    expect(out.version).toBe(1);
    expect(out.frameCount).toBe(1);
    expect(out.width).toBe(183);
    expect(out.height).toBe(52);
    expect(out.frames[0].frame).toBe(1);
    expect(out.frames[0].ops.length).toBeGreaterThan(0);
  });

  it('term_checksum reproduces the captured frame checksum', async () => {
    const out = parse<{
      ok: boolean;
      algorithm: string;
      frame: number;
      hex: string;
      checksum: number;
      cells: number;
    }>(toolObject(await runChecksum({ mode: 'trace', path: FIXTURE, frame: 1 })));

    expect(out.ok).toBe(true);
    expect(out.algorithm).toBe('utf16-sum-mod-65536');
    expect(out.frame).toBe(1);
    expect(out.hex).toBe('4b19');
    expect(out.checksum).toBe(19225);
    expect(out.cells).toBe(9516);
  });

  it('cell_history reports the first write to cell (1,0) as bold F', async () => {
    const out = parse<{
      ok: boolean;
      frames: number;
      cells: Array<{
        x: number;
        y: number;
        writes: Array<{ frame: number; label: string; char: string; mods: string[] }>;
      }>;
    }>(
      toolObject(await runHistory({ path: FIXTURE, region: { x: 0, y: 0, width: 8, height: 2 } }))
    );

    expect(out.ok).toBe(true);
    expect(out.frames).toBe(1);
    const cell = out.cells.find((entry) => entry.x === 1 && entry.y === 0);
    expect(cell).toBeDefined();
    expect(cell?.writes[0]).toMatchObject({
      frame: 1,
      label: 'flush',
      char: 'F',
    });
    expect(cell?.writes[0].mods).toContain('BOLD');
  });

  it.skipIf(!hasTmux)(
    'trace_replay matches the captured frame through the tmux oracle',
    async () => {
      const out = parse<{
        ok: boolean;
        oracle: string;
        compared: number;
        divergences: unknown[];
        matched: boolean;
      }>(toolObject(await runReplay({ path: FIXTURE, stopOnFirstDivergence: true })));

      expect(out.ok).toBe(true);
      expect(out.oracle).toBe('tmux');
      expect(out.compared).toBe(1);
      expect(out.divergences).toEqual([]);
      expect(out.matched).toBe(true);
    },
    120000
  );
});
