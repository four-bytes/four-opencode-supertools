// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  listPluginReport,
  pluginOverview,
  planPluginLifecycle,
  runPluginLifecycle,
  type LifecyclePlan,
  type PluginOverview,
} from '../src/lib/shopware/plugin-report';
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

function pluginRunner(): ConsoleRunner {
  return async () => raw(consoleFixture('plugin-list.json'));
}

describe('listPluginReport', () => {
  it('maps the recorded plugin list with order, active, theme and update flags', async () => {
    const { runner } = capture(() => raw(consoleFixture('plugin-list.json')));
    const report = await listPluginReport({ root: projectRoot, consolePath, runner });

    expect(report.source).toBe('runtime');
    expect(report.incomplete).toBe(false);
    expect(report.plugins.map((entry) => entry.order)).toEqual([0, 1, 2]);
    expect(report.plugins.map((entry) => entry.name)).toEqual([
      'AlphaPlugin',
      'BetaPlugin',
      'ThemePlugin',
    ]);
    expect(report.plugins.map((entry) => entry.active)).toEqual([true, false, true]);
    expect(report.plugins.map((entry) => entry.theme)).toEqual([false, false, true]);
    // Every reported version matches the composer.json version → no update.
    expect(report.plugins.map((entry) => entry.updateAvailable)).toEqual([false, false, false]);
    expect(report.plugins[0].path).toBe(`${projectRoot}/custom/plugins/AlphaPlugin`);
  });

  it('reports updateAvailable=null when the runtime version is missing', async () => {
    const { runner } = capture(() => raw(consoleFixture('plugin-list-legacy.json')));
    const report = await listPluginReport({ root: projectRoot, consolePath, runner });

    expect(report.plugins.map((entry) => entry.updateAvailable)).toEqual([null, null, null]);
    // Legacy output carries no path, so no theme can be detected statically.
    expect(report.plugins.map((entry) => entry.theme)).toEqual([false, false, false]);
  });

  it('reports updateAvailable=true when the runtime version differs from composer', async () => {
    const bumped = JSON.stringify([
      {
        name: 'AlphaPlugin',
        label: 'Alpha',
        version: '9.9.9',
        active: true,
        path: 'custom/plugins/AlphaPlugin',
      },
    ]);
    const { runner } = capture(() => raw(bumped));
    const report = await listPluginReport({ root: projectRoot, consolePath, runner });

    expect(report.plugins[0].updateAvailable).toBe(true);
    expect(report.plugins[0].theme).toBe(false);
  });
});

describe('pluginOverview', () => {
  it('collects services, subscribers, entities, migrations, admin and twig files', async () => {
    const overview: PluginOverview = await pluginOverview('AlphaPlugin', {
      root: projectRoot,
      consolePath,
      runner: pluginRunner(),
    });

    expect(overview.plugin).toBe('AlphaPlugin');
    expect(overview.path).toBe('custom/plugins/AlphaPlugin');
    expect(overview.version).toBe('1.0.0');
    expect(overview.active).toBe(true);
    expect(overview.theme).toBe(false);
    expect(overview.incomplete).toBe(false);
    expect(overview.truncated).toEqual([]);

    // Services come from src/Resources/config/services.xml.
    const serviceIds = overview.services.map((service) => service.id);
    expect(serviceIds).toContain('AlphaPlugin\\ScheduledTask\\ExampleTask');
    expect(serviceIds).toContain('AlphaPlugin\\Subscriber\\ProductSubscriber');

    const task = overview.services.find(
      (service) => service.id === 'AlphaPlugin\\ScheduledTask\\ExampleTask'
    );
    expect(task).toBeDefined();
    expect(task?.tags).toEqual(['shopware.scheduled.task']);
    expect(task?.path).toBe('custom/plugins/AlphaPlugin/src/Resources/config/services.xml');
    expect(task?.line).toBe(4);

    // The scheduled-task service appears in both sections.
    expect(overview.scheduledTasks.map((service) => service.id)).toEqual([
      'AlphaPlugin\\ScheduledTask\\ExampleTask',
    ]);

    // Subscribers via getSubscribedEvents(), with the class declaration location.
    expect(overview.subscribers).toHaveLength(1);
    const subscriber = overview.subscribers[0];
    expect(subscriber.event).toBe('product.written');
    expect(subscriber.class).toBe('AlphaPlugin\\Subscriber\\ProductSubscriber');
    expect(subscriber.method).toBe('onProductWritten');
    expect(subscriber.priority).toBe(0);
    expect(subscriber.path).toBe('custom/plugins/AlphaPlugin/src/Subscriber/ProductSubscriber.php');
    expect(subscriber.line).toBe(7);

    // All four entity kinds.
    const kinds = Object.fromEntries(
      overview.entities.map((entity) => [entity.class, entity.kind])
    );
    expect(kinds).toEqual({
      ProductDefinition: 'definition',
      ProductExtension: 'extension',
      ProductCollection: 'collection',
      ProductEntity: 'entity',
    });

    // One migration, located at its class declaration.
    expect(overview.migrations).toHaveLength(1);
    expect(overview.migrations[0].path).toBe(
      'custom/plugins/AlphaPlugin/src/Migration/Migration1700000000AddExample.php'
    );
    expect(overview.migrations[0].line).toBe(8);

    // One admin module directory.
    expect(overview.adminModules).toEqual([
      {
        name: 'alpha-module',
        path: 'custom/plugins/AlphaPlugin/src/Resources/app/administration/src/module/alpha-module',
      },
    ]);

    // Twig overrides: the existing view plus the added nested component.
    const twigPaths = overview.twigOverrides.map((twig) => twig.path);
    expect(twigPaths).toContain(
      'custom/plugins/AlphaPlugin/src/Resources/views/storefront/component/alpha.html.twig'
    );
    expect(twigPaths).toContain('custom/plugins/AlphaPlugin/src/Resources/views/alpha.html.twig');
    expect(overview.twigOverrides.every((twig) => twig.line === 1)).toBe(true);
  });

  it('returns incomplete with available names for an unknown plugin', async () => {
    const overview: PluginOverview = await pluginOverview('MissingPlugin', {
      root: projectRoot,
      consolePath,
      runner: pluginRunner(),
    });

    expect(overview.incomplete).toBe(true);
    expect(overview.available).toEqual(['AlphaPlugin', 'BetaPlugin', 'ThemePlugin']);
    expect(overview.hint).toContain('AlphaPlugin');
    expect(overview.services).toEqual([]);
    expect(overview.subscribers).toEqual([]);
  });
});

