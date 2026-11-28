// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Twig loader paths and template resolution. Runtime data comes from
 * `debug:twig --format=json`; the static fallback reads
 * config/packages/twig.(yaml|yml) and is always marked incomplete. Nothing here
 * throws: a broken console, YAML or filesystem falls back to a partial result.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runConsoleJson, type ConsoleRunner } from '../framework/console';
import { scanTwig, TWIG_KNOWN_TAGS, type TwigScanResult } from './scanner';

export interface TwigLoaders {
  paths: string[];
  namespaces: Record<string, string>;
  source: 'runtime' | 'static';
  incomplete: boolean;
  reason?: string;
}

export interface LoaderOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
  timeoutMs?: number;
}

export type TemplateCandidateKind = 'bundle-override' | 'namespace' | 'bundle' | 'loader';

export interface TemplateCandidate {
  path: string;
  kind: TemplateCandidateKind;
  exists: boolean;
}

export interface TemplateResolution {
  name: string;
  path: string | null;
  candidates: TemplateCandidate[];
}

export interface TemplateChainEntry {
  name: string;
  path: string | null;
  line: number;
}

export interface TemplateChainBlock {
  name: string;
  template: string;
  path: string;
  line: number;
  parentCall: boolean;
}

export interface TemplateChainReference {
  target: string;
  template: string;
  path: string | null;
  line: number;
}

export interface TemplateChainUnknownTag {
  tag: string;
  path: string;
  line: number;
}

export interface TemplateChain {
  template: string;
  path: string | null;
  parent: TemplateChainEntry | null;
  extendsChain: TemplateChainEntry[];
  blocks: TemplateChainBlock[];
  uses: TemplateChainReference[];
  embeds: TemplateChainReference[];
  includes: TemplateChainReference[];
  unknownTags: TemplateChainUnknownTag[];
  missing: string[];
}

type PlainObject = Record<string, unknown>;

const VENDOR_SCAN_CAP = 200;
const MAX_EXTENDS_DEPTH = 20;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve a possibly relative Twig path, honouring the kernel placeholder. */
function toAbsolute(root: string, value: string): string {
  const stripped = value.replace(/^%kernel\.project_dir%[\\/]?/, '');
  return isAbsolute(stripped) ? resolve(stripped) : resolve(root, stripped);
}

function splitSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function collectPathStrings(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.flatMap((entry) => collectPathStrings(entry));
  if (isPlainObject(raw)) {
    return Object.values(raw).flatMap((entry) => collectPathStrings(entry));
  }
  return [];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeRuntimeLoaders(data: unknown, root: string): TwigLoaders | null {
  if (!isPlainObject(data)) return null;

  const rawPaths = data.loader_paths ?? data.paths;
  const paths = dedupe(collectPathStrings(rawPaths).map((path) => toAbsolute(root, path)));

  const namespaces: Record<string, string> = {};
  if (isPlainObject(data.namespaces)) {
    for (const [name, raw] of Object.entries(data.namespaces)) {
      const first = collectPathStrings(raw)[0];
      if (first) namespaces[name] = toAbsolute(root, first);
    }
  }

  return { paths, namespaces, source: 'runtime', incomplete: false };
}

function looksLikePath(value: string): boolean {
  if (value.startsWith('@')) return false;
  // Symfony's canonical form allows `%kernel.project_dir%/...` path keys.
  if (value.startsWith('%kernel.project_dir%')) return true;
  if (value.startsWith('%')) return false;
  return /[\\/]/.test(value) || value.startsWith('.');
}

interface StaticTwigConfig {
  defaultPath?: string;
  paths?: PlainObject;
}

function readStaticTwigConfig(root: string): StaticTwigConfig | null {
  const candidates = [
    join(root, 'config', 'packages', 'twig.yaml'),
    join(root, 'config', 'packages', 'twig.yml'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    try {
      const bun = Bun as unknown as { YAML?: { parse(input: string): unknown } };
      if (!bun.YAML?.parse) return null;
      const parsed = bun.YAML.parse(text);
      if (!isPlainObject(parsed)) return null;
      const twig = isPlainObject(parsed.twig) ? parsed.twig : parsed;
      return {
        defaultPath: typeof twig.default_path === 'string' ? twig.default_path : undefined,
        paths: isPlainObject(twig.paths) ? twig.paths : undefined,
      };
    } catch {
      return null;
    }
  }

  return null;
}

function staticLoaders(root: string, reason: string): TwigLoaders {
  const paths: string[] = [];
  const namespaces: Record<string, string> = {};

  try {
    const config = readStaticTwigConfig(root);
    if (config?.defaultPath) paths.push(toAbsolute(root, config.defaultPath));

    if (config?.paths) {
      for (const [key, rawValue] of Object.entries(config.paths)) {
        if (typeof rawValue !== 'string' || rawValue.length === 0) {
          // Namespace-less entry (`path: ~`): the key is the loader path.
          if (looksLikePath(key)) paths.push(toAbsolute(root, key));
          continue;
        }
        const keyIsPath = looksLikePath(key);
        const valueIsPath = looksLikePath(rawValue);
        if (keyIsPath && !valueIsPath) {
          const base = toAbsolute(root, key);
          namespaces[rawValue] = base;
          paths.push(base);
        } else {
          const base = toAbsolute(root, rawValue);
          namespaces[key] = base;
          paths.push(base);
        }
      }
    }

    const templates = join(root, 'templates');
    if (existsSync(templates)) paths.push(templates);
  } catch {
    // A malformed config must not break the fallback.
  }

  return {
    paths: dedupe(paths),
    namespaces,
    source: 'static',
    incomplete: true,
    reason,
  };
}

export async function resolveLoaderPaths(options: LoaderOptions): Promise<TwigLoaders> {
  const { root, consolePath } = options;

  try {
    if (consolePath && existsSync(consolePath)) {
      const runtime = await runConsoleJson(consolePath, ['debug:twig'], {
        cwd: root,
        runner: options.runner,
        timeoutMs: options.timeoutMs,
      });
      if (runtime.ok) {
        const normalized = normalizeRuntimeLoaders(runtime.data, root);
        if (normalized) return normalized;
        return staticLoaders(root, 'debug:twig returned an unexpected JSON shape');
      }
      return staticLoaders(root, `runtime ${runtime.reason}: ${runtime.message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return staticLoaders(root, `runtime error: ${message}`);
  }

  return staticLoaders(root, 'console-unavailable');
}

function vendorCandidates(root: string, segments: string[]): string[] {
  const vendor = join(root, 'vendor');
  if (!existsSync(vendor)) return [];

  const found: string[] = [];
  let scanned = 0;

  let vendors: string[];
  try {
    vendors = readdirSync(vendor).sort();
  } catch {
    return [];
  }

  for (const vendorName of vendors) {
    if (scanned >= VENDOR_SCAN_CAP) break;
    const vendorDir = join(vendor, vendorName);

    let packages: string[];
    try {
      packages = readdirSync(vendorDir).sort();
    } catch {
      continue;
    }

    for (const packageName of packages) {
      if (scanned >= VENDOR_SCAN_CAP) break;
      scanned++;
      const packageDir = join(vendorDir, packageName);
      for (const sub of ['Resources/views', 'templates']) {
        const base = join(packageDir, ...splitSegments(sub));
        if (!existsSync(base)) continue;
        const candidate = join(base, ...segments);
        if (!found.includes(candidate)) found.push(candidate);
      }
    }
  }

  return found.sort();
}

export function resolveTemplate(
  name: string,
  loaders: TwigLoaders,
  root: string
): TemplateResolution {
  const candidates: TemplateCandidate[] = [];
  const push = (path: string, kind: TemplateCandidateKind): void => {
    const resolved = resolve(path);
    if (candidates.some((candidate) => candidate.path === resolved)) return;
    candidates.push({ path: resolved, kind, exists: existsSync(resolved) });
  };

  try {
    if (name.startsWith('@') && name.includes('/')) {
      const slash = name.indexOf('/');
      const bundle = name.slice(1, slash);
      const rest = name.slice(slash + 1);
      const segments = splitSegments(rest);

      if (bundle && segments.length > 0) {
        push(join(root, 'templates', 'bundles', bundle, ...segments), 'bundle-override');

        const namespace = loaders.namespaces[`@${bundle}`] ?? loaders.namespaces[bundle] ?? null;
        if (namespace) push(join(namespace, ...segments), 'namespace');

        for (const candidate of vendorCandidates(root, segments)) push(candidate, 'bundle');
      }
    } else {
      const segments = splitSegments(name);
      if (segments.length > 0) {
        const templatesPath = join(root, 'templates', ...segments);
        if (existsSync(templatesPath)) push(templatesPath, 'loader');
        for (const loaderPath of loaders.paths) push(join(loaderPath, ...segments), 'loader');
      }
    }
  } catch {
    // Resolution never throws; an unreadable project just yields no candidates.
  }

  const found = candidates.find((candidate) => candidate.exists);
  return { name, path: found?.path ?? null, candidates };
}

function scanFile(path: string): TwigScanResult | null {
  try {
    return scanTwig(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function unresolvedMessage(name: string): string {
  return name;
}

/** Resolve a template and follow its `extends` chain (cycle-safe, capped at 20). */
export function buildTemplateChain(
  name: string,
  loaders: TwigLoaders,
  root: string
): TemplateChain {
  const start = resolveTemplate(name, loaders, root);
  const result: TemplateChain = {
    template: name,
    path: start.path,
    parent: null,
    extendsChain: [],
    blocks: [],
    uses: [],
    embeds: [],
    includes: [],
    unknownTags: [],
    missing: [],
  };

  if (!start.path) {
    result.missing.push(unresolvedMessage(name));
    return result;
  }

  const seen = new Set<string>();
  let currentName = name;
  let currentPath: string | null = start.path;

  for (let depth = 0; depth < MAX_EXTENDS_DEPTH && currentPath; depth++) {
    if (seen.has(currentPath)) break;
    seen.add(currentPath);

    const scan = scanFile(currentPath);
    if (!scan) {
      result.missing.push(unresolvedMessage(currentName));
      break;
    }

    for (const block of scan.blocks) {
      result.blocks.push({
        name: block.name,
        template: currentName,
        path: currentPath,
        line: block.line,
        parentCall: block.parentCall,
      });
    }

    const collectReference = (
      refs: Array<{ target: string; line: number }>,
      target: TemplateChainReference[]
    ): void => {
      for (const ref of refs) {
        const resolved = resolveTemplate(ref.target, loaders, root);
        target.push({
          target: ref.target,
          template: currentName,
          path: resolved.path,
          line: ref.line,
        });
        if (!resolved.path) result.missing.push(unresolvedMessage(ref.target));
      }
    };

    collectReference(scan.uses, result.uses);
    collectReference(scan.embeds, result.embeds);
    collectReference(scan.includes, result.includes);

    for (const tag of scan.tags) {
      if (TWIG_KNOWN_TAGS.has(tag.name)) continue;
      result.unknownTags.push({ tag: tag.name, path: currentPath, line: tag.line });
    }

    const extended = scan.extends;
    if (!extended) break;

    const resolved = resolveTemplate(extended.target, loaders, root);
    result.extendsChain.push({
      name: extended.target,
      path: resolved.path,
      line: extended.line,
    });

    if (!resolved.path) {
      result.missing.push(unresolvedMessage(extended.target));
      break;
    }

    currentName = extended.target;
    currentPath = resolved.path;
  }

  result.parent = result.extendsChain[0] ?? null;
  return result;
}
