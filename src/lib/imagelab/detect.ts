// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  'coverage',
  'tmp',
  'var',
]);

const SNAPSHOT_DIRECTORIES = new Set([
  'snapshot',
  'snapshots',
  '__snapshot__',
  '__snapshots__',
  'golden',
  'goldens',
]);

const GOLDEN_FILE = /\.(golden|snap|expected)\.png$/i;
const MAX_DIRECTORIES = 200;
const MAX_DEPTH = 3;

export function hasGoldenSnapshots(root: string): boolean {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let processed = 0;

  while (queue.length > 0 && processed < MAX_DIRECTORIES) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    processed++;
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const isSnapshotDirectory = SNAPSHOT_DIRECTORIES.has(basename(current.directory).toLowerCase());

    for (const entry of entries) {
      const name = entry.name;
      if (entry.isFile()) {
        if (GOLDEN_FILE.test(name)) {
          return true;
        }
        if (isSnapshotDirectory && name.toLowerCase().endsWith('.png')) {
          return true;
        }
        continue;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      if (current.depth >= MAX_DEPTH) {
        continue;
      }
      const lower = name.toLowerCase();
      if (lower.startsWith('.')) {
        continue;
      }
      if (SKIP_DIRECTORIES.has(lower)) {
        continue;
      }
      queue.push({ directory: join(current.directory, name), depth: current.depth + 1 });
    }
  }

  return false;
}
