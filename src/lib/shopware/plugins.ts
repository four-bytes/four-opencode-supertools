// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Shopware plugin discovery and load order. Runtime `plugin:list` is tried as
 * `--format=json`, then `--json`, then a plain text table; the json/text
 * parsers are tolerant and exported for tests. Without a usable console the
 * discovery falls back to custom/plugins, custom/static-plugins and
 * custom/apps and is always marked incomplete. Nothing here throws.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runConsole, type ConsoleRunner } from '../framework/console';

export interface ShopwarePlugin {
  name: string; // technical name, e.g. "AlphaPlugin"
  label?: string;
  version?: string;
  active: boolean;
  kind: 'plugin' | 'app';
  path: string | null; // absolute project path when discovered
}

export interface PluginListResult {
  plugins: ShopwarePlugin[]; // load order: runtime order kept; static = deterministic
  source: 'runtime' | 'static';
  incomplete: boolean;
  reason?: string; // console failure reason or 'no-console'
}

export interface PluginListOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
}

type PlainObject = Record<string, unknown>;

interface TableColumn {
  key: 'name' | 'label' | 'version' | 'active';
  start: number;
}

const PLUGIN_COMMANDS: string[][] = [
  ['plugin:list', '--format=json'],
  ['plugin:list', '--json'],
  ['plugin:list'],
];

const PLUGIN_TYPES = new Set(['shopware-platform-plugin']);
const TRUE_VALUES = new Set(['yes', 'true', '1', '✓', 'x']);
const MAX_DIR_ENTRIES = 500;

const COLUMN_PATTERNS: Array<{ key: TableColumn['key']; re: RegExp }> = [
  { key: 'name', re: /(?:plugin|name|technical[\s_-]*name)/i },
  { key: 'label', re: /label/i },
  { key: 'version', re: /version/i },
  { key: 'active', re: /active/i },
];

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return TRUE_VALUES.has(value.trim().toLowerCase());
  return false;
}

function normalizeJsonPlugin(raw: unknown): ShopwarePlugin | null {
  if (!isPlainObject(raw)) return null;

  const name =
    asString(raw.name) ?? asString(raw.technicalName) ?? asString(raw.technical_name) ?? null;
  if (!name) return null;

  const kind = asString(raw.type) === 'app' || asString(raw.kind) === 'app' ? 'app' : 'plugin';

  return {
    name,
    label: asString(raw.label),
    version: asString(raw.version),
    active: isTruthy(raw.active ?? raw.isActive ?? raw.enabled),
    kind,
    path: asString(raw.path) ?? null,
  };
}

function parseJsonPlugins(text: string): ShopwarePlugin[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  let rows: unknown[];
  if (Array.isArray(data)) {
    rows = data;
  } else if (isPlainObject(data) && Array.isArray(data.plugins)) {
    rows = data.plugins;
  } else {
    return null;
  }

  const plugins: ShopwarePlugin[] = [];
  for (const row of rows) {
    const plugin = normalizeJsonPlugin(row);
    if (plugin) plugins.push(plugin);
  }
  return plugins.length > 0 ? plugins : null;
}

function headerColumns(header: string): TableColumn[] | null {
  const found: TableColumn[] = [];
  for (const def of COLUMN_PATTERNS) {
    const match = def.re.exec(header);
    if (match) found.push({ key: def.key, start: match.index });
  }

  if (!found.some((column) => column.key === 'name')) return null;
  if (!found.some((column) => column.key === 'active')) return null;

  found.sort((a, b) => a.start - b.start);
  return found;
}

function parseTextPlugins(text: string): ShopwarePlugin[] | null {
  const lines = text.split(/\r?\n/);

  let headerIndex = -1;
  let columns: TableColumn[] | null = null;
  for (let index = 0; index < lines.length; index++) {
    const candidate = headerColumns(lines[index]);
    if (candidate) {
      headerIndex = index;
      columns = candidate;
      break;
    }
  }
  if (!columns || headerIndex < 0) return null;

  const plugins: ShopwarePlugin[] = [];
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (/^[-+|=\s]+$/.test(line)) continue;

    const cells: Partial<Record<TableColumn['key'], string>> = {};
    const segments = line
      .split(/\s{2,}/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    if (segments.length === columns.length) {
      columns.forEach((column, columnIndex) => {
        cells[column.key] = segments[columnIndex];
      });
    } else {
      columns.forEach((column, columnIndex) => {
        const start = column.start;
        const end = columnIndex + 1 < columns.length ? columns[columnIndex + 1].start : line.length;
        cells[column.key] = line.slice(start, end).trim();
      });
    }

    const name = cells.name;
    if (!name || /\s/.test(name)) continue;

    plugins.push({
      name,
      label: cells.label || undefined,
      version: cells.version || undefined,
      active: isTruthy(cells.active ?? ''),
      kind: 'plugin',
      path: null,
    });
  }

  return plugins.length > 0 ? plugins : null;
}