describe('planPluginLifecycle', () => {
  it('uninstall keeps user data by default', () => {
    const plan = planPluginLifecycle({ action: 'uninstall', plugin: 'AlphaPlugin' });
    expect(plan.keepUserData).toBe(true);
    expect(plan.steps.map((step) => step.args)).toEqual([
      ['plugin:uninstall', 'AlphaPlugin', '--keep-user-data'],
      ['cache:clear'],
    ]);
  });

  it('uninstall omits --keep-user-data when keepUserData is false', () => {
    const plan = planPluginLifecycle({
      action: 'uninstall',
      plugin: 'AlphaPlugin',
      keepUserData: false,
    });
    expect(plan.steps[0].args).toEqual(['plugin:uninstall', 'AlphaPlugin']);
    expect(plan.steps.map((step) => step.args)).toEqual([
      ['plugin:uninstall', 'AlphaPlugin'],
      ['cache:clear'],
    ]);
  });

  it('refresh needs no plugin name', () => {
    const plan = planPluginLifecycle({ action: 'refresh' });
    expect(plan.plugin).toBeUndefined();
    expect(plan.steps.map((step) => step.args)).toEqual([['plugin:refresh'], ['cache:clear']]);
  });

  it('appends theme:compile only for theme state changes', () => {
    const themed = planPluginLifecycle({ action: 'install', plugin: 'ThemePlugin', theme: true });
    expect(themed.theme).toBe(true);
    expect(themed.steps.map((step) => step.args)).toEqual([
      ['plugin:install', 'ThemePlugin'],
      ['cache:clear'],
      ['theme:compile'],
    ]);

    const plain = planPluginLifecycle({ action: 'install', plugin: 'AlphaPlugin' });
    expect(plain.theme).toBe(false);
    expect(plain.steps.map((step) => step.args)).toEqual([
      ['plugin:install', 'AlphaPlugin'],
      ['cache:clear'],
    ]);
  });

  it('throws when a required plugin name is missing', () => {
    expect(() => planPluginLifecycle({ action: 'install' })).toThrow();
  });
});

describe('runPluginLifecycle', () => {
  it('is a dry run without confirm and never calls the runner', async () => {
    const { runner, calls } = capture(() => raw(''));
    const plan = planPluginLifecycle({ action: 'activate', plugin: 'AlphaPlugin' });

    const run = await runPluginLifecycle(plan, { root: projectRoot, consolePath, runner });

    expect(run.dryRun).toBe(true);
    expect(run.executed).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('runs the planned steps in order when confirmed', async () => {
    const { runner, calls } = capture(() => raw(''));
    const plan = planPluginLifecycle({ action: 'activate', plugin: 'AlphaPlugin', theme: true });

    const run = await runPluginLifecycle(plan, {
      root: projectRoot,
      consolePath,
      runner,
      confirm: true,
    });

    expect(run.dryRun).toBe(false);
    expect(run.ok).toBe(true);
    expect(run.executed.map((step) => step.ok)).toEqual([true, true, true]);
    expect(calls.map((cmd) => cmd.slice(1))).toEqual([
      ['plugin:activate', 'AlphaPlugin'],
      ['cache:clear'],
      ['theme:compile'],
    ]);
  });

  it('stops at the first failing step and maps the failure', async () => {
    const { runner, calls } = capture((cmd) =>
      cmd.includes('cache:clear') ? raw('', 1) : raw('')
    );
    const plan: LifecyclePlan = planPluginLifecycle({ action: 'install', plugin: 'AlphaPlugin' });

    const run = await runPluginLifecycle(plan, {
      root: projectRoot,
      consolePath,
      runner,
      confirm: true,
    });

    expect(run.ok).toBe(false);
    expect(run.executed).toHaveLength(2);
    expect(run.failedStep?.args).toEqual(['cache:clear']);
    expect(run.failedStep?.ok).toBe(false);
    expect(run.failedStep?.reason).toBe('console-failed');
    // theme:compile must not run after the failure.
    expect(calls.map((cmd) => cmd.slice(1))).toEqual([
      ['plugin:install', 'AlphaPlugin'],
      ['cache:clear'],
    ]);
  });
});
