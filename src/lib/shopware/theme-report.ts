// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Shopware theme report library: a flattened theme list with resolved parent
 * chains and sales-channel assignments, a per-theme resolve view that pairs the
 * effective view chain with the declared style/script assets, and an
 * SCSS-aware `theme:compile` wrapper.
 *
 * Everything here is tolerant: a missing `theme.json`, an unknown parent or a
 * failed compile is reported as `incomplete`/`reason`, never thrown. SCSS
 * diagnostics are normalised to root-relative paths and capped so callers never
 * have to dump raw console output.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  defaultConsoleRunner,
  runConsole,
  type ConsoleResult,
  type ConsoleRunner,
  type RawConsoleResult,
} from '../framework/console';
import { listPlugins, type PluginListResult } from './plugins';
import {
  listThemes,
  resolveThemeViewChain,
  type ShopwareTheme,
  type ThemeListResult,
  type ViewRoot,
} from './themes';

export interface ThemeStyleEntry {
  theme: string; // theme name that declared it
  origin: 'theme' | 'parent'; // own theme vs inherited from a parent theme
  entry: string; // raw string from theme.json
  path: string; // resolved path (theme-relative)
  kind: 'style' | 'script';
  exists: boolean;
}

export interface ThemeListEntry {
  name: string;
  technicalName?: string;
  parentName?: string;
  parentChain: string[]; // own name first, then parents
  views: string[];
  path: string | null;
  salesChannelIds: string[]; // sorted, from theme_sales_channel
}

export interface ThemeListReport {
  themes: ThemeListEntry[];
  source: 'runtime' | 'static';
  incomplete: boolean;
  reason?: string;
  unresolvedParents: string[]; // parent names that could not be resolved
}

export interface ThemeResolveReport {
  theme: string;
  parentChain: string[];
  roots: ViewRoot[]; // most specific first, from resolveThemeViewChain
  unresolved: string[]; // namespace tokens that did not resolve
  assets: ThemeStyleEntry[]; // style+script entries, most specific theme first
  salesChannelIds: string[];
  source: 'runtime' | 'static';
  incomplete: boolean;
  reason?: string;
}

export interface ScssError {
  path: string;
  line: number;
  column?: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  command: string[]; // ['theme:compile', ...flags]
  errors: ScssError[]; // only path:line + message, no raw output
  reason?: string; // console failure reason on a failed run
  message?: string; // compact tail for non-SCSS failures only
  hint?: string;
  truncated: boolean; // more errors existed than the cap
}

export interface ThemeReportOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
  /** Test seam: use an already-resolved theme list instead of running listThemes. */
  themeList?: ThemeListResult;
}

export interface ThemeCompileOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
  salesChannel?: string;
  timeoutMs?: number;
}

type PlainObject = Record<string, unknown>;

const DEFAULT_SCSS_LIMIT = 50;
const MAX_SCSS_LIMIT = 1000;
const MAX_SCSS_SCAN = 5000;
const MAX_PARENT_DEPTH = 20;
const DEFAULT_COMPILE_TIMEOUT_MS = 300000;
const COMPACT_MESSAGE_LINES = 12;

// Built without a control-character literal so `no-control-regex` stays happy.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function relPath(root: string, abs: string): string {
  return toSlashes(relative(root, abs));
}

function findThemeByName(list: ThemeListResult, name: string): ShopwareTheme | undefined {
  const needle = name.trim().toLowerCase();
  return list.themes.find(
    (theme) => theme.name.toLowerCase() === needle || theme.technicalName?.toLowerCase() === needle
  );
}

function buildParentChain(
  list: ThemeListResult,
  start: ShopwareTheme
): { parentChain: string[]; unresolved: string[] } {
  const parentChain: string[] = [start.name];
  const unresolved: string[] = [];
  const seen = new Set<string>([start.name.toLowerCase()]);

  let current = start;
  while (current.parentName && parentChain.length < MAX_PARENT_DEPTH) {
    const parent = findThemeByName(list, current.parentName);
    if (!parent) {
      unresolved.push(current.parentName);
      break;
    }
    const key = parent.name.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    parentChain.push(parent.name);
    current = parent;
  }

  return { parentChain, unresolved };
}

