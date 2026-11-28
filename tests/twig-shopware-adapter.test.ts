// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveShopwareTwigContext,
  SHOPWARE_TAG_ALIASES,
  SHOPWARE_TAG_PREFIXES,
} from '../src/lib/twig/shopware-adapter';
import { scanTwig } from '../src/lib/twig/scanner';
import { buildBlockChain } from '../src/lib/twig/blocks';
import type { ConsoleRunner, RawConsoleResult } from '../src/lib/framework/console';

const fixtureRoot = (path: string) =>
  new URL(`./fixtures/shopware/${path}`, import.meta.url).pathname;

const projectRoot = fixtureRoot('project');
const consolePath = fixtureRoot('project/bin/console');

const storefrontViews = join(projectRoot, 'vendor/shopware/storefront/Resources/views');
const storefrontBuy = join(storefrontViews, 'storefront/page/product-detail/buy-widget.html.twig');
const alphaViews = join(projectRoot, 'custom/plugins/AlphaPlugin/src/Resources/views');
const betaViews = join(projectRoot, 'custom/plugins/BetaPlugin/Resources/views');
const betaBuy = join(betaViews, 'storefront/page/product-detail/buy-widget.html.twig');
const themePluginViews = join(projectRoot, 'custom/plugins/ThemePlugin/src/Resources/views');
const themePluginBuy = join(
  themePluginViews,
  'storefront/page/product-detail/buy-widget.html.twig'
);
const childViews = join(projectRoot, 'custom/static-plugins/ChildTheme/src/Resources/views');
const parentViews = join(projectRoot, 'custom/static-plugins/ParentTheme/src/Resources/views');

const consoleFixture = (name: string): string =>
  readFileSync(fixtureRoot(`console/${name}`), 'utf8');

function raw(stdout: string, exitCode = 0): RawConsoleResult {
  return { exitCode, stdout, stderr: '' };
}

function shopwareRunner(assignments = 'theme-sales-channel-rows.json'): ConsoleRunner {
  return async (cmd: string[]) => {
    if (cmd.some((arg) => arg === 'plugin:list')) return raw(consoleFixture('plugin-list.json'));
    if (cmd.some((arg) => arg.includes('theme_sales_channel')))
      return raw(consoleFixture(assignments));
    if (cmd.some((arg) => arg.includes('FROM theme')))
      return raw(consoleFixture('theme-rows.json'));
    return raw('[]');
  };
}

const channelAa = '000000000000000000000000000000aa';
const channelBb = '000000000000000000000000000000bb';

describe('Shopware Twig adapter — tags', () => {
  it('maps aliases and lets config win over discovery over alias', async () => {
    const context = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath: null,
      tags: { sw_extends: 'discovered', custom_a: 'extends' },
      configTags: { sw_extends: 'config', custom_b: 'include' },
    });

    expect(context.tagMap.sw_extends).toBe('config');
    expect(context.tagMap.custom_a).toBe('extends');
    expect(context.tagMap.custom_b).toBe('include');
    expect(context.tagMap.sw_include).toBe(SHOPWARE_TAG_ALIASES.sw_include);
    expect(context.tagMap.sw_embed).toBe('embed');
    expect(context.tagMap.sw_use).toBe('use');
  });

  it('suppresses sw_ prefixed tags but still reports arbitrary unknown tags', async () => {
    const context = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath: null,
    });

    expect(context.knownTagPrefixes).toEqual(['sw_']);
    expect(SHOPWARE_TAG_PREFIXES).toEqual(['sw_']);

    const scanned = scanTwig("{% sw_icon 'cart' %}\n{% my_tag %}", {
      knownTagPrefixes: context.knownTagPrefixes,
    });
    expect(scanned.unknownTags).not.toContain('sw_icon');
    expect(scanned.unknownTags).toContain('my_tag');

    const mapped = scanTwig("{% sw_extends '@Storefront/x.html.twig' %}", {
      tagMap: context.tagMap,
    });
    expect(mapped.extends).toEqual({ target: '@Storefront/x.html.twig', line: 1 });
    expect(mapped.unknownTags).toEqual([]);
  });
});

