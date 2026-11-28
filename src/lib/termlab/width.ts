// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/** Grapheme splitting via Intl.Segmenter. */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export type WidthModel = 'unicode' | 'wcwidth';

const COMBINING_MARK = /^[\p{Mn}\p{Me}]$/u;
const FORMAT_CHAR = /^\p{Cf}$/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

const ZWJ = 0x200d;
const VS16 = 0xfe0f;

/** East Asian Wide/Fullwidth blocks (non-CJK model). */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1b000, 0x1b001],
  [0x20000, 0x3fffd],
];

/** Codepoints that render as emoji by default (wide, two cells). */
const INHERENT_EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f000, 0x1f0ff],
  [0x1f300, 0x1faff],
];

// Compact approximation of unicode-width's VS16 emoji promotion: covers the
// 0x2600–0x27BF symbol blocks plus emoji-presentation ranges, not the full
// Unicode data table.
const VS16_EMOJI_TEXT_RANGES: ReadonlyArray<readonly [number, number]> = [[0x2600, 0x27bf]];

const REGIONAL_INDICATOR = [0x1f1e6, 0x1f1ff] as const;

interface CodePointInfo {
  str: string;
  code: number;
}

function codePointInfos(grapheme: string): CodePointInfo[] {
  const infos: CodePointInfo[] = [];
  for (const str of grapheme) {
    const code = str.codePointAt(0);
    if (code !== undefined) infos.push({ str, code });
  }
  return infos;
}

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => code >= start && code <= end);
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isZeroWidth(info: CodePointInfo): boolean {
  const { code, str } = info;
  if (code === ZWJ) return true;
  if (code >= 0xfe00 && code <= 0xfe0f) return true;
  if (code >= 0xe0100 && code <= 0xe01ef) return true;
  if (COMBINING_MARK.test(str)) return true;
  if (FORMAT_CHAR.test(str)) return true;
  return false;
}

function isWide(code: number): boolean {
  return inRanges(code, WIDE_RANGES);
}

function countRegionalIndicators(infos: CodePointInfo[]): number {
  return infos.filter(({ code }) => code >= REGIONAL_INDICATOR[0] && code <= REGIONAL_INDICATOR[1])
    .length;
}

/** Emoji clusters that both models collapse to a single two-cell glyph. */
function isEmojiCluster(infos: CodePointInfo[]): boolean {
  const hasZwj = infos.some(({ code }) => code === ZWJ);
  const hasPictographic = infos.some(({ str }) => EXTENDED_PICTOGRAPHIC.test(str));
  const hasInherent = infos.some(({ code }) => inRanges(code, INHERENT_EMOJI_RANGES));
  const hasRegionalPair = countRegionalIndicators(infos) >= 2;

  return (hasZwj && hasPictographic) || hasInherent || hasRegionalPair;
}

/** VS16 promotes a text-presentation emoji to emoji presentation (unicode-width only). */
function hasVs16Emoji(infos: CodePointInfo[]): boolean {
  if (!infos.some(({ code }) => code === VS16)) return false;
  return infos.some(
    ({ str, code }) => EXTENDED_PICTOGRAPHIC.test(str) || inRanges(code, VS16_EMOJI_TEXT_RANGES)
  );
}

export function splitGraphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

/** Model of Rust's unicode-width (non-CJK): emoji presentation is two cells. */
export function unicodeWidth(grapheme: string): number {
  if (grapheme === '') return 0;
  const infos = codePointInfos(grapheme);

  if (isEmojiCluster(infos) || hasVs16Emoji(infos)) return 2;

  let width = 0;
  for (const info of infos) {
    if (isControl(info.code)) continue;
    if (isZeroWidth(info)) continue;
    width += isWide(info.code) ? 2 : 1;
  }
  return width;
}

/**
 * Classic wcwidth model: no emoji promotion through VS16 (`❤️` stays 1), emoji
 * clusters that are inherently wide (including ZWJ sequences) are two cells.
 */
export function wcwidthWidth(grapheme: string): number {
  if (grapheme === '') return 0;
  const infos = codePointInfos(grapheme);

  if (infos.length === 1 && isControl(infos[0].code)) return -1;

  if (isEmojiCluster(infos)) return 2;

  let width = 0;
  for (const info of infos) {
    if (isControl(info.code)) continue;
    if (isZeroWidth(info)) continue;
    width += isWide(info.code) ? 2 : 1;
  }
  return width;
}

export function stringWidth(text: string, model: WidthModel): number {
  let total = 0;
  for (const grapheme of splitGraphemes(text)) {
    const width = model === 'unicode' ? unicodeWidth(grapheme) : wcwidthWidth(grapheme);
    total += Math.max(0, width);
  }
  return total;
}

function codePointLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

export interface WidthGrapheme {
  grapheme: string;
  codepoints: string[];
  unicode: number;
  wcwidth: number;
  differs: boolean;
}

export interface WidthReport {
  graphemes: WidthGrapheme[];
  total: { unicode: number; wcwidth: number };
}

export function widthReport(text: string): WidthReport {
  const graphemes: WidthGrapheme[] = splitGraphemes(text).map((grapheme) => {
    const unicode = unicodeWidth(grapheme);
    const wcwidth = wcwidthWidth(grapheme);
    return {
      grapheme,
      codepoints: codePointInfos(grapheme).map(({ code }) => codePointLabel(code)),
      unicode,
      wcwidth,
      differs: unicode !== wcwidth,
    };
  });

  return {
    graphemes,
    total: {
      unicode: stringWidth(text, 'unicode'),
      wcwidth: stringWidth(text, 'wcwidth'),
    },
  };
}
