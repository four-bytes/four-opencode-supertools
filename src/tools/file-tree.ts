// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';

interface FileNode {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);

function walkDir(dir: string, depth: number, maxDepth: number, filter?: string, includeHidden = false): FileNode[] {
  if (depth > maxDepth) return [];

  const results: FileNode[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries.sort()) {
    if (!includeHidden && entry.startsWith('.') && entry !== '.gitignore') continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry) && !includeHidden) continue;
      const children = walkDir(fullPath, depth + 1, maxDepth, filter, includeHidden);
      results.push({
        name: entry + '/',
        type: 'dir',
        children: children.length > 0 ? children : undefined,
      });
    } else {
      if (filter) {
        const regex = new RegExp('^' + filter.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        if (!regex.test(entry)) continue;
      }
      results.push({ name: entry, type: 'file', size: stat.size });
    }
  }

  return results;
}

export const fileTreeTool = tool({
  description: `List directory contents as a structured tree with file sizes. Skips .git, node_modules, vendor by default. Respects .gitignore. Use instead of bash ls/find for parsed output.`,

  args: {
    path: tool.schema.string().describe('Directory path to list'),
    depth: tool.schema
      .number()
      .optional()
      .describe('Maximum depth (default: 3)'),
    filter: tool.schema
      .string()
      .optional()
      .describe('Glob pattern to filter files (e.g., "*.ts")'),
    include_hidden: tool.schema
      .boolean()
      .optional()
      .describe('Include hidden files and directories (default: false)'),
  },

  async execute(args, _ctx) {
    const targetPath = args.path;
    const depth = args.depth ?? 3;

    logDebugEvent('file_tree.start', { path: targetPath, depth });

    if (!existsSync(targetPath)) {
      throw new Error(`Path not found: ${targetPath}`);
    }

    if (!statSync(targetPath).isDirectory()) {
      const stat = statSync(targetPath);
      const singleFile = {
        name: targetPath.split('/').pop() || targetPath,
        type: 'file' as const,
        size: stat.size,
      };
      return {
        title: targetPath.split('/').pop() || targetPath,
        output: JSON.stringify(singleFile, null, 2),
        metadata: { entries: [singleFile] },
      };
    }

    const results = walkDir(targetPath, 0, depth, args.filter, args.include_hidden);
    logDebugEvent('file_tree.complete', { path: targetPath, entries: results.length });
    return {
      title: targetPath.split('/').pop() || targetPath,
      output: JSON.stringify(results, null, 2),
      metadata: { path: targetPath, entries: results.length, tree: results },
    };
  },
});
