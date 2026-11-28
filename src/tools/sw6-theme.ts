// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolContext } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework } from '../lib/framework/detect';
import type { ConsoleRunner } from '../lib/framework/console';
import {
  compileTheme,
  listThemeReport,
  resolveThemeReport,
  type ScssError,
  type ThemeListReport,
} from '../lib/shopware/theme-report';

/**
 * Test seam: the Shopware report library accepts an injectable console runner.
 * opencode never sets this field; tests attach a fake runner to the tool context
 * so the theme queries and compile can be asserted without spawning bin/console.
 */
type Sw6ThemeContext = ToolContext & { runner?: ConsoleRunner };

const DESCRIPTION =
  'Shopware 6 themes. list: theme hierarchy with parent chains and sales-channel assignments. resolve: effective view chain plus declared style/script assets for one theme or sales channel. compile: run theme:compile and return SCSS errors as path:line, never raw output.';

type Mode = 'list' | 'resolve' | 'compile';

type ErrorOutcome = {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
};

const DEFAULT_LIMIT = 50;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 900000;
const DEFAULT_TIMEOUT_MS = 300000;

function errorResult(
  mode: Mode,
  message: string,
  extra: Record<string, unknown> = {}
): ErrorOutcome {
  return {
    title: 'Shopware Theme',
    output: JSON.stringify({ available: true, mode, error: message, ...extra }),
    metadata: { available: true, error: true },
  };
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.floor(value));
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function formatScssError(error: ScssError): string {
  const location =
    error.column !== undefined
      ? `${error.path}:${error.line}:${error.column}`
      : `${error.path}:${error.line}`;
  return `${location} ${error.message}`;
}

function findThemeEntry(report: ThemeListReport, name: string) {
  const needle = name.trim().toLowerCase();
  return report.themes.find(
    (theme) => theme.name.toLowerCase() === needle || theme.technicalName?.toLowerCase() === needle
  );
}

function availableChannels(report: ThemeListReport): string[] {
  const ids = report.themes.flatMap((theme) => theme.salesChannelIds);
  return [...new Set(ids)].sort();
}

export const sw6ThemeTool = tool({
  description: DESCRIPTION,

  args: {
    mode: tool.schema
      .enum(['list', 'resolve', 'compile'])
      .optional()
      .default('list')
      .describe(
        'list: theme hierarchy; resolve: view chain and assets for one theme or sales channel; compile: run theme:compile'
      ),
    theme: tool.schema
      .string()
      .optional()
      .describe('Theme name or technical name — required for resolve unless salesChannel is given'),
    salesChannel: tool.schema
      .string()
      .optional()
      .describe(
        'Sales channel id — compile passes --only=<id>; resolve maps it to its bound theme when theme is omitted'
      ),
    limit: tool.schema
      .number()
      .optional()
      .default(50)
      .describe('Maximum asset/error entries (default: 50)'),
    timeoutMs: tool.schema
      .number()
      .optional()
      .describe('Compile timeout in milliseconds (default: 300000, clamped to 1000…900000)'),
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
        title: 'Shopware Theme',
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
    const runner = (ctx as Sw6ThemeContext).runner;
    // Direct execute() calls (tests) do not run Zod defaults; keep list as the base.
    const mode: Mode = args.mode ?? 'list';
    const limit = normalizeLimit(args.limit);

    if (mode === 'list') {
      const report = await listThemeReport({ root, consolePath, runner });
      const count = report.themes.length;

      logDebugEvent('sw6_theme.complete', {
        mode,
        root,
        source: report.source,
        count,
        incomplete: report.incomplete,
      });

      return {
        title: 'Shopware Theme',
        output: JSON.stringify({
          framework: 'shopware',
          mode,
          count,
          themes: report.themes,
          source: report.source,
          incomplete: report.incomplete,
          unresolvedParents: report.unresolvedParents,
          ...(report.reason ? { reason: report.reason } : {}),
        }),
        metadata: { count, source: report.source, incomplete: report.incomplete },
      };
    }

    if (mode === 'resolve') {
      const requestedTheme = args.theme?.trim();
      const requestedChannel = args.salesChannel?.trim();

      if (!requestedTheme && !requestedChannel) {
        return errorResult(mode, 'theme is required', {
          hint: 'Pass theme, or salesChannel to resolve the theme bound to that channel.',
        });
      }

      const list = await listThemeReport({ root, consolePath, runner });

      let themeName: string;
      if (requestedTheme) {
        const match = findThemeEntry(list, requestedTheme);
        if (!match) {
          const availableThemes = list.themes.map((theme) => theme.name);
          return errorResult(mode, `Unknown theme '${requestedTheme}'.`, {
            theme: requestedTheme,
            availableThemes,
            incomplete: true,
            hint:
              availableThemes.length > 0
                ? `Known themes: ${availableThemes.join(', ')}.`
                : 'No themes were discovered.',
          });
        }
        themeName = match.name;
      } else {
        const channel = (requestedChannel as string).toLowerCase();
        const mapped = list.themes.find((theme) => theme.salesChannelIds.includes(channel));
        if (!mapped) {
          const channels = availableChannels(list);
          return errorResult(mode, `No theme is assigned to sales channel '${requestedChannel}'.`, {
            salesChannel: requestedChannel,
            availableSalesChannels: channels,
            hint:
              channels.length > 0
                ? `Assigned sales channels: ${channels.join(', ')}.`
                : 'No sales channel has a theme assignment.',
          });
        }
        themeName = mapped.name;
      }

      const report = await resolveThemeReport(themeName, { root, consolePath, runner });
      const truncated = report.assets.length > limit;
      const assets = truncated ? report.assets.slice(0, limit) : report.assets;

      logDebugEvent('sw6_theme.complete', {
        mode,
        root,
        theme: report.theme,
        source: report.source,
        assets: assets.length,
        truncated,
        incomplete: report.incomplete,
      });

      return {
        title: 'Shopware Theme',
        output: JSON.stringify({
          framework: 'shopware',
          mode,
          theme: report.theme,
          parentChain: report.parentChain,
          roots: report.roots,
          assets,
          unresolved: report.unresolved,
          salesChannelIds: report.salesChannelIds,
          source: report.source,
          incomplete: report.incomplete,
          truncated,
          ...(report.reason ? { reason: report.reason } : {}),
        }),
        metadata: {
          theme: report.theme,
          assets: assets.length,
          truncated,
          source: report.source,
          incomplete: report.incomplete,
        },
      };
    }

    // ---- compile ------------------------------------------------------------
    // theme:compile is an idempotent build action: no confirm gate.
    const salesChannel = args.salesChannel?.trim() || undefined;
    const timeoutMs = clampTimeout(args.timeoutMs);
    const result = await compileTheme({ root, consolePath, salesChannel, timeoutMs, runner });

    const totalErrors = result.errors.length;
    const shown = totalErrors > limit ? result.errors.slice(0, limit) : result.errors;
    const errors = shown.map(formatScssError);
    const truncated = result.truncated || totalErrors > limit;

    logDebugEvent('sw6_theme.complete', {
      mode,
      root,
      ok: result.ok,
      errors: errors.length,
      truncated,
      ...(result.reason ? { reason: result.reason } : {}),
    });

    return {
      title: 'Shopware Theme',
      output: JSON.stringify({
        framework: 'shopware',
        mode,
        ok: result.ok,
        command: result.command,
        errors,
        truncated,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.message ? { message: result.message } : {}),
        ...(result.hint ? { hint: result.hint } : {}),
      }),
      metadata: {
        ok: result.ok,
        errors: errors.length,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    };
  },
});
