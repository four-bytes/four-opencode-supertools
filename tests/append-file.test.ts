import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileTool } from '../src/tools/append-file';

function mockCtx(dir: string) {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe('append_file tool', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-append-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    ctx = mockCtx(testDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('appends to an existing file', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'line1\nline2\n', 'utf-8');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'line3\nline4',
        mode: 'append',
      },
      ctx
    );

    expect(result).toContain('Appended to');
    expect(result).toContain('append mode');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('line1\nline2\nline3\nline4\n');
  });

  it('prepends at the top of an existing file', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'line1\nline2\n', 'utf-8');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'header',
        mode: 'prepend',
        after_line: 0,
      },
      ctx
    );

    expect(result).toContain('prepend mode');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('header\nline1\nline2\n');
  });

  it('prepends after a specific line', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf-8');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'inserted',
        mode: 'prepend',
        after_line: 1,
      },
      ctx
    );

    expect(result).toContain('prepend mode');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('line1\nline2\ninserted\nline3\n');
  });

  it('appends to an empty file', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, '', 'utf-8');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'first line',
        mode: 'append',
      },
      ctx
    );

    expect(result).toContain('Appended to');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('first line\n');
  });

  it('prepends to an empty file', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, '', 'utf-8');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'first line',
        mode: 'prepend',
        after_line: 0,
      },
      ctx
    );

    expect(result).toContain('prepend mode');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('first line\n');
  });

  it('prepends before the last line with after_line=-1 (3-line file)', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf-8');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'inserted',
        mode: 'prepend',
        after_line: -1,
      },
      ctx
    );

    expect(result).toContain('prepend mode');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('line1\nline2\ninserted\nline3\n');
  });

  it('prepends before the last line with after_line=-1 (2-line file — edge case)', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'line1\nline2\n', 'utf-8');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'inserted',
        mode: 'prepend',
        after_line: -1,
      },
      ctx
    );

    expect(result).toContain('prepend mode');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('line1\ninserted\nline2\n');
  });

  it('returns error for missing file', async () => {
    const filePath = join(testDir, 'nonexistent.txt');

    const result = await appendFileTool.execute(
      {
        file_path: filePath,
        content: 'hello',
        mode: 'append',
      },
      ctx
    );

    expect(result).toContain('Error');
    expect(result).toContain('ENOENT');
  });
});
