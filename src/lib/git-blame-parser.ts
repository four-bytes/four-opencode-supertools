// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { git } from './git-runner';

export interface BlameLine {
  line: number;
  author: string;
  commit: string;
}

/**
 * Parse `git blame --line-porcelain` for a single file.
 * Returns an array of BlameLine, one per line of the file.
 */
export async function parseGitBlame(filePath: string): Promise<BlameLine[]> {
  try {
    const output = await git(['blame', '--line-porcelain', '--', filePath]);
    return parseBlameOutput(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If the file doesn't exist in git, return empty array
    if (msg.includes('no such path') || msg.includes('exists on disk, but not in')) {
      return [];
    }
    throw err;
  }
}

/**
 * Parse `git blame --line-porcelain` for all tracked files in a directory.
 * Returns a Map of file path → blame lines.
 */
export async function parseGitBlameForDir(
  dirPath: string
): Promise<Map<string, BlameLine[]>> {
  const result = new Map<string, BlameLine[]>();

  // Get all tracked files in the directory
  let fileList: string;
  try {
    fileList = await git(['ls-files', '--', dirPath]);
  } catch {
    return result;
  }

  const files = fileList.split('\n').filter((f) => f.trim() !== '');

  for (const file of files) {
    const blame = await parseGitBlame(file);
    if (blame.length > 0) {
      result.set(file, blame);
    }
  }

  return result;
}

/**
 * Parse the raw output of `git blame --line-porcelain`.
 * The porcelain format emits:
 *   - A header line per commit: COMMIT_HASH ORIG_LINE FINAL_LINE [GROUP_SIZE]
 *   - Then "pseudo-headers" prefixed with a space and field name
 *   - Then the actual line content prefixed with a tab
 *
 * Exported for testing.
 */
export function parseBlameOutput(raw: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const allLines = raw.split('\n');

  let currentLineNum = 0;
  let currentCommit = '';
  let currentAuthor = '';

  for (const line of allLines) {
    // Header line: <40-char-hex> <orig-line> <final-line> [group-size]
    const headerMatch = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
    if (headerMatch) {
      currentCommit = headerMatch[1]!;
      currentLineNum = parseInt(headerMatch[3]!, 10);
      // Reset for new entry
      currentAuthor = '';
      continue;
    }

    // Pseudo-header: space-prefixed field
    if (line.startsWith('author ')) {
      currentAuthor = line.slice('author '.length);
      continue;
    }

    // Tab-prefixed line is the actual file content
    if (line.startsWith('\t')) {
      if (currentLineNum > 0) {
        lines.push({
          line: currentLineNum,
          author: currentAuthor,
          commit: currentCommit,
        });
        currentLineNum++; // increment for group lines
      }
      continue;
    }

    // Other pseudo-headers are ignored
  }

  return lines;
}
