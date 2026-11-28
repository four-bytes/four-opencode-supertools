// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { clamp, type Rgba } from './image.ts';

const NAMED_COLOURS: Record<string, Rgba> = {
  black: { r: 0, g: 0, b: 0, a: 255 },
  white: { r: 255, g: 255, b: 255, a: 255 },
  red: { r: 255, g: 0, b: 0, a: 255 },
  green: { r: 0, g: 128, b: 0, a: 255 },
  blue: { r: 0, g: 0, b: 255, a: 255 },
  yellow: { r: 255, g: 255, b: 0, a: 255 },
  cyan: { r: 0, g: 255, b: 255, a: 255 },
  magenta: { r: 255, g: 0, b: 255, a: 255 },
  gray: { r: 128, g: 128, b: 128, a: 255 },
  grey: { r: 128, g: 128, b: 128, a: 255 },
  silver: { r: 192, g: 192, b: 192, a: 255 },
  maroon: { r: 128, g: 0, b: 0, a: 255 },
  olive: { r: 128, g: 128, b: 0, a: 255 },
  lime: { r: 0, g: 255, b: 0, a: 255 },
  teal: { r: 0, g: 128, b: 128, a: 255 },
  navy: { r: 0, g: 0, b: 128, a: 255 },
  purple: { r: 128, g: 0, b: 128, a: 255 },
  orange: { r: 255, g: 165, b: 0, a: 255 },
};

function channel(value: number): number {
  return clamp(Math.round(value), 0, 255);
}

function alphaChannel(value: number): number {
  if (Number.isNaN(value)) {
    return 255;
  }
  return clamp(Math.round(value <= 1 ? value * 255 : value), 0, 255);
}

function parseHex(body: string, original: string): Rgba {
  if (!/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error(`invalid colour "${original}"`);
  }
  let r: number;
  let g: number;
  let b: number;
  let a = 255;
  if (body.length === 3 || body.length === 4) {
    r = parseInt(body[0] + body[0], 16);
    g = parseInt(body[1] + body[1], 16);
    b = parseInt(body[2] + body[2], 16);
    if (body.length === 4) {
      a = parseInt(body[3] + body[3], 16);
    }
  } else if (body.length === 6 || body.length === 8) {
    r = parseInt(body.slice(0, 2), 16);
    g = parseInt(body.slice(2, 4), 16);
    b = parseInt(body.slice(4, 6), 16);
    if (body.length === 8) {
      a = parseInt(body.slice(6, 8), 16);
    }
  } else {
    throw new Error(`invalid colour "${original}"`);
  }
  return { r, g, b, a };
}

function parseFunctional(input: string, original: string): Rgba | null {
  const match = /^(rgba?)\((.*)\)$/i.exec(input);
  if (!match) {
    return null;
  }
  const parts = match[2]
    .trim()
    .split(/[,\s/]+/)
    .filter((part) => part.length > 0);
  const isRgba = match[1].toLowerCase() === 'rgba';
  if (parts.length !== (isRgba ? 4 : 3)) {
    throw new Error(`invalid colour "${original}"`);
  }
  const values = parts.map((part) => {
    if (part.endsWith('%')) {
      return (parseFloat(part.slice(0, -1)) / 100) * 255;
    }
    return parseFloat(part);
  });
  if (values.some((value) => Number.isNaN(value))) {
    throw new Error(`invalid colour "${original}"`);
  }
  return {
    r: channel(values[0]),
    g: channel(values[1]),
    b: channel(values[2]),
    a: isRgba ? alphaChannel(values[3]) : 255,
  };
}

export function parseColour(input: string): Rgba {
  const value = input.trim();
  if (value.startsWith('#')) {
    return parseHex(value.slice(1), input);
  }
  const functional = parseFunctional(value, input);
  if (functional) {
    return functional;
  }
  const named = NAMED_COLOURS[value.toLowerCase()];
  if (named) {
    return { ...named };
  }
  throw new Error(`invalid colour "${input}"`);
}

function hexByte(value: number): string {
  return channel(value).toString(16).padStart(2, '0');
}

export function formatColour(c: Rgba, forceAlpha = false): string {
  const base = `#${hexByte(c.r)}${hexByte(c.g)}${hexByte(c.b)}`;
  if (forceAlpha || channel(c.a) < 255) {
    return `${base}${hexByte(c.a)}`;
  }
  return base;
}

export function composite(fg: Rgba, bg: Rgba): Rgba {
  const af = clamp(fg.a, 0, 255) / 255;
  const ab = clamp(bg.a, 0, 255) / 255;
  const ao = af + ab * (1 - af);
  if (ao <= 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const mix = (fc: number, bc: number) => channel((fc * af + bc * ab * (1 - af)) / ao);
  return {
    r: mix(fg.r, bg.r),
    g: mix(fg.g, bg.g),
    b: mix(fg.b, bg.b),
    a: channel(ao * 255),
  };
}

export function relativeLuminance(c: Rgba): number {
  const linear = (value: number) => {
    const s = clamp(value, 0, 255) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const effective = composite(fg, bg);
  const l1 = relativeLuminance(effective);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function quantizeKey(c: Rgba, bits = 5): number {
  const depth = clamp(Math.round(bits), 1, 8);
  const levels = (1 << depth) - 1;
  const q = (value: number) => Math.round((clamp(value, 0, 255) / 255) * levels);
  return (q(c.r) * levels + q(c.g)) * levels + q(c.b);
}
