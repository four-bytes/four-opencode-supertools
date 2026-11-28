// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { resolve } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';
import {
  BOLD,
  CROSSED_OUT,
  DIM,
  HIDDEN,
  ITALIC,
  RAPID_BLINK,
  REVERSED,
  SLOW_BLINK,
  UNDERLINED,
  describeMods,
  parseTraceText,
  readTraceFile,
  type TraceFrame,
} from '../lib/termlab/trace';
import { decodeOps } from '../lib/termlab/ops';
import { splitGraphemes, unicodeWidth } from '../lib/termlab/width';
import type { Region } from '../lib/termlab/checksum';

const TITLE = 'Cell History';
const DEFAULT_LIMIT = 200;
const DEFAULT_WRITES_PER_CELL = 50;

const DESCRIPTION =
  'Reconstruct which value every screen cell held over a TURBO_TUI_TRACE, without tmux. Returns the ordered writes per cell (character, modifier names/mask, OSC 8 link). Filter by explicit x/y, a region, or every written cell. A term_run session can be recorded by passing env { TURBO_TUI_TRACE: "/tmp/x.trace" } and then reading that trace.';

interface WriteRecord {
  frame: number;
  label: string;
  char: string;
  mods: string[];
  modsMask: number;
  link: string | null;
}

interface CellWrites {
  x: number;
  y: number;
  writes: WriteRecord[];
}

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify({ available: true, error, hint }),
    metadata: { available: true, error: true },
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function applySgrMask(mask: number, params: number[]): number {
  let result = mask;
  const codes = params.length === 0 ? [0] : params;

  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) result = 0;
    else if (code === 1) result |= BOLD;
    else if (code === 2) result |= DIM;
    else if (code === 3) result |= ITALIC;
    else if (code === 4) result |= UNDERLINED;
    else if (code === 5) result |= SLOW_BLINK;
    else if (code === 6) result |= RAPID_BLINK;
    else if (code === 7) result |= REVERSED;
    else if (code === 8) result |= HIDDEN;
    else if (code === 9) result |= CROSSED_OUT;
    else if (code === 21) result &= ~BOLD;
    else if (code === 22) result &= ~(BOLD | DIM);
    else if (code === 23) result &= ~ITALIC;
    else if (code === 24) result &= ~UNDERLINED;
    else if (code === 25) result &= ~(SLOW_BLINK | RAPID_BLINK);
    else if (code === 27) result &= ~REVERSED;
    else if (code === 28) result &= ~HIDDEN;
    else if (code === 29) result &= ~CROSSED_OUT;
    else if (code === 38 || code === 48) {
      const mode = codes[index + 1];
      if (mode === 5) index += 2;
      else if (mode === 2) index += 4;
      else index += 1;
    }
  }

  return result;
}

function newGrid(width: number, height: number): string[] {
  return new Array(width * height).fill(' ');
}

