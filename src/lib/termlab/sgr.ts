// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { splitGraphemes, unicodeWidth } from './width';

export interface ScreenCell {
  char: string;
  fg: string;
  bg: string;
  mods: string[];
}

export interface Screen {
  width: number;
  height: number;
  cells: ScreenCell[];
  rows: string[];
}

export interface AttrRun {
  from: number;
  to: number;
  style: string;
}

export interface ScreenDiff {
  row: number;
  text: string;
  attrs: AttrRun[];
}

const MOD_ORDER = [
  'bold',
  'dim',
  'italic',
  'underline',
  'blink',
  'reverse',
  'hidden',
  'crossed-out',
] as const;

interface StyleState {
  fg: string;
  bg: string;
  mods: Set<string>;
}

function defaultStyle(): StyleState {
  return { fg: 'default', bg: 'default', mods: new Set() };
}

function resetStyle(style: StyleState): void {
  style.fg = 'default';
  style.bg = 'default';
  style.mods.clear();
}

function modsList(mods: Set<string>): string[] {
  return MOD_ORDER.filter((name) => mods.has(name));
}

function hex2(value: number): string {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(255, Math.floor(value))) : 0;
  return clamped.toString(16).padStart(2, '0');
}

function parseParams(raw: string): number[] {
  const cleaned = raw.startsWith('?') ? raw.slice(1) : raw;
  if (cleaned === '') return [0];
  return cleaned.split(';').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function readExtendedColor(params: number[], start: number): [string | null, number] {
  const mode = params[start];
  if (mode === 5) {
    const index = params[start + 1];
    if (index === undefined) return [null, 1];
    return [`ansi:${index}`, 2];
  }
  if (mode === 2) {
    const r = params[start + 1];
    const g = params[start + 2];
    const b = params[start + 3];
    if (r === undefined || g === undefined || b === undefined) return [null, 3];
    return [`#${hex2(r)}${hex2(g)}${hex2(b)}`, 4];
  }
  return [null, 1];
}

function applySgr(params: number[], style: StyleState): void {
  const codes = params.length === 0 ? [0] : params;
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    switch (code) {
      case 0:
        resetStyle(style);
        break;
      case 1:
        style.mods.add('bold');
        break;
      case 2:
        style.mods.add('dim');
        break;
      case 3:
        style.mods.add('italic');
        break;
      case 4:
        style.mods.add('underline');
        break;
      case 5:
      case 6:
        style.mods.add('blink');
        break;
      case 7:
        style.mods.add('reverse');
        break;
      case 8:
        style.mods.add('hidden');
        break;
      case 9:
        style.mods.add('crossed-out');
        break;
      case 21:
        style.mods.delete('bold');
        break;
      case 22:
        style.mods.delete('bold');
        style.mods.delete('dim');
        break;
      case 23:
        style.mods.delete('italic');
        break;
      case 24:
        style.mods.delete('underline');
        break;
      case 25:
        style.mods.delete('blink');
        break;
      case 27:
        style.mods.delete('reverse');
        break;
      case 28:
        style.mods.delete('hidden');
        break;
      case 29:
        style.mods.delete('crossed-out');
        break;
      case 38: {
        const [color, consumed] = readExtendedColor(codes, index + 1);
        if (color !== null) style.fg = color;
        index += consumed;
        break;
      }
      case 48: {
        const [color, consumed] = readExtendedColor(codes, index + 1);
        if (color !== null) style.bg = color;
        index += consumed;
        break;
      }
      case 39:
        style.fg = 'default';
        break;
      case 49:
        style.bg = 'default';
        break;
      default:
        if (code >= 30 && code <= 37) style.fg = `ansi:${code - 30}`;
        else if (code >= 90 && code <= 97) style.fg = `ansi:${code - 90 + 8}`;
        else if (code >= 40 && code <= 47) style.bg = `ansi:${code - 40}`;
        else if (code >= 100 && code <= 107) style.bg = `ansi:${code - 100 + 8}`;
        break;
    }
  }
}

function cellStyle(cell: ScreenCell): string {
  const parts: string[] = [...cell.mods];
  if (cell.fg !== 'default') parts.push(`fg=${cell.fg}`);
  if (cell.bg !== 'default') parts.push(`bg=${cell.bg}`);
  return parts.join(' ');
}

function isDefaultCell(cell: ScreenCell): boolean {
  return cell.mods.length === 0 && cell.fg === 'default' && cell.bg === 'default';
}

/**
 * Parse the output of `capture-pane -e` into a cell grid. SGR state is reset at
 * every line start (tmux emits self-contained lines); unsupported escapes are
 * skipped without throwing.
 */
