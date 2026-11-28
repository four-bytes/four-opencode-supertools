// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolContext } from '@opencode-ai/plugin';
import { resolve } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';
import {
  UNDERLINED,
  describeMods,
  parseTraceText,
  readTraceFile,
  type TraceFrame,
} from '../lib/termlab/trace';
import { unicodeWidth } from '../lib/termlab/width';
import { parseSgrScreen, type Screen } from '../lib/termlab/sgr';
import { isTmuxAvailable, TmuxSession, type TmuxRunner } from '../lib/termlab/tmux';

const TITLE = 'Trace Replay';
const DEFAULT_SETTLE_MS = 60;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

const DESCRIPTION =
  'Replay a TURBO_TUI_TRACE through an independent tmux terminal emulator and compare the rendered screen against the recorded back buffer and modifier masks. Returns ok:true with matched:false plus divergences when the emulator disagrees (divergences are data, not a failure). Colour is never compared. Returns available:false when tmux is not installed.';

type TraceReplayContext = ToolContext & { tmuxRunner?: TmuxRunner; skipTmuxCheck?: boolean };

const ORACLE_COMMAND = "sh -c 'stty -echo raw 2>/dev/null; exec cat'";

const TRACE_MOD_NAMES: Record<string, string> = {
  BOLD: 'bold',
  DIM: 'dim',
  ITALIC: 'italic',
  UNDERLINED: 'underline',
  SLOW_BLINK: 'blink',
  RAPID_BLINK: 'blink',
  REVERSED: 'reverse',
  HIDDEN: 'hidden',
  CROSSED_OUT: 'crossed-out',
};

interface CellState {
  char: string;
  mods: string[];
}

interface Divergence {
  frame: number;
  label: string;
  x: number;
  y: number;
  expected: CellState;
  actual: CellState;
  frameBytesHex: string;
}

class TimeoutError extends Error {}

function failure(error: string, hint: string, available = true) {
  return {
    title: TITLE,
    output: JSON.stringify({ available, oracle: 'tmux', error, hint }),
    metadata: { available, error: true },
  };
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function traceModsToNames(mask: number): string[] {
  const names = new Set<string>();
  for (const name of describeMods(mask)) {
    const mapped = TRACE_MOD_NAMES[name];
    if (mapped) names.add(mapped);
  }
  return [...names];
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function compareFrame(frame: TraceFrame, screen: Screen, compareMods: boolean): Divergence[] {
  const expectedCells = frame.width * frame.height;
  if (frame.back.length < expectedCells) {
    throw new Error(
      `back buffer has ${frame.back.length} cells, expected ${expectedCells} (${frame.width}x${frame.height})`
    );
  }

  const divergences: Divergence[] = [];
  const bytesHex = hexOf(frame.bytes.subarray(0, 64));

  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const index = y * frame.width + x;
      const expectedSymbol = frame.back[index] ?? '';
      const expectedChar = expectedSymbol === '' ? ' ' : expectedSymbol;

      const cell = screen.cells[index];
      const actualChar = cell && cell.char !== '' ? cell.char : ' ';

      const charDiffers = expectedChar !== actualChar;

      let expectedMods: string[] = [];
      let actualMods: string[] = [];
      let modsDiffer = false;

      if (compareMods) {
        let mask = frame.mods[index] ?? 0;
        if (frame.links[index]) mask &= ~UNDERLINED;
        expectedMods = traceModsToNames(mask);
        actualMods = cell ? cell.mods : [];
        modsDiffer = !sameSet(expectedMods, actualMods);
      }

      if (charDiffers || modsDiffer) {
        divergences.push({
          frame: frame.number,
          label: frame.label,
          x,
          y,
          expected: { char: expectedChar, mods: expectedMods },
          actual: { char: actualChar, mods: actualMods },
          frameBytesHex: bytesHex,
        });
      }

      if (unicodeWidth(expectedChar) === 2) x += 1;
    }
  }

  return divergences;
}

