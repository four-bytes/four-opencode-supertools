// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Shopware Storefront bridge for the Twig tools. Resolves the effective view
 * chain per theme (Storefront → plugins → theme) and turns it into `TwigLoaders`
 * that `buildBlockChain` / `buildTemplateChain` understand.
 *
 * Shopware's own tags (`sw_extends`, `sw_include`, …) are mapped onto the
 * built-in Twig semantics; every other `sw_`-prefixed tag is treated as known
 * so it is never reported as unknown. Nothing here throws.
 */

import { listPlugins, type PluginListResult } from '../shopware/plugins';
import {
  listThemes,
  resolveSalesChannelViewChain,
  resolveThemeViewChain,
  type ThemeListResult,
  type ViewRoot,
} from '../shopware/themes';
import type { ConsoleRunner } from '../framework/console';
import type { TwigLoaders } from './resolver';

/** Shopware Storefront tag → built-in Twig semantics. */
export const SHOPWARE_TAG_ALIASES: Readonly<Record<string, string>> = {
  sw_extends: 'extends',
  sw_include: 'include',
  sw_embed: 'embed',
  sw_use: 'use',
};

/** Every `sw_`-prefixed tag is Shopware-specific and must never be reported as unknown. */
export const SHOPWARE_TAG_PREFIXES: readonly string[] = ['sw_'];

export interface ShopwareTwigChain {
  theme: string;
  salesChannelIds: string[]; // from ThemeAssignment, sorted
  roots: ViewRoot[]; // most specific first, as returned by resolveThemeViewChain
  loaders: TwigLoaders;
  incomplete: boolean;
  unresolved: string[];
}

export interface ShopwareTwigContext {
  chains: ShopwareTwigChain[]; // one per distinct theme, sorted by theme name; empty when nothing resolved
  tagMap: Record<string, string>; // aliases + discovered + config (later wins)
  knownTagPrefixes: readonly string[]; // SHOPWARE_TAG_PREFIXES
  themes: ThemeListResult;
  plugins: PluginListResult;
  incomplete: boolean;
  reason?: string;
}

export interface ShopwareTwigContextOptions {
  root: string;
  consolePath?: string | null;
  runner?: ConsoleRunner;
  /** discovery tag map (from discoverCustomTags) */
  tags?: Readonly<Record<string, string>>;
  /** .supertools.json twig.tags — highest priority */
  configTags?: Readonly<Record<string, string>>;
  /** optional theme name filter (matches name or technicalName, case-insensitive) */
  theme?: string;
  /** optional sales channel id filter (hex id as used by theme_sales_channel) */
  salesChannel?: string;
}

function namespaceForOrigin(origin: string): string | null {
  if (origin === 'storefront') return '@Storefront';
  const separator = origin.indexOf(':');
  if (separator === -1) return null;
  const kind = origin.slice(0, separator);
  const name = origin.slice(separator + 1);
  if (name.length === 0) return null;
  if (kind === 'plugin' || kind === 'theme' || kind === 'parent') return `@${name}`;
  return null;
}

function buildLoaders(
  roots: ViewRoot[],
  source: 'runtime' | 'static',
  incomplete: boolean
): TwigLoaders {
  // buildBlockChain breaks ties by scan order, which must be base → derived.
  const paths = roots.map((root) => root.path).reverse();
  const namespaces: Record<string, string> = {};
  for (const root of roots) {
    const namespace = namespaceForOrigin(root.origin);
    if (!namespace) continue;
    if (Object.prototype.hasOwnProperty.call(namespaces, namespace)) continue;
    namespaces[namespace] = root.path;
  }

  return { paths, namespaces, source, incomplete };
}

function findThemeName(list: ThemeListResult, query: string): string | null {
  const needle = query.toLowerCase();
  const theme = list.themes.find(
    (candidate) =>
      candidate.name.toLowerCase() === needle || candidate.technicalName?.toLowerCase() === needle
  );
  return theme ? theme.name : null;
}

function distinctThemeNames(list: ThemeListResult): string[] {
  return [...new Set(list.themes.map((theme) => theme.name))].sort((a, b) => a.localeCompare(b));
}

