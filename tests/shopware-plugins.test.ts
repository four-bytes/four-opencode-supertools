// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listPlugins, parsePluginList, type ShopwarePlugin } from '../src/lib/shopware/plugins';
import type { ConsoleRunner, RawConsoleResult } from '../src/lib/framework/console';

const fixtureRoot = (path: string) =>
  new URL(`./fixtures/shopware/${path}`, import.meta.url).pathname;

const projectRoot = fixtureRoot('project');
const consolePath = fixtureRoot('project/bin/console');

const consoleFixture = (name: string): string =>
  readFileSync(fixtureRoot(`console/${name}`), 'utf8');

function raw(stdout: string, exitCode = 0): RawConsoleResult {
  return { exitCode, stdout, stderr: '' };
}

function capture(handler: (cmd: string[]) => RawConsoleResult): {
  calls: string[][];
  runner: ConsoleRunner;
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (cmd: string[]) => {
      calls.push(cmd);
      return handler(cmd);
    },
  };
}

describe('parsePluginList', () => {
  it('parses a JSON array and keeps load order', () => {
    const plugins = parsePluginList(consoleFixture('plugin-list.json'));
    expect(plugins?.map((plugin) => plugin.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(plugins?.map((plugin) => plugin.active)).toEqual([true, false, true]);
    expect(plugins?.[0].label).toBe('Alpha');
    expect(plugins?.[0].version).toBe('1.0.0');
    expect(plugins?.[0].kind).toBe('plugin');
  });

  it('parses the legacy { plugins: [...] } shape with technicalName/isActive', () => {
    const plugins = parsePluginList(consoleFixture('plugin-list-legacy.json'));
    expect(plugins?.map((plugin) => plugin.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(plugins?.map((plugin) => plugin.active)).toEqual([true, false, true]);
  });

  it('parses a text table with tolerant Active values', () => {
    const plugins = parsePluginList(consoleFixture('plugin-list.txt'));
    expect(plugins?.map((plugin) => plugin.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(plugins?.map((plugin) => plugin.active)).toEqual([true, false, true]);
    expect(plugins?.map((plugin) => plugin.version)).toEqual(['1.0.0', '2.0.0', '1.2.3']);
  });

  it('returns null for broken JSON and unparseable text', () => {
    expect(parsePluginList(consoleFixture('broken.json'))).toBeNull();
    expect(parsePluginList('just some prose without a table')).toBeNull();
    expect(parsePluginList('')).toBeNull();
  });
});

describe('listPlugins — runtime', () => {
  it('returns runtime plugins in load order and resolves relative paths', async () => {
    const { runner } = capture(() => raw(consoleFixture('plugin-list.json')));
    const result = await listPlugins({ root: projectRoot, consolePath, runner });

    expect(result.source).toBe('runtime');
    expect(result.incomplete).toBe(false);
    expect(result.plugins.map((plugin) => plugin.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(result.plugins[0].path).toBe(join(projectRoot, 'custom', 'plugins', 'AlphaPlugin'));
  });

  it('falls back from --format=json to --json before parsing', async () => {
    const { runner, calls } = capture((cmd) =>
      cmd.includes('--format=json')
        ? raw('not json', 1)
        : raw(consoleFixture('plugin-list-legacy.json'))
    );
    const result = await listPlugins({ root: projectRoot, consolePath, runner });

    expect(result.source).toBe('runtime');
    expect(result.plugins.map((plugin) => plugin.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--format=json');
    expect(calls[1]).toContain('plugin:list');
    expect(calls[1]).toContain('--json');
    expect(calls[1]).not.toContain('--format=json');
  });

  it('falls all the way through to the plain text table', async () => {
    const { runner, calls } = capture((cmd) =>
      cmd.includes('--format=json') || cmd.includes('--json')
        ? raw('', 1)
        : raw(consoleFixture('plugin-list.txt'))
    );
    const result = await listPlugins({ root: projectRoot, consolePath, runner });

    expect(result.source).toBe('runtime');
    expect(result.plugins.map((plugin) => plugin.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual([consolePath, 'plugin:list']);
  });

  it('keeps the invalid-json reason when a later command fails', async () => {
    const { runner } = capture((cmd) =>
      cmd.includes('--format=json') ? raw('not json', 0) : raw('', 1)
    );
    const result = await listPlugins({ root: projectRoot, consolePath, runner });

    expect(result.source).toBe('static');
    expect(result.reason).toBe('invalid-json');
  });
});

describe('listPlugins — static fallback', () => {
  it('scans composer plugins and apps without a console, marked incomplete', async () => {
    const result = await listPlugins({ root: projectRoot, consolePath: null });

    expect(result.source).toBe('static');
    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('no-console');
    expect(result.plugins.map((plugin) => plugin.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
      'MyApp',
    ]);
    expect(result.plugins.every((plugin) => plugin.active === false)).toBe(true);

    const app = result.plugins.find((plugin) => plugin.name === 'MyApp') as
      ShopwarePlugin | undefined;
    expect(app?.kind).toBe('app');
    expect(app?.label).toBe('My App');

    const alpha = result.plugins.find((plugin) => plugin.name === 'AlphaPlugin');
    expect(alpha?.version).toBe('1.0.0');
    expect(alpha?.path).toBe(join(projectRoot, 'custom', 'plugins', 'AlphaPlugin'));
  });

  it('falls back to static when every console attempt fails', async () => {
    const { runner } = capture(() => raw('', 1));
    const result = await listPlugins({ root: projectRoot, consolePath, runner });

    expect(result.source).toBe('static');
    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('console-failed');
    expect(result.plugins).toHaveLength(4);
  });

  it('never throws when the project has no plugin directories', async () => {
    const result = await listPlugins({ root: fixtureRoot('does-not-exist'), consolePath: null });
    expect(result.source).toBe('static');
    expect(result.incomplete).toBe(true);
    expect(result.plugins).toEqual([]);
  });
});
