// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Shopware theme discovery and effective view chain. Runtime data comes from
 * `dbal:run-sql ... --format=json` against the theme and theme_sales_channel
 * tables; static fallback scans theme.json files and is always marked
 * incomplete (parent links and sales-channel assignments are unknown).
 * The chain is ordered most-specific first following each theme's `views`
 * array (last entry = highest priority) on top of the selected theme → DB
 * parent chain. Nonexistent view roots are never emitted. Nothing here throws.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runConsole, type ConsoleRunner } from '../framework/console';
import type { PluginListResult, ShopwarePlugin } from './plugins';

export interface ShopwareTheme {
  name: string; // theme.json "name" / DB name
  technicalName?: string;
  parentName?: string; // resolved parent theme name when known
  views: string[]; // raw theme.json views, e.g. ["@Storefront","@Plugins"]
  path: string | null;
}

export interface ThemeAssignment {
  themeName: string;
  salesChannelId: string;
}

export interface ThemeListResult {
  themes: ShopwareTheme[];
  assignments: ThemeAssignment[];
  source: 'runtime' | 'static';
  incomplete: boolean;
  reason?: string;
}

export interface ViewRoot {
  path: string;
  origin: string; // 'theme:<Name>' | 'parent:<Name>' | 'plugin:<Name>' | 'storefront' | 'unresolved'
}

export interface ViewChainResult {
  roots: ViewRoot[]; // most specific first
  unresolved: string[]; // @namespace / @Theme tokens that could not be mapped
  incomplete: boolean;
}

export interface ThemeListOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
}

type PlainObject = Record<string, unknown>;

interface ThemeRow {
  id: string;
  name: string;
  technicalName?: string;
  parentThemeId?: string;
}

interface AssignmentRow {
  themeId: string;
  salesChannelId: string;
}

interface DiscoveredTheme {
  name: string;
  technicalName?: string;
  views: string[];
  path: string; // directory containing theme.json
}

type SqlResult = { ok: true; data: unknown } | { ok: false; reason: string };

const THEME_SQL = 'SELECT LOWER(HEX(id)) AS id, name, technical_name, parent_theme_id FROM theme';
const ASSIGNMENT_SQL =
  'SELECT LOWER(HEX(theme_id)) AS theme_id, LOWER(HEX(sales_channel_id)) AS sales_channel_id FROM theme_sales_channel';

const MAX_THEME_FILES = 500;
const MAX_DIR_ENTRIES = 500;

interface DirEntries {
  dirs: string[];
  truncated: boolean;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sortedDirs(base: string): DirEntries {
  try {
    const entries = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()) // isDirectory() is false for symlinks
      .map((entry) => entry.name)
      .sort();
    const truncated = entries.length > MAX_DIR_ENTRIES;
    return { dirs: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries, truncated };
  } catch {
    return { dirs: [], truncated: false };
  }
}

