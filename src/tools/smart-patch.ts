// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { logDebugEvent } from '../lib/debug-logger';

/** Simple unified diff parser — extracts context, additions, and deletions per hunk. */
function parseSimpleDiff(patch: string): Array<{ context: string[]; additions: string[]; deletions: string[] }> {
  const hunks: Array<{ context: string[]; additions: string[]; deletions: string[] }> = [];
  const lines = patch.split('\n');
  let current: { context: string[]; additions: string[]; deletions: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { context: [], additions: [], deletions: [] };
    } else if (current) {
      if (line.startsWith(' ')) current.context.push(line.substring(1));
      else if (line.startsWith('+')) current.additions.push(line.substring(1));
      else if (line.startsWith('-')) current.deletions.push(line.substring(1));
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export const smartPatchTool = tool({
  description: `Apply a unified diff patch to a file using context-anchored matching (ignores line numbers). Scans the file for the best match of context lines. Use when native patch fails due to line number drift.`,

  args: {
    file_path: tool.schema.string().describe('Absolute path to the file'),
    patch: tool.schema.string().describe('Unified diff patch to apply'),
    fuzz: tool.schema
      .number()
      .optional()
      .describe('Maximum mismatched lines allowed in context match (default: 3)'),
  },

  async execute(args, _ctx) {
    const { file_path, patch, fuzz: fuzzRaw } = args;
    const fuzz = fuzzRaw ?? 3;

    logDebugEvent('smart_patch.start', { file_path, patch_length: patch.length, fuzz });

    if (!existsSync(file_path)) {
      throw new Error(`File not found: ${file_path}`);
    }

    const content = readFileSync(file_path, 'utf-8');
    const fileLines = content.split('\n');

    const hunks = parseSimpleDiff(patch);
    if (hunks.length === 0) {
      throw new Error('No hunks found in patch');
    }

    // Process hunks in reverse (bottom-up) to avoid offset cascade
    const reversedHunks = [...hunks].reverse();
    const offsets: number[] = [];

    for (const hunk of reversedHunks) {
      if (hunk.context.length === 0 && hunk.deletions.length === 0) {
        // Pure addition — append to end
        offsets.unshift(fileLines.length);
        fileLines.push(...hunk.additions);
        continue;
      }

      // Sliding window search for context match
      let bestMatch = -1;
      let bestMismatches = Infinity;

      const searchLen = hunk.context.length + hunk.deletions.length;
      const maxStart = fileLines.length - searchLen;

      for (let i = 0; i <= maxStart; i++) {
        let mismatches = 0;

        // Compare context lines
        for (let j = 0; j < hunk.context.length; j++) {
          if (fileLines[i + j] !== hunk.context[j]) {
            mismatches++;
            if (mismatches > fuzz) break;
          }
        }

        if (mismatches > fuzz) continue;

        // Compare deletion lines (lines being replaced)
        for (let j = 0; j < hunk.deletions.length; j++) {
          const idx = i + hunk.context.length + j;
          if (idx < fileLines.length && fileLines[idx] !== hunk.deletions[j]) {
            mismatches++;
            if (mismatches > fuzz) break;
          }
        }

        if (mismatches < bestMismatches) {
          bestMismatches = mismatches;
          bestMatch = i;
          if (mismatches === 0) break; // Perfect match
        }
      }

      if (bestMatch === -1) {
        throw new Error(
          `Could not match hunk context (${hunk.context.length} context + ${hunk.deletions.length} deletion lines). ` +
            `Best mismatch: ${bestMismatches === Infinity ? 'none found' : bestMismatches} (fuzz=${fuzz})`
        );
      }

      // Apply hunk at bestMatch — replace context+deletions with additions
      const replacementLen = hunk.context.length + hunk.deletions.length;
      fileLines.splice(bestMatch, replacementLen, ...hunk.additions);
      offsets.unshift(bestMatch);
    }

    writeFileSync(file_path, fileLines.join('\n'), 'utf-8');
    logDebugEvent('smart_patch.complete', { file_path, hunks: hunks.length });
    return { applied: true, hunks: hunks.length, offsets: offsets };
  },
});
