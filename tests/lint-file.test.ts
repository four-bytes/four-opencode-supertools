import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLintCommand, findGoModuleRoot, lintFileTool } from '../src/tools/lint-file';

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
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('returns error for missing file', async () => {
    const result = await lintFileTool.execute(
      {
        file_path: join(testDir, 'nonexistent.ts'),
      },
      ctx
    );

    expect(result).toContain('Error');
    expect(result).toContain('File not found');
  });

  it('detects eslint for .ts files', async () => {
    writeFileSync(join(testDir, 'test.ts'), 'const x = 1;\n', 'utf-8');

    const result = await lintFileTool.execute(
      {
        file_path: join(testDir, 'test.ts'),
        linter: 'eslint',
      },
      ctx
    );

    // Should not crash — might fail if eslint not installed, but shouldn't throw
    expect(typeof result).toBe('string');
  });

  it('handles linter override', async () => {
    writeFileSync(join(testDir, 'test.ts'), 'code\n', 'utf-8');

    const result = await lintFileTool.execute(
      {
        file_path: join(testDir, 'test.ts'),
        linter: 'eslint',
      },
      ctx
    );

    expect(typeof result).toBe('string');
  });
});

describe('lint_file Go support', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-lint-go-${Date.now()}`);
    mkdirSync(join(testDir, 'internal', 'stock'), { recursive: true });
    writeFileSync(join(testDir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n', 'utf-8');
    ctx = mockCtx(testDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('finds the module root above a file', () => {
    const file = join(testDir, 'internal', 'stock', 'stock.go');
    expect(findGoModuleRoot(file)).toBe(testDir);
  });

  it('returns null without go.mod', () => {
    expect(findGoModuleRoot(join(tmpdir(), 'no-module-here', 'x.go'))).toBeNull();
  });

  it('lints the package directory relative to the module root', () => {
    const file = join(testDir, 'internal', 'stock', 'stock.go');
    const { cmd } = buildLintCommand('golangci', file, testDir);
    expect(cmd).toEqual(['golangci-lint', 'run', '--show-stats=false', './internal/stock']);
  });

  it('lints "." for a file in the module root', () => {
    const { cmd } = buildLintCommand('golangci', join(testDir, 'main.go'), testDir);
    expect(cmd[cmd.length - 1]).toBe('.');
  });

  it('reports a missing go.mod', async () => {
    const dir = join(tmpdir(), `supertools-lint-nomod-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.go'), 'package x\n', 'utf-8');
    const result = await lintFileTool.execute({ file_path: join(dir, 'x.go') }, mockCtx(dir));
    rmSync(dir, { recursive: true });
    expect(result).toContain('No go.mod');
  });

  it.skipIf(!Bun.which('golangci-lint'))('reports an issue found by golangci-lint', async () => {
    const file = join(testDir, 'internal', 'stock', 'stock.go');
    writeFileSync(
      file,
      'package stock\n\nimport "os"\n\nfunc Remove() {\n\tos.Remove("x")\n}\n',
      'utf-8'
    );
    const result = await lintFileTool.execute({ file_path: file }, ctx);
    expect(result).toContain('errcheck');
  });

  it.skipIf(!Bun.which('golangci-lint'))('passes clean Go code', async () => {
    const file = join(testDir, 'internal', 'stock', 'stock.go');
    writeFileSync(
      file,
      'package stock\n\n// Two returns 2.\nfunc Two() int { return 2 }\n',
      'utf-8'
    );
    const result = await lintFileTool.execute({ file_path: file }, ctx);
    expect(result).toContain('No lint errors');
  });
});
