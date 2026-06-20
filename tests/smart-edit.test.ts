// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { smartEditTool } from '../src/tools/smart-edit';

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

describe('smart_edit tool', () => {
  let testFile: string;

  beforeEach(() => {
    testFile = join(tmpdir(), `smart-edit-test-${Date.now()}.txt`);
    writeFileSync(testFile, "function hello() {\n  return 'world';\n}", 'utf-8');
  });

  afterEach(() => {
    try {
      if (existsSync(testFile)) unlinkSync(testFile);
    } catch {
      /* ignore */
    }
  });

  it('exact match replaces text', async () => {
    const result = await smartEditTool.execute(
      {
        file_path: testFile,
        old_string: "return 'world'",
        new_string: "return 'universe'",
      },
      mockCtx()
    );

    expect(result.metadata.changed).toBe(true);
    expect(result.metadata.method).toBe('exact');
    expect(result.title).toMatch(/^Updated /);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    const content = readFileSync(testFile, 'utf-8');
    expect(content).toContain("return 'universe'");
  });

  it('normalized match replaces with whitespace variance', async () => {
    writeFileSync(testFile, "function hello() {\n\treturn 'world';\n}", 'utf-8');

    const result = await smartEditTool.execute(
      {
        file_path: testFile,
        old_string: "  return 'world';",
        new_string: "  return 'mars';",
      },
      mockCtx()
    );

    expect(result.metadata.changed).toBe(true);
    expect(result.metadata.method).toBe('normalized');
    expect(result.title).toMatch(/^Updated /);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    const content = readFileSync(testFile, 'utf-8');
    expect(content).toContain("return 'mars'");
  });

  it('throws on file not found', async () => {
    expect(
      smartEditTool.execute(
        {
          file_path: '/tmp/nonexistent-file-12345.txt',
          old_string: 'x',
          new_string: 'y',
        },
        mockCtx()
      )
    ).rejects.toThrow('File not found');
  });

  it('throws on multiple matches without allow_multiple', async () => {
    writeFileSync(testFile, 'foo\nfoo\nbar\n', 'utf-8');

    expect(
      smartEditTool.execute(
        {
          file_path: testFile,
          old_string: 'foo',
          new_string: 'baz',
        },
        mockCtx()
      )
    ).rejects.toThrow('Found 2 exact matches');
  });

  it('allows multiple matches when allow_multiple is true', async () => {
    writeFileSync(testFile, 'foo\nfoo\nbar\n', 'utf-8');

    const result = await smartEditTool.execute(
      {
        file_path: testFile,
        old_string: 'foo',
        new_string: 'baz',
        allow_multiple: true,
      },
      mockCtx()
    );

    expect(result.metadata.matches).toBe(2);
    const content = readFileSync(testFile, 'utf-8');
    expect(content).toBe('baz\nbaz\nbar\n');
  });
});
