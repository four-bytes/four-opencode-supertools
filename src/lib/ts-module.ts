// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Nearest directory above the file that holds a tsconfig.json; tsc runs from there.
export function findTsconfigRoot(filePath: string): string | null {
  const abs = resolve(filePath);
  let dir = isDirectory(abs) ? abs : dirname(abs);
  for (;;) {
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Nearest directory above the file that holds a deno.json or deno.jsonc; deno runs from there.
export function findDenoRoot(filePath: string): string | null {
  const abs = resolve(filePath);
  let dir = isDirectory(abs) ? abs : dirname(abs);
  for (;;) {
    if (existsSync(join(dir, 'deno.json')) || existsSync(join(dir, 'deno.jsonc'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
