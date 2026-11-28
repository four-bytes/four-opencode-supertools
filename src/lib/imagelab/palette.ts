// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { formatColour, quantizeKey } from './colour.ts';
import { roundTo, type RasterImage, type Rect } from './image.ts';

export interface PaletteColour {
  hex: string;
  share: number;
  count: number;
}

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export function dominantColours(
  image: RasterImage,
  rect: Rect,
  limit: number,
  bits = 5
): PaletteColour[] {
  const buckets = new Map<number, Bucket>();
  let sampled = 0;

  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const a = image.data[i + 3];
      const key = quantizeKey({ r, g, b, a }, bits);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { count: 0, r: 0, g: 0, b: 0, a: 0 };
        buckets.set(key, bucket);
      }
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.a += a;
      sampled++;
    }
  }

  if (sampled === 0) {
    return [];
  }

  const colours: PaletteColour[] = [];
  for (const bucket of buckets.values()) {
    const mean = {
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
      a: Math.round(bucket.a / bucket.count),
    };
    colours.push({
      hex: formatColour(mean),
      share: roundTo(bucket.count / sampled, 4),
      count: bucket.count,
    });
  }

  colours.sort((p, q) => q.count - p.count || (p.hex < q.hex ? -1 : p.hex > q.hex ? 1 : 0));
  return colours.slice(0, Math.max(0, Math.floor(limit)));
}

export interface RegionSample {
  uniqueColors: number;
  mean: string;
  dominant: PaletteColour[];
}

export function sampleRegion(image: RasterImage, rect: Rect, dominantLimit: number): RegionSample {
  const seen = new Set<number>();
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  let count = 0;

  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const a = image.data[i + 3];
      seen.add(((r * 256 + g) * 256 + b) * 256 + a);
      sumR += r;
      sumG += g;
      sumB += b;
      sumA += a;
      count++;
    }
  }

  const mean = formatColour({
    r: Math.round(sumR / count),
    g: Math.round(sumG / count),
    b: Math.round(sumB / count),
    a: Math.round(sumA / count),
  });

  return {
    uniqueColors: seen.size,
    mean,
    dominant: dominantColours(image, rect, dominantLimit),
  };
}