function salesChannelIdsFor(themeName: string, list: ThemeListResult): string[] {
  const needle = themeName.toLowerCase();
  return list.assignments
    .filter((assignment) => assignment.themeName.toLowerCase() === needle)
    .map((assignment) => assignment.salesChannelId)
    .sort();
}

function makeChain(
  theme: string,
  roots: ViewRoot[],
  unresolved: string[],
  viewIncomplete: boolean,
  source: 'runtime' | 'static',
  baseIncomplete: boolean,
  assignments: string[]
): ShopwareTwigChain {
  const incomplete = viewIncomplete || baseIncomplete;
  return {
    theme,
    salesChannelIds: assignments,
    roots,
    loaders: buildLoaders(roots, source, incomplete),
    incomplete,
    unresolved,
  };
}

/**
 * Resolve the Shopware Twig context: plugins, themes and one `TwigLoaders`
 * chain per resolved theme. Never throws; every unresolved detail is reported
 * through `incomplete`, `unresolved` or `reason`.
 */
export async function resolveShopwareTwigContext(
  options: ShopwareTwigContextOptions
): Promise<ShopwareTwigContext> {
  const { root, consolePath } = options;
  const tagMap: Record<string, string> = {
    ...SHOPWARE_TAG_ALIASES,
    ...(options.tags ?? {}),
    ...(options.configTags ?? {}),
  };

  try {
    const [plugins, themes] = await Promise.all([
      listPlugins({ root, consolePath, runner: options.runner }),
      listThemes({ root, consolePath, runner: options.runner }),
    ]);

    const source: 'runtime' | 'static' = themes.source === 'runtime' ? 'runtime' : 'static';
    const baseIncomplete = plugins.incomplete || themes.incomplete;

    let chains: ShopwareTwigChain[] = [];
    let reason: string | undefined;

    if (options.theme !== undefined) {
      const themeName = findThemeName(themes, options.theme);
      if (themeName) {
        const view = resolveThemeViewChain(themeName, themes, plugins, root);
        chains = [
          makeChain(
            themeName,
            view.roots,
            view.unresolved,
            view.incomplete,
            source,
            baseIncomplete,
            salesChannelIdsFor(themeName, themes)
          ),
        ];
      } else {
        reason = 'theme-not-found';
      }
    } else if (options.salesChannel !== undefined) {
      const needle = options.salesChannel.toLowerCase();
      const assignment = themes.assignments.find(
        (entry) => entry.salesChannelId.toLowerCase() === needle
      );
      if (!assignment) {
        reason = 'sales-channel-unassigned';
      } else {
        const themeName = findThemeName(themes, assignment.themeName) ?? assignment.themeName;
        const view = resolveSalesChannelViewChain(options.salesChannel, themes, plugins, root);
        chains = [
          makeChain(
            themeName,
            view.roots,
            view.unresolved,
            view.incomplete,
            source,
            baseIncomplete,
            salesChannelIdsFor(themeName, themes)
          ),
        ];
      }
    } else {
      chains = distinctThemeNames(themes).map((themeName) => {
        const view = resolveThemeViewChain(themeName, themes, plugins, root);
        return makeChain(
          themeName,
          view.roots,
          view.unresolved,
          view.incomplete,
          source,
          baseIncomplete,
          salesChannelIdsFor(themeName, themes)
        );
      });
      chains.sort((a, b) => a.theme.localeCompare(b.theme));
    }

    const incomplete =
      baseIncomplete || chains.length === 0 || chains.some((chain) => chain.incomplete);

    return {
      chains,
      tagMap,
      knownTagPrefixes: SHOPWARE_TAG_PREFIXES,
      themes,
      plugins,
      incomplete,
      ...(reason !== undefined ? { reason } : {}),
    };
  } catch {
    return {
      chains: [],
      tagMap,
      knownTagPrefixes: SHOPWARE_TAG_PREFIXES,
      themes: { themes: [], assignments: [], source: 'static', incomplete: true },
      plugins: { plugins: [], source: 'static', incomplete: true },
      incomplete: true,
      reason: 'unexpected-error',
    };
  }
}