/** Parse plugin:list output, accepting JSON arrays, `{ plugins: [...] }` and text tables. */
export function parsePluginList(text: string): ShopwarePlugin[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return parseJsonPlugins(trimmed) ?? parseTextPlugins(trimmed);
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

interface DirEntries {
  dirs: string[];
  truncated: boolean;
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

function xmlTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(text);
  if (!match) return undefined;
  const value = match[1].replace(/<[^>]+>/g, '').trim();
  return value.length > 0 ? value : undefined;
}

function discoverApps(root: string): { plugins: ShopwarePlugin[]; incomplete: boolean } {
  const base = join(root, 'custom', 'apps');
  if (!existsSync(base)) return { plugins: [], incomplete: false };

  const entries = sortedDirs(base);
  let incomplete = entries.truncated;
  const apps: ShopwarePlugin[] = [];
  for (const dirName of entries.dirs) {
    const dir = join(base, dirName);
    const manifestPath = join(dir, 'manifest.xml');
    if (!existsSync(manifestPath)) continue;

    let text: string;
    try {
      text = readFileSync(manifestPath, 'utf8');
    } catch {
      incomplete = true;
      continue;
    }

    const meta = /<meta[\s\S]*?<\/meta>/i.exec(text)?.[0] ?? text;
    const name = xmlTag(meta, 'name') ?? dirName;
    apps.push({
      name,
      label: xmlTag(meta, 'label'),
      active: false,
      kind: 'app',
      path: dir,
    });
  }

  apps.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins: apps, incomplete };
}

function discoverStaticPlugins(root: string): { plugins: ShopwarePlugin[]; incomplete: boolean } {
  const plugins: ShopwarePlugin[] = [];
  let incomplete = false;

  for (const rel of ['custom/plugins', 'custom/static-plugins']) {
    const base = join(root, ...rel.split('/'));
    if (!existsSync(base)) continue;

    const entries = sortedDirs(base);
    if (entries.truncated) incomplete = true;
    for (const dirName of entries.dirs) {
      const dir = join(base, dirName);
      const composerPath = join(dir, 'composer.json');
      if (!existsSync(composerPath)) continue;

      const composer = readJsonFile(composerPath);
      if (!isPlainObject(composer)) {
        incomplete = true;
        continue;
      }
      const type = asString(composer.type);
      if (!type || !PLUGIN_TYPES.has(type)) continue;

      plugins.push({
        name: dirName,
        label: asString(composer.description),
        version: asString(composer.version),
        active: false,
        kind: 'plugin',
        path: dir,
      });
    }
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name));

  const apps = discoverApps(root);
  if (apps.incomplete) incomplete = true;
  plugins.push(...apps.plugins);

  return { plugins, incomplete };
}

function staticPluginResult(root: string, reason: string): PluginListResult {
  try {
    const discovered = discoverStaticPlugins(root);
    return {
      plugins: discovered.plugins,
      source: 'static',
      incomplete: true,
      reason,
    };
  } catch {
    return { plugins: [], source: 'static', incomplete: true, reason };
  }
}

function resolvePluginPaths(plugins: ShopwarePlugin[], root: string): ShopwarePlugin[] {
  return plugins.map((plugin) => ({
    ...plugin,
    path: plugin.path && !isAbsolute(plugin.path) ? resolve(root, plugin.path) : plugin.path,
  }));
}

export async function listPlugins(options: PluginListOptions): Promise<PluginListResult> {
  const { root, consolePath } = options;

  try {
    if (consolePath && existsSync(consolePath)) {
      let lastReason: string | undefined;
      let invalidJsonSeen = false;

      for (const args of PLUGIN_COMMANDS) {
        const result = await runConsole(consolePath, args, {
          cwd: root,
          runner: options.runner,
        });
        if (!result.ok) {
          lastReason = result.reason;
          continue;
        }

        const parsed = parsePluginList(result.stdout);
        if (parsed) {
          return {
            plugins: resolvePluginPaths(parsed, root),
            source: 'runtime',
            incomplete: false,
          };
        }
        // A later command may still fail; keep the more informative reason.
        invalidJsonSeen = true;
      }

      const reason = invalidJsonSeen ? 'invalid-json' : (lastReason ?? 'console-failed');
      return staticPluginResult(root, reason);
    }
  } catch {
    // Any runner/filesystem error falls through to the static scan.
  }

  return staticPluginResult(root, 'no-console');
}
