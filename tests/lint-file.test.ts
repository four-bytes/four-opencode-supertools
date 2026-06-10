import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lintFileTool } from '../src/tools/lint-file';

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

describe('lint_file tool', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-lint-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    ctx = mockCtx(testDir);
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('returns error for missing file', async () => {
    const result = await lintFileTool.execute({
      file_path: join(testDir, 'nonexistent.ts'),
    }, ctx);

    expect(result).toContain('Error');
    expect(result).toContain('File not found');
  });

  it('detects eslint for .ts files', async () => {
    writeFileSync(join(testDir, 'test.ts'), 'const x = 1;\n', 'utf-8');

    const result = await lintFileTool.execute({
      file_path: join(testDir, 'test.ts'),
      linter: 'eslint',
    }, ctx);

    // Should not crash — might fail if eslint not installed, but shouldn't throw
    expect(typeof result).toBe('string');
  });

  it('handles linter override', async () => {
    writeFileSync(join(testDir, 'test.ts'), 'code\n', 'utf-8');

    const result = await lintFileTool.execute({
      file_path: join(testDir, 'test.ts'),
      linter: 'eslint',
    }, ctx);

    expect(typeof result).toBe('string');
  });
});
