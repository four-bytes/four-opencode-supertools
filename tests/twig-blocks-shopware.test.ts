// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTwigBlocksTool, twigBlocksTool } from '../src/tools/twig-blocks';
import { resolveShopwareTwigContext } from '../src/lib/twig/shopware-adapter';
import { buildBlockChain } from '../src/lib/twig/blocks';
import { scanTwig } from '../src/lib/twig/scanner';
import type { ConsoleRunner, RawConsoleResult } from '../src/lib/framework/console';
import { toolObject } from './helpers';

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url).pathname;

const shopwareRoot = fixture('shopware/project');
const shopwareConsole = fixture('shopware/project/bin/console');
const symfonyRoot = fixture('twig/app');

const BLOCK = 'page_product_detail_buy_form';
const CHANNEL_AA = '000000000000000000000000000000aa';
const CHANNEL_BB = '000000000000000000000000000000bb';

const STOREFRONT_BUY =
  'vendor/shopware/storefront/Resources/views/storefront/page/product-detail/buy-widget.html.twig';
const BETA_BUY =
  'custom/plugins/BetaPlugin/Resources/views/storefront/page/product-detail/buy-widget.html.twig';
const THEME_BUY =
  'custom/plugins/ThemePlugin/src/Resources/views/storefront/page/product-detail/buy-widget.html.twig';

const consoleFixture = (name: string): string =>
  readFileSync(fixture(`shopware/console/${name}`), 'utf8');

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

function mockCtx(dir: string) {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function parseOutput(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { output: string }).output) as Record<string, unknown>;
}

const slash = (value: string) => value.replace(/\\/g, '/');

