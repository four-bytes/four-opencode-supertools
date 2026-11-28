// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Shopware plugin report library: a flattened plugin list, a static per-plugin
 * overview (services, subscribers, entities, Twig overrides, migrations, admin
 * modules, scheduled tasks) and a dry-run-first lifecycle planner/runner.
 *
 * The overview is static only — it never runs bin/console. Every filesystem
 * walk is bounded and every read is guarded, so broken PHP/XML is tolerated and
 * nothing here throws except the pure `planPluginLifecycle` validation.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runConsole, type ConsoleRunner } from '../framework/console';
import {
  collectStaticListeners,
  readStaticServices,
  type StaticService,
} from '../framework/symfony-static';
import { listPlugins, type PluginListResult } from './plugins';

export interface PluginListEntry {
  order: number; // 0-based load order index
  name: string;
  version?: string;
  active: boolean;
  kind: 'plugin' | 'app';
  path: string | null;
  theme: boolean; // theme.json found in the plugin dir
  updateAvailable: boolean | null; // null = unknown (no composer version or no runtime version)
}

export interface PluginListReport {
  plugins: PluginListEntry[];
  source: 'runtime' | 'static';
  incomplete: boolean;
  reason?: string;
}

export interface ReportRef {
  path: string;
  line: number;
}

export interface ServiceReport extends ReportRef {
  id: string;
  class?: string;
  tags: string[];
}

export interface SubscriberReport extends ReportRef {
  event: string;
  class?: string;
  method: string;
  priority: number;
}

export interface EntityReport extends ReportRef {
  class: string;
  kind: 'definition' | 'extension' | 'collection' | 'entity';
}

export interface AdminModuleReport {
  name: string;
  path: string;
}

export interface PluginOverview {
  plugin: string;
  path: string;
  version?: string;
  active: boolean;
  theme: boolean;
  themeHint?: string; // 'theme detected — use sw6_theme for the storefront view chain'
  services: ServiceReport[];
  subscribers: SubscriberReport[];
  entities: EntityReport[];
  twigOverrides: ReportRef[]; // files under Resources/views or src/Resources/views
  migrations: ReportRef[];
  adminModules: AdminModuleReport[];
  scheduledTasks: ServiceReport[]; // services carrying the shopware.scheduled.task tag
  incomplete: boolean; // true when the plugin dir is unknown or a scan was capped
  truncated: string[]; // section names that hit their cap
  available?: string[]; // known plugin names when the requested plugin was not found
  hint?: string;
}

export type PluginLifecycleAction =
  'refresh' | 'install' | 'activate' | 'deactivate' | 'update' | 'uninstall';

export interface LifecycleStep {
  args: string[];
  note?: string;
}

export interface LifecyclePlan {
  plugin?: string;
  action: PluginLifecycleAction;
  steps: LifecycleStep[];
  keepUserData: boolean;
  theme: boolean;
}

export interface LifecycleStepResult extends LifecycleStep {
  ok: boolean;
  reason?: string;
  message?: string;
  hint?: string;
}

export interface LifecycleRun {
  plan: LifecyclePlan;
  dryRun: boolean;
  executed: LifecycleStepResult[]; // empty in dry-run
  ok: boolean;
  failedStep?: LifecycleStepResult;
}

export interface PluginListReportOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
}

export interface PluginOverviewOptions extends PluginListReportOptions {
  limit?: number;
}

export interface PluginLifecycleRunOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
  confirm?: boolean;
}

type PlainObject = Record<string, unknown>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_SCAN_FILES = 2000;
const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git']);
const SCHEDULED_TASK_TAG = 'shopware.scheduled.task';

const ACTIONS = new Set<PluginLifecycleAction>([
  'refresh',
  'install',
  'activate',
  'deactivate',
  'update',
  'uninstall',
]);

const STATE_CHANGE_ACTIONS = new Set<PluginLifecycleAction>([
  'install',
  'activate',
  'deactivate',
  'update',
  'uninstall',
]);

interface WalkState {
  files: string[];
  capped: boolean;
}

