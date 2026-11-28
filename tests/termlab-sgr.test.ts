// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { attributeRuns, diffScreens, parseSgrScreen, snapshotText } from '../src/lib/termlab/sgr';

describe('parseSgrScreen', () => {
  it('applies bold and 16-colour foreground/background', () => {
    const screen = parseSgrScreen('\x1b[1;31;44mAB\x1b[0m C', 5, 1);

    expect(screen.cells[0]).toEqual({ char: 'A', fg: 'ansi:1', bg: 'ansi:4', mods: ['bold'] });
    expect(screen.cells[1]).toEqual({ char: 'B', fg: 'ansi:1', bg: 'ansi:4', mods: ['bold'] });
    expect(screen.cells[2]).toEqual({ char: ' ', fg: 'default', bg: 'default', mods: [] });
    expect(screen.cells[3]).toEqual({ char: 'C', fg: 'default', bg: 'default', mods: [] });
    expect(snapshotText(screen)[0]).toBe('AB C');
  });

  it('parses 256-colour and truecolor parameters', () => {
    const indexed = parseSgrScreen('\x1b[38;5;196;48;5;21mX', 2, 1);
    expect(indexed.cells[0]).toMatchObject({ char: 'X', fg: 'ansi:196', bg: 'ansi:21' });

    const truecolor = parseSgrScreen('\x1b[38;2;30;30;30;48;2;1;2;3mY', 2, 1);
    expect(truecolor.cells[0]).toMatchObject({ char: 'Y', fg: '#1e1e1e', bg: '#010203' });
  });

  it('reserves a continuation cell for wide graphemes', () => {
    const screen = parseSgrScreen('世A', 4, 1);
    expect(screen.cells[0].char).toBe('世');
    expect(screen.cells[1].char).toBe('');
    expect(screen.cells[2].char).toBe('A');
    expect(snapshotText(screen)[0]).toBe('世A');
    expect(attributeRuns(screen, 0)).toEqual([]);
  });

  it('ignores unsupported escapes without throwing', () => {
    const screen = parseSgrScreen('\x1b]8;;https://example.com\x07ok\x1b[?25l', 5, 1);
    expect(snapshotText(screen)[0]).toBe('ok');
  });

  it('coalesces attribute runs into ranges', () => {
    const screen = parseSgrScreen('\x1b[1mAB\x1b[0m\x1b[4mC', 4, 1);
    expect(attributeRuns(screen, 0)).toEqual([
      { from: 0, to: 2, style: 'bold' },
      { from: 2, to: 3, style: 'underline' },
    ]);
  });
});

describe('diffScreens', () => {
  it('returns all non-empty rows for the first snapshot', () => {
    const next = parseSgrScreen('AB\n\nCD', 4, 3);
    const diff = diffScreens(undefined, next);

    expect(diff.map((entry) => entry.row)).toEqual([0, 2]);
    expect(diff[0].text).toBe('AB');
    expect(diff[1].text).toBe('CD');
  });

  it('reports only rows whose text or attributes changed', () => {
    const previous = parseSgrScreen('\x1b[1mAB', 4, 2);
    const next = parseSgrScreen('\x1b[1mA\x1b[0mC', 4, 2);

    const diff = diffScreens(previous, next);
    expect(diff).toHaveLength(1);
    expect(diff[0].row).toBe(0);
    expect(diff[0].text).toBe('AC');
    expect(diff[0].attrs).toEqual([{ from: 0, to: 1, style: 'bold' }]);
  });

  it('reports an attribute-only change on identical text', () => {
    const previous = parseSgrScreen('AB', 4, 1);
    const next = parseSgrScreen('\x1b[1mAB', 4, 1);

    const diff = diffScreens(previous, next);
    expect(diff).toHaveLength(1);
    expect(diff[0].text).toBe('AB');
    expect(diff[0].attrs).toEqual([{ from: 0, to: 2, style: 'bold' }]);
  });
});
