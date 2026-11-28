// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { stringWidth } from './width';

export type TermOp =
  | { kind: 'TEXT'; text: string; x: number; y: number }
  | { kind: 'MOVE'; x: number; y: number }
  | { kind: 'SGR'; params: number[] }
  | { kind: 'OSC8'; id: string | null; url: string | null }
  | { kind: 'OSC'; command: string; payload: string }
  | { kind: 'CLEAR'; params: number[] }
  | { kind: 'ERASE_LINE'; params: number[] }
  | { kind: 'ERASE_CHARS'; params: number[] }
  | { kind: 'CURSOR'; visible: boolean }
  | { kind: 'CR' }
  | { kind: 'LF' }
  | { kind: 'BS' }
  | { kind: 'TAB' }
  | { kind: 'CSI'; params: number[]; final: string }
  | { kind: 'ESC'; bytes: string }
  | { kind: 'RAW'; hex: string };

export interface DecodeOpsOptions {
  width?: number;
  height?: number;
}

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

function hexOf(text: string): string {
  return Array.from(utf8Encoder.encode(text))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isParamChar(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

function isIntermediateChar(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isFinalChar(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isControl(code: number): boolean {
  return (code < 0x20 || (code >= 0x7f && code <= 0x9f)) && code !== 0x1b;
}

/**
 * Decode a raw byte stream into readable terminal operations. Never throws.
 *
 * Invalid UTF-8 in the raw frame is replaced with U+FFFD before tokenizing, so
 * a RAW op's hex cannot reproduce those original invalid octets.
 */
export function decodeOps(bytes: Uint8Array, opts: DecodeOpsOptions = {}): TermOp[] {
  // width/height are reserved for future wrap-aware cursor modelling; the raw
  // stream positions the cursor explicitly, so nothing wraps today.
  void opts;

  const chars = Array.from(utf8Decoder.decode(bytes));
  const ops: TermOp[] = [];

  let x = 0;
  let y = 0;

  let run = '';
  let runX = 0;
  let runY = 0;

  const flushRun = (): void => {
    if (run === '') return;
    ops.push({ kind: 'TEXT', text: run, x: runX, y: runY });
    x += stringWidth(run, 'unicode');
    run = '';
  };

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const code = ch.codePointAt(0) ?? 0;

    if (code === 0x1b) {
      flushRun();
      const next = chars[i + 1];

      if (next === undefined) {
        ops.push({ kind: 'RAW', hex: '1b' });
        i += 1;
        continue;
      }

      if (next === '[') {
        let j = i + 2;
        let paramStr = '';
        while (j < chars.length && isParamChar(chars[j].codePointAt(0) ?? 0)) {
          paramStr += chars[j];
          j++;
        }
        while (j < chars.length && isIntermediateChar(chars[j].codePointAt(0) ?? 0)) {
          j++;
        }
        if (j >= chars.length || !isFinalChar(chars[j].codePointAt(0) ?? 0)) {
          ops.push({ kind: 'RAW', hex: hexOf(chars.slice(i, j + 1).join('')) });
          i = j + 1;
          continue;
        }

        const final = chars[j];
        i = j + 1;

        const isPrivate = paramStr.startsWith('?');
        const cleaned = isPrivate ? paramStr.slice(1) : paramStr;
        const rawParams = cleaned === '' ? [] : cleaned.split(';');
        const numbers = rawParams.map((part) => {
          const value = Number.parseInt(part, 10);
          return Number.isFinite(value) ? value : 0;
        });

        if (final === 'H' || final === 'f') {
          const row = rawParams.length > 0 ? Number.parseInt(rawParams[0], 10) : Number.NaN;
          const col = rawParams.length > 1 ? Number.parseInt(rawParams[1], 10) : Number.NaN;
          y = (Number.isFinite(row) ? row : 1) - 1;
          x = (Number.isFinite(col) ? col : 1) - 1;
          ops.push({ kind: 'MOVE', x, y });
          continue;
        }

        if (final === 'm') {
          const params = rawParams.length > 0 ? numbers : [0];
          ops.push({ kind: 'SGR', params });
          continue;
        }

        if (final === 'J' || final === 'K' || final === 'X') {
          const params = numbers.length > 0 ? numbers : [0];
          if (final === 'J') ops.push({ kind: 'CLEAR', params });
          else if (final === 'K') ops.push({ kind: 'ERASE_LINE', params });
          else ops.push({ kind: 'ERASE_CHARS', params });
          continue;
        }

        if (isPrivate && cleaned === '25' && (final === 'h' || final === 'l')) {
          ops.push({ kind: 'CURSOR', visible: final === 'h' });
          continue;
        }

        ops.push({ kind: 'CSI', params: numbers, final });
        continue;
      }

      if (next === ']') {
        let j = i + 2;
        let content = '';
        let terminated = false;
        while (j < chars.length) {
          const current = chars[j];
          if (current === '\x07') {
            j += 1;
            terminated = true;
            break;
          }
          if (current === '\x1b' && chars[j + 1] === '\\') {
            j += 2;
            terminated = true;
            break;
          }
          content += current;
          j += 1;
        }
        if (!terminated) {
          ops.push({ kind: 'RAW', hex: hexOf(chars.slice(i).join('')) });
          i = chars.length;
          continue;
        }
        i = j;

        const semi = content.indexOf(';');
        const command = semi === -1 ? content : content.slice(0, semi);
        const payload = semi === -1 ? '' : content.slice(semi + 1);

        if (command === '8') {
          const semi2 = payload.indexOf(';');
          const paramsPart = semi2 === -1 ? payload : payload.slice(0, semi2);
          const urlPart = semi2 === -1 ? '' : payload.slice(semi2 + 1);
          const idMatch = /(?:^|;)id=([^;]*)/.exec(paramsPart);
          ops.push({
            kind: 'OSC8',
            id: idMatch ? idMatch[1] : null,
            url: urlPart === '' ? null : urlPart,
          });
        } else {
          ops.push({ kind: 'OSC', command, payload });
        }
        continue;
      }

      ops.push({ kind: 'ESC', bytes: hexOf(ch + next) });
      i += 2;
      continue;
    }

    if (code === 0x0d) {
      flushRun();
      ops.push({ kind: 'CR' });
      x = 0;
      i += 1;
      continue;
    }

    if (code === 0x0a) {
      flushRun();
      ops.push({ kind: 'LF' });
      y += 1;
      i += 1;
      continue;
    }

    if (code === 0x08) {
      flushRun();
      ops.push({ kind: 'BS' });
      x = Math.max(0, x - 1);
      i += 1;
      continue;
    }

    if (code === 0x09) {
      flushRun();
      ops.push({ kind: 'TAB' });
      x = (Math.floor(x / 8) + 1) * 8;
      i += 1;
      continue;
    }

    if (isControl(code)) {
      flushRun();
      ops.push({ kind: 'RAW', hex: hexOf(ch) });
      i += 1;
      continue;
    }

    if (run === '') {
      runX = x;
      runY = y;
    }
    run += ch;
    i += 1;
  }

  flushRun();
  return ops;
}

/** Compact one-line rendering of an op for token-efficient output. */
export function formatOp(op: TermOp): string {
  switch (op.kind) {
    case 'TEXT':
      return `TEXT ${JSON.stringify(op.text)} at ${op.x},${op.y}`;
    case 'MOVE':
      return `MOVE ${op.x},${op.y}`;
    case 'SGR':
      return `SGR ${op.params.join(';')}`;
    case 'OSC8':
      return `OSC8 id=${op.id ?? '-'} url=${op.url ?? '-'}`;
    case 'OSC':
      return op.payload === '' ? `OSC ${op.command}` : `OSC ${op.command} ${op.payload}`;
    case 'CLEAR':
      return `CLEAR ${op.params.join(';')}`;
    case 'ERASE_LINE':
      return `ERASE_LINE ${op.params.join(';')}`;
    case 'ERASE_CHARS':
      return `ERASE_CHARS ${op.params.join(';')}`;
    case 'CURSOR':
      return `CURSOR ${op.visible ? 'show' : 'hide'}`;
    case 'CR':
      return 'CR';
    case 'LF':
      return 'LF';
    case 'BS':
      return 'BS';
    case 'TAB':
      return 'TAB';
    case 'CSI':
      return op.params.length > 0 ? `CSI ${op.params.join(';')} ${op.final}` : `CSI ${op.final}`;
    case 'ESC':
      return `ESC ${op.bytes}`;
    case 'RAW':
      return `RAW ${op.hex}`;
  }
}
