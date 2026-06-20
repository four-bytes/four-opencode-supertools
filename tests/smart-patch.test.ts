// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { smartPatchTool } from '../src/tools/smart-patch';

function mockCtx() {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: '/tmp',
    worktree: '/tmp',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe('smart_patch tool', () => {
  let testFile: string;

  beforeEach(() => {
    testFile = join(tmpdir(), `smart-patch-test-${Date.now()}.txt`);
    writeFileSync(testFile, 'line 1\nline 2\nline 3\nline 4\nline 5', 'utf-8');
  });

  afterEach(() => {
    try {
      if (existsSync(testFile)) unlinkSync(testFile);
    } catch {
      /* ignore */
    }
  });

  it('applies simple patch with context', async () => {
    const patch = '@@ -1,5 +1,5 @@\n line 1\n-line 2\n+line two\n line 3\n line 4\n line 5';
    const result = await smartPatchTool.execute(
      {
        file_path: testFile,
        patch,
      },
      mockCtx()
    );

    expect(result.metadata.applied).toBe(true);
    expect(result.metadata.hunks).toBe(1);
    expect(result.title).toMatch(/^Patched /);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    const content = readFileSync(testFile, 'utf-8');
    expect(content).toContain('line two');
  });

  it('applies patch even with wrong line numbers (context anchored)', async () => {
    // Line numbers say @@ -10,5 but we match by context
    const patch = '@@ -10,5 +10,5 @@\n line 2\n-line 3\n+line three\n line 4';
    const result = await smartPatchTool.execute(
      {
        file_path: testFile,
        patch,
      },
      mockCtx()
    );

    expect(result.metadata.applied).toBe(true);
    expect(result.title).toMatch(/^Patched /);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    const content = readFileSync(testFile, 'utf-8');
    expect(content).toContain('line three');
  });

  it('throws on file not found', async () => {
    await expect(
      smartPatchTool.execute(
        {
          file_path: '/tmp/nonexistent-patch-test.txt',
          patch: '@@ -1 +1 @@\n-old\n+new',
        },
        mockCtx()
      )
    ).rejects.toThrow('File not found');
  });

  it('throws on bad patch with no hunks', async () => {
    await expect(
      smartPatchTool.execute(
        {
          file_path: testFile,
          patch: 'not a valid patch',
        },
        mockCtx()
      )
    ).rejects.toThrow('No hunks found');
  });
});
