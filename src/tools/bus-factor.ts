// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { parseGitBlameForDir, type BlameLine } from '../lib/git-blame-parser';
import { git } from '../lib/git-runner';
import { logDebugEvent } from '../lib/debug-logger';

interface BusFactorResult {
  directory: string;
  bus_factor: number;
  total_lines: number;
  top_author: string;
  top_author_pct: number;
  authors: string[];
  risk: 'critical' | 'high' | 'medium' | 'low';
}

export const busFactorTool = tool({
  description:
    'Calculate bus factor per directory — ownership concentration analysis. Identifies modules that would be orphaned if key contributors left.',

  args: {
    since: tool.schema
      .string()
      .describe("Only consider commits since date (e.g., '90d', '6m')"),
  },

  async execute(_args, _ctx) {
    logDebugEvent('bus_factor.start', {});

    try {
      const result = await computeBusFactor();
      logDebugEvent('bus_factor.done', { directories: result.length });
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebugEvent('bus_factor.error', { error: msg });
      return `Error computing bus factor: ${msg}`;
    }
  },
});

/**
 * Get all tracked directories from git ls-files.
 */
async function getTrackedDirectories(): Promise<string[]> {
  const output = await git(['ls-files']);
  const files = output.split('\n').filter((f) => f.trim() !== '');
  const dirs = new Set<string>();

  for (const file of files) {
    const parts = file.split('/');
    if (parts.length > 1) {
      dirs.add(parts[0]!);
    }
  }

  return Array.from(dirs).sort();
}

/**
 * Compute bus factor for all top-level directories.
 */
export async function computeBusFactor(): Promise<BusFactorResult[]> {
  const dirs = await getTrackedDirectories();
  const results: BusFactorResult[] = [];

  for (const dir of dirs) {
    try {
      const blameMap = await parseGitBlameForDir(dir + '/');

      if (blameMap.size === 0) continue;

      const authorLines = new Map<string, number>();
      let totalLines = 0;

      for (const [, blameLines] of blameMap) {
        for (const bl of blameLines) {
          // Count only meaningful authors (skip "Not Committed Yet")
          if (bl.author && bl.author !== 'Not Committed Yet') {
            authorLines.set(bl.author, (authorLines.get(bl.author) ?? 0) + 1);
            totalLines++;
          }
        }
      }

      if (totalLines === 0) continue;

      // Sort authors by line count descending
      const sortedAuthors = Array.from(authorLines.entries()).sort((a, b) => b[1] - a[1]);
      const topAuthor = sortedAuthors[0];
      if (!topAuthor) continue;

      const topAuthorPct = Math.round((topAuthor[1] / totalLines) * 1000) / 10;

      // Bus factor: how many authors needed to cover >50% of lines
      let cumulative = 0;
      let busFactor = 0;
      const authorNames: string[] = [];
      for (const [author, lines] of sortedAuthors) {
        authorNames.push(author);
        cumulative += lines;
        busFactor++;
        if (cumulative > totalLines * 0.5) break;
      }

      // Risk level
      let risk: BusFactorResult['risk'] = 'low';
      if (busFactor === 1) risk = 'critical';
      else if (busFactor === 2) risk = 'high';
      else if (busFactor === 3) risk = 'medium';

      results.push({
        directory: dir,
        bus_factor: busFactor,
        total_lines: totalLines,
        top_author: topAuthor[0],
        top_author_pct: topAuthorPct,
        authors: authorNames,
        risk,
      });
    } catch {
      // Skip directories that fail (e.g., no tracked files with blame)
    }
  }

  // Sort by risk: critical first, then by lowest bus_factor
  const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  results.sort((a, b) => {
    const r = riskOrder[a.risk] - riskOrder[b.risk];
    if (r !== 0) return r;
    return a.bus_factor - b.bus_factor;
  });

  return results;
}
