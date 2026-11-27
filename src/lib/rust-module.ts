// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Nearest directory above the file that holds a Cargo.toml; cargo runs from there.
export function findCargoRoot(filePath: string): string | null {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (existsSync(join(dir, 'Cargo.toml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// `cargo test --test <name>` selector for integration tests under <root>/tests/, else no filter.
export function cargoTestArgs(cargoRoot: string, testFile: string): string[] {
  const testsDir = join(resolve(cargoRoot), 'tests');
  const absFile = resolve(testFile);
  if (dirname(absFile) === testsDir && absFile.endsWith('.rs')) {
    return ['--test', basename(absFile, '.rs')];
  }
  return [];
}
