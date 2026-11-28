// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework } from '../lib/framework/detect';
import { DEFAULT_TWIG_MAX_FILES, loadSupertoolsConfig } from '../lib/framework/config';
import { buildTemplateChain, resolveLoaderPaths, type TemplateChain } from '../lib/twig/resolver';
import { buildBlockChain, type BlockChainResult } from '../lib/twig/blocks';
import { discoverCustomTags } from '../lib/twig/custom-tags';
import { resolveShopwareTwigContext, type ShopwareTwigChain } from '../lib/twig/shopware-adapter';

const UNKNOWN_TAG_HINT = 'Unmapped Twig tag; map it in .supertools.json under twig.tags';

const DESCRIPTION =
  'Show the Twig override chain for a block or template: extends, block, parent(), use, embed and include with path:line. Auto-detects custom inheritance tags and honours .supertools.json twig.tags. Uses debug:twig --format=json, with a static config/packages/twig.yaml fallback marked incomplete. In a Shopware project (shopware module active) it maps sw_extends/sw_include, treats every sw_* tag as known and follows the storefront → plugin → theme view chain; theme and salesChannel are Shopware-only.';

export interface TwigBlocksToolOptions {
  /** Enable the Shopware storefront adapter. Only effective inside a Shopware project. */
  shopware?: boolean;
}

type UnknownTag = { tag: string; path: string; line: number };

