// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import {
  CHECKSUM_ALGORITHM,
  checksumFromFrame,
  checksumFromText,
  computeChecksum,
  decrqcraQuery,
  escapeBytes,
  parseChecksumResponse,
} from '../src/lib/termlab/checksum';
import type { TraceFrame } from '../src/lib/termlab/trace';

describe('computeChecksum', () => {
  it('sums UTF-16 code units over the region modulo 65536', () => {
    const result = computeChecksum(['A', 'B', ' ', 'C'], 2, { x: 0, y: 0, width: 2, height: 2 });
    expect(result.checksum).toBe(230);
    expect(result.hex).toBe('00e6');
    expect(result.cells).toBe(4);
  });

  it('treats missing and empty cells as spaces', () => {
    const result = computeChecksum(['A', '', undefined as unknown as string], 2, {
      x: 0,
      y: 0,
      width: 2,
      height: 1,
    });
    expect(result.checksum).toBe(65 + 32);
  });

  it('applies the 16-bit modulus', () => {
    const cells = new Array(400).fill('\uFFFF');
    const result = computeChecksum(cells, 400, { x: 0, y: 0, width: 400, height: 1 });
    expect(result.checksum).toBe((0xffff * 400) % 65536);
    expect(result.hex).toHaveLength(4);
  });
});

describe('decrqcraQuery', () => {
  it('emits the CSI DECRQCRA request with 1-based coordinates', () => {
    const bytes = decrqcraQuery({ top: 1, left: 1, bottom: 2, right: 3 });
    expect(escapeBytes(bytes)).toBe('\\x1b[1;1;1;1;2;3*y');
  });

  it('honours id and page', () => {
    const bytes = decrqcraQuery({ id: 7, page: 2, top: 4, left: 5, bottom: 6, right: 7 });
    expect(escapeBytes(bytes)).toBe('\\x1b[7;2;4;5;6;7*y');
  });
});

describe('parseChecksumResponse', () => {
  it('parses the primary DECCKSR DCS form with an ST terminator', () => {
    expect(parseChecksumResponse('\x1bP1!~00e6\x1b\\')).toEqual({
      id: 1,
      checksum: 230,
      hex: '00e6',
    });
  });

  it('parses the BEL-terminated DECCKSR form', () => {
    expect(parseChecksumResponse('\x1bP3!~010a\x07')).toEqual({
      id: 3,
      checksum: 266,
      hex: '010a',
    });
  });

  it('parses the CSI variant', () => {
    expect(parseChecksumResponse('\x1b[2;230*y')).toEqual({
      id: 2,
      checksum: 230,
      hex: '00e6',
    });
  });

  it('returns null for unparseable input', () => {
    expect(parseChecksumResponse('nope')).toBeNull();
  });
});

describe('checksumFromText', () => {
  it('checksums a screen dump with the full grid as default region', () => {
    const result = checksumFromText('AB\nCD');
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.checksum).toBe(65 + 66 + 67 + 68);
    expect(result.region).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it('pads short lines and respects an explicit region', () => {
    const result = checksumFromText('ABC\nA', { x: 0, y: 0, width: 1, height: 1 });
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect(result.checksum).toBe(65);
  });
});

describe('checksumFromFrame', () => {
  it('checksums a trace frame back buffer', () => {
    const frame: TraceFrame = {
      number: 1,
      label: 'x',
      width: 2,
      height: 1,
      bytes: new Uint8Array(),
      back: ['A', 'B'],
      mods: [0, 0],
      links: [null, null],
    };
    const result = checksumFromFrame(frame);
    expect(result.checksum).toBe(65 + 66);
    expect(result.region).toEqual({ x: 0, y: 0, width: 2, height: 1 });
  });

  it('uses the same UTF-16 algorithm as computeChecksum for non-ASCII cells', () => {
    const back = ['┏', '世', '❤️', 'a', ' ', 'Z'];
    const frame: TraceFrame = {
      number: 1,
      label: 'unicode',
      width: 3,
      height: 2,
      bytes: new Uint8Array(),
      back,
      mods: [0, 0, 0, 0, 0, 0],
      links: [null, null, null, null, null, null],
    };
    const full = { x: 0, y: 0, width: 3, height: 2 };
    const fromFrame = checksumFromFrame(frame);
    const direct = computeChecksum(back, frame.width, full);
    expect(fromFrame.checksum).toBe(direct.checksum);
    expect(fromFrame.hex).toBe(direct.hex);
    expect(fromFrame.cells).toBe(direct.cells);

    const region = { x: 0, y: 0, width: 3, height: 1 };
    expect(checksumFromFrame(frame, region).checksum).toBe(
      computeChecksum(back, frame.width, region).checksum
    );
  });
});

describe('escapeBytes', () => {
  it('escapes non-printable bytes', () => {
    expect(escapeBytes(new Uint8Array([0x1b, 0x5b, 0x41]))).toBe('\\x1b[A');
  });

  it('exposes the algorithm identifier', () => {
    expect(CHECKSUM_ALGORITHM).toBe('utf16-sum-mod-65536');
  });
});