interface LocatedService {
  service: StaticService;
  absFile: string;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function toSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function relPath(root: string, abs: string): string {
  return toSlashes(relative(root, abs));
}

function readLines(file: string): string[] | null {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

function findLineContaining(file: string, needle: string): number {
  const lines = readLines(file);
  if (!lines) return 1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].includes(needle)) return index + 1;
  }
  return 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findClassLine(file: string, className: string): number {
  const lines = readLines(file);
  if (!lines) return 1;
  const pattern = new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\b`);
  for (let index = 0; index < lines.length; index++) {
    if (pattern.test(lines[index])) return index + 1;
  }
  return 1;
}

function walkFiles(base: string, match: (name: string) => boolean, state: WalkState): void {
  if (state.capped) return;

  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.capped) return;
    const full = join(base, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, match, state);
      continue;
    }

    if (!entry.isFile() || !match(entry.name)) continue;
    if (state.files.length >= MAX_SCAN_FILES) {
      state.capped = true;
      return;
    }
    state.files.push(full);
  }
}

function collectFiles(base: string, match: (name: string) => boolean): WalkState {
  const state: WalkState = { files: [], capped: false };
  if (existsSync(base)) walkFiles(base, match, state);
  return state;
}

/** `theme.json` lives in `<plugin>/src/Resources/` or `<plugin>/Resources/`. */
export function isThemePlugin(path: string | null): boolean {
  if (!path) return false;
  return (
    existsSync(join(path, 'src', 'Resources', 'theme.json')) ||
    existsSync(join(path, 'Resources', 'theme.json'))
  );
}

function readComposerVersion(pluginPath: string | null): string | undefined {
  if (!pluginPath) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(pluginPath, 'composer.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isPlainObject(data)) return undefined;
  const version = data.version;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
}

/**
 * Read plugin service definitions from the plugin root and from
 * `src/Resources` (the Shopware location of `config/services.xml`). Files are
 * resolved to absolute paths and deduplicated by id + file.
 */
function readPluginServices(pluginPath: string): LocatedService[] {
  const bases = [pluginPath, join(pluginPath, 'src', 'Resources')];
  const seen = new Set<string>();
  const located: LocatedService[] = [];

  for (const base of bases) {
    let services: StaticService[];
    try {
      services = readStaticServices(base);
    } catch {
      continue;
    }
    for (const service of services) {
      const absFile = service.file ? resolve(base, service.file) : base;
      const key = `${service.id}\u0000${absFile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      located.push({ service, absFile });
    }
  }

  return located;
}

function shortClassName(fqcn: string | undefined): string | undefined {
  if (!fqcn) return undefined;
  const parts = fqcn.split('\\');
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : undefined;
}

function entityKindOf(fileName: string): EntityReport['kind'] | null {
  if (fileName.endsWith('Definition.php')) return 'definition';
  if (fileName.endsWith('Extension.php')) return 'extension';
  if (fileName.endsWith('Collection.php')) return 'collection';
  if (fileName.endsWith('Entity.php')) return 'entity';
  return null;
}

export async function listPluginReport(
  options: PluginListReportOptions
): Promise<PluginListReport> {
  let result: PluginListResult;
  try {
    result = await listPlugins(options);
  } catch {
    return { plugins: [], source: 'static', incomplete: true, reason: 'no-console' };
  }

  const plugins = result.plugins.map((plugin, order) => {
    const composerVersion = readComposerVersion(plugin.path);
    const updateAvailable =
      plugin.version && composerVersion ? plugin.version !== composerVersion : null;
    return {
      order,
      name: plugin.name,
      version: plugin.version,
      active: plugin.active,
      kind: plugin.kind,
      path: plugin.path,
      theme: isThemePlugin(plugin.path),
      updateAvailable,
    };
  });

  return {
    plugins,
    source: result.source,
    incomplete: result.incomplete,
    reason: result.reason,
  };
}

interface OverviewAccumulator {
  incomplete: boolean;
  truncated: Set<string>;
}

function buildServiceReports(
  root: string,
  located: LocatedService[],
  limit: number
): {
  services: ServiceReport[];
  scheduledTasks: ServiceReport[];
  truncated: boolean;
} {
  const services: ServiceReport[] = [];
  const scheduledTasks: ServiceReport[] = [];
  let truncated = false;

  for (const { service, absFile } of located) {
    const report: ServiceReport = {
      id: service.id,
      class: service.class,
      tags: service.tags.map((tag) => tag.name),
      path: relPath(root, absFile),
      line: findLineContaining(absFile, service.id),
    };

    if (report.tags.includes(SCHEDULED_TASK_TAG)) {
      if (scheduledTasks.length < limit) scheduledTasks.push(report);
      else truncated = true;
    }

    if (services.length < limit) services.push(report);
    else truncated = true;
  }

  return { services, scheduledTasks, truncated };
}

