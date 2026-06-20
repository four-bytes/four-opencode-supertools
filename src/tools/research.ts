// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';

export const researchTool = tool({
  description: `Search both the brain knowledge base and the web in parallel. Combines brain_search + websearch into a single call. Saves 2 round trips.`,

  args: {
    queries: tool.schema.string().describe('JSON array of search queries (strings)'),
    scope: tool.schema
      .string()
      .optional()
      .describe("Search scope: 'brain' (local only), 'web' (internet only), or 'both' (default)"),
  },

  async execute(args, _rawCtx) {
    const ctx = _rawCtx as typeof _rawCtx & {
      callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    };

    const queries: string[] = JSON.parse(args.queries);
    if (!Array.isArray(queries)) {
      throw new Error('queries must be a JSON array of strings');
    }
    if (!queries.every((q) => typeof q === 'string')) {
      throw new Error('queries must be a JSON array of strings (each element must be a string)');
    }

    const scope = args.scope || 'both';
    const validScopes = ['brain', 'web', 'both'];
    if (!validScopes.includes(scope)) {
      throw new Error(`Invalid scope: ${scope}. Must be one of: ${validScopes.join(', ')}`);
    }
    logDebugEvent('research.start', { queryCount: queries.length, scope });

    const results: Array<{ query: string; brain?: unknown[]; web?: unknown[] }> = [];

    for (const query of queries) {
      const entry: { query: string; brain?: unknown[]; web?: unknown[] } = { query };

      const promises: Promise<void>[] = [];

      if (scope === 'brain' || scope === 'both') {
        promises.push(
          (async () => {
            try {
              const result = await ctx.callTool('brain_search', { query, limit: 5 });
              entry.brain = Array.isArray(result) ? result : [result];
            } catch {
              entry.brain = [];
            }
          })()
        );
      }

      if (scope === 'web' || scope === 'both') {
        promises.push(
          (async () => {
            try {
              const result = await ctx.callTool('websearch', { query });
              entry.web = Array.isArray(result) ? result : [result];
            } catch {
              entry.web = [];
            }
          })()
        );
      }

      await Promise.all(promises);
      results.push(entry);
    }

    logDebugEvent('research.complete', { count: results.length });
    return {
      title: `Research: ${queries.join(', ').substring(0, 80)}`,
      output: JSON.stringify(results, null, 2),
      metadata: { queryCount: queries.length, scope, results },
    };
  },
});
