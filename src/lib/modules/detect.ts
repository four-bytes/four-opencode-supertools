// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type ModuleId =
  'core' | 'search' | 'lsp' | 'php' | 'go' | 'rust' | 'symfony' | 'doctrine' | 'shopware';

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
}

interface ComposerJson {
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
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

function readComposer(root: string): ComposerJson | null {
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

function hasPackage(composer: ComposerJson, name: string): boolean {
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

  const hasDependency = (name: string): boolean =>
    composers.some(({ composer }) => (composer ? hasPackage(composer, name) : false));

  let symfony = hasDependency('symfony/framework-bundle');
  const doctrine = hasDependency('doctrine/orm');
  const shopware = hasDependency('shopware/core');

  // A shopware project is always a symfony project, and both are PHP projects.
  if (shopware) symfony = true;

  return {
    php: php || shopware || symfony || doctrine,
    go,
    rust,
    symfony,
    doctrine,
    shopware,
  };
}

export function detectModules(ctx: DetectionContext): ModuleId[] {
  const markers = detectMarkers(ctx);
  const order: (keyof ProjectMarkers)[] = ['php', 'go', 'rust', 'symfony', 'doctrine', 'shopware'];
  return order.filter((id) => markers[id]);
}
