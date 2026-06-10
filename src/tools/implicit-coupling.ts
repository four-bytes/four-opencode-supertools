// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { parseGitLog, type Commit } from '../lib/git-log-parser';
import { logDebugEvent } from '../lib/debug-logger';

interface CouplingResult {
  files: [string, string];
  co_commits: number;
  coupling_strength: number;
  last_together: string;
}

export const implicitCouplingTool = tool({
  description:
    'Detect files that always change together in the same commit — hidden dependencies invisible in code. Returns co-commit pairs ranked by coupling strength.',

  args: {
    threshold: tool.schema
      .number()
      .describe('Minimum co-commit rate to report (0.0-1.0, default: 0.8)'),
    since: tool.schema
      .string()
      .describe("Only consider commits since date (e.g., '90d', '6m')"),
  },

  async execute(args, _ctx) {
    const threshold = (args.threshold as number) ?? 0.8;
    const since = args.since as string | undefined;

    logDebugEvent('implicit_coupling.start', { threshold, since: since ?? 'none' });

    try {
      const commits = await parseGitLog(since);
      const results = computeCoupling(commits, threshold);
      logDebugEvent('implicit_coupling.done', { pairs: results.length });
      return JSON.stringify(results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebugEvent('implicit_coupling.error', { error: msg });
      return `Error computing implicit coupling: ${msg}`;
    }
  },
});

/**
 * Compute implicit coupling between files.
 * For each commit with ≥2 files, build all file pairs.
 * Count co-occurrences and compute coupling strength.
 */
export function computeCoupling(commits: Commit[], threshold: number): CouplingResult[] {
  const pairCounts = new Map<string, { count: number; lastDate: string }>();
  const fileTotalCommits = new Map<string, number>();

  for (const commit of commits) {
    const changedFiles = commit.files.map((f) => f.path);

    if (changedFiles.length < 2) continue;

    // Track total commits per file
    for (const file of changedFiles) {
      fileTotalCommits.set(file, (fileTotalCommits.get(file) ?? 0) + 1);
    }

    // Build all pairs
    for (let i = 0; i < changedFiles.length; i++) {
      for (let j = i + 1; j < changedFiles.length; j++) {
        const a = changedFiles[i]!;
        const b = changedFiles[j]!;
        // Canonical ordering
        const key = a < b ? `${a}|||${b}` : `${b}|||${a}`;
        const existing = pairCounts.get(key);
        if (existing) {
          existing.count++;
          if (commit.date > existing.lastDate) {
            existing.lastDate = commit.date;
          }
        } else {
          pairCounts.set(key, { count: 1, lastDate: commit.date });
        }
      }
    }
  }

  const results: CouplingResult[] = [];

  for (const [key, data] of pairCounts) {
    const [fileA, fileB] = key.split('|||') as [string, string];

    // Coupling strength: co-commit count / max(either file's total commits)
    const maxCommits = Math.max(
      fileTotalCommits.get(fileA) ?? 0,
      fileTotalCommits.get(fileB) ?? 0
    );
    if (maxCommits === 0) continue;

    const strength = Math.round((data.count / maxCommits) * 1000) / 1000;

    if (strength >= threshold) {
      results.push({
        files: [fileA, fileB],
        co_commits: data.count,
        coupling_strength: strength,
        last_together: data.lastDate.split('T')[0],
      });
    }
  }

  results.sort((a, b) => b.coupling_strength - a.coupling_strength);
  return results;
}
