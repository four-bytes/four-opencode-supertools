// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPixel } from '../src/lib/imagelab/image.ts';
import { decodeSixel } from '../src/lib/imagelab/sixel.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'imagelab', 'sample.sixel');

describe('decodeSixel', () => {
  it('decodes a single red pixel', () => {
    const result = decodeSixel('#1;2;100;0;0#1@');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.bands).toBe(1);
    expect(result.coloursUsed).toBe(1);
    expect(result.palette).toEqual([{ index: 1, r: 255, g: 0, b: 0, hex: '#ff0000' }]);
    expect(getPixel(result.image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('decodes the multi-band fixture', () => {
    const result = decodeSixel(readFileSync(FIXTURE));
    expect(result.width).toBe(6);
    expect(result.height).toBe(12);
    expect(result.bands).toBe(2);
    expect(result.coloursUsed).toBe(2);
    expect(result.palette.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(result.palette[1].hex).toBe('#ff0000');
    expect(result.palette[2].hex).toBe('#00ff00');
    expect(result.declared).toEqual({ width: 6, height: 12 });

    expect(getPixel(result.image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(getPixel(result.image, 5, 5)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(getPixel(result.image, 0, 6)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(getPixel(result.image, 5, 11)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it('expands !n repeats', () => {
    const result = decodeSixel('#2;2;0;100;0#2!3@');
    expect(result.width).toBe(3);
    expect(result.height).toBe(1);
    for (let x = 0; x < 3; x++) {
      expect(getPixel(result.image, x, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    }
  });

  it('converts HLS definitions', () => {
    const result = decodeSixel('#3;1;0;50;100#3@');
    expect(result.palette[0]).toEqual({ index: 3, r: 255, g: 0, b: 0, hex: '#ff0000' });
    expect(getPixel(result.image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('keeps defined but unused palette entries and counts used colours', () => {
    const result = decodeSixel('#0;2;0;0;0#5;2;0;0;100#5@');
    expect(result.palette.map((entry) => entry.index)).toEqual([0, 5]);
    expect(result.coloursUsed).toBe(1);
    expect(result.bands).toBe(1);
  });

  it('honours a declared raster larger than the painted area', () => {
    const result = decodeSixel('"1;1;10;20#1;2;100;0;0#1@');
    expect(result.width).toBe(10);
    expect(result.height).toBe(20);
    expect(result.bands).toBe(4);
    expect(result.declared).toEqual({ width: 10, height: 20 });
    expect(getPixel(result.image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(getPixel(result.image, 9, 19)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('accepts a DCS-wrapped stream', () => {
    const body = '#1;2;100;0;0#1@';
    const wrapped = `\x1bP0;0;0q${body}\x1b\\`;
    const result = decodeSixel(wrapped);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(getPixel(result.image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('throws for empty streams and pixel caps', () => {
    expect(() => decodeSixel('#1;2;100;0;0')).toThrow(/no pixels/);
    expect(() => decodeSixel('#1;2;100;0;0#1@', { maxPixels: 0 })).toThrow(/maximum/);
  });

  it('applies colour definitions that appear after first use', () => {
    const result = decodeSixel('#1@#1;2;100;0;0');
    expect(getPixel(result.image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(result.palette).toContainEqual({ index: 1, r: 255, g: 0, b: 0, hex: '#ff0000' });
  });
});
