// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileTreeTool } from '../src/tools/file-tree';

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

describe('file_tree tool', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-tree-test-${Date.now()}`);
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'subdir'));
    writeFileSync(join(testDir, 'file1.txt'), 'hello', 'utf-8');
    writeFileSync(join(testDir, 'subdir', 'file2.ts'), 'const x = 1;', 'utf-8');
  });

  afterEach(() => {
    try {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('lists directory tree', async () => {
    const result = await fileTreeTool.execute({ path: testDir, depth: 2 }, mockCtx());
    expect(Array.isArray(result)).toBe(true);
    expect(result.some((n: { name: string }) => n.name === 'file1.txt')).toBe(true);
    expect(result.some((n: { name: string }) => n.name === 'subdir/')).toBe(true);
  });

  it('returns file info for single file path', async () => {
    const result = await fileTreeTool.execute({ path: join(testDir, 'file1.txt') }, mockCtx());
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe('file');
    expect(result[0].size).toBe(5);
  });

  it('throws on nonexistent path', async () => {
    expect(fileTreeTool.execute({ path: '/tmp/nonexistent-file-tree' }, mockCtx())).rejects.toThrow('Path not found');
  });
});
