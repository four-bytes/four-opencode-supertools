// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, expect, it } from 'bun:test';
import { createImage, getPixel, setPixel, type RasterImage } from '../src/lib/imagelab/image.ts';
import { buildDiffImage, diffImages } from '../src/lib/imagelab/diff.ts';

const BLACK = { r: 0, g: 0, b: 0, a: 255 };

function clone(image: RasterImage): RasterImage {
  const copy = createImage(image.width, image.height);
  copy.data.set(image.data);
  return copy;
}

describe('diffImages', () => {
  it('counts changed pixels and builds regions', () => {
    const a = createImage(4, 4, BLACK);
    const b = clone(a);
    setPixel(b, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
    setPixel(b, 1, 0, { r: 255, g: 0, b: 0, a: 255 });
    setPixel(b, 3, 3, { r: 0, g: 0, b: 255, a: 255 });

    const result = diffImages(a, b);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.totalPixels).toBe(16);
    expect(result.changedPixels).toBe(3);
    expect(result.changedRatio).toBe(0.1875);
    expect(result.maxDelta).toBe(255);
    expect(result.meanDelta).toBe(47.81);
    expect(result.regionsTotal).toBe(2);
    expect(result.regions).toEqual([
      { x: 0, y: 0, width: 2, height: 1, pixels: 2 },
      { x: 3, y: 3, width: 1, height: 1, pixels: 1 },
    ]);
  });

  it('honours the threshold', () => {
    const a = createImage(2, 1, BLACK);
    const b = clone(a);
    setPixel(b, 0, 0, { r: 0, g: 0, b: 0, a: 100 });

    expect(diffImages(a, b, { threshold: 100 }).changedPixels).toBe(1);
    expect(diffImages(a, b, { threshold: 155 }).changedPixels).toBe(0);
    expect(diffImages(a, b, { threshold: 200 }).changedPixels).toBe(0);
    expect(diffImages(a, b, { threshold: 200 }).maxDelta).toBe(155);
  });

  it('uses the union canvas for mismatched sizes', () => {
    const a = createImage(2, 2, BLACK);
    const b = createImage(3, 3, BLACK);
    const result = diffImages(a, b);
    expect(result.width).toBe(3);
    expect(result.height).toBe(3);
    expect(result.totalPixels).toBe(9);
    expect(result.changedPixels).toBe(5);
    expect(result.regionsTotal).toBe(1);
    expect(result.regions[0]).toEqual({ x: 0, y: 0, width: 3, height: 3, pixels: 5 });
  });

  it('caps regions but keeps regionsTotal', () => {
    const a = createImage(10, 1, BLACK);
    const b = clone(a);
    for (const x of [0, 2, 4, 6, 8]) {
      setPixel(b, x, 0, { r: 255, g: 0, b: 0, a: 255 });
    }
    const result = diffImages(a, b, { maxRegions: 2 });
    expect(result.changedPixels).toBe(5);
    expect(result.regionsTotal).toBe(5);
    expect(result.regions.length).toBe(2);
    expect(result.regions.every((region) => region.pixels === 1)).toBe(true);
  });
});

describe('buildDiffImage', () => {
  it('highlights changes and dims unchanged pixels', () => {
    const a = createImage(4, 4, BLACK);
    const b = clone(a);
    setPixel(b, 0, 0, { r: 255, g: 0, b: 0, a: 255 });

    const { image, result } = buildDiffImage(a, b);
    expect(result.changedPixels).toBe(1);
    expect(getPixel(image, 0, 0)).toEqual({ r: 255, g: 0, b: 68, a: 255 });
    expect(getPixel(image, 1, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('uses a custom highlight and dim', () => {
    const a = createImage(2, 2, BLACK);
    const b = clone(a);
    setPixel(b, 0, 0, { r: 100, g: 100, b: 100, a: 255 });

    const { image } = buildDiffImage(a, b, {
      highlight: { r: 0, g: 255, b: 0, a: 255 },
      dim: 0.5,
    });
    expect(getPixel(image, 0, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(getPixel(image, 1, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('paints black where the b side is missing', () => {
    const a = createImage(2, 2); // transparent
    const b = createImage(1, 1); // transparent
    const { image } = buildDiffImage(a, b);
    expect(getPixel(image, 1, 1)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });
});