export function parseSgrScreen(raw: string, width: number, height: number): Screen {
  const cells: ScreenCell[] = [];
  for (let index = 0; index < width * height; index++) {
    cells.push({ char: ' ', fg: 'default', bg: 'default', mods: [] });
  }

  const style = defaultStyle();
  let x = 0;
  let y = 0;

  const writeGrapheme = (grapheme: string, graphemeWidth: number): void => {
    if (graphemeWidth === 0) {
      let prev = x - 1;
      while (prev >= 0 && y >= 0 && y < height && cells[y * width + prev].char === '') prev--;
      if (prev >= 0 && y >= 0 && y < height) cells[y * width + prev].char += grapheme;
      return;
    }

    if (x >= width) {
      x = 0;
      y += 1;
    }
    if (y < 0 || y >= height) return;

    const index = y * width + x;
    cells[index] = { char: grapheme, fg: style.fg, bg: style.bg, mods: modsList(style.mods) };
    if (graphemeWidth === 2 && x + 1 < width) {
      cells[index + 1] = { char: '', fg: style.fg, bg: style.bg, mods: modsList(style.mods) };
    }
    x += graphemeWidth;
  };

  const flush = (run: string): void => {
    if (run === '') return;
    for (const grapheme of splitGraphemes(run)) {
      writeGrapheme(grapheme, unicodeWidth(grapheme));
    }
  };

  let run = '';
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];

    if (char === '\x1b') {
      flush(run);
      run = '';
      index = consumeEscape(raw, index, style);
      continue;
    }

    if (char === '\n') {
      flush(run);
      run = '';
      y += 1;
      x = 0;
      resetStyle(style);
      index += 1;
      continue;
    }

    if (char === '\r') {
      flush(run);
      run = '';
      x = 0;
      index += 1;
      continue;
    }

    if (char === '\t') {
      flush(run);
      run = '';
      x = (Math.floor(x / 8) + 1) * 8;
      index += 1;
      continue;
    }

    if (char === '\b') {
      flush(run);
      run = '';
      x = Math.max(0, x - 1);
      index += 1;
      continue;
    }

    run += char;
    index += 1;
  }
  flush(run);

  const screen: Screen = { width, height, cells, rows: [] };
  screen.rows = snapshotText(screen);
  return screen;
}

function consumeEscape(raw: string, start: number, style: StyleState): number {
  const next = raw[start + 1];

  if (next === '[') {
    let index = start + 2;
    let params = '';
    while (index < raw.length && /[0-9;?]/.test(raw[index])) {
      params += raw[index];
      index++;
    }
    while (index < raw.length && raw[index] >= '\x20' && raw[index] <= '\x2f') {
      index++;
    }
    const final = raw[index];
    if (final === 'm') applySgr(parseParams(params), style);
    return final === undefined ? index : index + 1;
  }

  if (next === ']') {
    let index = start + 2;
    while (index < raw.length) {
      if (raw[index] === '\x07') return index + 1;
      if (raw[index] === '\x1b' && raw[index + 1] === '\\') return index + 2;
      index++;
    }
    return index;
  }

  return Math.min(raw.length, start + 2);
}

function snapshotRow(screen: Screen, row: number): string {
  let line = '';
  for (let col = 0; col < screen.width; col++) {
    line += screen.cells[row * screen.width + col].char;
  }
  return line.replace(/ +$/, '');
}

/** Rows of the screen with trailing blank columns removed. */
export function snapshotText(screen: Screen): string[] {
  const rows: string[] = [];
  for (let row = 0; row < screen.height; row++) rows.push(snapshotRow(screen, row));
  return rows;
}

/** Coalesced non-default attribute runs for one row. */
export function attributeRuns(screen: Screen, row: number): AttrRun[] {
  const runs: AttrRun[] = [];
  let current: AttrRun | null = null;

  for (let col = 0; col < screen.width; col++) {
    const cell = screen.cells[row * screen.width + col];
    if (isDefaultCell(cell)) {
      current = null;
      continue;
    }
    const style = cellStyle(cell);
    if (current && current.style === style && current.to === col) {
      current.to = col + 1;
    } else {
      current = { from: col, to: col + 1, style };
      runs.push(current);
    }
  }
  return runs;
}

function sameRuns(a: AttrRun[], b: AttrRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index].from !== b[index].from) return false;
    if (a[index].to !== b[index].to) return false;
    if (a[index].style !== b[index].style) return false;
  }
  return true;
}

/**
 * Rows whose trimmed text or attribute runs differ. An undefined `previous`
 * yields every non-empty row of `next`.
 */
export function diffScreens(previous: Screen | undefined, next: Screen): ScreenDiff[] {
  const out: ScreenDiff[] = [];

  for (let row = 0; row < next.height; row++) {
    const text = snapshotRow(next, row);
    const attrs = attributeRuns(next, row);

    if (!previous) {
      if (text !== '' || attrs.length > 0) out.push({ row, text, attrs });
      continue;
    }

    const oldText = row < previous.height ? snapshotRow(previous, row) : '';
    const oldAttrs = row < previous.height ? attributeRuns(previous, row) : [];
    if (oldText !== text || !sameRuns(oldAttrs, attrs)) {
      out.push({ row, text, attrs });
    }
  }

  return out;
}