function readThemeJson(themePath: string): DiscoveredTheme | null {
  let text: string;
  try {
    text = readFileSync(themePath, 'utf8');
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;

  const name = asString(data.name);
  if (!name) return null;

  const rawViews = data.views;
  const views = Array.isArray(rawViews)
    ? rawViews
        .filter((view): view is string => typeof view === 'string')
        .map((view) => view.trim())
        .filter((view) => view.length > 0)
    : [];

  return {
    name,
    technicalName: asString(data.technicalName) ?? asString(data.technical_name),
    views,
    path: dirname(themePath),
  };
}

function discoverThemeFiles(root: string): { themes: DiscoveredTheme[]; incomplete: boolean } {
  const found: DiscoveredTheme[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let capped = false;
  let incomplete = false;

  const add = (themePath: string): void => {
    if (scanned >= MAX_THEME_FILES) {
      capped = true;
      return;
    }
    if (!existsSync(themePath)) return;
    const key = resolve(themePath);
    if (seen.has(key)) return;
    seen.add(key);
    scanned++;
    const parsed = readThemeJson(themePath);
    if (parsed) found.push(parsed);
  };

  for (const rel of ['custom/plugins', 'custom/static-plugins']) {
    const base = join(root, ...rel.split('/'));
    const entries = sortedDirs(base);
    if (entries.truncated) incomplete = true;
    for (const dirName of entries.dirs) {
      add(join(base, dirName, 'src', 'Resources', 'theme.json'));
    }
  }

  const appsBase = join(root, 'custom', 'apps');
  const apps = sortedDirs(appsBase);
  if (apps.truncated) incomplete = true;
  for (const dirName of apps.dirs) {
    add(join(appsBase, dirName, 'Resources', 'theme.json'));
  }

  const vendorBase = join(root, 'vendor', 'shopware');
  const vendors = sortedDirs(vendorBase);
  if (vendors.truncated) incomplete = true;
  for (const dirName of vendors.dirs) {
    add(join(vendorBase, dirName, 'src', 'Resources', 'theme.json'));
    add(join(vendorBase, dirName, 'Resources', 'theme.json'));
  }

  return { themes: found, incomplete: incomplete || capped };
}

function findDiscovered(
  discovered: DiscoveredTheme[],
  name: string,
  technicalName?: string
): DiscoveredTheme | undefined {
  const needles = [name, technicalName]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  return discovered.find((candidate) => {
    const names = [candidate.name, candidate.technicalName]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());
    return needles.some((needle) => names.includes(needle));
  });
}

function normalizeThemeRows(data: unknown): ThemeRow[] | null {
  let rows: unknown[];
  if (Array.isArray(data)) {
    rows = data;
  } else if (isPlainObject(data) && Array.isArray(data.rows)) {
    rows = data.rows;
  } else {
    return null;
  }

  const result: ThemeRow[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const id = asString(row.id);
    const name = asString(row.name);
    if (!id || !name) continue;
    result.push({
      id: id.toLowerCase(),
      name,
      technicalName: asString(row.technical_name) ?? asString(row.technicalName),
      parentThemeId:
        asString(row.parent_theme_id)?.toLowerCase() ?? asString(row.parentThemeId)?.toLowerCase(),
    });
  }

  return result.length > 0 ? result : null;
}

function normalizeAssignmentRows(data: unknown): AssignmentRow[] | null {
  let rows: unknown[];
  if (Array.isArray(data)) {
    rows = data;
  } else if (isPlainObject(data) && Array.isArray(data.rows)) {
    rows = data.rows;
  } else {
    return null;
  }

  const result: AssignmentRow[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const themeId = asString(row.theme_id) ?? asString(row.themeId);
    const salesChannelId = asString(row.sales_channel_id) ?? asString(row.salesChannelId);
    if (!themeId || !salesChannelId) continue;
    result.push({ themeId: themeId.toLowerCase(), salesChannelId: salesChannelId.toLowerCase() });
  }

  return result;
}

interface MergedThemes {
  themes: ShopwareTheme[];
  incomplete: boolean;
}

function mergeThemes(rows: ThemeRow[], discovered: DiscoveredTheme[]): MergedThemes {
  const nameById = new Map(rows.map((row) => [row.id, row.name]));
  let incomplete = false;

  const themes = rows.map((row) => {
    const match = findDiscovered(discovered, row.name, row.technicalName);
    if (!match) incomplete = true;
    return {
      name: row.name,
      technicalName: row.technicalName,
      parentName: row.parentThemeId ? nameById.get(row.parentThemeId) : undefined,
      views: match?.views ?? [],
      path: match?.path ?? null,
    };
  });

  return { themes, incomplete };
}

function buildAssignments(rows: AssignmentRow[], themeRows: ThemeRow[]): ThemeAssignment[] {
  const nameById = new Map(themeRows.map((row) => [row.id, row.name]));
  return rows.map((row) => ({
    themeName: nameById.get(row.themeId) ?? row.themeId,
    salesChannelId: row.salesChannelId,
  }));
}

function staticThemeResult(root: string, reason: string): ThemeListResult {
  try {
    const discovered = discoverThemeFiles(root);
    const themes: ShopwareTheme[] = discovered.themes.map((theme) => ({
      name: theme.name,
      technicalName: theme.technicalName,
      views: theme.views,
      path: theme.path,
    }));
    return { themes, assignments: [], source: 'static', incomplete: true, reason };
  } catch {
    return { themes: [], assignments: [], source: 'static', incomplete: true, reason };
  }
}

async function runSql(
  consolePath: string,
  root: string,
  runner: ConsoleRunner | undefined,
  sql: string
): Promise<SqlResult> {
  const result = await runConsole(consolePath, ['dbal:run-sql', sql, '--format=json'], {
    cwd: root,
    runner,
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  try {
    return { ok: true, data: JSON.parse(result.stdout.trim()) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

export async function listThemes(options: ThemeListOptions): Promise<ThemeListResult> {
  const { root, consolePath } = options;

  try {
    if (consolePath && existsSync(consolePath)) {
      const themeQuery = await runSql(consolePath, root, options.runner, THEME_SQL);
      if (!themeQuery.ok) return staticThemeResult(root, themeQuery.reason);

      const rows = normalizeThemeRows(themeQuery.data);
      if (!rows) return staticThemeResult(root, 'invalid-json');

      const discovered = discoverThemeFiles(root);
      const merged = mergeThemes(rows, discovered.themes);
      let incomplete = merged.incomplete || discovered.incomplete;
      let reason: string | undefined = merged.incomplete
        ? 'theme.json not located for some themes'
        : undefined;

      const assignmentQuery = await runSql(consolePath, root, options.runner, ASSIGNMENT_SQL);
      let assignments: ThemeAssignment[] = [];
      if (assignmentQuery.ok) {
        const assignmentRows = normalizeAssignmentRows(assignmentQuery.data);
        if (assignmentRows) {
          assignments = buildAssignments(assignmentRows, rows);
        } else {
          incomplete = true;
          reason = reason ?? 'invalid-json';
        }
      } else {
        incomplete = true;
        reason = reason ?? assignmentQuery.reason;
      }

      return {
        themes: merged.themes,
        assignments,
        source: 'runtime',
        incomplete,
        reason,
      };
    }
  } catch {
    // Any runner/filesystem error falls through to the static scan.
  }

  return staticThemeResult(root, 'no-console');
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function themeViewsRoot(theme: ShopwareTheme): string | null {
  if (!theme.path) return null;
  return firstExisting([join(theme.path, 'views')]);
}

function pluginViewsRoot(plugin: ShopwarePlugin): string | null {
  if (!plugin.path) return null;
  return firstExisting([
    join(plugin.path, 'src', 'Resources', 'views'),
    join(plugin.path, 'Resources', 'views'),
  ]);
}

function storefrontViewsRoot(root: string): string | null {
  return firstExisting([
    join(root, 'vendor', 'shopware', 'storefront', 'Resources', 'views'),
    join(root, 'vendor', 'shopware', 'storefront', 'src', 'Resources', 'views'),
  ]);
}

function findTheme(list: ThemeListResult, name: string): ShopwareTheme | undefined {
  const needle = name.toLowerCase();
  return list.themes.find(
    (theme) => theme.name.toLowerCase() === needle || theme.technicalName?.toLowerCase() === needle
  );
}

function findPlugin(plugins: PluginListResult, name: string): ShopwarePlugin | undefined {
  const needle = name.toLowerCase();
  return plugins.plugins.find((plugin) => plugin.name.toLowerCase() === needle);
}

function pushRoot(roots: ViewRoot[], path: string, origin: string): void {
  const resolved = resolve(path);
  if (roots.some((root) => resolve(root.path) === resolved)) return;
  roots.push({ path, origin });
}

function buildThemeChain(
  themeName: string,
  list: ThemeListResult
): {
  chain: Array<{ theme: ShopwareTheme; parent: boolean }>;
  unresolved: string[];
} {
  const chain: Array<{ theme: ShopwareTheme; parent: boolean }> = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  let current = findTheme(list, themeName);
  while (current) {
    const key = (current.technicalName ?? current.name).toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    chain.push({ theme: current, parent: chain.length > 0 });

    if (!current.parentName) break;
    const parent = findTheme(list, current.parentName);
    if (!parent) {
      unresolved.push(`@${current.parentName}`);
      break;
    }
    current = parent;
  }

  if (chain.length === 0) unresolved.push(`@${themeName}`);
  return { chain, unresolved };
}

function buildViewChain(
  themeName: string,
  list: ThemeListResult,
  plugins: PluginListResult,
  root: string
): ViewChainResult {
  const { chain, unresolved: chainUnresolved } = buildThemeChain(themeName, list);
  const unresolved = [...chainUnresolved];
  let incomplete = list.incomplete || plugins.incomplete;

  if (chain.length === 0) {
    return { roots: [], unresolved: dedupeStrings(unresolved), incomplete: true };
  }

  const roots: ViewRoot[] = [];
  const chainKeys = new Set(
    chain.map((entry) => (entry.theme.technicalName ?? entry.theme.name).toLowerCase())
  );

  // A theme's own directory always outranks namespaces it inherits, so all
  // chain themes (selected + DB parents) are emitted before any `views` token.
  for (const entry of chain) {
    const ownRoot = themeViewsRoot(entry.theme);
    if (ownRoot) {
      pushRoot(
        roots,
        ownRoot,
        entry.parent ? `parent:${entry.theme.name}` : `theme:${entry.theme.name}`
      );
    } else {
      incomplete = true;
    }
  }

  // theme.json `views` is ordered lowest → highest priority: the last entry
  // wins, so expand every array in reverse and append roots in that order.
  for (const entry of chain) {
    const tokens = [...entry.theme.views].reverse();
    for (const token of tokens) {
      if (!token.startsWith('@')) {
        unresolved.push(token);
        incomplete = true;
        continue;
      }

      if (token === '@Storefront') {
        const storefront = storefrontViewsRoot(root);
        if (storefront) {
          pushRoot(roots, storefront, 'storefront');
        } else {
          unresolved.push(token);
          incomplete = true;
        }
        continue;
      }

      if (token === '@Plugins') {
        // Earlier-loaded plugins win by default.
        for (const plugin of plugins.plugins) {
          if (!plugin.active) continue;
          const viewsRoot = pluginViewsRoot(plugin);
          if (viewsRoot) {
            pushRoot(roots, viewsRoot, `plugin:${plugin.name}`);
          } else {
            unresolved.push(`@${plugin.name}`);
            incomplete = true;
          }
        }
        continue;
      }

      const tokenName = token.slice(1);

      const matchedTheme = findTheme(list, tokenName);
      if (matchedTheme) {
        const key = (matchedTheme.technicalName ?? matchedTheme.name).toLowerCase();
        if (chainKeys.has(key)) continue; // own root already emitted
        const viewsRoot = themeViewsRoot(matchedTheme);
        if (viewsRoot) {
          pushRoot(roots, viewsRoot, `theme:${matchedTheme.name}`);
        } else {
          unresolved.push(token);
          incomplete = true;
        }
        continue;
      }

      const matchedPlugin = findPlugin(plugins, tokenName);
      if (matchedPlugin) {
        const viewsRoot = pluginViewsRoot(matchedPlugin);
        if (viewsRoot) {
          pushRoot(roots, viewsRoot, `plugin:${matchedPlugin.name}`);
        } else {
          unresolved.push(token);
          incomplete = true;
        }
        continue;
      }

      unresolved.push(token);
      incomplete = true;
    }
  }

  return { roots, unresolved: dedupeStrings(unresolved), incomplete };
}

export function resolveThemeViewChain(
  themeName: string,
  list: ThemeListResult,
  plugins: PluginListResult,
  root: string
): ViewChainResult {
  try {
    return buildViewChain(themeName, list, plugins, root);
  } catch {
    return { roots: [], unresolved: [`@${themeName}`], incomplete: true };
  }
}

export function resolveSalesChannelViewChain(
  salesChannelId: string,
  themes: ThemeListResult,
  plugins: PluginListResult,
  root: string
): ViewChainResult {
  try {
    const needle = salesChannelId.toLowerCase();
    const assignment = themes.assignments.find(
      (entry) => entry.salesChannelId.toLowerCase() === needle
    );
    if (!assignment) {
      return {
        roots: [],
        unresolved: [`sales-channel:${salesChannelId}`],
        incomplete: true,
      };
    }
    return buildViewChain(assignment.themeName, themes, plugins, root);
  } catch {
    return { roots: [], unresolved: [`sales-channel:${salesChannelId}`], incomplete: true };
  }
}
