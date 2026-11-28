// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolContext } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework } from '../lib/framework/detect';
import type { ConsoleRunner } from '../lib/framework/console';
import {
  isThemePlugin,
  listPluginReport,
  planPluginLifecycle,
  pluginOverview,
  runPluginLifecycle,
  type LifecyclePlan,
} from '../lib/shopware/plugin-report';

/**
 * Test seam: the Shopware report library accepts an injectable console runner.
 * opencode never sets this field; tests attach a fake runner to the tool context
 * so lifecycle execution can be asserted without spawning bin/console.
 */
type Sw6PluginContext = ToolContext & { runner?: ConsoleRunner };

const DESCRIPTION =
  'Shopware 6 plugins. list: state and load order. overview: what a plugin registers (services, scheduled tasks, subscribers, entities, migrations, admin modules, Twig overrides) with path:line. lifecycle: run the plugin console sequence — dry run unless confirmed.';

type Mode = 'list' | 'overview' | 'lifecycle';

type ErrorOutcome = {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
};

function errorResult(
  mode: Mode,
  message: string,
  extra: Record<string, unknown> = {}
): ErrorOutcome {
  return {
    title: 'Shopware Plugin',
    output: JSON.stringify({ available: true, mode, error: message, ...extra }),
    metadata: { available: true, error: true },
  };
}

export const sw6PluginTool = tool({
  description: DESCRIPTION,

  args: {
    mode: tool.schema
      .enum(['list', 'overview', 'lifecycle'])
      .optional()
      .default('list')
      .describe(
        'list: plugin state and load order; overview: what one plugin registers; lifecycle: run a plugin console sequence'
      ),
    plugin: tool.schema
      .string()
      .optional()
      .describe(
        'Technical plugin name — required for overview and for every lifecycle action except refresh'
      ),
    action: tool.schema
      .enum(['refresh', 'install', 'activate', 'deactivate', 'update', 'uninstall'])
      .optional()
      .describe('Lifecycle action (required in lifecycle mode)'),
    confirm: tool.schema
      .boolean()
      .optional()
      .default(false)
      .describe('Execute the lifecycle commands; without it the plan is a dry run'),
    keepUserData: tool.schema
      .boolean()
      .optional()
      .default(true)
      .describe('uninstall keeps user data unless explicitly false'),
    limit: tool.schema
      .number()
      .optional()
      .default(50)
      .describe('Maximum entries per overview section (default: 50)'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Project directory to inspect (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const start = args.directory ?? ctx.directory;
    const framework = detectFramework(start);

    if (framework.framework !== 'shopware' || !framework.root) {
      return {
        title: 'Shopware Plugin',
        output: JSON.stringify({
          available: false,
          framework: framework.framework,
          hint: 'Not a Shopware project (no shopware/core in composer.json).',
        }),
        metadata: { available: false },
      };
    }

    const root = framework.root;
    const consolePath = framework.consolePath;
    const runner = (ctx as Sw6PluginContext).runner;
    // Direct execute() calls (tests) do not run Zod defaults; keep list as the base.
    const mode: Mode = args.mode ?? 'list';

    if (mode === 'list') {
      const report = await listPluginReport({ root, consolePath, runner });
      const count = report.plugins.length;
      const active = report.plugins.filter((plugin) => plugin.active).length;

      logDebugEvent('sw6_plugin.complete', {
        mode,
        root,
        source: report.source,
        count,
        active,
      });

      return {
        title: 'Shopware Plugin',
        output: JSON.stringify({
          framework: 'shopware',
          mode,
          count,
          plugins: report.plugins,
          source: report.source,
          incomplete: report.incomplete,
          ...(report.reason ? { reason: report.reason } : {}),
        }),
        metadata: { count, active, source: report.source, incomplete: report.incomplete },
      };
    }

    if (mode === 'overview') {
      const plugin = args.plugin?.trim();
      if (!plugin) return errorResult(mode, 'plugin is required');

      const overview = await pluginOverview(plugin, {
        root,
        consolePath,
        limit: args.limit,
        runner,
      });

      logDebugEvent('sw6_plugin.complete', {
        mode,
        root,
        plugin: overview.plugin,
        theme: overview.theme,
        incomplete: overview.incomplete,
        truncated: overview.truncated,
      });

      return {
        title: 'Shopware Plugin',
        output: JSON.stringify({ framework: 'shopware', ...overview }),
        metadata: {
          available: true,
          plugin: overview.plugin,
          theme: overview.theme,
          incomplete: overview.incomplete,
        },
      };
    }

    // ---- lifecycle ----------------------------------------------------------
    const action = args.action;
    if (!action) return errorResult(mode, 'action is required');

    const requested = action === 'refresh' ? undefined : args.plugin?.trim();
    if (action !== 'refresh' && !requested) {
      return errorResult(mode, 'plugin is required', { action });
    }

    let canonical: string | undefined = requested;
    let theme = false;

    if (requested) {
      // Resolve without bin/console: planning must not shell out before the
      // confirmed run, and the static scan already covers the standard plugin
      // directories (custom/plugins, custom/static-plugins, custom/apps).
      const report = await listPluginReport({ root, consolePath: null });
      const found = report.plugins.find(
        (candidate) => candidate.name.toLowerCase() === requested.toLowerCase()
      );

      if (!found) {
        const availablePlugins = report.plugins.map((candidate) => candidate.name);
        return errorResult(mode, `Unknown plugin '${requested}'.`, {
          plugin: requested,
          action,
          availablePlugins,
          hint:
            availablePlugins.length > 0
              ? `Known plugins: ${availablePlugins.join(', ')}.`
              : 'No plugins were discovered.',
        });
      }

      canonical = found.name;
      theme = isThemePlugin(found.path);
    }

    let plan: LifecyclePlan;
    try {
      plan = planPluginLifecycle({
        action,
        plugin: canonical,
        theme,
        keepUserData: args.keepUserData,
      });
    } catch (error) {
      return errorResult(mode, error instanceof Error ? error.message : String(error), {
        plugin: canonical,
        action,
      });
    }

    const run = await runPluginLifecycle(plan, {
      root,
      consolePath,
      confirm: args.confirm,
      runner,
    });

    logDebugEvent('sw6_plugin.complete', {
      mode,
      root,
      action,
      plugin: plan.plugin,
      theme: plan.theme,
      dryRun: run.dryRun,
      ok: run.ok,
      steps: plan.steps.length,
      executed: run.executed.length,
    });

    return {
      title: 'Shopware Plugin',
      output: JSON.stringify({
        framework: 'shopware',
        mode,
        plugin: plan.plugin,
        action,
        dryRun: run.dryRun,
        ok: run.ok,
        steps: plan.steps,
        executed: run.executed,
        keepUserData: plan.keepUserData,
        ...(run.failedStep ? { failedStep: run.failedStep } : {}),
        ...(args.confirm ? {} : { hint: 'Dry run — pass confirm: true to execute' }),
      }),
      metadata: {
        dryRun: run.dryRun,
        ok: run.ok,
        steps: plan.steps.length,
        executed: run.executed.length,
      },
    };
  },
});
