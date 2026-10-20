// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Nearest directory above the file that holds a go.mod; Go tools run from there.
export function findGoModuleRoot(filePath: string): string | null {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (existsSync(join(dir, 'go.mod'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Package argument for go tools: the file's directory relative to the module root, always "./…".
export function goPackageTarget(moduleRoot: string, filePath: string): string {
  const pkgDir = relative(moduleRoot, dirname(resolve(filePath)));
  if (pkgDir === '') return '.';
  if (pkgDir === '..' || pkgDir.startsWith('../')) return pkgDir;
  return `./${pkgDir}`;
}
