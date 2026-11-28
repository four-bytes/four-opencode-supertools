// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

export interface RasterImage {
  width: number;
  height: number;
  data: Uint8Array; // RGBA8, length = width * height * 4
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAX_IMAGE_PIXELS = 16_777_216;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function assertImageSize(width: number, height: number, max = MAX_IMAGE_PIXELS): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(
      `invalid image size ${width}x${height}: width and height must be positive integers`
    );
  }
  if (width > max || height > max || width * height > max) {
    throw new Error(`image size ${width}x${height} exceeds the maximum of ${max} pixels`);
  }
}

export function createImage(width: number, height: number, fill?: Rgba): RasterImage {
  assertImageSize(width, height);
  const data = new Uint8Array(width * height * 4);
  const image: RasterImage = { width, height, data };
  if (fill) {
    fillRect(image, { x: 0, y: 0, width, height }, fill);
  }
  return image;
}

function inBounds(image: RasterImage, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < image.width && y < image.height;
}

export function getPixel(image: RasterImage, x: number, y: number): Rgba {
  if (!inBounds(image, x, y)) {
    throw new RangeError(`pixel ${x},${y} is outside ${image.width}x${image.height}`);
  }
  const i = (y * image.width + x) * 4;
  return {
    r: image.data[i],
    g: image.data[i + 1],
    b: image.data[i + 2],
    a: image.data[i + 3],
  };
}

export function setPixel(image: RasterImage, x: number, y: number, colour: Rgba): void {
  if (!inBounds(image, x, y)) {
    return;
  }
  const i = (y * image.width + x) * 4;
  image.data[i] = clamp(Math.round(colour.r), 0, 255);
  image.data[i + 1] = clamp(Math.round(colour.g), 0, 255);
  image.data[i + 2] = clamp(Math.round(colour.b), 0, 255);
  image.data[i + 3] = clamp(Math.round(colour.a), 0, 255);
}

export function cropImage(image: RasterImage, rect: Rect): RasterImage {
  if (
    !Number.isInteger(rect.x) ||
    !Number.isInteger(rect.y) ||
    !Number.isInteger(rect.width) ||
    !Number.isInteger(rect.height) ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > image.width ||
    rect.y + rect.height > image.height
  ) {
    throw new Error(
      `crop rect ${rect.x},${rect.y} ${rect.width}x${rect.height} is outside ${image.width}x${image.height}`
    );
  }
  const out = createImage(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const srcStart = ((rect.y + y) * image.width + rect.x) * 4;
    const dstStart = y * rect.width * 4;
    out.data.set(image.data.subarray(srcStart, srcStart + rect.width * 4), dstStart);
  }
  return out;
}

export function scaleNearest(image: RasterImage, factor: number): RasterImage {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`scale factor must be an integer >= 1, got ${factor}`);
  }
  const width = image.width * factor;
  const height = image.height * factor;
  const out = createImage(width, height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const a = image.data[i + 3];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const j = ((y * factor + dy) * width + x * factor + dx) * 4;
          out.data[j] = r;
          out.data[j + 1] = g;
          out.data[j + 2] = b;
          out.data[j + 3] = a;
        }
      }
    }
  }
  return out;
}

export function blit(dest: RasterImage, src: RasterImage, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dest.height) {
      continue;
    }
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dest.width) {
        continue;
      }
      const si = (sy * src.width + sx) * 4;
      const di = (dy * dest.width + dx) * 4;
      dest.data[di] = src.data[si];
      dest.data[di + 1] = src.data[si + 1];
      dest.data[di + 2] = src.data[si + 2];
      dest.data[di + 3] = src.data[si + 3];
    }
  }
}

export function fillRect(image: RasterImage, rect: Rect, colour: Rgba): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
  const r = clamp(Math.round(colour.r), 0, 255);
  const g = clamp(Math.round(colour.g), 0, 255);
  const b = clamp(Math.round(colour.b), 0, 255);
  const a = clamp(Math.round(colour.a), 0, 255);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = a;
    }
  }
}
