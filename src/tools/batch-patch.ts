// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { logDebugEvent } from '../lib/debug-logger';
import { smartPatchTool } from './smart-patch';

export const batchPatchTool = tool({
  description: `Apply patches to multiple files in one call. Optional atomic mode: snapshot all files, apply all, rollback on any failure.`,

  args: {
    patches: tool.schema
      .string()
      .describe('JSON array of { file_path: string, patch: string } objects'),
    atomic: tool.schema
      .boolean()
      .optional()
      .describe('If true, rollback ALL files on any failure (default: false)'),
  },

  async execute(args, _ctx) {
    const patches: Array<{ file_path: string; patch: string }> = JSON.parse(args.patches);

    if (!Array.isArray(patches)) {
      throw new Error('patches must be a JSON array');
    }

    logDebugEvent('batch_patch.start', { count: patches.length, atomic: args.atomic ?? false });

    const applied: string[] = [];
    const failed: Array<{ file: string; error: string }> = [];
    const snapshots = new Map<string, string | null>();

    // Take snapshots if atomic
    if (args.atomic) {
      for (const p of patches) {
        try {
          if (existsSync(p.file_path)) {
            snapshots.set(p.file_path, readFileSync(p.file_path, 'utf-8'));
          } else {
            snapshots.set(p.file_path, null); // File doesn't exist yet
          }
        } catch {
          snapshots.set(p.file_path, null);
        }
      }
    }

    for (const p of patches) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await smartPatchTool.execute({ file_path: p.file_path, patch: p.patch }, {} as any);
        applied.push(p.file_path);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        failed.push({ file: p.file_path, error: errMsg });

        if (args.atomic) {
          logDebugEvent('batch_patch.rollback', { file: p.file_path, error: errMsg });
          // Rollback all snapshots
          for (const [path, content] of snapshots) {
            if (content === null) {
              try {
                unlinkSync(path);
              } catch {
                /* ignore */
              }
            } else {
              try {
                writeFileSync(path, content, 'utf-8');
              } catch {
                /* ignore */
              }
            }
          }
          return {
            title: 'Batch patch rolled back',
            output: `Rolled back due to failure in ${failed[0]?.file}: ${failed[0]?.error}`,
            metadata: { applied: [], failed, rolled_back: applied.length > 0 ? applied : [] },
          };
        }
      }
    }

    logDebugEvent('batch_patch.complete', { applied: applied.length, failed: failed.length });
    return {
      title: applied.length > 0 ? `Patched ${applied.length} file(s)` : 'Batch patch',
      output: `Applied: ${applied.length}, Failed: ${failed.length}\n${[...applied.map((f) => `  ✓ ${f}`), ...failed.map((f) => `  ✗ ${f.file}: ${f.error}`)].join('\n')}`,
      metadata: { applied, failed },
    };
  },
});
