// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listThemes,
  resolveThemeViewChain,
  resolveSalesChannelViewChain,
  type ThemeListResult,
} from '../src/lib/shopware/themes';
import { listPlugins, type PluginListResult } from '../src/lib/shopware/plugins';
import type { ConsoleRunner, RawConsoleResult } from '../src/lib/framework/console';

const fixtureRoot = (path: string) =>
  new URL(`./fixtures/shopware/${path}`, import.meta.url).pathname;

const projectRoot = fixtureRoot('project');
const consolePath = fixtureRoot('project/bin/console');
const channelId = '000000000000000000000000000000aa';

const consoleFixture = (name: string): string =>
  readFileSync(fixtureRoot(`console/${name}`), 'utf8');

function raw(stdout: string, exitCode = 0): RawConsoleResult {
  return { exitCode, stdout, stderr: '' };
}

async function runtimePlugins(): Promise<PluginListResult> {
  const runner: ConsoleRunner = async () => raw(consoleFixture('plugin-list.json'));
  return listPlugins({ root: projectRoot, consolePath, runner });
}

function themeRunner(calls?: string[][]): ConsoleRunner {
  return async (cmd: string[]) => {
    calls?.push(cmd);
    return raw(
      cmd.some((arg) => arg.includes('theme_sales_channel'))
        ? consoleFixture('theme-sales-channel-rows.json')
        : consoleFixture('theme-rows.json')
    );
  };
}

async function runtimeThemes(calls?: string[][]): Promise<ThemeListResult> {
  return listThemes({ root: projectRoot, consolePath, runner: themeRunner(calls) });
}

describe('listThemes — runtime', () => {
  it('merges DB rows with theme.json data and resolves the parent name', async () => {
    const calls: string[][] = [];
    const result = await runtimeThemes(calls);

    expect(result.source).toBe('runtime');
    expect(result.incomplete).toBe(false);

    const child = result.themes.find((theme) => theme.name === 'ChildTheme');
    expect(child?.views).toEqual(['@Storefront', '@Plugins']);
    expect(child?.parentName).toBe('ParentTheme');
    expect(child?.path).toBe(
      join(projectRoot, 'custom', 'static-plugins', 'ChildTheme', 'src', 'Resources')
    );

    const parent = result.themes.find((theme) => theme.name === 'ParentTheme');
    expect(parent?.parentName).toBeUndefined();
    expect(parent?.views).toEqual(['@Storefront']);

    expect(result.assignments).toEqual([{ themeName: 'ChildTheme', salesChannelId: channelId }]);

    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe('dbal:run-sql');
    expect(calls[0][2]).toContain('FROM theme');
    expect(calls[0]).toContain('--format=json');
    expect(calls[1][2]).toContain('theme_sales_channel');
  });

  it('marks a DB-only theme incomplete with empty views and no path', async () => {
    const runner: ConsoleRunner = async (cmd: string[]) => {
      if (cmd.some((arg) => arg.includes('theme_sales_channel'))) return raw('[]');
      return raw(
        JSON.stringify([
          {
            id: '00000000000000000000000000000009',
            name: 'OrphanTheme',
            technical_name: 'OrphanTheme',
            parent_theme_id: null,
          },
        ])
      );
    };

    const result = await listThemes({ root: projectRoot, consolePath, runner });
    expect(result.source).toBe('runtime');
    expect(result.incomplete).toBe(true);
    expect(result.themes[0].views).toEqual([]);
    expect(result.themes[0].path).toBeNull();
    expect(result.reason).toContain('theme.json');
  });
});

