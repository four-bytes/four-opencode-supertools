// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sw6PluginTool } from '../src/tools/sw6-plugin';
import type { ConsoleRunner, RawConsoleResult } from '../src/lib/framework/console';
import { toolObject } from './helpers';

const fixtureRoot = (path: string) =>
  new URL(`./fixtures/shopware/${path}`, import.meta.url).pathname;

const projectRoot = fixtureRoot('project');
const symfonyRoot = new URL('./fixtures/twig/app', import.meta.url).pathname;

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

const pluginRunner = () => capture(() => raw(consoleFixture('plugin-list.json')));

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

type ExecuteArgs = Parameters<typeof sw6PluginTool.execute>[0];

// execute() is called directly, so Zod defaults are not applied; every field the
// tool reads defensively is optional here.
function runTool(args: Partial<ExecuteArgs>, ctx: ReturnType<typeof mockCtx>) {
  return sw6PluginTool.execute(args as ExecuteArgs, ctx);
}

function parseOutput<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

interface PluginEntry {
  order: number;
  name: string;
  active: boolean;
  theme: boolean;
}

interface OverviewOutput {
  framework: string;
  plugin: string;
  theme: boolean;
  themeHint?: string;
  services: Array<{ id: string; tags: string[] }>;
  scheduledTasks: Array<{ id: string }>;
  subscribers: Array<{ event: string }>;
  entities: Array<{ class: string; kind: string }>;
  migrations: Array<{ path: string }>;
  adminModules: Array<{ name: string }>;
  twigOverrides: Array<{ path: string }>;
}

