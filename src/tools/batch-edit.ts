// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';

export const batchEditTool = tool({
  description: `Search and replace across multiple files in a single call. Saves ~80% tokens vs. grep→read→edit×N.

Use this when you need to make the same change across many files. It will:
1. Find all files matching the glob pattern
2. Search each file for the regex pattern
3. Replace matches with the replacement text
4. Write back only changed files

Returns a summary of files changed and replacements per file.`,

  args: {
    search: tool.schema.string().describe('Regex pattern to search for (JavaScript regex syntax)'),
    replace: tool.schema.string().describe('Replacement text. Use $1, $2, etc. for capture groups.'),
    glob: tool.schema.string().describe('Glob pattern to filter files (e.g., "src/**/*.ts", "**/*.php")'),
    path: tool.schema.string().optional().describe('Base directory for glob search. Defaults to project root.'),
    dry_run: tool.schema.boolean().optional().describe('If true, show what would change without writing files.'),
  },

  async execute(args, ctx) {
    const { search, replace, glob: globPattern, path: basePath, dry_run } = args;
    const directory = basePath ? resolve(ctx.directory, basePath) : ctx.directory;

    logDebugEvent('batch_edit.start', { search, glob: globPattern, path: directory, dry_run });

    try {
      // 1. Validate regex
      let regex: RegExp;
      try {
        regex = new RegExp(search, 'gm');
      } catch (e) {
        return `Error: Invalid regex pattern "${search}": ${e instanceof Error ? e.message : String(e)}`;
      }

      // 2. Find matching files
      let files: string[];
      try {
        const globResult = new Bun.Glob(globPattern);
        files = Array.from(globResult.scanSync({ cwd: directory, absolute: true }));
      } catch {
        return `Error: Could not scan files with glob "${globPattern}" in ${directory}`;
      }

      if (files.length === 0) {
        return `No files found matching glob "${globPattern}" in ${directory}`;
      }

      // 3. Process each file
      const results: Array<{ file: string; matches: number }> = [];
      let totalMatches = 0;
      let filesChanged = 0;

      for (const file of files) {
        try {
          const content = readFileSync(file, 'utf-8');

          // Reset regex state
          regex.lastIndex = 0;

          // Count matches
          const matchCount = (content.match(regex) || []).length;
          if (matchCount === 0) continue;

          totalMatches += matchCount;

          if (!dry_run) {
            // Reset and apply replacement
            regex.lastIndex = 0;
            const newContent = content.replace(regex, replace);

            if (newContent !== content) {
              writeFileSync(file, newContent, 'utf-8');
              filesChanged++;
            }
          } else {
            filesChanged++;
          }

          results.push({
            file: relative(directory, file),
            matches: matchCount,
          });
        } catch (err) {
          logDebugEvent('batch_edit.file_error', { file, error: String(err) });
          // Skip files we can't read
        }
      }

      // 4. Summary
      const prefix = dry_run ? '[DRY RUN] ' : '';
      const lines: string[] = [
        `${prefix}Searched ${files.length} file(s) matching "${globPattern}"`,
        `Pattern: /${search}/gm → "${replace}"`,
        `${totalMatches} match(es) across ${filesChanged} file(s):`,
      ];

      for (const r of results) {
        lines.push(`  ${r.file}: ${r.matches} replacement(s)`);
      }

      if (dry_run) {
        lines.push('\nDry run — no files were modified. Remove dry_run: true to apply changes.');
      }

      logDebugEvent('batch_edit.complete', { files: files.length, matches: totalMatches, changed: filesChanged, dry_run });
      return lines.join('\n');

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logDebugEvent('batch_edit.error', { error: msg });
      return `Error in batch_edit: ${msg}`;
    }
  },
});
