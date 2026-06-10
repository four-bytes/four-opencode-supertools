// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { parseGitLog } from '../lib/git-log-parser';
import { parseGitBlame } from '../lib/git-blame-parser';
import { computeCoupling } from './implicit-coupling';
import { logDebugEvent } from '../lib/debug-logger';

interface BlastRadiusResult {
  target: string;
  coupled_files: string[];
  author_related: string[];
  total_blast_radius: number;
  risk: 'critical' | 'high' | 'medium' | 'low';
}

export const blastRadiusTool = tool({
  description:
    'Given a file, find everything that might break when you touch it — coupled files, shared authors, related modules.',

  args: {
    file: tool.schema.string().describe('File path relative to repo root to analyze'),
    since: tool.schema
      .string()
      .describe("Only consider commits since date (e.g., '90d', '6m')"),
  },

  async execute(args, _ctx) {
    const targetFile = args.file as string;
    const since = args.since as string | undefined;

    logDebugEvent('blast_radius.start', { file: targetFile, since: since ?? 'none' });

    try {
      const result = await computeBlastRadius(targetFile, since);
      logDebugEvent('blast_radius.done', { total: result.total_blast_radius });
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebugEvent('blast_radius.error', { error: msg });
      return `Error computing blast radius: ${msg}`;
    }
  },
});

/**
 * Compute blast radius for a target file.
 *
 * - Coupled files: files that co-change with the target (threshold 0.5)
 * - Author related: files by the same top authors, excluding already coupled
 */
export async function computeBlastRadius(
  targetFile: string,
  since?: string
): Promise<BlastRadiusResult> {
  // 1. Find coupled files via implicit coupling analysis
  const commits = await parseGitLog(since);
  const couplings = computeCoupling(commits, 0.5);

  const coupledFiles: string[] = [];
  for (const c of couplings) {
    const other = c.files[0] === targetFile ? c.files[1] : c.files[0] === targetFile ? c.files[0] : null;
    if (other && !coupledFiles.includes(other)) {
      coupledFiles.push(other);
    }
  }

  // 2. Find author-related files
  const targetBlame = await parseGitBlame(targetFile);
  const targetAuthors = new Set<string>();
  for (const bl of targetBlame) {
    if (bl.author && bl.author !== 'Not Committed Yet') {
      targetAuthors.add(bl.author);
    }
  }

  // Find files touched by the same authors in commit history
  const authorFiles = new Set<string>();
  const coupledSet = new Set(coupledFiles);
  coupledSet.add(targetFile);

  for (const commit of commits) {
    for (const author of targetAuthors) {
      if (commit.author === author) {
        for (const file of commit.files) {
          if (!coupledSet.has(file.path) && file.path !== targetFile) {
            authorFiles.add(file.path);
          }
        }
      }
    }
  }

  const allAffected = coupledFiles.length + authorFiles.size;

  // Risk assessment
  let risk: BlastRadiusResult['risk'] = 'low';
  if (allAffected > 10) risk = 'critical';
  else if (allAffected > 5) risk = 'high';
  else if (allAffected > 2) risk = 'medium';

  return {
    target: targetFile,
    coupled_files: coupledFiles,
    author_related: Array.from(authorFiles).sort(),
    total_blast_radius: allAffected,
    risk,
  };
}
