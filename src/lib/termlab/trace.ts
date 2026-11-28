// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { readFileSync } from 'node:fs';

/** Modifier bit names as used by the turbo-tui trace format. */
export const BOLD = 1 << 0;
export const DIM = 1 << 1;
export const ITALIC = 1 << 2;
export const UNDERLINED = 1 << 3;
export const SLOW_BLINK = 1 << 4;
export const RAPID_BLINK = 1 << 5;
export const REVERSED = 1 << 6;
export const HIDDEN = 1 << 7;
export const CROSSED_OUT = 1 << 8;

const MOD_NAMES: ReadonlyArray<readonly [number, string]> = [
  [BOLD, 'BOLD'],
  [DIM, 'DIM'],
  [ITALIC, 'ITALIC'],
  [UNDERLINED, 'UNDERLINED'],
  [SLOW_BLINK, 'SLOW_BLINK'],
  [RAPID_BLINK, 'RAPID_BLINK'],
  [REVERSED, 'REVERSED'],
  [HIDDEN, 'HIDDEN'],
  [CROSSED_OUT, 'CROSSED_OUT'],
];

/** Names of the modifier bits set in `mask`, in bit order. */
export function describeMods(mask: number): string[] {
  return MOD_NAMES.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
}

export interface TraceFrame {
  number: number;
  label: string;
  width: number;
  height: number;
  bytes: Uint8Array;
  /** Row-major back buffer, `width * height` cells. */
  back: string[];
  /** Row-major modifier bitmasks, `width * height` entries. */
  mods: number[];
  /** Row-major link ids or null, `width * height` entries. */
  links: (string | null)[];
}

export interface TraceFile {
  version: 1;
  frames: TraceFrame[];
}

export const TRACE_MAGIC = 'TURBO_TUI_TRACE 1';

const HEADER_PATTERN = /^=== turbo-tui frame (\d+) (.*) (\d+) bytes (\d+)x(\d+) ===$/;
const END_PATTERN = /^=== end frame (\d+) ===$/;

const utf8Decoder = new TextDecoder('utf-8');
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

/** Decode bytes to a string with one character per byte (true latin1, not windows-1252). */
function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Decode a trace line, preferring UTF-8 so non-ASCII back-buffer cells survive.
 * Falls back to latin1 for invalid UTF-8, keeping binary traces byte-transparent.
 */
function decodeLine(bytes: Uint8Array): string {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0d) end--;
  const line = bytes.subarray(0, end);
  try {
    return utf8FatalDecoder.decode(line);
  } catch {
    return decodeLatin1(line);
  }
}

class ByteReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readLine(): string | null {
    if (this.offset >= this.bytes.length) return null;
    let end = this.offset;
    while (end < this.bytes.length && this.bytes[end] !== 0x0a) end++;
    const line = this.bytes.subarray(this.offset, end);
    this.offset = end < this.bytes.length ? end + 1 : end;
    return decodeLine(line);
  }

  readExact(count: number): Uint8Array {
    if (this.remaining < count) {
      throw new Error(`expected ${count} raw bytes, only ${this.remaining} remain`);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  consumeNewline(): void {
    if (this.bytes[this.offset] === 0x0d) this.offset++;
    if (this.bytes[this.offset] !== 0x0a) {
      throw new Error('expected a newline after the raw frame bytes');
    }
    this.offset++;
  }
}

function parseBackRow(line: string, width: number): string[] {
  const cells = line.split('\t');
  const row: string[] = [];
  for (let i = 0; i < width; i++) {
    row.push(i < cells.length ? cells[i] : ' ');
  }
  return row;
}

function splitCells(line: string): string[] {
  const trimmed = line.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

function parseModsRow(line: string, width: number): number[] {
  const parts = splitCells(line);
  const row: number[] = [];
  for (let i = 0; i < width; i++) {
    const token = parts[i];
    const value = token ? Number.parseInt(token, 16) : 0;
    row.push(Number.isFinite(value) ? value : 0);
  }
  return row;
}

function parseLinksRow(line: string, width: number): (string | null)[] {
  const parts = splitCells(line);
  const row: (string | null)[] = [];
  for (let i = 0; i < width; i++) {
    const token = parts[i];
    row.push(!token || token === '-' ? null : token);
  }
  return row;
}

function readSection(
  reader: ByteReader,
  height: number,
  marker: string,
  parseRow: (line: string) => unknown[]
): unknown[] {
  const markerLine = reader.readLine();
  if (markerLine === null || markerLine.trim() !== marker) {
    throw new Error(`missing ${marker} marker`);
  }
  const flattened: unknown[] = [];
  for (let row = 0; row < height; row++) {
    const line = reader.readLine();
    if (line === null) throw new Error(`truncated ${marker} section`);
    flattened.push(...parseRow(line));
  }
  return flattened;
}

/** Parse a turbo-tui trace v1 byte buffer. */
export function parseTrace(bytes: Uint8Array): TraceFile {
  const reader = new ByteReader(bytes);
  const magic = reader.readLine();
  if (magic !== TRACE_MAGIC) {
    throw new Error('not a TURBO_TUI_TRACE 1 file');
  }

  const frames: TraceFrame[] = [];

  while (true) {
    let header = reader.readLine();
    while (header !== null && header.trim() === '') header = reader.readLine();
    if (header === null) break;

    const match = HEADER_PATTERN.exec(header);
    if (!match) {
      throw new Error(`invalid frame header: ${header}`);
    }

    const number = Number(match[1]);
    const label = match[2];
    const byteCount = Number(match[3]);
    const width = Number(match[4]);
    const height = Number(match[5]);

    try {
      const frameBytes = reader.readExact(byteCount);
      reader.consumeNewline();

      const back = readSection(reader, height, '--- back ---', (line) =>
        parseBackRow(line, width)
      ) as string[];
      const mods = readSection(reader, height, '--- mods ---', (line) =>
        parseModsRow(line, width)
      ) as number[];
      const links = readSection(reader, height, '--- links ---', (line) =>
        parseLinksRow(line, width)
      ) as (string | null)[];

      const endLine = reader.readLine();
      if (endLine === null || !END_PATTERN.test(endLine.trim())) {
        throw new Error('missing end frame marker');
      }

      frames.push({
        number,
        label,
        width,
        height,
        bytes: frameBytes,
        back,
        mods,
        links,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`frame ${number}: ${message}`, { cause: err });
    }
  }

  return { version: 1, frames };
}

/** Alias kept for callers that name the byte-oriented entry point explicitly. */
export const parseTraceBytes = parseTrace;

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Parse a latin1-decoded trace string. Each character is treated as one byte,
 * so this round-trips binary traces without loss. Prefer `parseTrace` for bytes.
 */
export function parseTraceText(text: string): TraceFile {
  return parseTrace(latin1ToBytes(text));
}

/** Read and parse a trace file from disk. */
export function readTraceFile(path: string): TraceFile {
  const buffer = readFileSync(path);
  return parseTrace(new Uint8Array(buffer));
}

/** Decode a frame's raw byte stream as UTF-8 text (invalid bytes replaced). */
export function frameBytesText(frame: TraceFrame): string {
  return utf8Decoder.decode(frame.bytes);
}
