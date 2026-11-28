// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { parseSgrScreen, type Screen } from './sgr';
import { isTmuxAvailable, TmuxSession, type TmuxRunner } from './tmux';

const ORACLE_COMMAND = "sh -c 'stty -echo raw 2>/dev/null; exec cat'";
const PROBE_WIDTH = 40;
const MAX_PROBES = 100;
const MAX_HEIGHT = 200;
const DEFAULT_SETTLE_MS = 60;

export interface MeasureEmulatorOptions {
  runner?: TmuxRunner;
  settleMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Any C0 control (including CR/LF) cannot be probed as a single visible cell. */
function hasC0Control(grapheme: string): boolean {
  for (const char of grapheme) {
    const code = char.codePointAt(0);
    if (code !== undefined && code <= 0x1f) return true;
  }
  return false;
}

/**
 * Display column of the `|` sentinel in one probe row. Continuation cells (the
 * second column of a wide grapheme) count one column; a tmux padding space that
 * follows such a continuation is dropped so it does not shift the sentinel.
 */
function sentinelColumn(screen: Screen, row: number): number | null {
  let column = 0;
  let previousContinuation = false;

  for (let x = 0; x < screen.width; x++) {
    const cell = screen.cells[row * screen.width + x];

    if (cell.char === '') {
      column += 1;
      previousContinuation = true;
      continue;
    }

    if (cell.char === ' ') {
      if (previousContinuation) previousContinuation = false;
      else column += 1;
      continue;
    }

    if (cell.char === '|' || cell.char.endsWith('|')) return column;

    previousContinuation = false;
    column += 1;
  }

  return null;
}

/**
 * Measure each grapheme's display width with an independent tmux emulator. One
 * detached session echoes `${grapheme}|` per row; the sentinel's column is the
 * width the emulator assigned. Returns null when tmux is unavailable or the
 * session fails (never throws); a probe row whose sentinel cannot be located
 * yields null for that grapheme, while a genuine width of 0 stays 0.
 */
export async function measureEmulatorWidths(
  graphemes: string[],
  opts: MeasureEmulatorOptions = {}
): Promise<(number | null)[] | null> {
  const runner = opts.runner;
  if (!(await isTmuxAvailable(runner))) return null;

  const selected = graphemes.slice(0, MAX_PROBES);
  if (selected.length === 0) return [];

  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const height = Math.min(graphemes.length + 1, MAX_HEIGHT);

  // C0 controls are filtered out of the probes and keep the genuine width 0.
  const widths: (number | null)[] = new Array(selected.length).fill(0);
  const probes = selected
    .map((grapheme, index) => ({ grapheme, index }))
    .filter(({ grapheme }) => !hasC0Control(grapheme));

  const session = new TmuxSession({
    command: ORACLE_COMMAND,
    width: PROBE_WIDTH,
    height,
    runner,
  });

  const probeRows: Array<{ index: number; row: number }> = [];

  try {
    await session.start();

    for (let row = 0; row < probes.length; row++) {
      await session.sendLiteral(`${probes[row].grapheme}|`);
      await session.sendLiteral('\r');
      if (row < probes.length - 1) await session.sendLiteral('\n');
      probeRows.push({ index: probes[row].index, row });
    }

    if (probeRows.length > 0 && settleMs > 0) await sleep(settleMs);

    const pane = await session.capture();
    const screen = parseSgrScreen(pane.raw, PROBE_WIDTH, height);

    for (const { index, row } of probeRows) {
      widths[index] = sentinelColumn(screen, row);
    }

    return widths;
  } catch {
    return null;
  } finally {
    await session.kill();
  }
}
