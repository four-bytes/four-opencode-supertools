// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createImage, setPixel, type RasterImage } from './image.ts';

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function hasSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) {
    return false;
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function samplesPerPixel(colourType: number): number {
  switch (colourType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`unsupported PNG colour type ${colourType}`);
  }
}

function validBitDepth(colourType: number, bitDepth: number): boolean {
  switch (colourType) {
    case 0:
      return (
        bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16
      );
    case 2:
      return bitDepth === 8 || bitDepth === 16;
    case 3:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8;
    case 4:
      return bitDepth === 8 || bitDepth === 16;
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    default:
      return false;
  }
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  compression: number;
  filter: number;
  interlace: number;
}

function parseIhdr(data: Uint8Array): Header {
  if (data.length !== 13) {
    throw new Error('malformed PNG IHDR chunk');
  }
  return {
    width: readU32(data, 0),
    height: readU32(data, 4),
    bitDepth: data[8],
    colourType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
}

function validateHeader(header: Header): void {
  if (header.width < 1 || header.height < 1) {
    throw new Error('invalid PNG dimensions');
  }
  if (header.compression !== 0) {
    throw new Error(`unsupported PNG compression method ${header.compression}`);
  }
  if (header.filter !== 0) {
    throw new Error(`unsupported PNG filter method ${header.filter}`);
  }
  if (header.interlace !== 0) {
    throw new Error('Adam7 interlaced PNG is not supported');
  }
  if (!validBitDepth(header.colourType, header.bitDepth)) {
    throw new Error(
      `unsupported PNG colour type ${header.colourType} with bit depth ${header.bitDepth}`
    );
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function packedSample(row: Uint8Array, index: number, depth: number): number {
  const bitOffset = index * depth;
  const byte = row[bitOffset >> 3];
  const shift = 8 - depth - (bitOffset & 7);
  const mask = (1 << depth) - 1;
  return (byte >> shift) & mask;
}

export function pngInfo(bytes: Uint8Array): PngInfo {
  if (!hasSignature(bytes)) {
    throw new Error('not a PNG file: invalid signature');
  }
  if (bytes.length < 8 + 12 + 13) {
    throw new Error('truncated PNG data');
  }
  const length = readU32(bytes, 8);
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (type !== 'IHDR' || length !== 13) {
    throw new Error('PNG does not start with an IHDR chunk');
  }
  const header = parseIhdr(bytes.subarray(16, 29));
  return {
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    colourType: header.colourType,
  };
}

export function decodePng(bytes: Uint8Array): RasterImage {
  if (!hasSignature(bytes)) {
    throw new Error('not a PNG file: invalid signature');
  }

  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let sawIend = false;
  let offset = 8;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error('truncated PNG data');
    }
    const length = readU32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > bytes.length) {
      throw new Error('truncated PNG data');
    }
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const expectedCrc = readU32(bytes, dataEnd);
    const actualCrc = crc32(bytes, offset + 4, dataEnd);
    if (actualCrc !== expectedCrc) {
      throw new Error(`PNG CRC mismatch in ${type} chunk`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      header = parseIhdr(data);
    } else if (type === 'PLTE') {
      palette = data.slice();
    } else if (type === 'IDAT') {
      idatParts.push(data.slice());
    } else if (type === 'tRNS') {
      transparency = data.slice();
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    } else if (bytes[offset + 4] < 97) {
      throw new Error(`unknown critical PNG chunk ${type}`);
    }

    offset = crcEnd;
  }

  if (!header) {
    throw new Error('PNG is missing the IHDR chunk');
  }
  if (!sawIend) {
    throw new Error('truncated PNG data: missing IEND chunk');
  }
  validateHeader(header);
  const { width, height, bitDepth, colourType } = header;

  if (colourType === 3 && !palette) {
    throw new Error('PNG colour type 3 requires a PLTE chunk');
  }
  if (idatParts.length === 0) {
    throw new Error('PNG contains no IDAT data');
  }

  let raw: Uint8Array;
  try {
    raw = inflateSync(concat(idatParts));
  } catch {
    throw new Error('failed to inflate PNG IDAT data');
  }

  const samples = samplesPerPixel(colourType);
  const rowBytes = Math.ceil((width * samples * bitDepth) / 8);
  const expectedLength = height * (rowBytes + 1);
  if (raw.length < expectedLength) {
    throw new Error('truncated PNG image data');
  }

  const bytesPerPixel = Math.max(1, Math.ceil((samples * bitDepth) / 8));
  const pixels = new Uint8Array(height * rowBytes);
  const previous = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const rowStart = y * (rowBytes + 1) + 1;
    const current = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const value = raw[rowStart + i];
      const a = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
      const b = previous[i];
      const c = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
      let decoded: number;
      switch (filter) {
        case 0:
          decoded = value;
          break;
        case 1:
          decoded = value + a;
          break;
        case 2:
          decoded = value + b;
          break;
        case 3:
          decoded = value + ((a + b) >> 1);
          break;
        case 4:
          decoded = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filter}`);
      }
      current[i] = decoded & 0xff;
    }
    pixels.set(current, y * rowBytes);
    previous.set(current);
  }

  const image = createImage(width, height);
  const transparentGray =
    transparency && transparency.length >= 2 ? (transparency[0] << 8) | transparency[1] : -1;
  const transparentRgb =
    transparency && transparency.length >= 6
      ? [
          (transparency[0] << 8) | transparency[1],
          (transparency[2] << 8) | transparency[3],
          (transparency[4] << 8) | transparency[5],
        ]
      : null;
  const maxLow = (1 << bitDepth) - 1;

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (bitDepth === 16) {
        const base = x * samples * 2;
        const hi = (index: number) => row[base + index * 2];
        const full = (index: number) => (row[base + index * 2] << 8) | row[base + index * 2 + 1];
        if (colourType === 0) {
          r = g = b = hi(0);
          if (transparentGray >= 0 && full(0) === transparentGray) {
            a = 0;
          }
        } else if (colourType === 2) {
          r = hi(0);
          g = hi(1);
          b = hi(2);
          if (
            transparentRgb &&
            full(0) === transparentRgb[0] &&
            full(1) === transparentRgb[1] &&
            full(2) === transparentRgb[2]
          ) {
            a = 0;
          }
        } else if (colourType === 4) {
          r = g = b = hi(0);
          a = hi(1);
        } else if (colourType === 6) {
          r = hi(0);
          g = hi(1);
          b = hi(2);
          a = hi(3);
        }
      } else if (bitDepth === 8) {
        const base = x * samples;
        if (colourType === 0) {
          r = g = b = row[base];
          if (transparentGray >= 0 && row[base] === transparentGray) {
            a = 0;
          }
        } else if (colourType === 2) {
          r = row[base];
          g = row[base + 1];
          b = row[base + 2];
          if (
            transparentRgb &&
            r === transparentRgb[0] &&
            g === transparentRgb[1] &&
            b === transparentRgb[2]
          ) {
            a = 0;
          }
        } else if (colourType === 3) {
          const index = row[base];
          const p = index * 3;
          if (palette && p + 2 < palette.length) {
            r = palette[p];
            g = palette[p + 1];
            b = palette[p + 2];
          }
          a = transparency && index < transparency.length ? transparency[index] : 255;
        } else if (colourType === 4) {
          r = g = b = row[base];
          a = row[base + 1];
        } else if (colourType === 6) {
          r = row[base];
          g = row[base + 1];
          b = row[base + 2];
          a = row[base + 3];
        }
      } else {
        const sample = packedSample(row, x, bitDepth);
        if (colourType === 0) {
          const gray = Math.round((sample * 255) / maxLow);
          r = g = b = gray;
          if (transparentGray >= 0 && sample === transparentGray) {
            a = 0;
          }
        } else if (colourType === 3) {
          const p = sample * 3;
          if (palette && p + 2 < palette.length) {
            r = palette[p];
            g = palette[p + 1];
            b = palette[p + 2];
          }
          a = transparency && sample < transparency.length ? transparency[sample] : 255;
        }
      }

      setPixel(image, x, y, { r, g, b, a });
    }
  }

  return image;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export function encodePng(image: RasterImage): Uint8Array {
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error('image data length does not match its dimensions');
  }
  const stride = image.width * 4;
  const raw = new Uint8Array(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = deflateSync(raw);

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, image.width);
  writeU32(ihdr, 4, image.height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return concat([
    SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', new Uint8Array(0)),
  ]);
}

export function readPng(path: string): RasterImage {
  return decodePng(readFileSync(path));
}

export function writePng(path: string, image: RasterImage): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(image));
}