function collectWrites(frames: TraceFrame[]): CellWrites[] {
  const cells = new Map<string, CellWrites>();
  let width = frames[0]?.width ?? 0;
  let height = frames[0]?.height ?? 0;
  let grid = newGrid(width, height);
  let cursorX = 0;
  let cursorY = 0;
  let mask = 0;
  let link: string | null = null;
  let frameNumber = frames[0]?.number ?? 0;
  let frameLabel = frames[0]?.label ?? '';

  const record = (char: string, x: number, y: number): void => {
    const key = `${x},${y}`;
    let entry = cells.get(key);
    if (!entry) {
      entry = { x, y, writes: [] };
      cells.set(key, entry);
    }
    entry.writes.push({
      frame: frameNumber,
      label: frameLabel,
      char,
      mods: describeMods(mask),
      modsMask: mask,
      link,
    });
  };

  const inBounds = (x: number, y: number): boolean => x >= 0 && x < width && y >= 0 && y < height;

  const clearCell = (x: number, y: number): void => {
    if (!inBounds(x, y)) return;
    grid[y * width + x] = ' ';
    record(' ', x, y);
  };

  const clearRow = (y: number, fromX: number, toX: number): void => {
    if (y < 0 || y >= height) return;
    const start = Math.max(0, fromX);
    const end = Math.min(width - 1, toX);
    for (let x = start; x <= end; x++) clearCell(x, y);
  };

  const writeGrapheme = (grapheme: string): void => {
    const graphemeWidth = unicodeWidth(grapheme);

    if (graphemeWidth === 0) {
      const prevX = cursorX - 1;
      if (inBounds(prevX, cursorY)) {
        grid[cursorY * width + prevX] += grapheme;
        const entry = cells.get(`${prevX},${cursorY}`);
        const last = entry?.writes[entry.writes.length - 1];
        if (last) last.char += grapheme;
      }
      return;
    }

    if (cursorX >= width) {
      cursorX = 0;
      cursorY += 1;
    }

    if (inBounds(cursorX, cursorY)) {
      grid[cursorY * width + cursorX] = grapheme;
      record(grapheme, cursorX, cursorY);
      if (graphemeWidth === 2 && cursorX + 1 < width) {
        grid[cursorY * width + cursorX + 1] = '';
      }
    }

    cursorX += graphemeWidth;
  };

  for (const frame of frames) {
    frameNumber = frame.number;
    frameLabel = frame.label;

    if (frame.width !== width || frame.height !== height) {
      width = frame.width;
      height = frame.height;
      grid = newGrid(width, height);
      cursorX = 0;
      cursorY = 0;
      mask = 0;
      link = null;
    }

    const ops = decodeOps(frame.bytes, { width, height });
    for (const op of ops) {
      switch (op.kind) {
        case 'MOVE':
          cursorX = op.x;
          cursorY = op.y;
          break;
        case 'CR':
          cursorX = 0;
          break;
        case 'LF':
          cursorY += 1;
          break;
        case 'BS':
          cursorX = Math.max(0, cursorX - 1);
          break;
        case 'TAB':
          cursorX = (Math.floor(cursorX / 8) + 1) * 8;
          break;
        case 'SGR':
          mask = applySgrMask(mask, op.params);
          break;
        case 'OSC8':
          link = op.id;
          break;
        case 'CLEAR': {
          const mode = op.params[0] ?? 0;
          if (mode === 2 || mode === 3) {
            for (let idx = 0; idx < width * height; idx++) {
              clearCell(idx % width, Math.floor(idx / width));
            }
          } else if (mode === 0) {
            const startIdx = cursorY * width + cursorX;
            for (let idx = Math.max(0, startIdx); idx < width * height; idx++) {
              clearCell(idx % width, Math.floor(idx / width));
            }
          } else if (mode === 1) {
            const endIdx = cursorY * width + cursorX;
            for (let idx = 0; idx <= Math.min(endIdx, width * height - 1); idx++) {
              clearCell(idx % width, Math.floor(idx / width));
            }
          }
          break;
        }
        case 'ERASE_LINE': {
          const mode = op.params[0] ?? 0;
          if (mode === 0) clearRow(cursorY, cursorX, width - 1);
          else if (mode === 1) clearRow(cursorY, 0, cursorX);
          else if (mode === 2) clearRow(cursorY, 0, width - 1);
          break;
        }
        case 'ERASE_CHARS': {
          const raw = op.params[0] ?? 1;
          const count = raw === 0 ? 1 : raw;
          clearRow(cursorY, cursorX, cursorX + count - 1);
          break;
        }
        case 'TEXT':
          for (const grapheme of splitGraphemes(op.text)) writeGrapheme(grapheme);
          break;
        case 'CSI':
          if (op.final === 'G') cursorX = (op.params[0] ?? 1) - 1;
          else if (op.final === 'C') cursorX += op.params[0] ?? 1;
          else if (op.final === 'D') cursorX = Math.max(0, cursorX - (op.params[0] ?? 1));
          else if (op.final === 'A') cursorY = Math.max(0, cursorY - (op.params[0] ?? 1));
          else if (op.final === 'B') cursorY += op.params[0] ?? 1;
          break;
        default:
          break;
      }
    }
  }

  return [...cells.values()];
}

function inRegion(cell: CellWrites, region: Region): boolean {
  return (
    cell.x >= region.x &&
    cell.x < region.x + region.width &&
    cell.y >= region.y &&
    cell.y < region.y + region.height
  );
}

