// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, expect, it } from 'bun:test';
import { collectSkinPairs, contrastEntry } from '../src/lib/imagelab/contrast.ts';

describe('contrastEntry', () => {
  it('scores black on white at 21', () => {
    const entry = contrastEntry({ foreground: '#000000', background: '#ffffff' });
    expect(entry.ratio).toBe(21);
    expect(entry.aa).toBe(true);
    expect(entry.aaa).toBe(true);
    expect(entry.largeTextAa).toBe(true);
    expect(entry.largeTextAaa).toBe(true);
  });

  it('scores #777777 on white', () => {
    const entry = contrastEntry({ label: 'body', foreground: '#777777', background: '#ffffff' });
    expect(entry.label).toBe('body');
    expect(entry.ratio).toBeCloseTo(4.48, 2);
    expect(entry.aa).toBe(false);
    expect(entry.aaa).toBe(false);
    expect(entry.largeTextAa).toBe(true);
    expect(entry.largeTextAaa).toBe(false);
  });

  it('supports rgba functional colours', () => {
    const entry = contrastEntry({ foreground: 'rgba(0,0,0,0.5)', background: '#ffffff' });
    expect(entry.ratio).toBeLessThan(21);
    expect(entry.ratio).toBeGreaterThan(1);
  });
});

describe('collectSkinPairs', () => {
  it('extracts nested foreground/background pairs', () => {
    const json = {
      colors: { text: '#ffffff', background: '#101010' },
      pens: [
        { fg: '#ff0000', bg: '#000000' },
        { fg: '#00ff00' },
        { colour: 'not-a-colour' },
        { pen: '#0000ff', background: '#222222' },
      ],
      surface: '#333333',
      note: 'not a colour',
    };
    const pairs = collectSkinPairs(json, '#abcdef');
    expect(pairs.length).toBe(4);
    expect(pairs.map((pair) => pair.label)).toEqual([
      'colors.text',
      'pens[0].fg',
      'pens[1].fg',
      'pens[3].pen',
    ]);
    expect(pairs[0].background).toBe('#101010');
    expect(pairs[1].background).toBe('#000000');
    expect(pairs[2].background).toBe('#abcdef');
    expect(pairs[3].background).toBe('#222222');
  });

  it('normalises key spelling and casing', () => {
    const pairs = collectSkinPairs(
      { block: { textColor: '#111111', 'background-colour': '#eeeeee' } },
      '#000000'
    );
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toEqual({
      label: 'block.textColor',
      foreground: '#111111',
      background: '#eeeeee',
    });
  });

  it('never throws on garbage input', () => {
    expect(collectSkinPairs('nope', '#ffffff')).toEqual([]);
    expect(collectSkinPairs(null, '#ffffff')).toEqual([]);
    expect(collectSkinPairs([1, true, null, { fg: 5 }], '#ffffff')).toEqual([]);
  });
});
