// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { git } from './git-runner';

export interface FileChange {
  path: string;
  added: number;
  deleted: number;
}

export interface Commit {
  hash: string;
  author: string;
  date: string; // ISO 8601
  files: FileChange[];
}

/**
 * Parse `git log` output into structured Commit objects.
 * Uses `git log --numstat --format='%H|%an|%aI'` for machine-readable output.
 *
 * @param since Optional date filter (e.g., '90d', '2024-01-01', '6 months ago')
 */
export async function parseGitLog(since?: string): Promise<Commit[]> {
  const args = ['log', "--numstat", "--format=%H|%an|%aI"];

  if (since) {
    args.push(`--since=${since}`);
  }

  const output = await git(args);
  return parseLogOutput(output);
}

/**
 * Parse the raw output of `git log --numstat --format='%H|%an|%aI'`.
 * Exported for testing.
 *
 * Output format:
 *   HASH|AUTHOR|DATE
 *   (blank line — separator between header and numstat)
 *   added\tdeleted\tpath
 *   ...
 *   (blank line before next commit)
 *   HASH|AUTHOR|DATE
 *   ...
 */
export function parseLogOutput(raw: string): Commit[] {
  const commits: Commit[] = [];
  let currentCommit: Commit | null = null;

  const lines = raw.split('\n');

  for (const line of lines) {
    // Check if this is a commit header line: HASH|AUTHOR|DATE
    // Hash is exactly 40 hex chars, followed by |author|ISO-date
    const headerMatch = line.match(/^([0-9a-f]{40})\|([^|]+)\|(.+)$/);
    if (headerMatch) {
      // Save previous commit before starting new one
      if (currentCommit) {
        commits.push(currentCommit);
      }
      currentCommit = {
        hash: headerMatch[1]!,
        author: headerMatch[2]!,
        date: headerMatch[3]!,
        files: [],
      };
      continue;
    }

    // Skip blank lines (separators)
    if (line.trim() === '') {
      continue;
    }

    // Otherwise it's a numstat file line: added\tdeleted\tpath
    if (currentCommit) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match) {
        const added = match[1] === '-' ? 0 : parseInt(match[1], 10);
        const deleted = match[2] === '-' ? 0 : parseInt(match[2], 10);
        const path = match[3]!;
        currentCommit.files.push({ path, added, deleted });
      }
    }
  }

  // Don't forget the last commit
  if (currentCommit) {
    commits.push(currentCommit);
  }

  return commits;
}
