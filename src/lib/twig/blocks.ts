// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Block override chains across Symfony Twig templates. Definitions are ordered
 * base → derived using the `extends` graph, with `templates/bundles/<Bundle>/`
 * overrides after their bundle base. The scan is bounded and never throws.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isKnownTwigTag, scanTwig } from './scanner';
import { buildTemplateChain, resolveTemplate, type TwigLoaders } from './resolver';

export interface BlockDefinition {
  template: string;
  path: string;
  line: number;
  parentCall: boolean;
}

export interface BlockChainUnknownTag {
  tag: string;
  path: string;
  line: number;
}

export interface BlockChainResult {
  block: string;
  chain: BlockDefinition[];
  count: number;
  total: number;
  truncated: boolean;
  unknownTags: BlockChainUnknownTag[];
}

export interface BlockChainOptions {
  limit?: number;
  template?: string;
  tagMap?: Readonly<Record<string, string>>;
  knownTagPrefixes?: readonly string[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_FILES = 2000;
const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git']);

interface DefinitionEntry {
  definition: BlockDefinition;
  index: number;
}

interface WalkResult {
  paths: string[];
  truncated: boolean;
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function toSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function walkTwigFiles(base: string, out: string[], seen: Set<string>, state: WalkResult): void {
  if (state.truncated) return;

  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.truncated) return;
    const full = join(base, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTwigFiles(full, out, seen, state);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.twig')) continue;

    const resolved = resolve(full);
    if (seen.has(resolved)) continue;
    if (out.length >= MAX_FILES) {
      state.truncated = true;
      return;
    }
    seen.add(resolved);
    out.push(resolved);
  }
}

function collectTwigFiles(root: string, loaders: TwigLoaders): WalkResult {
  const state: WalkResult = { paths: [], truncated: false };
  const seen = new Set<string>();
  const bases = [join(root, 'templates'), ...loaders.paths];

  for (const base of bases) {
    if (state.truncated) break;
    if (existsSync(base)) walkTwigFiles(base, state.paths, seen, state);
  }

  return state;
}

function templateName(path: string, root: string, loaders: TwigLoaders): string {
  const templatesRoot = join(root, 'templates');
  if (path.startsWith(templatesRoot + '/') || path === templatesRoot) {
    return toSlashes(relative(templatesRoot, path));
  }
  for (const base of loaders.paths) {
    if (path.startsWith(base + '/') || path === base) {
      return toSlashes(relative(base, path));
    }
  }
  return toSlashes(relative(root, path));
}

function overrideInfo(path: string, root: string): { rest: string } | null {
  const prefix = toSlashes(join(root, 'templates', 'bundles')) + '/';
  const normalized = toSlashes(path);
  if (!normalized.startsWith(prefix)) return null;
  const segments = normalized.slice(prefix.length).split('/');
  if (segments.length < 2) return null;
  return { rest: segments.slice(1).join('/') };
}

function compareBundleOverride(aPath: string, bPath: string, root: string): number {
  const a = overrideInfo(aPath, root);
  const b = overrideInfo(bPath, root);
  if (a && !b && toSlashes(bPath).endsWith('/' + a.rest)) return 1;
  if (b && !a && toSlashes(aPath).endsWith('/' + b.rest)) return -1;
  return 0;
}

export function buildBlockChain(
  blockName: string,
  loaders: TwigLoaders,
  root: string,
  options: BlockChainOptions = {}
): BlockChainResult {
  const limit = normalizeLimit(options.limit);
  const scanned = new Map<string, string>();
  let truncated = false;

  try {
    if (options.template) {
      const chain = buildTemplateChain(options.template, loaders, root, {
        tagMap: options.tagMap,
        knownTagPrefixes: options.knownTagPrefixes,
      });
      if (chain.path) scanned.set(chain.path, chain.template);
      for (const entry of chain.extendsChain) {
        if (entry.path) scanned.set(entry.path, entry.name);
      }
    } else {
      const walk = collectTwigFiles(root, loaders);
      truncated = walk.truncated;
      for (const path of walk.paths) {
        scanned.set(path, templateName(path, root, loaders));
      }
    }
  } catch {
    // A broken project scan yields an empty chain, never an exception.
  }

  const definitions: DefinitionEntry[] = [];
  const unknownTags: BlockChainUnknownTag[] = [];
  const extendsEdge = new Map<string, string>();
  let index = 0;

  for (const [path, name] of scanned) {
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    let parsed;
    try {
      parsed = scanTwig(source, {
        tagMap: options.tagMap,
        knownTagPrefixes: options.knownTagPrefixes,
      });
    } catch {
      continue;
    }

    for (const block of parsed.blocks) {
      if (block.name !== blockName) continue;
      definitions.push({
        definition: {
          template: name,
          path,
          line: block.line,
          parentCall: block.parentCall,
        },
        index: index++,
      });
    }

    if (parsed.extends) {
      const resolved = resolveTemplate(parsed.extends.target, loaders, root);
      if (resolved.path && scanned.has(resolved.path)) extendsEdge.set(path, resolved.path);
    }

    for (const tag of parsed.tags) {
      if (isKnownTwigTag(tag.name, options.tagMap, options.knownTagPrefixes)) continue;
      unknownTags.push({ tag: tag.name, path, line: tag.line });
    }
  }

  const depthCache = new Map<string, number>();
  const depthOf = (path: string): number => {
    const cached = depthCache.get(path);
    if (cached !== undefined) return cached;
    let depth = 0;
    let current = path;
    const seen = new Set<string>();
    while (extendsEdge.has(current)) {
      const parent = extendsEdge.get(current) as string;
      if (seen.has(parent) || depth >= 50) break;
      seen.add(parent);
      depth++;
      current = parent;
    }
    depthCache.set(path, depth);
    return depth;
  };

  definitions.sort((a, b) => {
    const depthA = depthOf(a.definition.path);
    const depthB = depthOf(b.definition.path);
    if (depthA !== depthB) return depthA - depthB;
    const override = compareBundleOverride(a.definition.path, b.definition.path, root);
    if (override !== 0) return override;
    return a.index - b.index;
  });

  const total = definitions.length;
  const chain = definitions.slice(0, limit).map((entry) => entry.definition);

  return {
    block: blockName,
    chain,
    count: chain.length,
    total,
    truncated: truncated || total > chain.length,
    unknownTags,
  };
}