describe('sw6_plugin — list', () => {
  it('returns plugins with order, active and theme from the runtime report', async () => {
    const { runner } = pluginRunner();
    const result = toolObject(
      await runTool({ mode: 'list', directory: projectRoot }, mockCtx(projectRoot, runner))
    );
    const output = parseOutput<{
      framework: string;
      mode: string;
      count: number;
      plugins: PluginEntry[];
      source: string;
      incomplete: boolean;
    }>(result);

    expect(output.framework).toBe('shopware');
    expect(output.mode).toBe('list');
    expect(output.count).toBe(3);
    expect(output.source).toBe('runtime');
    expect(output.incomplete).toBe(false);
    expect(output.plugins.map((entry) => entry.order)).toEqual([0, 1, 2]);
    expect(output.plugins.map((entry) => entry.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(output.plugins.map((entry) => entry.active)).toEqual([true, false, true]);
    expect(output.plugins.map((entry) => entry.theme)).toEqual([false, false, true]);

    expect(result.metadata.count).toBe(3);
    expect(result.metadata.active).toBe(2);
    expect(result.metadata.source).toBe('runtime');
    expect(result.metadata.incomplete).toBe(false);
  });
});

describe('sw6_plugin — overview', () => {
  it('lists everything AlphaPlugin registers', async () => {
    const { runner } = pluginRunner();
    const result = toolObject(
      await runTool(
        { mode: 'overview', plugin: 'AlphaPlugin', limit: 50, directory: projectRoot },
        mockCtx(projectRoot, runner)
      )
    );
    const output = parseOutput<OverviewOutput>(result);

    expect(output.framework).toBe('shopware');
    expect(output.plugin).toBe('AlphaPlugin');
    expect(output.theme).toBe(false);

    expect(output.services.map((service) => service.id)).toContain(
      'AlphaPlugin\\Subscriber\\ProductSubscriber'
    );
    expect(output.scheduledTasks.map((service) => service.id)).toEqual([
      'AlphaPlugin\\ScheduledTask\\ExampleTask',
    ]);
    expect(output.subscribers.map((subscriber) => subscriber.event)).toEqual(['product.written']);
    expect(output.entities.map((entity) => entity.class).sort()).toEqual([
      'ProductCollection',
      'ProductDefinition',
      'ProductEntity',
      'ProductExtension',
    ]);
    expect(output.migrations).toHaveLength(1);
    expect(output.adminModules.map((module) => module.name)).toEqual(['alpha-module']);
    expect(output.twigOverrides.length).toBeGreaterThanOrEqual(2);
    expect(result.metadata.theme).toBe(false);
  });

  it('points a theme plugin at sw6_theme', async () => {
    const { runner } = pluginRunner();
    const result = toolObject(
      await runTool(
        { mode: 'overview', plugin: 'ThemePlugin', directory: projectRoot },
        mockCtx(projectRoot, runner)
      )
    );
    const output = parseOutput<OverviewOutput>(result);

    expect(output.framework).toBe('shopware');
    expect(output.plugin).toBe('ThemePlugin');
    expect(output.theme).toBe(true);
    expect(output.themeHint).toContain('sw6_theme');
  });
});

describe('sw6_plugin — lifecycle', () => {
  it('is a dry run without confirm and never calls the runner', async () => {
    const { runner, calls } = capture(() => raw(''));
    const result = toolObject(
      await runTool(
        { mode: 'lifecycle', action: 'activate', plugin: 'AlphaPlugin', directory: projectRoot },
        mockCtx(projectRoot, runner)
      )
    );
    const output = parseOutput<{
      dryRun: boolean;
      executed: unknown[];
      hint: string;
      steps: unknown[];
    }>(result);

    expect(output.dryRun).toBe(true);
    expect(output.executed).toEqual([]);
    expect(output.steps).toHaveLength(2);
    expect(output.hint).toContain('confirm: true');
    expect(result.metadata.dryRun).toBe(true);
    expect(result.metadata.executed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('uninstalls with --keep-user-data by default when confirmed', async () => {
    const { runner, calls } = capture(() => raw(''));
    const result = toolObject(
      await runTool(
        {
          mode: 'lifecycle',
          action: 'uninstall',
          plugin: 'AlphaPlugin',
          confirm: true,
          directory: projectRoot,
        },
        mockCtx(projectRoot, runner)
      )
    );
    const output = parseOutput<{
      dryRun: boolean;
      ok: boolean;
      keepUserData: boolean;
    }>(result);

    expect(output.dryRun).toBe(false);
    expect(output.ok).toBe(true);
    expect(output.keepUserData).toBe(true);
    expect(calls.map((cmd) => cmd.slice(1))).toEqual([
      ['plugin:uninstall', 'AlphaPlugin', '--keep-user-data'],
      ['cache:clear'],
    ]);
  });

  it('omits --keep-user-data when keepUserData is false', async () => {
    const { runner, calls } = capture(() => raw(''));
    await runTool(
      {
        mode: 'lifecycle',
        action: 'uninstall',
        plugin: 'AlphaPlugin',
        confirm: true,
        keepUserData: false,
        directory: projectRoot,
      },
      mockCtx(projectRoot, runner)
    );

    expect(calls.map((cmd) => cmd.slice(1))[0]).toEqual(['plugin:uninstall', 'AlphaPlugin']);
  });

  it('appends theme:compile for a confirmed theme activation', async () => {
    const { runner, calls } = capture(() => raw(''));
    const result = toolObject(
      await runTool(
        {
          mode: 'lifecycle',
          action: 'activate',
          plugin: 'ThemePlugin',
          confirm: true,
          directory: projectRoot,
        },
        mockCtx(projectRoot, runner)
      )
    );

    expect(calls.map((cmd) => cmd.slice(1))).toEqual([
      ['plugin:activate', 'ThemePlugin'],
      ['cache:clear'],
      ['theme:compile'],
    ]);
    expect(result.metadata.ok).toBe(true);
    expect(result.metadata.steps).toBe(3);
  });

  it('rejects an unknown plugin without executing anything', async () => {
    const { runner, calls } = capture(() => raw(''));
    const result = toolObject(
      await runTool(
        { mode: 'lifecycle', action: 'activate', plugin: 'NoSuchPlugin', directory: projectRoot },
        mockCtx(projectRoot, runner)
      )
    );
    const output = parseOutput<{
      available: boolean;
      error: string;
      availablePlugins: string[];
    }>(result);

    expect(output.available).toBe(true);
    expect(output.error).toContain('NoSuchPlugin');
    expect(output.availablePlugins).toContain('AlphaPlugin');
    expect(calls).toHaveLength(0);
  });
});

describe('sw6_plugin — non-Shopware and missing arguments', () => {
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

  it('requires a plugin name for overview', async () => {
    const result = toolObject(
      await runTool({ mode: 'overview', directory: projectRoot }, mockCtx(projectRoot))
    );
    const output = parseOutput<{ available: boolean; error: string }>(result);

    expect(output.available).toBe(true);
    expect(output.error).toBe('plugin is required');
    expect(result.metadata.error).toBe(true);
  });

  it('requires an action in lifecycle mode', async () => {
    const result = toolObject(
      await runTool({ mode: 'lifecycle', directory: projectRoot }, mockCtx(projectRoot))
    );
    const output = parseOutput<{ available: boolean; error: string }>(result);

    expect(output.available).toBe(true);
    expect(output.error).toBe('action is required');
    expect(result.metadata.error).toBe(true);
  });

  it('requires a plugin name for a non-refresh lifecycle action', async () => {
    const { runner, calls } = capture(() => raw(''));
    const result = toolObject(
      await runTool(
        { mode: 'lifecycle', action: 'activate', directory: projectRoot },
        mockCtx(projectRoot, runner)
      )
    );
    const output = parseOutput<{ error: string }>(result);

    expect(output.error).toBe('plugin is required');
    expect(calls).toHaveLength(0);
  });
});
