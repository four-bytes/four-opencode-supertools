// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { parseGitBlame, parseGitBlameForDir, type BlameLine } from '../lib/git-blame-parser';
import { statSync, existsSync } from 'node:fs';
import { logDebugEvent } from '../lib/debug-logger';

interface AuthorStat {
  author: string;
  lines: number;
  pct: number;
  files?: number;
}

interface FileOwnership {
  total: number;
  authors: AuthorStat[];
}

interface OwnershipResult {
  path: string;
  total_lines: number;
  authors: AuthorStat[];
  files?: Record<string, FileOwnership>;
}

export const ownershipTool = tool({
  description:
    'Analyze who owns the lines alive in HEAD — per-file and per-directory author breakdown. Surfaces knowledge silos and onboarding targets.',

  args: {
    path: tool.schema
      .string()
      .describe('File or directory path relative to repo root (default: entire repo)'),
  },

  async execute(args, _ctx) {
    const targetPath = (args.path as string) || '.';

    logDebugEvent('ownership.start', { path: targetPath });

    try {
      const result = await computeOwnership(targetPath);
      logDebugEvent('ownership.done', { total_lines: result.total_lines });
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebugEvent('ownership.error', { error: msg });
      return `Error computing ownership: ${msg}`;
    }
  },
});

/**
 * Compute author breakdown for a file or directory.
 */
export async function computeOwnership(targetPath: string): Promise<OwnershipResult> {
  const isDir = existsSync(targetPath) && statSync(targetPath).isDirectory();
  const normalizedPath = targetPath === '.' ? targetPath : targetPath.replace(/\/$/, '');

  if (isDir) {
    return computeDirOwnership(normalizedPath);
  }

  return computeFileOwnership(normalizedPath);
}

/**
 * Aggregate author stats from blame lines.
 */
function aggregateAuthors(
  blameLines: BlameLine[],
  filesTouched?: number
): { total: number; authors: AuthorStat[] } {
  const authorLines = new Map<string, number>();

  for (const bl of blameLines) {
    if (bl.author && bl.author !== 'Not Committed Yet') {
      authorLines.set(bl.author, (authorLines.get(bl.author) ?? 0) + 1);
    }
  }

  const total = Array.from(authorLines.values()).reduce((sum, n) => sum + n, 0);
  const authors: AuthorStat[] = [];

  for (const [author, lines] of authorLines) {
    authors.push({
      author,
      lines,
      pct: total > 0 ? Math.round((lines / total) * 1000) / 10 : 0,
      ...(filesTouched !== undefined ? { files: filesTouched } : {}),
    });
  }

  authors.sort((a, b) => b.lines - a.lines);

  return { total, authors };
}

async function computeFileOwnership(filePath: string): Promise<OwnershipResult> {
  const blameLines = await parseGitBlame(filePath);
  const { total, authors } = aggregateAuthors(blameLines);

  return {
    path: filePath,
    total_lines: total,
    authors,
  };
}

async function computeDirOwnership(dirPath: string): Promise<OwnershipResult> {
  const blameMap = await parseGitBlameForDir(dirPath);

  const files: Record<string, FileOwnership> = {};
  const globalAuthorLines = new Map<string, number>();
  const globalAuthorFiles = new Map<string, number>();
  let globalTotal = 0;

  for (const [filePath, blameLines] of blameMap) {
    const { total, authors } = aggregateAuthors(blameLines);
    files[filePath] = { total, authors };

    for (const author of authors) {
      globalAuthorLines.set(
        author.author,
        (globalAuthorLines.get(author.author) ?? 0) + author.lines
      );
      globalAuthorFiles.set(
        author.author,
        (globalAuthorFiles.get(author.author) ?? 0) + 1
      );
    }
    globalTotal += total;
  }

  const globalAuthors: AuthorStat[] = [];
  for (const [author, lines] of globalAuthorLines) {
    globalAuthors.push({
      author,
      lines,
      pct: globalTotal > 0 ? Math.round((lines / globalTotal) * 1000) / 10 : 0,
      files: globalAuthorFiles.get(author),
    });
  }
  globalAuthors.sort((a, b) => b.lines - a.lines);

  return {
    path: dirPath === '.' ? '.' : dirPath,
    total_lines: globalTotal,
    authors: globalAuthors,
    files,
  };
}
