// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hasGoldenSnapshots } from '../imagelab/detect';

const MAX_TEXT_FILE_BYTES = 1_048_576;

export type ModuleId =
  | 'core'
  | 'search'
  | 'lsp'
  | 'typescript'
  | 'php'
  | 'go'
  | 'rust'
  | 'symfony'
  | 'doctrine'
  | 'shopware'
  | 'termlab'
  | 'imagelab';

export interface DetectionContext {
  directory?: string;
  worktree?: string;
}

export interface ProjectMarkers {
  php: boolean;
  go: boolean;
  rust: boolean;
  symfony: boolean;
  doctrine: boolean;
  shopware: boolean;
  typescript: boolean;
  termlab: boolean;
  imagelab: boolean;
}

export interface ComposerJson {
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const RUST_TUI_LIBS = ['ratatui', 'crossterm', 'termion', 'cursive', 'notcurses', 'ratatui-core'];
const TS_TUI_LIBS = ['ink', 'blessed', 'neo-blessed', 'terminal-kit'];
const GO_TUI_LIBS = [
  'github.com/charmbracelet/bubbletea',
  'github.com/gdamore/tcell',
  'github.com/rivo/tview',
  'github.com/nsf/termbox-go',
  'github.com/jroimartin/gocui',
];

function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    // Oversized files are treated as absent (not a TUI marker) and never read.
    if (statSync(path).size > MAX_TEXT_FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function hasTsMarker(root: string): boolean {
  return (
    existsSync(join(root, 'tsconfig.json')) ||
    existsSync(join(root, 'deno.json')) ||
    existsSync(join(root, 'deno.jsonc')) ||
    existsSync(join(root, 'package.json'))
  );
}

/** Matches a dependency token without matching a longer identifier containing it. */
function wordishMatch(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_-])${escaped}(?![a-z0-9_-])`, 'i').test(text);
}

function packageHasTui(pkg: PackageJson, rawText: string): boolean {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of TS_TUI_LIBS) {
    if (name in deps) return true;
  }
  for (const key of Object.keys(deps)) {
    if (key.startsWith('@opentui/')) return true;
  }
  return rawText.includes('"@opentui/');
}

function rootHasTui(root: string): boolean {
  const cargo = readTextFile(join(root, 'Cargo.toml'));
  if (cargo && RUST_TUI_LIBS.some((name) => wordishMatch(cargo, name))) return true;

  const goMod = readTextFile(join(root, 'go.mod'));
  if (goMod && GO_TUI_LIBS.some((name) => wordishMatch(goMod, name))) return true;

  const pkgText = readTextFile(join(root, 'package.json'));
  if (pkgText) {
    let pkg: PackageJson | null = null;
    try {
      const parsed: unknown = JSON.parse(pkgText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        pkg = parsed as PackageJson;
      }
    } catch {
      pkg = null;
    }
    if (pkg && packageHasTui(pkg, pkgText)) return true;
    if (pkgText.includes('"@opentui/')) return true;
  }

  const hasExamples = existsSync(join(root, 'examples'));
  if (
    hasExamples &&
    (existsSync(join(root, 'Cargo.toml')) || existsSync(join(root, 'go.mod')) || hasTsMarker(root))
  ) {
    return true;
  }

  return false;
}

function projectRoots(ctx: DetectionContext): string[] {
  const roots: string[] = [];
  for (const candidate of [ctx.directory, ctx.worktree]) {
    if (!candidate) continue;
    const resolved = resolve(candidate);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

export function readComposer(root: string): ComposerJson | null {
  const path = join(root, 'composer.json');
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ComposerJson;
  } catch {
    return null;
  }
}

export function composerHasPackage(composer: ComposerJson, name: string): boolean {
  const require = composer.require;
  const requireDev = composer['require-dev'];
  if (require && typeof require === 'object' && name in require) return true;
  if (requireDev && typeof requireDev === 'object' && name in requireDev) return true;
  return false;
}

export function detectMarkers(ctx: DetectionContext): ProjectMarkers {
  const roots = projectRoots(ctx);
  const composers = roots.map((root) => ({ root, composer: readComposer(root) }));

  const php = composers.some(({ root }) => existsSync(join(root, 'composer.json')));
  const go = roots.some((root) => existsSync(join(root, 'go.mod')));
  const rust = roots.some((root) => existsSync(join(root, 'Cargo.toml')));
  const typescript = roots.some(
    (root) =>
      existsSync(join(root, 'tsconfig.json')) ||
      existsSync(join(root, 'deno.json')) ||
      existsSync(join(root, 'deno.jsonc')) ||
      existsSync(join(root, 'package.json'))
  );

  const hasDependency = (name: string): boolean =>
    composers.some(({ composer }) => (composer ? composerHasPackage(composer, name) : false));

  let symfony = hasDependency('symfony/framework-bundle');
  const doctrine = hasDependency('doctrine/orm');
  const shopware = hasDependency('shopware/core');

  // A shopware project is always a symfony project, and both are PHP projects.
  if (shopware) symfony = true;

  const termlab = roots.some((root) => rootHasTui(root));
  const imagelab = roots.some((root) => hasGoldenSnapshots(root));

  return {
    php: php || shopware || symfony || doctrine,
    go,
    rust,
    typescript,
    symfony,
    doctrine,
    shopware,
    termlab,
    imagelab,
  };
}

export function detectModules(ctx: DetectionContext): ModuleId[] {
  const markers = detectMarkers(ctx);
  const order: (keyof ProjectMarkers)[] = [
    'typescript',
    'php',
    'go',
    'rust',
    'symfony',
    'doctrine',
    'shopware',
    'termlab',
    'imagelab',
  ];
  return order.filter((id) => markers[id]);
}
