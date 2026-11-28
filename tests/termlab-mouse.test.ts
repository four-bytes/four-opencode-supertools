// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { encodeMouseSgr, type MouseEventInput } from '../src/lib/termlab/tmux';

function encode(event: Partial<MouseEventInput> & Pick<MouseEventInput, 'action'>): string {
  return encodeMouseSgr({ x: 0, y: 0, ...event });
}

describe('encodeMouseSgr', () => {
  it('encodes a left button press', () => {
    expect(encode({ action: 'press', x: 12, y: 7 })).toBe('\x1b[<0;13;8M');
  });

  it('encodes a release with the same button code and final m', () => {
    expect(encode({ action: 'release', button: 'right', x: 1, y: 2 })).toBe('\x1b[<2;2;3m');
  });

  it('encodes drag with the button offset and move as 35', () => {
    expect(encode({ action: 'drag', button: 'left', x: 1, y: 2 })).toBe('\x1b[<32;2;3M');
    expect(encode({ action: 'move', x: 3, y: 4 })).toBe('\x1b[<35;4;5M');
  });

  it('encodes wheel events', () => {
    expect(encode({ action: 'wheel', button: 'wheel-up', x: 5, y: 6 })).toBe('\x1b[<64;6;7M');
    expect(encode({ action: 'wheel', button: 'wheel-down', x: 5, y: 6 })).toBe('\x1b[<65;6;7M');
  });

  it('adds shift, alt and ctrl bits', () => {
    expect(encode({ action: 'press', button: 'right', x: 1, y: 1, shift: true, ctrl: true })).toBe(
      '\x1b[<22;2;2M'
    );
    expect(encode({ action: 'press', button: 'middle', x: 0, y: 0, alt: true })).toBe(
      '\x1b[<9;1;1M'
    );
  });
});
