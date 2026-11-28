// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sw6ThemeTool } from '../src/tools/sw6-theme';
import type { ConsoleRunner, RawConsoleResult } from '../src/lib/framework/console';
import { toolObject } from './helpers';

const fixtureRoot = (path: string) =>
  new URL(`./fixtures/shopware/${path}`, import.meta.url).pathname;

const projectRoot = fixtureRoot('project');
const symfonyRoot = new URL('./fixtures/twig/app', import.meta.url).pathname;
const channelId = '000000000000000000000000000000aa';
const unassignedChannel = '000000000000000000000000000000ff';

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
    if (joined.includes('plugin:list')) {
      return raw(consoleFixture('plugin-list.json'));
    }
    return raw(consoleFixture('theme-rows.json'));
  };
}

function compileRunner(stdout: string, exitCode = 0): ConsoleRunner {
  return async () => raw(stdout, exitCode);
}

function mockCtx(dir: string, runner?: ConsoleRunner) {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    runner,
  };
}

type ExecuteArgs = Parameters<typeof sw6ThemeTool.execute>[0];

// execute() is called directly, so Zod defaults are not applied; every field the
// tool reads defensively is optional here.
function runTool(args: Partial<ExecuteArgs>, ctx: ReturnType<typeof mockCtx>) {
  return sw6ThemeTool.execute(args as ExecuteArgs, ctx);
}

function parseOutput<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

interface ThemeEntry {
  name: string;
  parentChain: string[];
  salesChannelIds: string[];
}

describe('sw6_theme — list', () => {
  it('lists themes with their parent chain and sales channels', async () => {
    const result = toolObject(
      await runTool({ mode: 'list', directory: projectRoot }, mockCtx(projectRoot, themeRunner()))
    );
    const output = parseOutput<{
      framework: string;
      mode: string;
      count: number;
      themes: ThemeEntry[];
      source: string;
      incomplete: boolean;
    }>(result);

    expect(output.framework).toBe('shopware');
    expect(output.mode).toBe('list');
    expect(output.count).toBe(3);
    expect(output.source).toBe('runtime');
    expect(output.incomplete).toBe(false);
    expect(output.themes.map((theme) => theme.name)).toEqual([
      'ChildTheme',
      'ParentTheme',
      'ThemePlugin',
    ]);

    const child = output.themes.find((theme) => theme.name === 'ChildTheme');
    expect(child?.parentChain).toEqual(['ChildTheme', 'ParentTheme']);
    expect(child?.salesChannelIds).toEqual([channelId]);

    expect(result.metadata.count).toBe(3);
    expect(result.metadata.source).toBe('runtime');
    expect(result.metadata.incomplete).toBe(false);
  });
});

describe('sw6_theme — resolve', () => {
  it('merges the view chain with assets most-specific first', async () => {
    const result = toolObject(
      await runTool(
        { mode: 'resolve', theme: 'ChildTheme', directory: projectRoot },
        mockCtx(projectRoot, themeRunner())
      )
    );
    const output = parseOutput<{
      framework: string;
      mode: string;
      theme: string;
      parentChain: string[];
      roots: Array<{ origin: string }>;
      assets: Array<{ entry: string; origin: string; exists: boolean }>;
      unresolved: string[];
      salesChannelIds: string[];
      truncated: boolean;
      incomplete: boolean;
    }>(result);

    expect(output.framework).toBe('shopware');
    expect(output.mode).toBe('resolve');
    expect(output.theme).toBe('ChildTheme');
    expect(output.parentChain).toEqual(['ChildTheme', 'ParentTheme']);
    expect(output.roots.map((root) => root.origin)).toEqual([
      'theme:ChildTheme',
      'parent:ParentTheme',
      'plugin:AlphaPlugin',
      'plugin:ThemePlugin',
      'storefront',
    ]);
    expect(output.unresolved).toEqual([]);
    expect(output.incomplete).toBe(false);
    expect(output.truncated).toBe(false);
    expect(output.salesChannelIds).toEqual([channelId]);

    expect(output.assets.map((asset) => asset.entry)).toEqual([
      'app/storefront/src/scss/base.scss',
      'app/storefront/src/scss/child.scss',
      'app/storefront/src/js/child.js',
      'app/storefront/src/js/missing.js',
      'app/storefront/src/scss/parent.scss',
    ]);
    expect(output.assets.map((asset) => asset.origin)).toEqual([
      'theme',
      'theme',
      'theme',
      'theme',
      'parent',
    ]);
    expect(output.assets.map((asset) => asset.exists)).toEqual([true, true, true, false, true]);
  });

  it('maps a sales channel to its bound theme', async () => {
    const result = toolObject(
      await runTool(
        { mode: 'resolve', salesChannel: channelId, directory: projectRoot },
        mockCtx(projectRoot, themeRunner())
      )
    );
    const output = parseOutput<{ theme: string; parentChain: string[] }>(result);

    expect(output.theme).toBe('ChildTheme');
    expect(output.parentChain).toEqual(['ChildTheme', 'ParentTheme']);
    expect(result.metadata.theme).toBe('ChildTheme');
  });

  it('returns an error object for an unassigned sales channel', async () => {
    const result = toolObject(
      await runTool(
        { mode: 'resolve', salesChannel: unassignedChannel, directory: projectRoot },
        mockCtx(projectRoot, themeRunner())
      )
    );
    const output = parseOutput<{
      available: boolean;
      error: string;
      availableSalesChannels: string[];
      hint: string;
    }>(result);

    expect(output.available).toBe(true);
    expect(output.error).toContain('No theme is assigned');
    expect(output.availableSalesChannels).toEqual([channelId]);
    expect(output.hint).toContain(channelId);
    expect(result.metadata.error).toBe(true);
  });
});

