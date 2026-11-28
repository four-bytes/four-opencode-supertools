// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { cellHistoryTool } from '../src/tools/cell-history';
import { BOLD, RAPID_BLINK } from '../src/lib/termlab/trace';
import { toolObject } from './helpers';

interface FrameInput {
  number: number;
  label: string;
  width: number;
  height: number;
  bytes: string;
  mods?: number[];
}

function buildTrace(frames: FrameInput[]): string {
  const encoder = new TextEncoder();
  const parts: string[] = ['TURBO_TUI_TRACE 1\n'];

  for (const frame of frames) {
    const rawBytes = encoder.encode(frame.bytes);
    const latin1 = Array.from(rawBytes, (byte) => String.fromCharCode(byte)).join('');
    parts.push(
      `=== turbo-tui frame ${frame.number} ${frame.label} ${rawBytes.length} bytes ` +
        `${frame.width}x${frame.height} ===\n`
    );
    parts.push(latin1);
    parts.push('\n--- back ---\n');
    for (let row = 0; row < frame.height; row++) {
      parts.push(`${new Array(frame.width).fill(' ').join('\t')}\n`);
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
      parts.push(`${new Array(frame.width).fill('-').join(' ')}\n`);
    }
    parts.push(`=== end frame ${frame.number} ===\n`);
  }

  return parts.join('');
}

function mockCtx() {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: '/tmp',
    worktree: '/tmp',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

type CellHistoryArgs = Parameters<typeof cellHistoryTool.execute>[0];

function run(args: Partial<CellHistoryArgs>) {
  return cellHistoryTool.execute(args as CellHistoryArgs, mockCtx() as never);
}

interface WriteOut {
  frame: number;
  char: string;
  mods: string[];
  modsMask: number;
  link: string | null;
}

function parse<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

describe('cell_history tool', () => {
  it('records both writes to a cell across frames', async () => {
    const text = buildTrace([
      { number: 1, label: 'first', width: 4, height: 2, bytes: '\x1b[1;1HAB' },
      { number: 2, label: 'second', width: 4, height: 2, bytes: '\x1b[1;2HX' },
    ]);

    const result = toolObject(await run({ text, x: 1, y: 0 }));
    const out = parse<{
      ok: boolean;
      frames: number;
      cells: Array<{ x: number; y: number; writes: WriteOut[] }>;
    }>(result);

    expect(out.ok).toBe(true);
    expect(out.frames).toBe(2);
    expect(out.cells).toHaveLength(1);
    expect(out.cells[0]).toMatchObject({ x: 1, y: 0 });
    expect(out.cells[0].writes.map((write) => write.char)).toEqual(['B', 'X']);
    expect(out.cells[0].writes.map((write) => write.frame)).toEqual([1, 2]);
  });

  it('records a wide grapheme only at its start cell', async () => {
    const text = buildTrace([
      { number: 1, label: 'wide', width: 4, height: 2, bytes: '\x1b[1;1H世' },
    ]);

    const result = toolObject(await run({ text }));
    const out = parse<{ cells: Array<{ x: number; y: number; writes: WriteOut[] }> }>(result);

    const start = out.cells.find((cell) => cell.x === 0 && cell.y === 0);
    expect(start?.writes[0].char).toBe('世');
    expect(out.cells.some((cell) => cell.x === 1 && cell.y === 0)).toBe(false);
  });

  it('captures SGR modifier masks on writes', async () => {
    const text = buildTrace([
      { number: 1, label: 'bold', width: 4, height: 2, bytes: '\x1b[1;6mZ' },
    ]);

    const result = toolObject(await run({ text, x: 0, y: 0 }));
    const out = parse<{ cells: Array<{ writes: WriteOut[] }> }>(result);

    expect(out.cells[0].writes[0].modsMask).toBe(BOLD | RAPID_BLINK);
    expect(out.cells[0].writes[0].mods).toEqual(['BOLD', 'RAPID_BLINK']);
  });

  it('filters cells by region', async () => {
    const text = buildTrace([
      {
        number: 1,
        label: 'grid',
        width: 4,
        height: 2,
        bytes: '\x1b[1;1HA\x1b[2;4HB',
      },
    ]);

    const result = toolObject(await run({ text, region: { x: 3, y: 1, width: 1, height: 1 } }));
    const out = parse<{ cells: Array<{ x: number; y: number; writes: WriteOut[] }> }>(result);

    expect(out.cells).toHaveLength(1);
    expect(out.cells[0]).toMatchObject({ x: 3, y: 1 });
    expect(out.cells[0].writes[0].char).toBe('B');
  });

  it('requires x and y together', async () => {
    const text = buildTrace([
      { number: 1, label: 'one', width: 4, height: 2, bytes: '\x1b[1;1HA' },
    ]);
    const result = toolObject(await run({ text, x: 0 }));
    const out = parse<{ available: boolean; error: string }>(result);
    expect(out.available).toBe(true);
    expect(out.error).toContain('together');
  });
});