export const cellHistoryTool = tool({
  description: DESCRIPTION,

  args: {
    path: tool.schema
      .string()
      .optional()
      .describe('Path to a TURBO_TUI_TRACE file (required when text is omitted).'),
    text: tool.schema
      .string()
      .optional()
      .describe('Trace content as a latin1-safe string (required when path is omitted).'),
    x: tool.schema.number().int().min(0).optional().describe('Cell column (requires y).'),
    y: tool.schema.number().int().min(0).optional().describe('Cell row (requires x).'),
    region: tool.schema
      .object({
        x: tool.schema.number().int().min(0),
        y: tool.schema.number().int().min(0),
        width: tool.schema.number().int().min(1),
        height: tool.schema.number().int().min(1),
      })
      .optional()
      .describe('Only return cells inside this region.'),
    fromFrame: tool.schema
      .number()
      .int()
      .optional()
      .describe('First frame number (inclusive, defaults to the first frame).'),
    toFrame: tool.schema
      .number()
      .int()
      .optional()
      .describe('Last frame number (inclusive, defaults to the last frame).'),
    limit: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_LIMIT)
      .describe('Maximum cells returned (default: 200).'),
    writesPerCell: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_WRITES_PER_CELL)
      .describe('Maximum writes retained per cell (default: 50).'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for a relative path (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const hasPath = typeof args.path === 'string';
    const hasText = typeof args.text === 'string';
    if (hasPath === hasText) {
      return failure(
        'exactly one of path or text is required',
        'Pass path to a trace file, or text with the trace content.'
      );
    }

    const hasX = typeof args.x === 'number';
    const hasY = typeof args.y === 'number';
    if (hasX !== hasY) {
      return failure('x and y must be provided together', 'Pass both cell coordinates or neither.');
    }

    let trace;
    try {
      if (hasPath) {
        const base = args.directory ?? ctx.directory;
        trace = readTraceFile(resolve(base, args.path as string));
      } else {
        trace = parseTraceText(args.text as string);
      }
    } catch (err) {
      return failure(
        err instanceof Error ? err.message : String(err),
        'The file must start with "TURBO_TUI_TRACE 1" and contain complete frames.'
      );
    }

    if (trace.frames.length === 0) {
      return failure('trace contains no frames', 'The trace has a valid header but no frames.');
    }

    const numbers = trace.frames.map((frame) => frame.number);
    const from = args.fromFrame ?? numbers[0];
    const to = args.toFrame ?? numbers[numbers.length - 1];
    const selected = trace.frames.filter((frame) => frame.number >= from && frame.number <= to);
    if (selected.length === 0) {
      return failure(
        `no frames in range ${from}…${to}`,
        `Available frames: ${numbers.join(', ')}.`
      );
    }

    const limit = positiveInt(args.limit, DEFAULT_LIMIT);
    const writesPerCell = positiveInt(args.writesPerCell, DEFAULT_WRITES_PER_CELL);

    const allCells = collectWrites(selected);

    let filtered: CellWrites[];
    if (hasX && hasY) {
      const x = args.x as number;
      const y = args.y as number;
      filtered = allCells.filter((cell) => cell.x === x && cell.y === y);
    } else if (args.region) {
      const region = args.region;
      filtered = allCells.filter((cell) => inRegion(cell, region));
    } else {
      filtered = allCells;
    }

    filtered.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

    const truncatedCells = filtered.length > limit;
    const selectedCells = filtered.slice(0, limit);
    const truncatedWrites = selectedCells.some((cell) => cell.writes.length > writesPerCell);

    const cells = selectedCells.map((cell) => ({
      x: cell.x,
      y: cell.y,
      writes: cell.writes.slice(0, writesPerCell),
    }));

    logDebugEvent('cell_history.complete', {
      frames: selected.length,
      cells: cells.length,
      truncatedCells,
      truncatedWrites,
    });

    return {
      title: TITLE,
      output: JSON.stringify({
        ok: true,
        frames: selected.length,
        cells,
        truncatedCells,
        truncatedWrites,
      }),
      metadata: {
        frames: selected.length,
        cells: cells.length,
        truncatedCells,
        truncatedWrites,
      },
    };
  },
});
