// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { composerHasPackage, readComposer } from '../modules/detect';

export type Framework = 'symfony' | 'shopware' | 'none';

export interface FrameworkInfo {
  framework: Framework;
  root: string | null; // dir holding composer.json
  composerPath: string | null;
  consolePath: string | null; // <root>/bin/console when it exists
}

const NONE: FrameworkInfo = {
  framework: 'none',
  root: null,
  composerPath: null,
  consolePath: null,
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function startDir(startPath: string): string {
  const resolved = resolve(startPath);
  try {
    if (statSync(resolved).isFile()) return dirname(resolved);
  } catch {
    // Does not exist: treat it as a file-like path and walk up from its parent.
  }
  if (isDirectory(resolved)) return resolved;
  return dirname(resolved);
}

export function detectFramework(startPath: string): FrameworkInfo {
  let dir = startDir(startPath);

  for (;;) {
    const composerPath = join(dir, 'composer.json');
    if (existsSync(composerPath)) {
      const composer = readComposer(dir);
      const consoleCandidate = join(dir, 'bin', 'console');
      const consolePath = existsSync(consoleCandidate) ? consoleCandidate : null;

      let framework: Framework = 'none';
      if (composer) {
        if (composerHasPackage(composer, 'shopware/core')) {
          framework = 'shopware';
        } else if (composerHasPackage(composer, 'symfony/framework-bundle')) {
          framework = 'symfony';
        }
      }

      return { framework, root: dir, composerPath, consolePath };
    }

    const parent = dirname(dir);
    if (parent === dir) return { ...NONE };
    dir = parent;
  }
}