export const traceReplayTool = tool({
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
    settleMs: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_SETTLE_MS)
      .describe('Wait after feeding each frame (clamped 0…5000).'),
    timeoutMs: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_TIMEOUT_MS)
      .describe('Overall timeout (clamped 1000…300000).'),
    stopOnFirstDivergence: tool.schema
      .boolean()
      .optional()
      .default(true)
      .describe('Stop after the first differing cell (default: true).'),
    limit: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_LIMIT)
      .describe('Maximum divergences when not stopping at the first (default: 5).'),
    compareMods: tool.schema
      .boolean()
      .optional()
      .default(true)
      .describe('Compare modifier masks in addition to characters.'),
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

    const settleMs = clamp(args.settleMs, 0, 5000, DEFAULT_SETTLE_MS);
    const timeoutMs = clamp(args.timeoutMs, 1000, 300000, DEFAULT_TIMEOUT_MS);
    const stopOnFirst = args.stopOnFirstDivergence !== false;
    const limit = clamp(args.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    const compareMods = args.compareMods !== false;
    const cap = stopOnFirst ? 1 : limit;

    const context = ctx as TraceReplayContext;
    const runner = context.tmuxRunner;
    const skipCheck = context.skipTmuxCheck === true;

    if (!skipCheck && !(await isTmuxAvailable(runner))) {
      return {
        title: TITLE,
        output: JSON.stringify({
          available: false,
          oracle: 'tmux',
          error: 'tmux not found',
          hint: 'Install tmux (Linux/WSL)',
        }),
        metadata: { available: false },
      };
    }

    const start = selected[0];
    const session = new TmuxSession({
      command: ORACLE_COMMAND,
      width: start.width,
      height: start.height,
      cwd: args.directory ?? ctx.directory,
      runner,
      timeoutMs,
    });

    const divergences: Divergence[] = [];
    let compared = 0;
    let truncated = false;
    let timedOut = false;

    try {
      await session.start();
      await sleep(settleMs);

      let currentWidth = start.width;
      let currentHeight = start.height;
      let needsResize = true;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const loop = (async () => {
        for (let frameIndex = 0; frameIndex < selected.length; frameIndex++) {
          if (divergences.length >= cap) {
            if (frameIndex < selected.length) truncated = true;
            break;
          }

          const frame = selected[frameIndex];
          try {
            if (needsResize || frame.width !== currentWidth || frame.height !== currentHeight) {
              await session.resize(frame.width, frame.height);
              currentWidth = frame.width;
              currentHeight = frame.height;
              needsResize = false;
            }

            await session.sendBytes(frame.bytes);
            if (settleMs > 0) await sleep(settleMs);

            const pane = await session.capture({ attributes: compareMods });
            const rawText = compareMods ? pane.raw : pane.rows.join('\n');
            const screen = parseSgrScreen(rawText, frame.width, frame.height);
            compared += 1;

            const frameDivergences = compareFrame(frame, screen, compareMods);
            for (const divergence of frameDivergences) {
              if (divergences.length >= cap) {
                truncated = true;
                break;
              }
              divergences.push(divergence);
            }

            if (divergences.length >= cap) {
              if (frameIndex < selected.length - 1) truncated = true;
              break;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`frame ${frame.number}: ${message}`, { cause: err });
          }
        }
      })();
      loop.catch(() => {});

      try {
        await Promise.race([
          loop,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
          }),
        ]);
      } catch (err) {
        if (err instanceof TimeoutError) timedOut = true;
        else throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      if (timedOut) {
        logDebugEvent('trace_replay.timeout', {
          compared,
          divergences: divergences.length,
          timeoutMs,
        });
        return {
          title: TITLE,
          output: JSON.stringify({
            available: true,
            oracle: 'tmux',
            ok: false,
            error: 'timeout',
            frames: trace.frames.length,
            compared,
            divergences,
            truncated,
            matched: divergences.length === 0,
          }),
          metadata: { available: true, error: true, timeout: true, compared },
        };
      }

      const matched = divergences.length === 0;
      logDebugEvent('trace_replay.complete', {
        frames: trace.frames.length,
        compared,
        divergences: divergences.length,
        matched,
        truncated,
      });

      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          oracle: 'tmux',
          frames: trace.frames.length,
          compared,
          divergences,
          truncated,
          matched,
        }),
        metadata: { compared, divergences: divergences.length, matched, truncated },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDebugEvent('trace_replay.error', { message, compared });
      return {
        title: TITLE,
        output: JSON.stringify({
          available: true,
          oracle: 'tmux',
          ok: false,
          error: message,
          frames: trace.frames.length,
          compared,
          divergences,
          truncated,
          matched: false,
        }),
        metadata: { available: true, error: true, compared },
      };
    } finally {
      await session.kill();
    }
  },
});