describe('Shopware Twig adapter — chain resolution', () => {
  it('resolves a theme-filtered chain with reversed loader paths and namespaces', async () => {
    const context = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath,
      runner: shopwareRunner(),
      theme: 'ChildTheme',
    });

    expect(context.chains).toHaveLength(1);
    const chain = context.chains[0];

    expect(chain.theme).toBe('ChildTheme');
    expect(chain.roots.map((root) => root.origin)).toEqual([
      'theme:ChildTheme',
      'parent:ParentTheme',
      'plugin:AlphaPlugin',
      'plugin:ThemePlugin',
      'storefront',
    ]);
    expect(chain.roots.map((root) => root.path)).toEqual([
      childViews,
      parentViews,
      alphaViews,
      themePluginViews,
      storefrontViews,
    ]);

    // buildBlockChain needs the least-specific loader first.
    expect(chain.loaders.paths).toEqual([
      storefrontViews,
      themePluginViews,
      alphaViews,
      parentViews,
      childViews,
    ]);
    expect(chain.loaders.namespaces['@Storefront']).toBe(storefrontViews);
    expect(chain.loaders.namespaces['@AlphaPlugin']).toBe(alphaViews);
    expect(chain.loaders.namespaces['@ChildTheme']).toBe(childViews);
    expect(chain.loaders.source).toBe('runtime');
    expect(chain.loaders.incomplete).toBe(false);
    expect(chain.salesChannelIds).toEqual([channelAa]);
  });

  it('returns one chain per theme, sorted by name (all-chains mode)', async () => {
    const context = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath,
      runner: shopwareRunner(),
    });

    expect(context.chains.map((chain) => chain.theme)).toEqual([
      'ChildTheme',
      'ParentTheme',
      'ThemePlugin',
    ]);
    expect(context.incomplete).toBe(false);
  });

  it('maps different sales channels to different themes and rejects unknown ids', async () => {
    const runner = shopwareRunner('theme-sales-channel-two.json');

    const first = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath,
      runner,
      salesChannel: channelAa,
    });
    const second = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath,
      runner,
      salesChannel: channelBb,
    });

    expect(first.chains).toHaveLength(1);
    expect(first.chains[0].theme).toBe('ChildTheme');
    expect(first.chains[0].roots.map((root) => root.origin)).toContain('theme:ChildTheme');
    expect(first.chains[0].salesChannelIds).toEqual([channelAa]);

    expect(second.chains).toHaveLength(1);
    expect(second.chains[0].theme).toBe('ParentTheme');
    expect(second.chains[0].roots.map((root) => root.origin)).toEqual([
      'theme:ParentTheme',
      'storefront',
    ]);
    expect(second.chains[0].salesChannelIds).toEqual([channelBb]);
    expect(first.chains[0].roots).not.toEqual(second.chains[0].roots);

    const unknown = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath,
      runner,
      salesChannel: 'cccccccccccccccccccccccccccccccc',
    });
    expect(unknown.chains).toEqual([]);
    expect(unknown.incomplete).toBe(true);
    expect(unknown.reason).toBe('sales-channel-unassigned');
    expect(unknown.themes.themes.map((theme) => theme.name)).toContain('ChildTheme');
  });

  it('falls back to static theme.json discovery without a console', async () => {
    const context = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath: null,
    });

    expect(context.themes.source).toBe('static');
    expect(context.themes.incomplete).toBe(true);
    expect(context.incomplete).toBe(true);
    expect(context.chains.length).toBeGreaterThan(0);

    for (const chain of context.chains) {
      expect(chain.loaders.source).toBe('static');
      expect(chain.incomplete).toBe(true);
      expect(chain.loaders.incomplete).toBe(true);
    }

    const child = context.chains.find((chain) => chain.theme === 'ChildTheme');
    expect(child?.roots.map((root) => root.origin)).toEqual(['theme:ChildTheme', 'storefront']);
  });
});

describe('Shopware Twig adapter — block chain', () => {
  it('orders block overrides Storefront → plugin → theme', async () => {
    const context = await resolveShopwareTwigContext({
      root: projectRoot,
      consolePath,
      runner: shopwareRunner(),
      theme: 'ThemePlugin',
    });
    expect(context.chains).toHaveLength(1);

    const result = buildBlockChain(
      'page_product_detail_buy_form',
      context.chains[0].loaders,
      projectRoot,
      { tagMap: context.tagMap }
    );

    expect(result.chain.map((entry) => entry.path)).toEqual([
      storefrontBuy,
      betaBuy,
      themePluginBuy,
    ]);
    expect(result.chain.map((entry) => entry.parentCall)).toEqual([false, true, true]);
    expect(result.count).toBe(3);
    expect(result.total).toBe(3);
  });
});
