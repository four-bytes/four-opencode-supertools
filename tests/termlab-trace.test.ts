// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOLD,
  CROSSED_OUT,
  describeMods,
  parseTrace,
  parseTraceText,
  readTraceFile,
  UNDERLINED,
} from '../src/lib/termlab/trace';

interface FrameInput {
  number: number;
  label: string;
  width: number;
  height: number;
  bytes: Uint8Array;
  back: string[];
  mods?: number[];
  links?: (string | null)[];
}

function buildTrace(frames: FrameInput[], eol = '\n'): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const push = (text: string): void => {
    for (const byte of encoder.encode(text)) chunks.push(byte);
  };

  push(`TURBO_TUI_TRACE 1${eol}`);
  for (const frame of frames) {
    push(
      `=== turbo-tui frame ${frame.number} ${frame.label} ${frame.bytes.length} bytes ` +
        `${frame.width}x${frame.height} ===${eol}`
    );
    for (const byte of frame.bytes) chunks.push(byte);
    push(`${eol}--- back ---${eol}`);
    for (let row = 0; row < frame.height; row++) {
      const cells: string[] = [];
      for (let col = 0; col < frame.width; col++) {
        cells.push(frame.back[row * frame.width + col] ?? ' ');
      }
      push(`${cells.join('\t')}${eol}`);
    }
    push(`--- mods ---${eol}`);
    for (let row = 0; row < frame.height; row++) {
      const cells: string[] = [];
      for (let col = 0; col < frame.width; col++) {
        const value = frame.mods?.[row * frame.width + col] ?? 0;
        cells.push(value.toString(16).padStart(4, '0'));
      }
      push(`${cells.join(' ')}${eol}`);
    }
    push(`--- links ---${eol}`);
    for (let row = 0; row < frame.height; row++) {
      const cells: string[] = [];
      for (let col = 0; col < frame.width; col++) {
        cells.push(frame.links?.[row * frame.width + col] ?? '-');
      }
      push(`${cells.join(' ')}${eol}`);
    }
    push(`=== end frame ${frame.number} ===${eol}`);
  }
  return new Uint8Array(chunks);
}

const rawBytes = new TextEncoder().encode('\x1b[2;3Hhi');

describe('parseTrace', () => {
  it('parses a single frame with raw bytes, back buffer, mods and links', () => {
    const buffer = buildTrace([
      {
        number: 7,
        label: 'drag',
        width: 3,
        height: 2,
        bytes: rawBytes,
        back: ['A', 'B', 'C', 'D', 'E', 'F'],
        mods: [BOLD, 0, 0, UNDERLINED, 0, 0],
        links: ['42', null, null, null, 'https://example.com', null],
      },
    ]);

    const trace = parseTrace(buffer);
    expect(trace.version).toBe(1);
    expect(trace.frames).toHaveLength(1);

    const frame = trace.frames[0];
    expect(frame.number).toBe(7);
    expect(frame.label).toBe('drag');
    expect(frame.width).toBe(3);
    expect(frame.height).toBe(2);
    expect(Array.from(frame.bytes)).toEqual(Array.from(rawBytes));
    expect(frame.back).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(frame.mods).toEqual([BOLD, 0, 0, UNDERLINED, 0, 0]);
    expect(frame.links).toEqual(['42', null, null, null, 'https://example.com', null]);
  });

  it('pads missing trailing cells and drops extras beyond the width', () => {
    const text = [
      'TURBO_TUI_TRACE 1',
      '=== turbo-tui frame 1 lbl 0 bytes 2x1 ===',
      '',
      '--- back ---',
      'a\tb\tc',
      '--- mods ---',
      '0001 0002 0003',
      '--- links ---',
      'l1 - l3',
      '=== end frame 1 ===',
      '',
    ].join('\n');

    const trace = parseTraceText(text);
    const frame = trace.frames[0];
    expect(frame.back).toEqual(['a', 'b']);
    expect(frame.mods).toEqual([1, 2]);
    expect(frame.links).toEqual(['l1', null]);
  });

  it('skips blank lines between frames and parses multiple frames', () => {
    const buffer = buildTrace([
      {
        number: 1,
        label: 'a',
        width: 1,
        height: 1,
        bytes: new Uint8Array(),
        back: ['x'],
      },
      {
        number: 2,
        label: 'b',
        width: 1,
        height: 1,
        bytes: new Uint8Array(),
        back: ['y'],
      },
    ]);

    const trace = parseTrace(buffer);
    expect(trace.frames.map((frame) => frame.number)).toEqual([1, 2]);
    expect(trace.frames[1].back).toEqual(['y']);
  });

  it('allows trailing carriage returns on the magic line', () => {
    const buffer = buildTrace(
      [
        {
          number: 1,
          label: 'crlf',
          width: 1,
          height: 1,
          bytes: new Uint8Array(),
          back: ['z'],
        },
      ],
      '\r\n'
    );

    const trace = parseTrace(buffer);
    expect(trace.frames[0].back).toEqual(['z']);
  });

  it('rejects an invalid magic line', () => {
    const buffer = new TextEncoder().encode('NOT_A_TRACE\n');
    expect(() => parseTrace(buffer)).toThrow('not a TURBO_TUI_TRACE 1 file');
  });

  it('reports the frame number on a truncated frame', () => {
    const text = ['TURBO_TUI_TRACE 1', '=== turbo-tui frame 5 lbl 10 bytes 2x1 ===', 'abc'].join(
      '\n'
    );
    expect(() => parseTraceText(text)).toThrow(/frame 5:/);
  });

  it('decodes UTF-8 back-buffer cells instead of latin1 mojibake', () => {
    const buffer = buildTrace([
      {
        number: 1,
        label: 'utf8',
        width: 3,
        height: 1,
        bytes: new Uint8Array(),
        back: ['┏', '❤️', '世'],
      },
    ]);

    const trace = parseTrace(buffer);
    expect(trace.frames[0].back).toEqual(['┏', '❤️', '世']);
  });
});

describe('describeMods', () => {
  it('lists set modifier bits in bit order', () => {
    expect(describeMods(BOLD | UNDERLINED | CROSSED_OUT)).toEqual([
      'BOLD',
      'UNDERLINED',
      'CROSSED_OUT',
    ]);
    expect(describeMods(0)).toEqual([]);
  });
});

describe('readTraceFile', () => {
  it('reads and parses a trace from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termlab-trace-'));
    try {
      const path = join(dir, 'sample.trace');
      const buffer = buildTrace([
        {
          number: 3,
          label: 'disk',
          width: 2,
          height: 1,
          bytes: new Uint8Array(),
          back: ['q', 'r'],
        },
      ]);
      writeFileSync(path, buffer);

      const trace = readTraceFile(path);
      expect(trace.frames[0].number).toBe(3);
      expect(trace.frames[0].back).toEqual(['q', 'r']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