describe('view chain', () => {
  it('AC1: orders theme → parent → plugins → storefront', async () => {
    const themes = await runtimeThemes();
    const plugins = await runtimePlugins();

    const chain = resolveThemeViewChain('ChildTheme', themes, plugins, projectRoot);

    expect(chain.roots.map((root) => root.origin)).toEqual([
      'theme:ChildTheme',
      'parent:ParentTheme',
      'plugin:AlphaPlugin',
      'plugin:ThemePlugin',
      'storefront',
    ]);
    expect(chain.roots[0].path).toBe(
      join(projectRoot, 'custom', 'static-plugins', 'ChildTheme', 'src', 'Resources', 'views')
    );
    expect(chain.roots[1].path).toBe(
      join(projectRoot, 'custom', 'static-plugins', 'ParentTheme', 'src', 'Resources', 'views')
    );
    expect(chain.unresolved).toEqual([]);
    expect(chain.incomplete).toBe(false);
  });

  it('AC1: maps a sales channel id to the same theme chain', async () => {
    const themes = await runtimeThemes();
    const plugins = await runtimePlugins();

    const chain = resolveSalesChannelViewChain(channelId, themes, plugins, projectRoot);

    expect(chain.roots.map((root) => root.origin)).toEqual([
      'theme:ChildTheme',
      'parent:ParentTheme',
      'plugin:AlphaPlugin',
      'plugin:ThemePlugin',
      'storefront',
    ]);
    expect(chain.incomplete).toBe(false);
  });

  it('AC2: @Plugins expands only ACTIVE plugins in load order', async () => {
    const themes = await runtimeThemes();
    const plugins = await runtimePlugins();

    const chain = resolveThemeViewChain('ChildTheme', themes, plugins, projectRoot);
    const pluginOrigins = chain.roots
      .map((root) => root.origin)
      .filter((origin) => origin.startsWith('plugin:'));

    expect(pluginOrigins).toEqual(['plugin:AlphaPlugin', 'plugin:ThemePlugin']);
    expect(pluginOrigins).not.toContain('plugin:BetaPlugin');
  });

  it('returns an honest unresolved marker for an unknown sales channel', async () => {
    const themes = await runtimeThemes();
    const plugins = await runtimePlugins();

    const chain = resolveSalesChannelViewChain('deadbeef', themes, plugins, projectRoot);
    expect(chain.roots).toEqual([]);
    expect(chain.unresolved).toEqual(['sales-channel:deadbeef']);
    expect(chain.incomplete).toBe(true);
  });

  it('de-duplicates roots and reports unknown view tokens', () => {
    const themes: ThemeListResult = {
      themes: [
        {
          name: 'DupTheme',
          views: ['@Storefront', '@Storefront', '@DupTheme', '@MissingTheme'],
          path: join(projectRoot, 'custom', 'static-plugins', 'ParentTheme', 'src', 'Resources'),
        },
      ],
      assignments: [],
      source: 'runtime',
      incomplete: false,
    };
    const plugins: PluginListResult = { plugins: [], source: 'runtime', incomplete: false };

    const chain = resolveThemeViewChain('DupTheme', themes, plugins, projectRoot);

    expect(chain.roots.map((root) => root.origin)).toEqual(['theme:DupTheme', 'storefront']);
    expect(chain.unresolved).toEqual(['@MissingTheme']);
    expect(chain.incomplete).toBe(true);
  });

  it('honours a non-standard views order: storefront before plugins', async () => {
    const plugins = await runtimePlugins();
    const themes: ThemeListResult = {
      themes: [
        {
          name: 'OrderTheme',
          views: ['@Plugins', '@Storefront'],
          path: join(projectRoot, 'custom', 'static-plugins', 'OrderTheme', 'src', 'Resources'),
        },
      ],
      assignments: [],
      source: 'runtime',
      incomplete: false,
    };

    const chain = resolveThemeViewChain('OrderTheme', themes, plugins, projectRoot);

    expect(chain.roots.map((root) => root.origin)).toEqual([
      'theme:OrderTheme',
      'storefront',
      'plugin:AlphaPlugin',
      'plugin:ThemePlugin',
    ]);
    const storefrontIndex = chain.roots.findIndex((root) => root.origin === 'storefront');
    const firstPluginIndex = chain.roots.findIndex((root) => root.origin.startsWith('plugin:'));
    expect(storefrontIndex).toBeLessThan(firstPluginIndex);
  });

  it('resolves @ParentTheme and @ChildTheme without duplicating roots', async () => {
    const plugins = await runtimePlugins();
    const themes: ThemeListResult = {
      themes: [
        {
          name: 'ChildTheme',
          parentName: 'ParentTheme',
          views: ['@Storefront', '@Plugins', '@ParentTheme', '@ChildTheme'],
          path: join(projectRoot, 'custom', 'static-plugins', 'ChildTheme', 'src', 'Resources'),
        },
        {
          name: 'ParentTheme',
          views: ['@Storefront'],
          path: join(projectRoot, 'custom', 'static-plugins', 'ParentTheme', 'src', 'Resources'),
        },
      ],
      assignments: [],
      source: 'runtime',
      incomplete: false,
    };

    const chain = resolveThemeViewChain('ChildTheme', themes, plugins, projectRoot);

    expect(chain.roots.map((root) => root.origin)).toEqual([
      'theme:ChildTheme',
      'parent:ParentTheme',
      'plugin:AlphaPlugin',
      'plugin:ThemePlugin',
      'storefront',
    ]);
    expect(chain.unresolved).toEqual([]);
    expect(chain.incomplete).toBe(false);
  });

  it('does not emit a view root that does not exist', () => {
    const themes: ThemeListResult = {
      themes: [
        {
          name: 'GhostTheme',
          views: ['@Storefront'],
          path: join(projectRoot, 'custom', 'static-plugins', 'GhostTheme', 'src', 'Resources'),
        },
      ],
      assignments: [],
      source: 'runtime',
      incomplete: false,
    };
    const plugins: PluginListResult = { plugins: [], source: 'runtime', incomplete: false };

    const chain = resolveThemeViewChain('GhostTheme', themes, plugins, projectRoot);

    expect(chain.roots.map((root) => root.origin)).toEqual(['storefront']);
    expect(chain.roots.some((root) => root.origin.startsWith('theme:'))).toBe(false);
    expect(chain.incomplete).toBe(true);
  });
});