describe('twig_blocks — Shopware adapter (tool)', () => {
  const shopwareTool = createTwigBlocksTool({ shopware: true });

  it('chains a block Storefront → BetaPlugin → ThemePlugin without a filter', async () => {
    const result = toolObject(
      await shopwareTool.execute(
        { mode: 'block', name: BLOCK, limit: 50, directory: shopwareRoot },
        mockCtx(shopwareRoot)
      )
    );
    const output = parseOutput(result) as {
      framework: string;
      count: number;
      total: number;
      chains: Array<{
        theme: string;
        salesChannelIds: string[];
        count: number;
        chain: Array<{ path: string }>;
      }>;
      unknownTags: Array<{ tag: string }>;
    };

    expect(result.metadata.framework).toBe('shopware');
    expect(output.framework).toBe('shopware');

    const themeChain = output.chains.find((entry) => entry.theme === 'ThemePlugin');
    expect(themeChain).toBeDefined();
    const paths = themeChain!.chain.map((entry) => slash(entry.path));
    expect(paths).toHaveLength(3);
    expect(paths[0].endsWith(STOREFRONT_BUY)).toBe(true);
    expect(paths[1].endsWith(BETA_BUY)).toBe(true);
    expect(paths[2].endsWith(THEME_BUY)).toBe(true);

    expect(themeChain!.count).toBe(3);
    expect(output.count).toBe(output.chains.reduce((sum, entry) => sum + entry.count, 0));
    expect(output.total).toBeGreaterThanOrEqual(output.count);
    expect(output.unknownTags.map((entry) => entry.tag)).not.toContain('sw_icon');
  });

  it('narrows to one theme and reports available themes for an unknown one', async () => {
    const known = toolObject(
      await shopwareTool.execute(
        { mode: 'block', name: BLOCK, limit: 50, directory: shopwareRoot, theme: 'ThemePlugin' },
        mockCtx(shopwareRoot)
      )
    );
    const knownOutput = parseOutput(known) as {
      framework: string;
      theme: string;
      salesChannelIds: string[];
      chain: Array<{ path: string }>;
      chains?: unknown;
    };

    expect(knownOutput.framework).toBe('shopware');
    expect(knownOutput.theme).toBe('ThemePlugin');
    expect(knownOutput.chains).toBeUndefined();
    expect(knownOutput.chain).toHaveLength(3);
    expect(knownOutput.chain.map((entry) => slash(entry.path))).toEqual([
      expect.stringMatching(new RegExp(`${STOREFRONT_BUY}$`)),
      expect.stringMatching(new RegExp(`${BETA_BUY}$`)),
      expect.stringMatching(new RegExp(`${THEME_BUY}$`)),
    ]);
    expect(Array.isArray(knownOutput.salesChannelIds)).toBe(true);

    const unknown = toolObject(
      await shopwareTool.execute(
        { mode: 'block', name: BLOCK, limit: 50, directory: shopwareRoot, theme: 'NoSuchTheme' },
        mockCtx(shopwareRoot)
      )
    );
    const unknownOutput = parseOutput(unknown) as {
      chains: unknown[];
      themes: string[];
      incomplete: boolean;
    };

    expect(unknownOutput.chains).toEqual([]);
    expect(unknownOutput.themes).toContain('ThemePlugin');
    expect(unknownOutput.incomplete).toBe(true);
    expect(unknown.metadata.incomplete).toBe(true);
  });

  it('maps two sales channel ids to different themes and chains', async () => {
    const runner = shopwareRunner('theme-sales-channel-two.json');

    const first = await resolveShopwareTwigContext({
      root: shopwareRoot,
      consolePath: shopwareConsole,
      runner,
      salesChannel: CHANNEL_AA,
    });
    const second = await resolveShopwareTwigContext({
      root: shopwareRoot,
      consolePath: shopwareConsole,
      runner,
      salesChannel: CHANNEL_BB,
    });

    expect(first.chains).toHaveLength(1);
    expect(second.chains).toHaveLength(1);
    expect(first.chains[0].theme).toBe('ChildTheme');
    expect(second.chains[0].theme).toBe('ParentTheme');

    const firstChain = buildBlockChain(BLOCK, first.chains[0].loaders, shopwareRoot, {
      tagMap: first.tagMap,
      knownTagPrefixes: first.knownTagPrefixes,
    });
    const secondChain = buildBlockChain(BLOCK, second.chains[0].loaders, shopwareRoot, {
      tagMap: second.tagMap,
      knownTagPrefixes: second.knownTagPrefixes,
    });

    expect(firstChain.chain.map((entry) => entry.path)).not.toEqual(
      secondChain.chain.map((entry) => entry.path)
    );
    expect(firstChain.chain.length).toBeGreaterThan(secondChain.chain.length);
  });

  it('suppresses sw_icon but reports arbitrary unknown tags', async () => {
    const context = await resolveShopwareTwigContext({
      root: shopwareRoot,
      consolePath: null,
    });
    const source = readFileSync(join(shopwareRoot, BETA_BUY.replace(/\//g, '/')), 'utf8');

    const scanned = scanTwig(source, {
      tagMap: context.tagMap,
      knownTagPrefixes: context.knownTagPrefixes,
    });
    expect(scanned.unknownTags).not.toContain('sw_icon');

    const withCustom = scanTwig(`${source}\n{% arbitrary_widget x %}\n`, {
      tagMap: context.tagMap,
      knownTagPrefixes: context.knownTagPrefixes,
    });
    expect(withCustom.unknownTags).not.toContain('sw_icon');
    expect(withCustom.unknownTags).toContain('arbitrary_widget');
  });
});

describe('twig_blocks — Shopware gate', () => {
  it('keeps the plain Symfony output when the module is inactive', async () => {
    const result = toolObject(
      await twigBlocksTool.execute(
        { mode: 'block', name: 'content', limit: 50, directory: symfonyRoot },
        mockCtx(symfonyRoot)
      )
    );
    const output = parseOutput(result);

    expect(Object.keys(output).sort()).toEqual(
      ['block', 'chain', 'count', 'hint', 'total', 'truncated', 'unknownTags'].sort()
    );
    expect(output).not.toHaveProperty('framework');
    expect(output).not.toHaveProperty('chains');
    expect(result.metadata).not.toHaveProperty('framework');
    expect(result.metadata).not.toHaveProperty('chains');
  });

  it('stays Symfony-style in a Shopware project when the shopware option is off', async () => {
    const result = toolObject(
      await createTwigBlocksTool().execute(
        { mode: 'block', name: BLOCK, limit: 50, directory: shopwareRoot },
        mockCtx(shopwareRoot)
      )
    );
    const output = parseOutput(result);

    expect(result.metadata.framework).toBeUndefined();
    expect(result.metadata.available).toBe(true);
    expect(output).not.toHaveProperty('framework');
    expect(output).not.toHaveProperty('chains');
    expect(output).not.toHaveProperty('themes');
    expect(output.chain).toEqual([]);
    expect(Object.keys(output).sort()).toEqual(
      ['block', 'chain', 'count', 'total', 'truncated', 'unknownTags'].sort()
    );
  });
});