function collectSalesChannelIds(list: ThemeListResult, theme: ShopwareTheme): string[] {
  const names = new Set<string>([theme.name.toLowerCase()]);
  if (theme.technicalName) names.add(theme.technicalName.toLowerCase());

  const ids = list.assignments
    .filter((assignment) => names.has(assignment.themeName.toLowerCase()))
    .map((assignment) => assignment.salesChannelId.toLowerCase());

  return [...new Set(ids)].sort();
}

export async function listThemeReport(options: ThemeReportOptions): Promise<ThemeListReport> {
  let list: ThemeListResult;
  try {
    list =
      options.themeList ??
      (await listThemes({
        root: options.root,
        consolePath: options.consolePath,
        runner: options.runner,
      }));
  } catch {
    return {
      themes: [],
      source: 'static',
      incomplete: true,
      reason: 'no-console',
      unresolvedParents: [],
    };
  }

  const unresolvedParents = new Set<string>();
  const themes: ThemeListEntry[] = list.themes.map((theme) => {
    const { parentChain, unresolved } = buildParentChain(list, theme);
    for (const name of unresolved) unresolvedParents.add(name);
    return {
      name: theme.name,
      technicalName: theme.technicalName,
      parentName: theme.parentName,
      parentChain,
      views: [...theme.views],
      path: theme.path,
      salesChannelIds: collectSalesChannelIds(list, theme),
    };
  });

  const unresolvedList = [...unresolvedParents].sort();
  const incomplete = list.incomplete || unresolvedList.length > 0;
  const report: ThemeListReport = {
    themes,
    source: list.source,
    incomplete,
    unresolvedParents: unresolvedList,
  };
  const reason = unresolvedList.length > 0 ? 'unresolved parent theme' : list.reason;
  if (reason) report.reason = reason;
  return report;
}

interface AssetCollection {
  assets: ThemeStyleEntry[];
  incomplete: boolean;
}

function collectThemeAssets(
  list: ThemeListResult,
  parentChain: string[],
  root: string
): AssetCollection {
  const assets: ThemeStyleEntry[] = [];
  let incomplete = false;

  for (let index = 0; index < parentChain.length; index++) {
    const theme = findThemeByName(list, parentChain[index]);
    if (!theme || !theme.path) {
      incomplete = true;
      continue;
    }

    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(theme.path, 'theme.json'), 'utf8'));
    } catch {
      incomplete = true;
      continue;
    }
    if (!isPlainObject(data)) {
      incomplete = true;
      continue;
    }

    const origin: ThemeStyleEntry['origin'] = index === 0 ? 'theme' : 'parent';
    for (const kind of ['style', 'script'] as const) {
      const entries = data[kind];
      if (!Array.isArray(entries)) continue;
      for (const value of entries) {
        if (typeof value !== 'string') continue;
        const entry = value.trim();
        if (entry.length === 0) continue;
        const abs = resolve(theme.path, entry);
        assets.push({
          theme: theme.name,
          origin,
          entry: value,
          path: relPath(root, abs),
          kind,
          exists: existsSync(abs),
        });
      }
    }
  }

  return { assets, incomplete };
}

export async function resolveThemeReport(
  theme: string,
  options: ThemeReportOptions
): Promise<ThemeResolveReport> {
  let list: ThemeListResult;
  try {
    list =
      options.themeList ??
      (await listThemes({
        root: options.root,
        consolePath: options.consolePath,
        runner: options.runner,
      }));
  } catch {
    list = {
      themes: [],
      assignments: [],
      source: 'static',
      incomplete: true,
      reason: 'no-console',
    };
  }

  let plugins: PluginListResult;
  try {
    plugins = await listPlugins({
      root: options.root,
      consolePath: options.consolePath,
      runner: options.runner,
    });
  } catch {
    plugins = { plugins: [], source: 'static', incomplete: true, reason: 'no-console' };
  }

  const chain = resolveThemeViewChain(theme, list, plugins, options.root);
  const found = findThemeByName(list, theme);
  const parentChain = found ? buildParentChain(list, found).parentChain : [];
  const { assets, incomplete: assetsIncomplete } = collectThemeAssets(
    list,
    parentChain,
    options.root
  );

  const report: ThemeResolveReport = {
    theme: found?.name ?? theme,
    parentChain,
    roots: chain.roots,
    unresolved: chain.unresolved,
    assets,
    salesChannelIds: found ? collectSalesChannelIds(list, found) : [],
    source: list.source,
    incomplete: chain.incomplete || assetsIncomplete || !found,
  };
  if (list.reason) report.reason = list.reason;
  return report;
}

function normalizeScssLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SCSS_LIMIT;
  return Math.min(MAX_SCSS_LIMIT, Math.max(1, Math.floor(value)));
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function normalizeErrorPath(rawPath: string, root: string): string {
  const cleaned = rawPath.trim().replace(/^\.\//, '');
  if (cleaned.length === 0) return '';
  const abs = isAbsolute(cleaned) ? cleaned : resolve(root, cleaned);
  return relPath(root, abs);
}

function nextNonEmpty(lines: string[], start: number): string {
  for (let index = start; index < lines.length; index++) {
    const value = lines[index].trim();
    if (value.length > 0) return value;
  }
  return '';
}

/** Parse SCSS/LESS/CSS diagnostics from console output, tolerate noise, cap the list. */
export function parseScssErrors(
  output: string,
  root: string,
  options: { limit?: number } = {}
): { errors: ScssError[]; truncated: boolean } {
  const limit = normalizeScssLimit(options.limit);
  const lines = stripAnsi(output ?? '').split(/\r?\n/);

  const errors: ScssError[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const add = (rawPath: string, line: number, message: string, column?: number): void => {
    const path = normalizeErrorPath(rawPath, root);
    const text = message.trim();
    if (path.length === 0 || text.length === 0) return;

    const key = `${path}:${line}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (errors.length >= limit || errors.length >= MAX_SCSS_SCAN) {
      truncated = true;
      return;
    }

    const error: ScssError = { path, line, message: text };
    if (column !== undefined) error.column = column;
    errors.push(error);
  };

  for (let index = 0; index < lines.length && errors.length < MAX_SCSS_SCAN; index++) {
    const line = lines[index];

    const symfony = /\bIn\s+(.+?\.(?:scss|sass|css|less))\s+line\s+(\d+):\s*$/.exec(line);
    if (symfony) {
      add(symfony[1], Number(symfony[2]), nextNonEmpty(lines, index + 1));
      continue;
    }

    const webpack =
      /^\s*ERROR in\s+(.+?\.(?:scss|sass|css|less))\s+(\d+)(?::(\d+))?\s*(?::\s*(.+))?$/.exec(line);
    if (webpack) {
      const column = webpack[3] !== undefined ? Number(webpack[3]) : undefined;
      const sameLine = webpack[4];
      const message =
        sameLine && sameLine.trim().length > 0 ? sameLine : nextNonEmpty(lines, index + 1);
      add(webpack[1], Number(webpack[2]), message, column);
      continue;
    }

    const plain = /([^\s:]+\.(?:scss|sass|css|less)):(\d+)(?::(\d+))?:\s*(.+)$/.exec(line);
    if (plain) {
      const column = plain[3] !== undefined ? Number(plain[3]) : undefined;
      add(plain[1], Number(plain[2]), plain[4], column);
      continue;
    }
  }

  return { errors, truncated };
}

function compactMessage(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(-COMPACT_MESSAGE_LINES).join('\n').trim();
}

/** Run `theme:compile`, returning parsed SCSS diagnostics instead of raw output. */
export async function compileTheme(options: ThemeCompileOptions): Promise<CompileResult> {
  const command = ['theme:compile'];
  // Shopware 6.5+ accepts --only=<salesChannelId> to compile a single channel.
  if (options.salesChannel) command.push(`--only=${options.salesChannel}`);

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
  const inner = options.runner ?? defaultConsoleRunner;

  // runConsole only exposes stdout/stderr on success, so capture the raw runner
  // result to keep the SCSS diagnostics on a failed compile.
  let captured: RawConsoleResult | undefined;
  const capturingRunner: ConsoleRunner = async (cmd, opts) => {
    const result = await inner(cmd, opts);
    captured = result;
    return result;
  };

  let result: ConsoleResult;
  try {
    result = await runConsole(options.consolePath ?? null, command, {
      cwd: options.root,
      runner: capturingRunner,
      timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, command, errors: [], reason: 'unknown', message, truncated: false };
  }

  if (result.ok) {
    return { ok: true, command, errors: [], truncated: false };
  }

  const combined = captured ? `${captured.stdout}\n${captured.stderr}` : '';
  const { errors, truncated } = parseScssErrors(combined, options.root);
  if (errors.length > 0) {
    return { ok: false, command, errors, reason: result.reason, truncated };
  }

  return {
    ok: false,
    command,
    errors: [],
    reason: result.reason,
    message: compactMessage(result.message),
    truncated,
  };
}
