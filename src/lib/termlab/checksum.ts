// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { TraceFrame } from './trace';

export const CHECKSUM_ALGORITHM = 'utf16-sum-mod-65536';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChecksumResult {
  checksum: number;
  hex: string;
  cells: number;
}

export interface TextChecksumResult extends ChecksumResult {
  width: number;
  height: number;
  region: Region;
}

export interface FrameChecksumResult extends ChecksumResult {
  region: Region;
}

export interface ParsedChecksum {
  id: number;
  checksum: number;
  hex: string;
}

function hex4(value: number): string {
  return (value % 65536).toString(16).padStart(4, '0');
}

/** DECRQCRA checksum: sum of UTF-16 code units per cell, modulo 65536. */
export function computeChecksum(cells: string[], width: number, region: Region): ChecksumResult {
  let sum = 0;
  for (let row = 0; row < region.height; row++) {
    for (let col = 0; col < region.width; col++) {
      const index = (region.y + row) * width + (region.x + col);
      const raw = cells[index];
      const symbol = raw === undefined || raw === '' ? ' ' : raw;
      for (let k = 0; k < symbol.length; k++) {
        sum += symbol.charCodeAt(k);
      }
    }
  }
  const checksum = sum % 65536;
  return { checksum, hex: hex4(checksum), cells: region.width * region.height };
}

export interface DecrqcraQueryInput {
  id?: number;
  page?: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Build the DECRQCRA request `CSI id ; page ; top ; left ; bottom ; right * y` (1-based). */
export function decrqcraQuery(query: DecrqcraQueryInput): Uint8Array {
  const id = query.id ?? 1;
  const page = query.page ?? 1;
  const sequence = `\x1b[${id};${page};${query.top};${query.left};${query.bottom};${query.right}*y`;
  return new TextEncoder().encode(sequence);
}

/** Parse a DECCKSR (DCS or CSI) checksum response; null when unparseable. */
export function parseChecksumResponse(text: string): ParsedChecksum | null {
  const dcsStart = text.indexOf('\u001bP');
  if (dcsStart !== -1) {
    const rest = text.slice(dcsStart + 2);
    const match = /^(\d+)!~([0-9a-fA-F]{4})/.exec(rest);
    if (match) {
      const checksum = Number.parseInt(match[2], 16) % 65536;
      return { id: Number.parseInt(match[1], 10), checksum, hex: hex4(checksum) };
    }
  }

  const csiStart = text.indexOf('\u001b[');
  if (csiStart !== -1) {
    const rest = text.slice(csiStart + 2);
    const match = /^(\d+);(\d+)\*y/.exec(rest);
    if (match) {
      const checksum = Number.parseInt(match[2], 10) % 65536;
      return { id: Number.parseInt(match[1], 10), checksum, hex: hex4(checksum) };
    }
  }

  return null;
}

function buildCells(text: string): { cells: string[]; width: number; height: number } {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const rows = lines.map((line) => Array.from(line));
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const height = rows.length;
  const cells: string[] = new Array(width * height).fill(' ');
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      cells[row * width + col] = rows[row][col] ?? ' ';
    }
  }
  return { cells, width, height };
}

/** Checksum a screen dump; short lines are padded, region defaults to the full grid. */
export function checksumFromText(text: string, region?: Region): TextChecksumResult {
  const { cells, width, height } = buildCells(text);
  const used = region ?? { x: 0, y: 0, width, height };
  const result = computeChecksum(cells, width, used);
  return { ...result, width, height, region: used };
}

/** Checksum a trace frame's back buffer; region defaults to the full frame. */
export function checksumFromFrame(frame: TraceFrame, region?: Region): FrameChecksumResult {
  const used = region ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  const result = computeChecksum(frame.back, frame.width, used);
  return { ...result, region: used };
}

/** Render bytes with non-printable bytes as `\xHH` escapes. */
export function escapeBytes(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}