describe('listThemes — static fallback', () => {
  it('AC3: scans theme.json without a console and never throws', async () => {
    const themes = await listThemes({ root: projectRoot, consolePath: null });
    const plugins = await listPlugins({ root: projectRoot, consolePath: null });

    expect(themes.source).toBe('static');
    expect(themes.incomplete).toBe(true);
    expect(themes.reason).toBe('no-console');
    expect(themes.assignments).toEqual([]);
    expect(themes.themes.map((theme) => theme.name)).toContain('ChildTheme');
    expect(themes.themes.map((theme) => theme.name)).toContain('ThemePlugin');

    const child = themes.themes.find((theme) => theme.name === 'ChildTheme');
    expect(child?.views).toEqual(['@Storefront', '@Plugins']);
    expect(child?.parentName).toBeUndefined();

    const chain = resolveThemeViewChain('ChildTheme', themes, plugins, projectRoot);
    expect(chain.roots[0].origin).toBe('theme:ChildTheme');
    expect(chain.roots.some((root) => root.origin.startsWith('parent:'))).toBe(false);
    expect(chain.roots.some((root) => root.origin.startsWith('plugin:'))).toBe(false);
    expect(chain.incomplete).toBe(true);
  });

  it('falls back to static when the SQL output is a text table', async () => {
    const runner: ConsoleRunner = async () => raw(consoleFixture('theme-rows.txt'));
    const result = await listThemes({ root: projectRoot, consolePath, runner });

    expect(result.source).toBe('static');
    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('invalid-json');
    expect(result.themes.map((theme) => theme.name)).toContain('ChildTheme');
  });

  it('falls back to static when the console fails', async () => {
    const runner: ConsoleRunner = async () => raw('', 1);
    const result = await listThemes({ root: projectRoot, consolePath, runner });

    expect(result.source).toBe('static');
    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('console-failed');
  });

  it('never throws for a missing project root', async () => {
    const result = await listThemes({ root: fixtureRoot('does-not-exist'), consolePath: null });
    expect(result.source).toBe('static');
    expect(result.themes).toEqual([]);
    expect(result.incomplete).toBe(true);
  });
});