function buildSubscriberReports(
  root: string,
  pluginPath: string,
  listeners: Awaited<ReturnType<typeof collectStaticListeners>>,
  limit: number,
  acc: OverviewAccumulator
): SubscriberReport[] {
  const phpFiles = collectFiles(join(pluginPath, 'src'), (name) => name.endsWith('.php'));
  if (phpFiles.capped) acc.incomplete = true;

  const reports: SubscriberReport[] = [];
  for (const listener of listeners) {
    if (reports.length >= limit) {
      acc.truncated.add('subscribers');
      break;
    }

    const shortName = shortClassName(listener.class);
    let path = relPath(root, pluginPath);
    let line = 1;

    if (shortName) {
      const file = phpFiles.files.find((candidate) => {
        const name = candidate.slice(candidate.lastIndexOf('/') + 1);
        return name === `${shortName}.php`;
      });
      if (file) {
        path = relPath(root, file);
        line = findClassLine(file, shortName);
      } else {
        acc.incomplete = true;
      }
    } else {
      acc.incomplete = true;
    }

    reports.push({
      event: listener.event,
      class: listener.class,
      method: listener.method,
      priority: listener.priority,
      path,
      line,
    });
  }

  return reports;
}

function buildEntityReports(
  root: string,
  pluginPath: string,
  limit: number,
  acc: OverviewAccumulator
): EntityReport[] {
  const scan = collectFiles(join(pluginPath, 'src'), (name) => name.endsWith('.php'));
  if (scan.capped) acc.incomplete = true;

  const reports: EntityReport[] = [];
  const seen = new Set<string>();

  for (const file of scan.files) {
    if (reports.length >= limit) {
      acc.truncated.add('entities');
      break;
    }

    const fileName = file.slice(file.lastIndexOf('/') + 1);
    const kind = entityKindOf(fileName);
    if (!kind) continue;

    const key = resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);

    const className = fileName.slice(0, -'.php'.length);
    reports.push({
      class: className,
      kind,
      path: relPath(root, file),
      line: findClassLine(file, className),
    });
  }

  return reports;
}

function buildTwigReports(
  root: string,
  pluginPath: string,
  limit: number,
  acc: OverviewAccumulator
): ReportRef[] {
  const bases = [
    join(pluginPath, 'src', 'Resources', 'views'),
    join(pluginPath, 'Resources', 'views'),
  ];
  const reports: ReportRef[] = [];
  const seen = new Set<string>();

  for (const base of bases) {
    if (reports.length >= limit) {
      acc.truncated.add('twigOverrides');
      break;
    }
    const scan = collectFiles(base, (name) => name.endsWith('.twig'));
    if (scan.capped) acc.incomplete = true;

    for (const file of scan.files) {
      if (reports.length >= limit) {
        acc.truncated.add('twigOverrides');
        break;
      }
      const key = resolve(file);
      if (seen.has(key)) continue;
      seen.add(key);
      reports.push({ path: relPath(root, file), line: 1 });
    }
  }

  return reports;
}

function buildMigrationReports(
  root: string,
  pluginPath: string,
  limit: number,
  acc: OverviewAccumulator
): ReportRef[] {
  const scan = collectFiles(join(pluginPath, 'src', 'Migration'), (name) => name.endsWith('.php'));
  if (scan.capped) acc.incomplete = true;

  const reports: ReportRef[] = [];
  for (const file of scan.files) {
    if (reports.length >= limit) {
      acc.truncated.add('migrations');
      break;
    }
    const fileName = file.slice(file.lastIndexOf('/') + 1);
    const className = fileName.slice(0, -'.php'.length);
    reports.push({ path: relPath(root, file), line: findClassLine(file, className) });
  }

  return reports;
}

