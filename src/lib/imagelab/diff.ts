// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import {
  assertImageSize,
  clamp,
  createImage,
  roundTo,
  setPixel,
  type RasterImage,
  type Rgba,
} from './image.ts';

export interface DiffOptions {
  threshold?: number; // 0..255, default 0
  maxRegions?: number; // default 20
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

export interface DiffResult {
  width: number;
  height: number;
  changedPixels: number;
  totalPixels: number;
  changedRatio: number;
  maxDelta: number;
  meanDelta: number;
  regions: DiffRegion[];
  regionsTotal: number;
}

export interface DiffImageOptions extends DiffOptions {
  highlight?: Rgba;
  dim?: number; // 0..1, default 0.35
}

function channelAt(image: RasterImage, x: number, y: number, offset: number): number {
  return x < image.width && y < image.height ? image.data[(y * image.width + x) * 4 + offset] : 0;
}

function pixelDelta(a: RasterImage, b: RasterImage, x: number, y: number): number {
  const dr = Math.abs(channelAt(a, x, y, 0) - channelAt(b, x, y, 0));
  const dg = Math.abs(channelAt(a, x, y, 1) - channelAt(b, x, y, 1));
  const db = Math.abs(channelAt(a, x, y, 2) - channelAt(b, x, y, 2));
  const da = Math.abs(channelAt(a, x, y, 3) - channelAt(b, x, y, 3));
  return Math.max(dr, dg, db, da);
}

export function diffImages(a: RasterImage, b: RasterImage, options: DiffOptions = {}): DiffResult {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  assertImageSize(width, height);
  const threshold = clamp(options.threshold ?? 0, 0, 255);
  const maxRegions = Math.max(0, Math.floor(options.maxRegions ?? 20));
  const totalPixels = width * height;

  const changedMask = new Uint8Array(totalPixels);
  let changedPixels = 0;
  let maxDelta = 0;
  let sumDelta = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const delta = pixelDelta(a, b, x, y);
      sumDelta += delta;
      if (delta > maxDelta) {
        maxDelta = delta;
      }
      if (delta > threshold) {
        changedMask[y * width + x] = 1;
        changedPixels++;
      }
    }
  }

  const regionList: DiffRegion[] = [];
  if (changedPixels > 0) {
    const queue = new Int32Array(totalPixels);
    for (let start = 0; start < totalPixels; start++) {
      if (changedMask[start] !== 1) {
        continue;
      }
      let head = 0;
      let tail = 0;
      changedMask[start] = 0;
      queue[tail++] = start;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      let count = 0;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = (index / width) | 0;
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (x > 0 && changedMask[index - 1] === 1) {
          changedMask[index - 1] = 0;
          queue[tail++] = index - 1;
        }
        if (x < width - 1 && changedMask[index + 1] === 1) {
          changedMask[index + 1] = 0;
          queue[tail++] = index + 1;
        }
        if (y > 0 && changedMask[index - width] === 1) {
          changedMask[index - width] = 0;
          queue[tail++] = index - width;
        }
        if (y < height - 1 && changedMask[index + width] === 1) {
          changedMask[index + width] = 0;
          queue[tail++] = index + width;
        }
      }
      regionList.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixels: count,
      });
    }
  }

  regionList.sort((p, q) => q.pixels - p.pixels || p.y - q.y || p.x - q.x);

  return {
    width,
    height,
    changedPixels,
    totalPixels,
    changedRatio: roundTo(changedPixels / totalPixels, 4),
    maxDelta: roundTo(maxDelta, 2),
    meanDelta: roundTo(sumDelta / totalPixels, 2),
    regions: regionList.slice(0, maxRegions),
    regionsTotal: regionList.length,
  };
}

export function buildDiffImage(
  a: RasterImage,
  b: RasterImage,
  options: DiffImageOptions = {}
): { image: RasterImage; result: DiffResult } {
  const result = diffImages(a, b, options);
  const threshold = clamp(options.threshold ?? 0, 0, 255);
  const highlight = options.highlight ?? { r: 255, g: 0, b: 68, a: 255 };
  const dim = clamp(options.dim ?? 0.35, 0, 1);
  const image = createImage(result.width, result.height);

  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      if (pixelDelta(a, b, x, y) > threshold) {
        setPixel(image, x, y, highlight);
      } else if (x < b.width && y < b.height) {
        const i = (y * b.width + x) * 4;
        setPixel(image, x, y, {
          r: Math.round(b.data[i] * dim),
          g: Math.round(b.data[i + 1] * dim),
          b: Math.round(b.data[i + 2] * dim),
          a: 255,
        });
      } else {
        setPixel(image, x, y, { r: 0, g: 0, b: 0, a: 255 });
      }
    }
  }

  return { image, result };
}
