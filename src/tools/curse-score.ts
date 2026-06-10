// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { parseGitLog, type Commit } from '../lib/git-log-parser';
import { logDebugEvent } from '../lib/debug-logger';

interface FileStats {
  file: string;
  changes: number;
  authors: Set<string>;
  lastChanged: Date;
  recentChanges: number; // changes in last 30 days
  olderChanges: number; // changes before last 30 days
}

interface CurseResult {
  file: string;
  score: number;
  changes: number;
  authors: number;
  last_changed: string;
  churn_trend: 'accelerating' | 'steady' | 'decelerating';
}

export const curseScoreTool = tool({
  description:
    'Rank files by risk using curse score algorithm: changes × author chaos × recency × churn acceleration. Returns top N most dangerous files in the repo.',

  args: {
    top: tool.schema.number().describe('Number of files to return (default: 10)'),
    since: tool.schema
      .string()
      .describe("Only consider commits since date (e.g., '90d', '6m', '2024-01-01')"),
  },

  async execute(args, _ctx) {
    const top = (args.top as number) ?? 10;
    const since = args.since as string | undefined;

    logDebugEvent('curse_score.start', { top, since: since ?? 'none' });

    try {
      const commits = await parseGitLog(since);

      if (commits.length === 0) {
        return JSON.stringify([]);
      }

      const results = computeCurseScores(commits, top);
      logDebugEvent('curse_score.done', { count: results.length });
      return JSON.stringify(results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebugEvent('curse_score.error', { error: msg });
      return `Error computing curse scores: ${msg}`;
    }
  },
});

/**
 * Build file statistics from commit history.
 */
function buildFileStats(commits: Commit[]): Map<string, FileStats> {
  const stats = new Map<string, FileStats>();
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  for (const commit of commits) {
    const commitDate = new Date(commit.date);
    const isRecent = now - commitDate.getTime() < thirtyDaysMs;

    for (const file of commit.files) {
      let s = stats.get(file.path);
      if (!s) {
        s = {
          file: file.path,
          changes: 0,
          authors: new Set(),
          lastChanged: new Date(0),
          recentChanges: 0,
          olderChanges: 0,
        };
        stats.set(file.path, s);
      }

      s.changes++;
      s.authors.add(commit.author);

      if (commitDate > s.lastChanged) {
        s.lastChanged = commitDate;
      }

      if (isRecent) {
        s.recentChanges++;
      } else {
        s.olderChanges++;
      }
    }
  }

  return stats;
}

/**
 * Compute curse scores for all files, returning top N.
 */
export function computeCurseScores(commits: Commit[], topN: number): CurseResult[] {
  const stats = buildFileStats(commits);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const results: CurseResult[] = [];

  for (const [, s] of stats) {
    // Author chaos: normalized entropy of authors
    const authorChaos = s.changes > 0 ? s.authors.size / s.changes : 0;

    // Recency: 1.0 if changed in last 30 days, decaying to 0.1 at 365 days
    const daysSinceLast = (now - s.lastChanged.getTime()) / dayMs;
    const recency = Math.max(0.1, 1.0 - (daysSinceLast - 30) / (365 - 30) * 0.9);

    // Churn acceleration: recent / older ratio, clamped 0.5-3.0
    const totalNonRecent = s.olderChanges || 1; // avoid division by zero
    const churnAcceleration = Math.max(0.5, Math.min(3.0, s.recentChanges / totalNonRecent));

    const score = s.changes * authorChaos * recency * churnAcceleration;

    // Churn trend label
    let churnTrend: CurseResult['churn_trend'] = 'steady';
    if (churnAcceleration > 1.2) churnTrend = 'accelerating';
    else if (churnAcceleration < 0.8) churnTrend = 'decelerating';

    results.push({
      file: s.file,
      score: Math.round(score * 10) / 10,
      changes: s.changes,
      authors: s.authors.size,
      last_changed: s.lastChanged.toISOString().split('T')[0],
      churn_trend: churnTrend,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topN);
}