function buildAdminModules(
  root: string,
  pluginPath: string,
  limit: number,
  acc: OverviewAccumulator
): AdminModuleReport[] {
  const moduleDir = join(pluginPath, 'src', 'Resources', 'app', 'administration', 'src', 'module');

  let entries: Dirent[];
  try {
    entries = readdirSync(moduleDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const modules: AdminModuleReport[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (modules.length >= limit) {
      acc.truncated.add('adminModules');
      break;
    }
    modules.push({
      name: entry.name,
      path: relPath(root, join(moduleDir, entry.name)),
    });
  }

  return modules;
}

export async function pluginOverview(
  plugin: string,
  options: PluginOverviewOptions
): Promise<PluginOverview> {
  const limit = normalizeLimit(options.limit);

  let result: PluginListResult;
  try {
    result = await listPlugins(options);
  } catch {
    result = { plugins: [], source: 'static', incomplete: true, reason: 'no-console' };
  }

  const wanted = plugin.trim().toLowerCase();
  const found = result.plugins.find((candidate) => candidate.name.toLowerCase() === wanted);
  const available = result.plugins.map((candidate) => candidate.name);

  if (!found) {
    return {
      plugin,
      path: '',
      active: false,
      theme: false,
      services: [],
      subscribers: [],
      entities: [],
      twigOverrides: [],
      migrations: [],
      adminModules: [],
      scheduledTasks: [],
      incomplete: true,
      truncated: [],
      available,
      hint:
        available.length > 0
          ? `Unknown plugin '${plugin}'. Known plugins: ${available.join(', ')}.`
          : `Unknown plugin '${plugin}'. No plugins were discovered.`,
    };
  }

  const pluginPath = found.path;
  const theme = isThemePlugin(pluginPath);
  const acc: OverviewAccumulator = { incomplete: pluginPath === null, truncated: new Set() };

  const base: PluginOverview = {
    plugin: found.name,
    path: pluginPath ? relPath(options.root, pluginPath) : '',
    version: found.version,
    active: found.active,
    theme,
    services: [],
    subscribers: [],
    entities: [],
    twigOverrides: [],
    migrations: [],
    adminModules: [],
    scheduledTasks: [],
    incomplete: false,
    truncated: [],
  };

  if (theme) {
    base.themeHint = 'theme detected — use sw6_theme for the storefront view chain';
  }

  if (!pluginPath) {
    base.available = available;
    base.incomplete = true;
    base.truncated = [];
    return base;
  }

  const serviceReports = buildServiceReports(options.root, readPluginServices(pluginPath), limit);
  if (serviceReports.truncated) acc.truncated.add('services');

  let listeners: Awaited<ReturnType<typeof collectStaticListeners>> = [];
  try {
    listeners = await collectStaticListeners(pluginPath);
  } catch {
    acc.incomplete = true;
  }

  base.services = serviceReports.services;
  base.scheduledTasks = serviceReports.scheduledTasks;
  base.subscribers = buildSubscriberReports(options.root, pluginPath, listeners, limit, acc);
  base.entities = buildEntityReports(options.root, pluginPath, limit, acc);
  base.twigOverrides = buildTwigReports(options.root, pluginPath, limit, acc);
  base.migrations = buildMigrationReports(options.root, pluginPath, limit, acc);
  base.adminModules = buildAdminModules(options.root, pluginPath, limit, acc);
  base.incomplete = acc.incomplete;
  base.truncated = [...acc.truncated];

  return base;
}

/** Pure lifecycle planner. Throws on invalid/unsupported combinations. */
export function planPluginLifecycle(input: {
  action: PluginLifecycleAction;
  plugin?: string;
  theme?: boolean;
  keepUserData?: boolean;
}): LifecyclePlan {
  const { action } = input;
  if (!ACTIONS.has(action)) {
    throw new Error(`Unsupported plugin lifecycle action: ${String(action)}`);
  }

  const keepUserData = input.keepUserData ?? true;
  const themeRequested = input.theme === true;

  if (action === 'refresh') {
    return {
      plugin: undefined,
      action,
      steps: [{ args: ['plugin:refresh'] }, { args: ['cache:clear'] }],
      keepUserData,
      theme: false,
    };
  }

  const plugin = input.plugin?.trim() || undefined;
  if (!plugin) {
    throw new Error(`Action '${action}' requires a plugin name`);
  }

  const steps: LifecycleStep[] = [];
  if (action === 'uninstall') {
    const args = ['plugin:uninstall', plugin];
    if (keepUserData) args.push('--keep-user-data');
    steps.push({ args });
  } else {
    steps.push({ args: [`plugin:${action}`, plugin] });
  }
  steps.push({ args: ['cache:clear'] });

  const themeCompile = STATE_CHANGE_ACTIONS.has(action) && themeRequested;
  if (themeCompile) steps.push({ args: ['theme:compile'] });

  return { plugin, action, steps, keepUserData, theme: themeCompile };
}

export async function runPluginLifecycle(
  plan: LifecyclePlan,
  options: PluginLifecycleRunOptions
): Promise<LifecycleRun> {
  if (options.confirm !== true) {
    return { plan, dryRun: true, executed: [], ok: true };
  }

  const executed: LifecycleStepResult[] = [];
  let ok = true;
  let failedStep: LifecycleStepResult | undefined;
  let current: LifecycleStep | undefined;

  try {
    for (const step of plan.steps) {
      current = step;
      const result = await runConsole(options.consolePath ?? null, step.args, {
        cwd: options.root,
        runner: options.runner,
      });

      if (result.ok) {
        executed.push({ ...step, ok: true });
        continue;
      }

      const failure: LifecycleStepResult = {
        ...step,
        ok: false,
        reason: result.reason,
        message: result.message,
        hint: result.hint,
      };
      executed.push(failure);
      failedStep = failure;
      ok = false;
      break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure: LifecycleStepResult = {
      ...(current ?? { args: [] }),
      ok: false,
      reason: 'unknown',
      message,
    };
    executed.push(failure);
    failedStep = failure;
    ok = false;
  }

  return { plan, dryRun: false, executed, ok, failedStep };
}
