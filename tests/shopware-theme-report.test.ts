// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compileTheme,
  listThemeReport,
  parseScssErrors,
  resolveThemeReport,
} from '../src/lib/shopware/theme-report';
import type { ThemeListResult } from '../src/lib/shopware/themes';
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

function themeRunner(): ConsoleRunner {
  return async (cmd: string[]) => {
    const joined = cmd.join(' ');
    if (joined.includes('theme_sales_channel')) {
      return raw(consoleFixture('theme-sales-channel-rows.json'));
    }
    return raw(consoleFixture('theme-rows.json'));
  };
}

function fullRunner(): ConsoleRunner {
  return async (cmd: string[]) => {
    const joined = cmd.join(' ');
    if (joined.includes('theme_sales_channel')) {
      return raw(consoleFixture('theme-sales-channel-rows.json'));
    }
    if (joined.includes('plugin:list')) {
      return raw(consoleFixture('plugin-list.json'));
    }
    return raw(consoleFixture('theme-rows.json'));
  };
}

describe('listThemeReport', () => {
  it('resolves parent chains and sales-channel assignments from runtime data', async () => {
    const report = await listThemeReport({ root: projectRoot, consolePath, runner: themeRunner() });

    expect(report.source).toBe('runtime');
    expect(report.incomplete).toBe(false);
    expect(report.unresolvedParents).toEqual([]);

    const child = report.themes.find((theme) => theme.name === 'ChildTheme');
    expect(child?.parentChain).toEqual(['ChildTheme', 'ParentTheme']);
    expect(child?.salesChannelIds).toEqual([channelId]);

    const parent = report.themes.find((theme) => theme.name === 'ParentTheme');
    expect(parent?.parentChain).toEqual(['ParentTheme']);
    expect(parent?.salesChannelIds).toEqual([]);
  });

  it('marks an unknown parent as unresolved and incomplete', async () => {
    const themeList: ThemeListResult = {
      themes: [
        {
          name: 'OrphanChild',
          technicalName: 'OrphanChild',
          parentName: 'GhostParent',
          views: ['@Storefront'],
          path: join(projectRoot, 'custom', 'static-plugins', 'ChildTheme', 'src', 'Resources'),
        },
      ],
      assignments: [],
      source: 'runtime',
      incomplete: false,
    };

    const report = await listThemeReport({ root: projectRoot, consolePath: null, themeList });

    expect(report.unresolvedParents).toEqual(['GhostParent']);
    expect(report.incomplete).toBe(true);
    expect(report.themes[0].parentChain).toEqual(['OrphanChild']);
  });
});

describe('resolveThemeReport', () => {
  it('orders the view chain and declared assets most-specific first', async () => {
    const report = await resolveThemeReport('ChildTheme', {
      root: projectRoot,
      consolePath,
      runner: fullRunner(),
    });

    expect(report.theme).toBe('ChildTheme');
    expect(report.parentChain).toEqual(['ChildTheme', 'ParentTheme']);
    expect(report.roots.map((root) => root.origin)).toEqual([
      'theme:ChildTheme',
      'parent:ParentTheme',
      'plugin:AlphaPlugin',
      'plugin:ThemePlugin',
      'storefront',
    ]);
    expect(report.unresolved).toEqual([]);
    expect(report.incomplete).toBe(false);
    expect(report.salesChannelIds).toEqual([channelId]);

    expect(report.assets.map((asset) => asset.entry)).toEqual([
      'app/storefront/src/scss/base.scss',
      'app/storefront/src/scss/child.scss',
      'app/storefront/src/js/child.js',
      'app/storefront/src/js/missing.js',
      'app/storefront/src/scss/parent.scss',
    ]);
    expect(report.assets.map((asset) => asset.origin)).toEqual([
      'theme',
      'theme',
      'theme',
      'theme',
      'parent',
    ]);
    expect(report.assets.map((asset) => asset.kind)).toEqual([
      'style',
      'style',
      'script',
      'script',
      'style',
    ]);
    expect(report.assets.map((asset) => asset.exists)).toEqual([true, true, true, false, true]);
    expect(report.assets[0].path).toBe(
      'custom/static-plugins/ChildTheme/src/Resources/app/storefront/src/scss/base.scss'
    );
  });
});

describe('parseScssErrors', () => {
  it('keeps only the two real diagnostics and drops console noise', () => {
    const { errors, truncated } = parseScssErrors(
      consoleFixture('theme-compile-error.txt'),
      projectRoot
    );

    expect(truncated).toBe(false);
    expect(errors).toEqual([
      {
        path: 'app/storefront/src/scss/base.scss',
        line: 12,
        column: 5,
        message: 'Undefined variable $brand-color.',
      },
      {
        path: 'app/storefront/src/scss/child.scss',
        line: 7,
        column: 3,
        message: 'SassError: Expected a selector.',
      },
    ]);
  });
});

describe('compileTheme', () => {
  it('reports success with the base command', async () => {
    const result = await compileTheme({
      root: projectRoot,
      consolePath,
      runner: async () => raw('', 0),
    });

    expect(result.ok).toBe(true);
    expect(result.command).toEqual(['theme:compile']);
    expect(result.errors).toEqual([]);
  });

  it('adds --only for a sales channel', async () => {
    const result = await compileTheme({
      root: projectRoot,
      consolePath,
      runner: async () => raw('', 0),
      salesChannel: channelId,
    });

    expect(result.ok).toBe(true);
    expect(result.command).toEqual(['theme:compile', `--only=${channelId}`]);
  });

  it('returns parsed SCSS errors without a raw message dump', async () => {
    const result = await compileTheme({
      root: projectRoot,
      consolePath,
      runner: async () => raw(consoleFixture('theme-compile-error.txt'), 1),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('console-failed');
    expect(result.message).toBeUndefined();
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatchObject({
      path: 'app/storefront/src/scss/base.scss',
      line: 12,
      message: 'Undefined variable $brand-color.',
    });
    expect(result.errors[1]).toMatchObject({
      path: 'app/storefront/src/scss/child.scss',
      line: 7,
      message: 'SassError: Expected a selector.',
    });
  });

  it('falls back to reason + compact message when no SCSS markers exist', async () => {
    const result = await compileTheme({
      root: projectRoot,
      consolePath,
      runner: async () => raw('Fatal error: the theme compiler crashed.', 1),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.reason).toBe('console-failed');
    expect(result.message).toContain('Fatal error');
  });

  it('never throws when the console is unavailable', async () => {
    const result = await compileTheme({ root: projectRoot, consolePath: null });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('console-unavailable');
    expect(result.errors).toEqual([]);
  });
});
