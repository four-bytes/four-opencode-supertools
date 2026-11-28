// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, expect, it } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { createImage, getPixel, setPixel } from '../src/lib/imagelab/image.ts';
import { decodePng, encodePng, pngInfo } from '../src/lib/imagelab/png.ts';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function be32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) {
    body[i] = type.charCodeAt(i);
  }
  body.set(data, 4);
  return concatBytes([be32(data.length), body, be32(crc32(body))]);
}

interface PngSpec {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace?: number;
  scanlines: number[];
  palette?: number[];
  transparency?: number[];
}

function buildPng(spec: PngSpec): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(spec.width), 0);
  ihdr.set(be32(spec.height), 4);
  ihdr[8] = spec.bitDepth;
  ihdr[9] = spec.colourType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = spec.interlace ?? 0;

  const parts: Uint8Array[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (spec.palette) {
    parts.push(pngChunk('PLTE', new Uint8Array(spec.palette)));
  }
  if (spec.transparency) {
    parts.push(pngChunk('tRNS', new Uint8Array(spec.transparency)));
  }
  parts.push(pngChunk('IDAT', deflateSync(new Uint8Array(spec.scanlines))));
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return concatBytes(parts);
}

describe('png codec', () => {
  it('round-trips RGBA data exactly', () => {
    const image = createImage(3, 2);
    const samples = [
      { r: 0, g: 0, b: 0, a: 0 },
      { r: 12, g: 34, b: 56, a: 78 },
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 1, g: 2, b: 3, a: 4 },
      { r: 200, g: 100, b: 50, a: 25 },
      { r: 90, g: 180, b: 240, a: 128 },
    ];
    samples.forEach((colour, index) => setPixel(image, index % 3, Math.floor(index / 3), colour));

    const decoded = decodePng(encodePng(image));
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(image.data));
  });

  it('reports PNG info', () => {
    const info = pngInfo(encodePng(createImage(4, 7)));
    expect(info).toEqual({ width: 4, height: 7, bitDepth: 8, colourType: 6 });
  });

  it('rejects invalid dimensions', () => {
    expect(() => createImage(0, 1)).toThrow();
    expect(() => createImage(-1, 5)).toThrow();
    expect(() => createImage(1.5, 5)).toThrow();
  });

  it('detects CRC mismatches', () => {
    const bytes = encodePng(createImage(2, 2));
    const corrupted = bytes.slice();
    corrupted[45] ^= 0xff;
    expect(() => decodePng(corrupted)).toThrow(/CRC/);
  });

  it('rejects truncated and invalid input', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/signature/);
    const bytes = encodePng(createImage(2, 2));
    expect(() => decodePng(bytes.subarray(0, 12))).toThrow();
    expect(() => decodePng(bytes.subarray(0, bytes.length - 12))).toThrow(/IEND|truncated/);
  });

  it('rejects image data that does not match its dimensions', () => {
    const broken = { width: 2, height: 2, data: new Uint8Array(4) };
    expect(() => encodePng(broken)).toThrow();
  });

  it('keeps getPixel bounds behaviour intact', () => {
    const image = createImage(1, 1);
    expect(() => getPixel(image, 1, 0)).toThrow(RangeError);
  });

  it('decodes a 1-bit palette with tRNS alpha', () => {
    const bytes = buildPng({
      width: 4,
      height: 1,
      bitDepth: 1,
      colourType: 3,
      scanlines: [0, 0x50],
      palette: [255, 0, 0, 0, 255, 0],
      transparency: [255, 128],
    });
    const image = decodePng(bytes);
    expect(getPixel(image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(getPixel(image, 1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 128 });
    expect(getPixel(image, 2, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(getPixel(image, 3, 0)).toEqual({ r: 0, g: 255, b: 0, a: 128 });
    expect(pngInfo(bytes)).toMatchObject({ bitDepth: 1, colourType: 3 });
  });

  it('applies an 8-bit grayscale tRNS key', () => {
    const bytes = buildPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colourType: 0,
      scanlines: [0, 0, 255],
      transparency: [0, 0],
    });
    const image = decodePng(bytes);
    expect(getPixel(image, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(getPixel(image, 1, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('decodes Sub, Up, Average and Paeth filtered rows', () => {
    const bytes = buildPng({
      width: 2,
      height: 4,
      bitDepth: 8,
      colourType: 6,
      scanlines: [
        1, 10, 20, 30, 255, 30, 30, 30, 0, 2, 251, 242, 233, 0, 224, 215, 206, 0, 3, 98, 107, 117,
        128, 76, 81, 85, 0, 4, 100, 100, 100, 0, 30, 30, 30, 0,
      ],
    });
    const image = decodePng(bytes);
    expect(getPixel(image, 0, 0)).toEqual({ r: 10, g: 20, b: 30, a: 255 });
    expect(getPixel(image, 1, 0)).toEqual({ r: 40, g: 50, b: 60, a: 255 });
    expect(getPixel(image, 0, 1)).toEqual({ r: 5, g: 6, b: 7, a: 255 });
    expect(getPixel(image, 1, 1)).toEqual({ r: 8, g: 9, b: 10, a: 255 });
    expect(getPixel(image, 0, 2)).toEqual({ r: 100, g: 110, b: 120, a: 255 });
    expect(getPixel(image, 1, 2)).toEqual({ r: 130, g: 140, b: 150, a: 255 });
    expect(getPixel(image, 0, 3)).toEqual({ r: 200, g: 210, b: 220, a: 255 });
    expect(getPixel(image, 1, 3)).toEqual({ r: 230, g: 240, b: 250, a: 255 });
  });

  it('rejects Adam7 interlaced PNGs', () => {
    const bytes = buildPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colourType: 0,
      interlace: 1,
      scanlines: [0, 0],
    });
    expect(() => decodePng(bytes)).toThrow(/Adam7/);
  });

  it('decodes 16-bit RGB by keeping the high byte', () => {
    const bytes = buildPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colourType: 2,
      scanlines: [0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc],
    });
    expect(getPixel(decodePng(bytes), 0, 0)).toEqual({ r: 0x12, g: 0x56, b: 0x9a, a: 255 });
  });
});
