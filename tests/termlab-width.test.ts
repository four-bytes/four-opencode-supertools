// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import {
  splitGraphemes,
  stringWidth,
  unicodeWidth,
  wcwidthWidth,
  widthReport,
} from '../src/lib/termlab/width';

const HEART = '\u2764\uFE0F'; // ❤️
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'; // 👨‍👩‍👧‍👦

describe('splitGraphemes', () => {
  it('keeps ZWJ emoji sequences as one grapheme', () => {
    expect(splitGraphemes(`a${FAMILY}b`)).toEqual(['a', FAMILY, 'b']);
  });

  it('keeps combining marks attached to their base', () => {
    expect(splitGraphemes('e\u0301')).toEqual(['e\u0301']);
  });
});

describe('unicodeWidth vs wcwidthWidth — AC cases', () => {
  it('em dash is one cell in both models', () => {
    expect(unicodeWidth('\u2014')).toBe(1);
    expect(wcwidthWidth('\u2014')).toBe(1);
  });

  it('heart with VS16 is two cells under unicode and one under wcwidth', () => {
    expect(unicodeWidth(HEART)).toBe(2);
    expect(wcwidthWidth(HEART)).toBe(1);
  });

  it('ZWJ family emoji is two cells in both models', () => {
    expect(unicodeWidth(FAMILY)).toBe(2);
    expect(wcwidthWidth(FAMILY)).toBe(2);
  });

  it('CJK ideograph is two cells in both models', () => {
    expect(unicodeWidth('世')).toBe(2);
    expect(wcwidthWidth('世')).toBe(2);
  });

  it('ASCII is one cell in both models', () => {
    expect(unicodeWidth('a')).toBe(1);
    expect(wcwidthWidth('a')).toBe(1);
  });
});

describe('width edge cases', () => {
  it('treats combining marks as zero width', () => {
    expect(unicodeWidth('e\u0301')).toBe(1);
    expect(wcwidthWidth('e\u0301')).toBe(1);
  });

  it('treats a lone text-presentation heart as one cell', () => {
    expect(unicodeWidth('\u2764')).toBe(1);
    expect(wcwidthWidth('\u2764')).toBe(1);
  });

  it('reports control characters as -1 in wcwidth and 0 in unicode', () => {
    expect(wcwidthWidth('\u0001')).toBe(-1);
    expect(unicodeWidth('\u0001')).toBe(0);
  });

  it('clamps negative widths when summing', () => {
    expect(stringWidth('a\u0001b', 'wcwidth')).toBe(2);
    expect(stringWidth('a\u0001b', 'unicode')).toBe(2);
  });
});

describe('widthReport', () => {
  it('marks where the models disagree', () => {
    const report = widthReport(`\u2014${HEART}`);
    expect(report.total).toEqual({ unicode: 3, wcwidth: 2 });

    const differs = report.graphemes
      .filter((entry) => entry.differs)
      .map((entry) => entry.grapheme);
    expect(differs).toEqual([HEART]);

    const heart = report.graphemes.find((entry) => entry.grapheme === HEART);
    expect(heart?.codepoints).toEqual(['U+2764', 'U+FE0F']);
    expect(heart?.unicode).toBe(2);
    expect(heart?.wcwidth).toBe(1);
  });

  it('reports totals for plain text', () => {
    const report = widthReport('abc');
    expect(report.total).toEqual({ unicode: 3, wcwidth: 3 });
    expect(report.graphemes.every((entry) => !entry.differs)).toBe(true);
  });
});
