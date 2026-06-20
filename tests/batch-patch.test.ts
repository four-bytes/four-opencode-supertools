// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batchPatchTool } from '../src/tools/batch-patch';

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

describe('batch_patch tool', () => {
  let file1: string;
  let file2: string;

  beforeEach(() => {
    const base = join(tmpdir(), `batch-patch-${Date.now()}`);
    file1 = `${base}-1.txt`;
    file2 = `${base}-2.txt`;
    writeFileSync(file1, 'hello world', 'utf-8');
    writeFileSync(file2, 'foo bar', 'utf-8');
  });

  afterEach(() => {
    try {
      if (existsSync(file1)) unlinkSync(file1);
      if (existsSync(file2)) unlinkSync(file2);
    } catch {
      /* ignore */
    }
  });

  it('applies patches to multiple files', async () => {
    const patches = JSON.stringify([
      { file_path: file1, patch: '@@ -1 +1 @@\n-hello world\n+hello universe' },
      { file_path: file2, patch: '@@ -1 +1 @@\n-foo bar\n+foo baz' },
    ]);

    const result = await batchPatchTool.execute({ patches }, mockCtx());
    expect(result.metadata.applied).toHaveLength(2);
    expect(result.metadata.failed).toHaveLength(0);
    expect(readFileSync(file1, 'utf-8')).toContain('hello universe');
    expect(readFileSync(file2, 'utf-8')).toContain('foo baz');
  });

  it('reports failure on bad patch', async () => {
    const patches = JSON.stringify([
      { file_path: file1, patch: '@@ -1 +1 @@\n-hello universe\n+hi' },
      { file_path: '/tmp/nonexistent-batch-patch-test.txt', patch: 'bad' },
    ]);

    const result = await batchPatchTool.execute({ patches }, mockCtx());
    expect(result.metadata.failed.length).toBeGreaterThan(0);
    expect(result.metadata.applied).toHaveLength(1); // First one still applies
  });

  it('rolls back on atomic mode', async () => {
    const original1 = readFileSync(file1, 'utf-8');
    const patches = JSON.stringify([
      { file_path: file1, patch: '@@ -1 +1 @@\n-hello world\n+hello universe' },
      { file_path: '/tmp/nonexistent-atomic-rollback.txt', patch: 'bad patch' },
    ]);

    const result = await batchPatchTool.execute({ patches, atomic: true }, mockCtx());
    expect(result.metadata.failed.length).toBeGreaterThan(0);
    // file1 should be rolled back
    expect(readFileSync(file1, 'utf-8')).toBe(original1);
  });
});
