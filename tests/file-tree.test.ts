// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes
/* global AbortController */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
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
    expect(Array.isArray(result.metadata.tree)).toBe(true);
    expect(result.metadata.tree.some((n: { name: string }) => n.name === 'file1.txt')).toBe(true);
    expect(result.metadata.tree.some((n: { name: string }) => n.name === 'subdir/')).toBe(true);
    expect(typeof result.output).toBe('string');
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it('returns file info for single file path (metadata.tree)', async () => {
    const result = await fileTreeTool.execute({ path: join(testDir, 'file1.txt') }, mockCtx());
    expect(Array.isArray(result.metadata.tree)).toBe(true);
    expect(result.metadata.tree[0].type).toBe('file');
    expect(result.metadata.tree[0].size).toBe(5);
  });

  it('throws on nonexistent path', async () => {
    await expect(
      fileTreeTool.execute({ path: '/tmp/nonexistent-file-tree' }, mockCtx())
    ).rejects.toThrow('Path not found');
  });

  it('filters files by glob pattern', async () => {
    const result = await fileTreeTool.execute(
      { path: testDir, depth: 2, filter: '*.txt' },
      mockCtx()
    );
    const names = result.metadata.tree.map((n: { name: string }) => n.name);
    expect(names).toContain('file1.txt');
    // filter only applies to files, not directories
    expect(names).toContain('subdir/');
    // but non-txt files inside subdir are filtered out
    const subdir = result.metadata.tree.find((n: { name: string }) => n.name === 'subdir/');
    if (subdir?.children) {
      expect(subdir.children.some((c: { name: string }) => c.name === 'file2.ts')).toBe(false);
    }
  });

  it('respects depth limit', async () => {
    mkdirSync(join(testDir, 'subdir', 'deep'), { recursive: true });
    writeFileSync(join(testDir, 'subdir', 'deep', 'nested.txt'), 'deep', 'utf-8');
    const result = await fileTreeTool.execute({ path: testDir, depth: 0 }, mockCtx());
    const subdir = result.metadata.tree.find((n: { name: string }) => n.name === 'subdir/');
    expect(subdir?.children).toBeUndefined();
  });

  it('includes hidden files when include_hidden is true', async () => {
    writeFileSync(join(testDir, '.hidden'), 'secret', 'utf-8');
    const result = await fileTreeTool.execute(
      { path: testDir, depth: 2, include_hidden: true },
      mockCtx()
    );
    const names = result.metadata.tree.map((n: { name: string }) => n.name);
    expect(names).toContain('.hidden');
  });

  it('excludes hidden files by default', async () => {
    writeFileSync(join(testDir, '.hidden'), 'secret', 'utf-8');
    const result = await fileTreeTool.execute({ path: testDir, depth: 2 }, mockCtx());
    const names = result.metadata.tree.map((n: { name: string }) => n.name);
    expect(names).not.toContain('.hidden');
  });

  it('skips symlinked directories to prevent cycles', async () => {
    mkdirSync(join(testDir, 'target'), { recursive: true });
    writeFileSync(join(testDir, 'target', 'real.txt'), 'real', 'utf-8');
    symlinkSync(join(testDir, 'target'), join(testDir, 'link'));
    const result = await fileTreeTool.execute({ path: testDir, depth: 3 }, mockCtx());
    const _names = result.metadata.tree.map((n: { name: string }) => n.name);
    // symlink dir itself may appear but its children must not be recursed
    const link = result.metadata.tree.find((n: { name: string }) => n.name === 'link/');
    if (link) {
      expect(link.children).toBeUndefined();
    }
    // target's children should still appear
    const target = result.metadata.tree.find((n: { name: string }) => n.name === 'target/');
    expect(target?.children?.some((c: { name: string }) => c.name === 'real.txt')).toBe(true);
  });
});
