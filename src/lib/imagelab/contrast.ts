// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { contrastRatio, parseColour } from './colour.ts';
import { roundTo } from './image.ts';

export interface ContrastPair {
  label?: string;
  foreground: string;
  background: string;
}

export interface ContrastEntry {
  label?: string;
  foreground: string;
  background: string;
  ratio: number;
  aa: boolean;
  aaa: boolean;
  largeTextAa: boolean;
  largeTextAaa: boolean;
}

export function contrastEntry(pair: ContrastPair): ContrastEntry {
  const foreground = parseColour(pair.foreground);
  const background = parseColour(pair.background);
  const ratio = contrastRatio(foreground, background);
  return {
    label: pair.label,
    foreground: pair.foreground,
    background: pair.background,
    ratio: roundTo(ratio, 2),
    aa: ratio >= 4.5,
    aaa: ratio >= 7,
    largeTextAa: ratio >= 3,
    largeTextAaa: ratio >= 4.5,
  };
}

const FOREGROUND_KEYS = new Set([
  'fg',
  'foreground',
  'text',
  'textcolor',
  'textcolour',
  'colour',
  'color',
  'pen',
  'ink',
  'primary',
]);

const BACKGROUND_KEYS = new Set([
  'bg',
  'background',
  'back',
  'paper',
  'surface',
  'backgroundcolor',
  'backgroundcolour',
]);

const MAX_PAIRS = 200;
const MAX_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function collectSkinPairs(json: unknown, defaultBackground: string): ContrastPair[] {
  const pairs: ContrastPair[] = [];

  const walk = (node: unknown, path: string, depth: number): void => {
    if (pairs.length >= MAX_PAIRS || depth > MAX_DEPTH) {
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length && pairs.length < MAX_PAIRS; index++) {
        walk(node[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    const object = node as Record<string, unknown>;
    const keys = Object.keys(object);

    let background: string | undefined;
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'string' && BACKGROUND_KEYS.has(normalizeKey(key))) {
        try {
          parseColour(value);
          background = value;
          break;
        } catch {
          // ignore unparseable background values
        }
      }
    }

    for (const key of keys) {
      if (pairs.length >= MAX_PAIRS) {
        return;
      }
      const value = object[key];
      if (typeof value !== 'string' || !FOREGROUND_KEYS.has(normalizeKey(key))) {
        continue;
      }
      try {
        parseColour(value);
      } catch {
        continue;
      }
      pairs.push({
        label: path ? `${path}.${key}` : key,
        foreground: value,
        background: background ?? defaultBackground,
      });
    }

    for (const key of keys) {
      if (pairs.length >= MAX_PAIRS) {
        return;
      }
      const value = object[key];
      if (value && typeof value === 'object') {
        walk(value, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  walk(json, '', 0);
  return pairs;
}
