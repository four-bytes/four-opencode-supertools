// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { decodeOps, formatOp } from '../src/lib/termlab/ops';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('decodeOps — cursor and text', () => {
  it('tracks MOVE and coalesces a printable run into one TEXT op', () => {
    const ops = decodeOps(bytes('\x1b[2;3Hhello'));
    expect(ops).toEqual([
      { kind: 'MOVE', x: 2, y: 1 },
      { kind: 'TEXT', text: 'hello', x: 2, y: 1 },
    ]);
  });

  it('advances the cursor by display width, not code units', () => {
    const ops = decodeOps(bytes('\x1b[1;1H世a'));
    const text = ops.find((op) => op.kind === 'TEXT');
    expect(text).toEqual({ kind: 'TEXT', text: '世a', x: 0, y: 0 });
  });

  it('emits CR, LF, BS and TAB', () => {
    const ops = decodeOps(bytes('a\r\nb\x08\t'));
    expect(ops.map((op) => op.kind)).toEqual(['TEXT', 'CR', 'LF', 'TEXT', 'BS', 'TAB']);
  });
});

describe('decodeOps — SGR, OSC and CSI', () => {
  it('decodes SGR parameters', () => {
    const ops = decodeOps(bytes('\x1b[1;31mX'));
    expect(ops[0]).toEqual({ kind: 'SGR', params: [1, 31] });
  });

  it('defaults an empty SGR to a reset', () => {
    const ops = decodeOps(bytes('\x1b[m'));
    expect(ops[0]).toEqual({ kind: 'SGR', params: [0] });
  });

  it('decodes OSC 8 hyperlinks with an ST terminator', () => {
    const ops = decodeOps(bytes('\x1b]8;id=42;https://example.com\x1b\\'));
    expect(ops[0]).toEqual({ kind: 'OSC8', id: '42', url: 'https://example.com' });
  });

  it('decodes OSC 8 hyperlinks with a BEL terminator and no id', () => {
    const ops = decodeOps(bytes('\x1b]8;;https://example.com\x07'));
    expect(ops[0]).toEqual({ kind: 'OSC8', id: null, url: 'https://example.com' });
  });

  it('decodes other OSC commands', () => {
    const ops = decodeOps(bytes('\x1b]0;window title\x07'));
    expect(ops[0]).toEqual({ kind: 'OSC', command: '0', payload: 'window title' });
  });

  it('decodes erase sequences', () => {
    expect(decodeOps(bytes('\x1b[2J'))[0]).toEqual({ kind: 'CLEAR', params: [2] });
    expect(decodeOps(bytes('\x1b[K'))[0]).toEqual({ kind: 'ERASE_LINE', params: [0] });
    expect(decodeOps(bytes('\x1b[3X'))[0]).toEqual({ kind: 'ERASE_CHARS', params: [3] });
  });

  it('decodes cursor visibility', () => {
    expect(decodeOps(bytes('\x1b[?25l'))[0]).toEqual({ kind: 'CURSOR', visible: false });
    expect(decodeOps(bytes('\x1b[?25h'))[0]).toEqual({ kind: 'CURSOR', visible: true });
  });

  it('keeps unknown CSI sequences as CSI', () => {
    const ops = decodeOps(bytes('\x1b[1;2r'));
    expect(ops[0]).toEqual({ kind: 'CSI', params: [1, 2], final: 'r' });
  });
});

describe('decodeOps — tolerance', () => {
  it('never throws on invalid bytes', () => {
    const ops = decodeOps(new Uint8Array([0xff, 0x1b]));
    expect(Array.isArray(ops)).toBe(true);
    expect(ops.at(-1)).toEqual({ kind: 'RAW', hex: '1b' });
  });

  it('reports an incomplete CSI as RAW', () => {
    const ops = decodeOps(bytes('\x1b[12'));
    expect(ops[0]).toEqual({ kind: 'RAW', hex: '1b5b3132' });
  });
});

describe('formatOp', () => {
  it('renders compact one-liners', () => {
    expect(formatOp({ kind: 'MOVE', x: 12, y: 3 })).toBe('MOVE 12,3');
    expect(formatOp({ kind: 'SGR', params: [1, 31] })).toBe('SGR 1;31');
    expect(formatOp({ kind: 'OSC8', id: '42', url: 'https://x' })).toBe('OSC8 id=42 url=https://x');
    expect(formatOp({ kind: 'TEXT', text: 'abc', x: 0, y: 0 })).toBe('TEXT "abc" at 0,0');
    expect(formatOp({ kind: 'CLEAR', params: [2] })).toBe('CLEAR 2');
    expect(formatOp({ kind: 'CURSOR', visible: false })).toBe('CURSOR hide');
    expect(formatOp({ kind: 'CR' })).toBe('CR');
    expect(formatOp({ kind: 'RAW', hex: '1b' })).toBe('RAW 1b');
  });
});