function availableThemeNames(context: { themes: { themes: Array<{ name: string }> } }): string[] {
  return [...new Set(context.themes.themes.map((theme) => theme.name))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function dedupeUnknownTags(entries: ReadonlyArray<UnknownTag>): UnknownTag[] {
  const map = new Map<string, UnknownTag>();
  for (const entry of entries) {
    map.set(`${entry.tag}\u0000${entry.path}:${entry.line}`, entry);
  }
  return [...map.values()];
}

export function createTwigBlocksTool(options: TwigBlocksToolOptions = {}) {
  return tool({
    description: DESCRIPTION,

    args: {
      mode: tool.schema
        .enum(['block', 'template'])
        .optional()
        .default('block')
        .describe(
          'block: override chain for a block name; template: outline of a template and its extends chain'
        ),
      name: tool.schema
        .string()
        .describe('Block name in block mode, template name in template mode'),
      template: tool.schema
        .string()
        .optional()
        .describe('Block mode only: restrict the chain to this template and its ancestors'),
      limit: tool.schema
        .number()
        .optional()
        .default(50)
        .describe('Maximum chain entries to return (default: 50)'),
      directory: tool.schema
        .string()
        .optional()
        .describe('Project directory to inspect (defaults to the project directory).'),
      theme: tool.schema
        .string()
        .optional()
        .describe('Shopware only: theme name or technical name (ignored on Symfony projects).'),
      salesChannel: tool.schema
        .string()
        .optional()
        .describe(
          'Shopware only: sales channel id (hex) used by theme_sales_channel (ignored on Symfony projects).'
        ),
    },

    async execute(args, ctx) {
      const start = (args.directory as string | undefined) ?? ctx.directory;
      const framework = detectFramework(start);
      const mode = args.mode;

      if (framework.framework === 'none' || !framework.root) {
        return {
          title: 'Twig Blocks',
          output: JSON.stringify({
            available: false,
            source: 'static',
            incomplete: true,
            mode,
            name: args.name,
            count: 0,
            chain: [],
            unknownTags: [],
            hint: 'No Symfony/Shopware composer.json found above this path.',
          }),
          metadata: { available: false },
        };
      }

      const config = loadSupertoolsConfig(framework.root);
      let configTags: Readonly<Record<string, string>> = {};
      let includeVendor = false;
      let maxFiles = DEFAULT_TWIG_MAX_FILES;
      let configError: string | undefined;

      if (config.ok) {
        configTags = config.config.twig.tags;
        includeVendor = config.config.twig.discovery.vendor;
        maxFiles = config.config.twig.discovery.maxFiles;
      } else {
        configError = config.error;
        logDebugEvent('twig_blocks.config_error', {
          root: framework.root,
          error: config.error,
          key: config.key,
        });
      }

      const discovery = await discoverCustomTags({
        root: framework.root,
        includeVendor,
        maxFiles,
      });

      const discoveryMetadata = {
        customTags: Object.keys(discovery.tags).length,
        configTags: Object.keys(configTags).length,
        discoveryIncomplete: discovery.incomplete,
      };

      const withHints = (
        result: Record<string, unknown>,
        unknownTags: number
      ): Record<string, unknown> => {
        const output: Record<string, unknown> = { ...result };
        if (configError) output.configError = configError;
        if (unknownTags > 0) output.hint = UNKNOWN_TAG_HINT;
        return output;
      };

      const isShopware = options.shopware === true && framework.framework === 'shopware';

      if (!isShopware) {
        // Config wins over auto-detection; built-ins are the fallback in the scanner.
        const tagMap: Record<string, string> = { ...discovery.tags, ...configTags };
        const loaders = await resolveLoaderPaths({
          root: framework.root,
          consolePath: framework.consolePath,
        });

        if (mode === 'template') {
          const result = buildTemplateChain(args.name, loaders, framework.root, { tagMap });
          const count = result.blocks.length;
          const output = withHints(
            result as unknown as Record<string, unknown>,
            result.unknownTags.length
          );

          logDebugEvent('twig_blocks.complete', {
            root: framework.root,
            mode,
            name: args.name,
            source: loaders.source,
            count,
            total: count,
            ...discoveryMetadata,
          });

          return {
            title: 'Twig Blocks',
            output: JSON.stringify(output),
            metadata: {
              available: true,
              source: loaders.source,
              mode,
              count,
              total: count,
              incomplete: loaders.incomplete || discovery.incomplete,
              unknownTags: result.unknownTags.length,
              ...discoveryMetadata,
            },
          };
        }

        const result = buildBlockChain(args.name, loaders, framework.root, {
          limit: args.limit,
          template: args.template,
          tagMap,
        });
        const output = withHints(
          result as unknown as Record<string, unknown>,
          result.unknownTags.length
        );

        logDebugEvent('twig_blocks.complete', {
          root: framework.root,
          mode,
          name: args.name,
          template: args.template,
          source: loaders.source,
          count: result.count,
          total: result.total,
          ...discoveryMetadata,
        });

        return {
          title: 'Twig Blocks',
          output: JSON.stringify(output),
          metadata: {
            available: true,
            source: loaders.source,
            mode,
            count: result.count,
            total: result.total,
            incomplete: loaders.incomplete || discovery.incomplete,
            unknownTags: result.unknownTags.length,
            ...discoveryMetadata,
          },
        };
      }

      // ---- Shopware path ------------------------------------------------------
      const shopwareRoot = framework.root;
      const context = await resolveShopwareTwigContext({
        root: shopwareRoot,
        consolePath: framework.consolePath,
        tags: discovery.tags,
        configTags,
        theme: args.theme,
        salesChannel: args.salesChannel,
      });
      const { tagMap, knownTagPrefixes } = context;
      const themes = availableThemeNames(context);
      const incomplete = context.incomplete || discovery.incomplete;
      const hasFilter = args.theme !== undefined || args.salesChannel !== undefined;

      const buildBlock = (chain: ShopwareTwigChain): BlockChainResult =>
        buildBlockChain(args.name, chain.loaders, shopwareRoot, {
          limit: args.limit,
          template: args.template,
          tagMap,
          knownTagPrefixes,
        });
      const buildTemplate = (chain: ShopwareTwigChain): TemplateChain =>
        buildTemplateChain(args.name, chain.loaders, shopwareRoot, {
          tagMap,
          knownTagPrefixes,
        });

      if (hasFilter) {
        if (context.chains.length === 0) {
          const empty =
            mode === 'template'
              ? {
                  template: args.name,
                  path: null,
                  parent: null,
                  extendsChain: [],
                  blocks: [],
                  uses: [],
                  embeds: [],
                  includes: [],
                  unknownTags: [],
                  missing: [args.name],
                }
              : {
                  block: args.name,
                  chain: [],
                  count: 0,
                  total: 0,
                  truncated: false,
                  unknownTags: [],
                };
          const output = withHints(
            {
              ...(empty as unknown as Record<string, unknown>),
              framework: 'shopware',
              ...(args.theme !== undefined ? { theme: args.theme } : {}),
              ...(args.salesChannel !== undefined ? { salesChannelIds: [args.salesChannel] } : {}),
              chains: [],
              themes,
              incomplete: true,
            },
            0
          );

          logDebugEvent('twig_blocks.complete', {
            root: framework.root,
            framework: 'shopware',
            mode,
            name: args.name,
            theme: args.theme,
            salesChannel: args.salesChannel,
            count: 0,
            total: 0,
            incomplete: true,
            ...discoveryMetadata,
          });

          return {
            title: 'Twig Blocks',
            output: JSON.stringify(output),
            metadata: {
              available: true,
              framework: 'shopware',
              mode,
              ...(args.theme !== undefined ? { theme: args.theme } : {}),
              themes,
              count: 0,
              total: 0,
              incomplete: true,
              unknownTags: 0,
              ...discoveryMetadata,
            },
          };
        }

        const chain = context.chains[0];
        const built = mode === 'template' ? buildTemplate(chain) : buildBlock(chain);
        const unknownTags = dedupeUnknownTags(built.unknownTags);
        const count =
          mode === 'template'
            ? (built as TemplateChain).blocks.length
            : (built as BlockChainResult).count;
        const total =
          mode === 'template'
            ? (built as TemplateChain).blocks.length
            : (built as BlockChainResult).total;
        const output = withHints(
          {
            ...(built as unknown as Record<string, unknown>),
            framework: 'shopware',
            theme: chain.theme,
            salesChannelIds: chain.salesChannelIds,
            ...(chain.unresolved.length > 0 ? { unresolved: chain.unresolved } : {}),
          },
          unknownTags.length
        );

        logDebugEvent('twig_blocks.complete', {
          root: framework.root,
          framework: 'shopware',
          mode,
          name: args.name,
          template: args.template,
          theme: chain.theme,
          source: chain.loaders.source,
          count,
          total,
          ...discoveryMetadata,
        });

        return {
          title: 'Twig Blocks',
          output: JSON.stringify(output),
          metadata: {
            available: true,
            framework: 'shopware',
            source: chain.loaders.source,
            mode,
            theme: chain.theme,
            count,
            total,
            incomplete,
            unknownTags: unknownTags.length,
            ...discoveryMetadata,
          },
        };
      }

      // ---- Shopware, no filter: one entry per distinct theme -------------------
      type ChainEntry = {
        theme: string;
        salesChannelIds: string[];
        count: number;
        total: number;
        chain: unknown[];
      };
      const entries: ChainEntry[] = [];
      const aggregated: UnknownTag[] = [];

      for (const chain of context.chains) {
        if (mode === 'template') {
          const built = buildTemplate(chain);
          entries.push({
            theme: chain.theme,
            salesChannelIds: chain.salesChannelIds,
            count: built.blocks.length,
            total: built.blocks.length,
            chain: built.extendsChain,
          });
          aggregated.push(...built.unknownTags);
        } else {
          const built = buildBlock(chain);
          entries.push({
            theme: chain.theme,
            salesChannelIds: chain.salesChannelIds,
            count: built.count,
            total: built.total,
            chain: built.chain,
          });
          aggregated.push(...built.unknownTags);
        }
      }

      const unknownTags = dedupeUnknownTags(aggregated);
      const count = entries.reduce((sum, entry) => sum + entry.count, 0);
      const total = entries.reduce((sum, entry) => sum + entry.total, 0);
      const output = withHints(
        {
          ...(mode === 'template' ? { template: args.name } : { block: args.name }),
          framework: 'shopware',
          count,
          total,
          chains: entries,
          unknownTags,
          ...(context.chains.length === 0 ? { themes } : {}),
          ...(incomplete ? { incomplete: true } : {}),
        },
        unknownTags.length
      );

      logDebugEvent('twig_blocks.complete', {
        root: framework.root,
        framework: 'shopware',
        mode,
        name: args.name,
        chains: entries.length,
        count,
        total,
        incomplete,
        ...discoveryMetadata,
      });

      return {
        title: 'Twig Blocks',
        output: JSON.stringify(output),
        metadata: {
          available: true,
          framework: 'shopware',
          source: context.themes.source,
          mode,
          themes,
          count,
          total,
          incomplete,
          unknownTags: unknownTags.length,
          ...discoveryMetadata,
        },
      };
    },
  });
}

export const twigBlocksTool = createTwigBlocksTool();
