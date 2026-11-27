// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Project-root resolution for language servers.
 * Roots come from markers or an explicit workspace strategy, never from the
 * first file's parent alone.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type RootStrategy = 'nearest' | 'cargo-workspace' | 'go-work';

export interface RootTarget {
  rootMarkers?: string[];
  rootStrategy?: RootStrategy;
}

export interface MarkerHit {
  root: string;
  marker: string;
  /** Number of directories between the file's directory and the marker (0 = same dir). */
  distance: number;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from the file and return the nearest directory containing one of the markers. */
export function nearestMarker(filePath: string, markers: string[]): MarkerHit | null {
  if (markers.length === 0) return null;
  let dir = dirname(resolve(filePath));
  let distance = 0;
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return { root: dir, marker, distance };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    distance++;
  }
}

function readCargoToml(dir: string): string | null {
  try {
    return readFileSync(join(dir, 'Cargo.toml'), 'utf8');
  } catch {
    return null;
  }
}

function declaresWorkspace(toml: string): boolean {
  return /^\s*\[workspace\]\s*$/m.test(toml);
}

/** `package.workspace = "…"` points at the workspace root directory. */
function packageWorkspacePath(toml: string): string | null {
  const match = toml.match(/^\s*workspace\s*=\s*["']([^"']+)["']\s*$/m);
  return match ? match[1] : null;
}

/** Nearest ancestor Cargo.toml (standalone crate or a workspace member). */
function nearestCargoDir(filePath: string): string | null {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (existsSync(join(dir, 'Cargo.toml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Cargo workspace root: the outermost ancestor Cargo.toml declaring `[workspace]`.
 * A member crate's own Cargo.toml is not the root; `package.workspace` wins when set.
 * Without any workspace ancestor the standalone crate (nearest Cargo.toml) is the root.
 */
export function resolveCargoWorkspaceRoot(filePath: string): string | null {
  const crateDir = nearestCargoDir(filePath);
  if (!crateDir) return null;

  const crateToml = readCargoToml(crateDir);
  if (crateToml) {
    const workspacePath = packageWorkspacePath(crateToml);
    if (workspacePath) {
      const candidate = resolve(crateDir, workspacePath);
      const target = isDirectory(candidate) ? candidate : dirname(candidate);
      if (existsSync(join(target, 'Cargo.toml'))) return target;
    }
  }

  let outermost: string | null = null;
  let dir = crateDir;
  for (;;) {
    const toml = readCargoToml(dir);
    if (toml && declaresWorkspace(toml)) outermost = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return outermost ?? crateDir;
}

/** `go.work` wins over any nested `go.mod`; otherwise the nearest `go.mod`. */
export function resolveGoRoot(filePath: string): string | null {
  const work = nearestMarker(filePath, ['go.work']);
  if (work) return work.root;
  const mod = nearestMarker(filePath, ['go.mod']);
  return mod?.root ?? null;
}

/** Canonicalise a directory so two spellings cannot create two pool entries. */
export function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Resolve the project root for a server using its markers or workspace strategy. */
export function resolveProjectRoot(filePath: string, target: RootTarget = {}): string {
  const strategy = target.rootStrategy ?? 'nearest';
  let root: string;

  if (strategy === 'cargo-workspace') {
    root = resolveCargoWorkspaceRoot(filePath) ?? dirname(resolve(filePath));
  } else if (strategy === 'go-work') {
    root = resolveGoRoot(filePath) ?? dirname(resolve(filePath));
  } else {
    root = nearestMarker(filePath, target.rootMarkers ?? [])?.root ?? dirname(resolve(filePath));
  }

  return canonicalRoot(root);
}

/** Nearest directory at or above the file that holds `.supertools.json`. */
export function findConfigRoot(filePath: string): string {
  const fallback = dirname(resolve(filePath));
  let dir = fallback;
  for (;;) {
    if (existsSync(join(dir, '.supertools.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}