describe('sw6_theme — compile', () => {
  it('reports success with the base command', async () => {
    const result = toolObject(
      await runTool(
        { mode: 'compile', directory: projectRoot },
        mockCtx(projectRoot, compileRunner('', 0))
      )
    );
    const output = parseOutput<{
      framework: string;
      mode: string;
      ok: boolean;
      command: string[];
      errors: string[];
      truncated: boolean;
    }>(result);

    expect(output.framework).toBe('shopware');
    expect(output.mode).toBe('compile');
    expect(output.ok).toBe(true);
    expect(output.command).toEqual(['theme:compile']);
    expect(output.errors).toEqual([]);
    expect(output.truncated).toBe(false);
    expect(result.metadata.ok).toBe(true);
    expect(result.metadata.errors).toBe(0);
  });

  it('compiles a single sales channel with --only', async () => {
    const result = toolObject(
      await runTool(
        { mode: 'compile', salesChannel: channelId, directory: projectRoot },
        mockCtx(projectRoot, compileRunner('', 0))
      )
    );
    const output = parseOutput<{ ok: boolean; command: string[] }>(result);

    expect(output.ok).toBe(true);
    expect(output.command).toEqual(['theme:compile', `--only=${channelId}`]);
  });

  it('returns only path:line message entries for SCSS errors', async () => {
    const result = toolObject(
      await runTool(
        { mode: 'compile', directory: projectRoot },
        mockCtx(projectRoot, compileRunner(consoleFixture('theme-compile-error.txt'), 1))
      )
    );
    const output = parseOutput<{
      ok: boolean;
      errors: string[];
      reason?: string;
      message?: string;
    }>(result);

    expect(output.ok).toBe(false);
    expect(output.reason).toBe('console-failed');
    expect(output.message).toBeUndefined();
    expect(output.errors).toHaveLength(2);
    expect(output.errors.every((entry) => typeof entry === 'string')).toBe(true);
    expect(output.errors[0]).toBe(
      'app/storefront/src/scss/base.scss:12:5 Undefined variable $brand-color.'
    );
    expect(output.errors[1]).toBe(
      'app/storefront/src/scss/child.scss:7:3 SassError: Expected a selector.'
    );

    const joined = output.errors.join('\n');
    expect(joined).not.toContain('Compiling theme');
    expect(joined).not.toContain('Cache warmed');
    expect(result.metadata.ok).toBe(false);
    expect(result.metadata.errors).toBe(2);
    expect(result.metadata.reason).toBe('console-failed');
  });

  it('clamps the compile timeout to 1000…900000 and forwards it to the runner', async () => {
    const timeouts: number[] = [];
    const runner: ConsoleRunner = async (_cmd, opts) => {
      timeouts.push(opts.timeoutMs);
      return raw('', 0);
    };

    await runTool(
      { mode: 'compile', timeoutMs: 5, directory: projectRoot },
      mockCtx(projectRoot, runner)
    );
    await runTool(
      { mode: 'compile', timeoutMs: 2_000_000, directory: projectRoot },
      mockCtx(projectRoot, runner)
    );
    await runTool({ mode: 'compile', directory: projectRoot }, mockCtx(projectRoot, runner));

    expect(timeouts).toEqual([1000, 900000, 300000]);
  });
});

describe('sw6_theme — non-Shopware and missing arguments', () => {
  it('reports unavailable outside a Shopware project', async () => {
    const result = toolObject(
      await runTool({ mode: 'list', directory: symfonyRoot }, mockCtx(symfonyRoot))
    );
    const output = parseOutput<{ available: boolean; framework: string; hint: string }>(result);

    expect(output.available).toBe(false);
    expect(output.framework).toBe('symfony');
    expect(output.hint).toContain('Not a Shopware project');
    expect(result.metadata.available).toBe(false);
  });

  it('requires a theme in resolve mode', async () => {
    const result = toolObject(
      await runTool(
        { mode: 'resolve', directory: projectRoot },
        mockCtx(projectRoot, themeRunner())
      )
    );
    const output = parseOutput<{ available: boolean; error: string }>(result);

    expect(output.available).toBe(true);
    expect(output.error).toBe('theme is required');
    expect(result.metadata.error).toBe(true);
  });
});
