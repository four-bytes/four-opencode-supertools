// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { resolve } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';
import { parseTraceText, readTraceFile, type TraceFrame } from '../lib/termlab/trace';
import { decodeOps, formatOp, type TermOp } from '../lib/termlab/ops';
import type { Region } from '../lib/termlab/checksum';

const TITLE = 'Trace Decode';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

const DESCRIPTION =
  'Decode a raw terminal byte trace (turbo-tui TURBO_TUI_TRACE v1) into readable ops per frame (MOVE, SGR, OSC8, TEXT, CLEAR). Filter by frame range and screen region, one compact line per op.';

function failure(error: string, hint: string, available = true) {
  return {
    title: TITLE,
    output: JSON.stringify({ available, error, hint }),
    metadata: { available, error: true },
  };
}

function inRegion(op: TermOp, region: Region): boolean {
  if (op.kind !== 'TEXT' && op.kind !== 'MOVE') return true;
  return (
    op.x >= region.x &&
    op.x < region.x + region.width &&
    op.y >= region.y &&
    op.y < region.y + region.height
  );
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function summarizeFrame(
  frame: TraceFrame,
  region: Region | undefined,
  limit: number
): { frame: number; label: string; bytes: number; ops: string[]; truncated: boolean } {
  const all = decodeOps(frame.bytes, { width: frame.width, height: frame.height });
  const filtered = region ? all.filter((op) => inRegion(op, region)) : all;
  const truncated = filtered.length > limit;
  return {
    frame: frame.number,
    label: frame.label,
    bytes: frame.bytes.length,
    ops: filtered.slice(0, limit).map(formatOp),
    truncated,
  };
}

export const traceDecodeTool = tool({
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
    region: tool.schema
      .object({
        x: tool.schema.number().int().min(0),
        y: tool.schema.number().int().min(0),
        width: tool.schema.number().int().min(1),
        height: tool.schema.number().int().min(1),
      })
      .optional()
      .describe('Only keep TEXT/MOVE ops whose cursor lies in this 0-based region.'),
    limit: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_LIMIT)
      .describe('Maximum ops per frame (default: 200, cap: 2000).'),
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
      return failure(
        'trace contains no frames',
        'The trace has a valid header but no frame blocks.'
      );
    }

    const numbers = trace.frames.map((frame) => frame.number);
    const from = args.fromFrame ?? numbers[0];
    const to = args.toFrame ?? numbers[numbers.length - 1];
    const selected = trace.frames.filter((frame) => frame.number >= from && frame.number <= to);
    const limit = clampLimit(args.limit);
    const region = args.region;

    const frames = selected.map((frame) => summarizeFrame(frame, region, limit));
    const base = selected[0] ?? trace.frames[0];
    const opCount = frames.reduce((sum, frame) => sum + frame.ops.length, 0);
    const truncatedFrames = frames.filter((frame) => frame.truncated).length;

    logDebugEvent('trace_decode.complete', {
      frameCount: trace.frames.length,
      selected: frames.length,
      ops: opCount,
      truncatedFrames,
    });

    return {
      title: TITLE,
      output: JSON.stringify({
        ok: true,
        version: trace.version,
        frameCount: trace.frames.length,
        width: base.width,
        height: base.height,
        frames,
      }),
      metadata: {
        frameCount: trace.frames.length,
        selected: frames.length,
        ops: opCount,
        truncatedFrames,
      },
    };
  },
});
