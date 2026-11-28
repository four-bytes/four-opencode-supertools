// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { traceDecodeTool } from '../src/tools/trace-decode';
import { widthCheckTool } from '../src/tools/width-check';
import { termChecksumTool } from '../src/tools/term-checksum';
import type { TmuxResult, TmuxRunner } from '../src/lib/termlab/tmux';
import { toolObject } from './helpers';

const HEART = '\u2764\uFE0F';

function mockCtx(dir: string) {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

const ctx = mockCtx('/tmp');

function parse<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

interface FrameInput {
  number: number;
  label: string;
  width: number;
  height: number;
  bytes: string;
  back: string[];
}

function buildTraceBytes(frames: FrameInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const push = (text: string): void => {
    for (const byte of encoder.encode(text)) chunks.push(byte);
  };

  push('TURBO_TUI_TRACE 1\n');
  for (const frame of frames) {
    const raw = encoder.encode(frame.bytes);
    push(
      `=== turbo-tui frame ${frame.number} ${frame.label} ${raw.length} bytes ` +
        `${frame.width}x${frame.height} ===\n`
    );
    for (const byte of raw) chunks.push(byte);
    push('\n--- back ---\n');
    for (let row = 0; row < frame.height; row++) {
      const cells: string[] = [];
      for (let col = 0; col < frame.width; col++) {
        cells.push(frame.back[row * frame.width + col] ?? ' ');
      }
      push(`${cells.join('\t')}\n`);
    }
    push('--- mods ---\n');
    for (let row = 0; row < frame.height; row++) {
      push(`${new Array(frame.width).fill('0000').join(' ')}\n`);
    }
    push('--- links ---\n');
    for (let row = 0; row < frame.height; row++) {
      push(`${new Array(frame.width).fill('-').join(' ')}\n`);
    }
    push(`=== end frame ${frame.number} ===\n`);
  }
  return new Uint8Array(chunks);
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

type TraceArgs = Parameters<typeof traceDecodeTool.execute>[0];
type WidthArgs = Parameters<typeof widthCheckTool.execute>[0];
type ChecksumArgs = Parameters<typeof termChecksumTool.execute>[0];

// execute() is called directly, so Zod defaults are not applied; partial args
// are cast at the boundary just like the other tool tests do.
function runTrace(args: Partial<TraceArgs>, _context?: unknown) {
  return traceDecodeTool.execute(args as TraceArgs, ctx);
}

function runWidth(args: Partial<WidthArgs>, context: unknown = ctx) {
  return widthCheckTool.execute(args as WidthArgs, context as never);
}

function runChecksum(args: Partial<ChecksumArgs>, _context?: unknown) {
  return termChecksumTool.execute(args as ChecksumArgs, ctx);
}

describe('trace_decode tool', () => {
  const frame: FrameInput = {
    number: 1,
    label: 'demo',
    width: 10,
    height: 3,
    bytes: '\x1b[2;3Hhi',
    back: new Array(30).fill(' '),
  };

  it('decodes a frame into readable ops', async () => {
    const text = latin1(buildTraceBytes([frame]));
    const result = toolObject(await runTrace({ text }, ctx));
    const out = parse<{
      ok: boolean;
      version: number;
      frameCount: number;
      width: number;
      height: number;
      frames: Array<{ frame: number; label: string; bytes: number; ops: string[] }>;
    }>(result);

    expect(out.ok).toBe(true);
    expect(out.version).toBe(1);
    expect(out.frameCount).toBe(1);
    expect(out.width).toBe(10);
    expect(out.height).toBe(3);
    expect(out.frames[0]).toMatchObject({ frame: 1, label: 'demo' });
    expect(out.frames[0].ops).toEqual(['MOVE 2,1', 'TEXT "hi" at 2,1']);
  });

  it('filters TEXT/MOVE by region and keeps control ops', async () => {
    const text = latin1(
      buildTraceBytes([
        {
          ...frame,
          bytes: '\x1b[1;1Haa\x1b[1;6Hbb',
        },
      ])
    );
    const result = toolObject(
      await runTrace({ text, region: { x: 4, y: 0, width: 5, height: 1 } }, ctx)
    );
    const out = parse<{ frames: Array<{ ops: string[] }> }>(result);
    expect(out.frames[0].ops).toEqual(['MOVE 5,0', 'TEXT "bb" at 5,0']);
  });

  it('truncates ops per frame at the limit', async () => {
    const text = latin1(buildTraceBytes([{ ...frame, bytes: 'a\x1b[1;1Hb' }]));
    const result = toolObject(await runTrace({ text, limit: 1 }, ctx));
    const out = parse<{ frames: Array<{ ops: string[]; truncated: boolean }> }>(result);
    expect(out.frames[0].ops).toHaveLength(1);
    expect(out.frames[0].truncated).toBe(true);
  });

  it('honours the inclusive frame range', async () => {
    const text = latin1(
      buildTraceBytes([
        { ...frame, number: 1, bytes: 'a' },
        { ...frame, number: 2, bytes: 'b' },
      ])
    );
    const result = toolObject(await runTrace({ text, fromFrame: 2 }, ctx));
    const out = parse<{ frames: Array<{ frame: number }> }>(result);
    expect(out.frames.map((entry) => entry.frame)).toEqual([2]);
  });

  it('requires exactly one of path or text', async () => {
    const result = toolObject(await runTrace({} as unknown as TraceArgs, ctx));
    const out = parse<{ available: boolean; error: string }>(result);
    expect(out.available).toBe(true);
    expect(out.error).toContain('exactly one');
  });

  it('rejects a non-trace text payload', async () => {
    const result = toolObject(await runTrace({ text: 'garbage' }, ctx));
    const out = parse<{ available: boolean; error: string }>(result);
    expect(out.available).toBe(true);
    expect(out.error).toContain('TURBO_TUI_TRACE');
  });

  it('reads a trace from a path relative to the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'termlab-tool-'));
    try {
      writeFileSync(join(dir, 'sample.trace'), buildTraceBytes([frame]));
      const result = toolObject(await runTrace({ path: 'sample.trace', directory: dir }, ctx));
      const out = parse<{ ok: boolean; frameCount: number }>(result);
      expect(out.ok).toBe(true);
      expect(out.frameCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('width_check tool', () => {
  function tmuxCtx(captures: string[]) {
    let captureIndex = 0;
    const runner: TmuxRunner = async (args): Promise<TmuxResult> => {
      const ok = (stdout = ''): TmuxResult => ({ exitCode: 0, stdout, stderr: '' });
      if (args.includes('-V')) return ok('tmux 3.4');
      if (args.includes('capture-pane')) {
        const stdout = captures[captureIndex] ?? '';
        captureIndex += 1;
        return ok(stdout);
      }
      return ok();
    };
    return { ...ctx, tmuxRunner: runner };
  }

  it('reports differing widths for em dash and VS16 emoji', async () => {
    const result = toolObject(await runWidth({ text: `\u2014${HEART}` }, ctx));
    const out = parse<{
      ok: boolean;
      totals: { unicode: number; wcwidth: number };
      differs: string[];
      graphemes: Array<{ grapheme: string; unicode: number; wcwidth: number }>;
    }>(result);

    expect(out.ok).toBe(true);
    expect(out.totals).toEqual({ unicode: 3, wcwidth: 2 });
    expect(out.differs).toEqual([HEART]);
    const heart = out.graphemes.find((entry) => entry.grapheme === HEART);
    expect(heart).toMatchObject({ unicode: 2, wcwidth: 1 });
  });

  it('omits codepoints and differs in plain mode', async () => {
    const result = toolObject(await runWidth({ text: 'a', plain: true }, ctx));
    const out = parse<{ graphemes: Array<Record<string, unknown>>; differs: string[] }>(result);
    expect(out.graphemes[0].codepoints).toBeUndefined();
    expect(out.graphemes[0].differs).toBeUndefined();
    expect(out.differs).toEqual([]);
  });

  it('restricts the reported models', async () => {
    const result = toolObject(await runWidth({ text: 'a', models: ['unicode'] }, ctx));
    const out = parse<{
      totals: Record<string, number>;
      graphemes: Array<Record<string, unknown>>;
    }>(result);
    expect(out.totals).toEqual({ unicode: 1 });
    expect(out.graphemes[0].unicode).toBe(1);
    expect(out.graphemes[0].wcwidth).toBeUndefined();
  });

  it('requires text', async () => {
    const result = toolObject(await runWidth({} as unknown as WidthArgs, ctx));
    const out = parse<{ available: boolean; error: string }>(result);
    expect(out.available).toBe(true);
    expect(out.error).toContain('text');
  });

  it('measures a tmux width and reports zero probe errors', async () => {
    const result = toolObject(
      await runWidth({ text: 'a', models: ['unicode', 'tmux'] }, tmuxCtx(['a|\n']))
    );
    const out = parse<{
      totals: { unicode?: number; tmux?: number };
      tmuxProbeErrors: number;
      graphemes: Array<{ grapheme: string; tmux?: number }>;
    }>(result);
    expect(out.graphemes[0].tmux).toBe(1);
    expect(out.totals.tmux).toBe(1);
    expect(out.tmuxProbeErrors).toBe(0);
  });

  it('counts a missing sentinel as a probe error, never width 0', async () => {
    const result = toolObject(
      await runWidth({ text: 'a', models: ['unicode', 'tmux'] }, tmuxCtx(['']))
    );
    const out = parse<{
      totals: { unicode?: number; tmux?: number };
      tmuxProbeErrors: number;
      graphemes: Array<{ grapheme: string; tmux?: number }>;
    }>(result);
    expect(out.graphemes[0].tmux).toBeUndefined();
    expect(out.totals.tmux).toBeUndefined();
    expect(out.tmuxProbeErrors).toBe(1);
  });
});

describe('term_checksum tool', () => {
  it('computes a checksum for a text screen dump', async () => {
    const result = toolObject(await runChecksum({ mode: 'compute', text: 'AB\nCD' }, ctx));
    const out = parse<{
      ok: boolean;
      algorithm: string;
      checksum: number;
      hex: string;
      width: number;
      height: number;
    }>(result);
    expect(out.ok).toBe(true);
    expect(out.algorithm).toBe('utf16-sum-mod-65536');
    expect(out.checksum).toBe(266);
    expect(out.hex).toBe('010a');
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });

  it('emits a DECRQCRA query for a region', async () => {
    const result = toolObject(
      await runChecksum({ mode: 'query', region: { x: 0, y: 0, width: 2, height: 2 } }, ctx)
    );
    const out = parse<{
      ok: boolean;
      sequence: string;
      top: number;
      left: number;
      bottom: number;
      right: number;
      bytes: number[];
    }>(result);
    expect(out.ok).toBe(true);
    expect(out.sequence).toBe('\\x1b[1;1;1;1;2;2*y');
    expect(out).toMatchObject({ top: 1, left: 1, bottom: 2, right: 2 });
    expect(out.bytes.length).toBeGreaterThan(0);
  });

  it('parses a checksum response', async () => {
    const result = toolObject(
      await runChecksum({ mode: 'parse', response: '\x1bP1!~010a\x1b\\' }, ctx)
    );
    const out = parse<{ ok: boolean; id: number; checksum: number; hex: string }>(result);
    expect(out).toMatchObject({ ok: true, id: 1, checksum: 266, hex: '010a' });
  });

  it('checksums a trace frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'termlab-checksum-'));
    try {
      writeFileSync(
        join(dir, 'sample.trace'),
        buildTraceBytes([
          {
            number: 1,
            label: 'grid',
            width: 2,
            height: 2,
            bytes: '',
            back: ['A', 'B', 'C', 'D'],
          },
        ])
      );
      const result = toolObject(
        await runChecksum({ mode: 'trace', path: 'sample.trace', directory: dir, frame: 1 }, ctx)
      );
      const out = parse<{ ok: boolean; frame: number; checksum: number; hex: string }>(result);
      expect(out).toMatchObject({ ok: true, frame: 1, checksum: 266, hex: '010a' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns structured errors for missing inputs', async () => {
    const compute = parse<{ available: boolean; error: string }>(
      toolObject(await runChecksum({ mode: 'compute' }, ctx))
    );
    expect(compute.available).toBe(true);
    expect(compute.error).toContain('text');

    const query = parse<{ available: boolean; error: string }>(
      toolObject(await runChecksum({ mode: 'query' }, ctx))
    );
    expect(query.available).toBe(true);
    expect(query.error).toContain('region');

    const parseMode = parse<{ available: boolean; error: string }>(
      toolObject(await runChecksum({ mode: 'parse' }, ctx))
    );
    expect(parseMode.available).toBe(true);
    expect(parseMode.error).toContain('response');

    const trace = parse<{ available: boolean; error: string }>(
      toolObject(await runChecksum({ mode: 'trace' }, ctx))
    );
    expect(trace.available).toBe(true);
    expect(trace.error).toContain('path');
  });
});
