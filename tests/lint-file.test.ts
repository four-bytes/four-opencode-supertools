import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildLintCommand,
  findCargoRoot,
  findDenoRoot,
  findGoModuleRoot,
  findTscBinary,
  findTsconfigRoot,
  lintFileTool,
  parseClippyJson,
  parseCargoWorkspaceRoot,
  parseDenoCheckOutput,
  parseDenoLintJson,
  parseTscOutput,
} from '../src/tools/lint-file';

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

  it.skipIf(!Bun.which('golangci-lint'))(
    'reports an issue found by golangci-lint',
    async () => {
      const file = join(testDir, 'internal', 'stock', 'stock.go');
      writeFileSync(
        file,
        'package stock\n\nimport "os"\n\nfunc Remove() {\n\tos.Remove("x")\n}\n',
        'utf-8'
      );
      const result = await lintFileTool.execute({ file_path: file }, ctx);
      expect(result).toContain('errcheck');
    },
    120_000
  );

  it.skipIf(!Bun.which('golangci-lint'))(
    'passes clean Go code',
    async () => {
      const file = join(testDir, 'internal', 'stock', 'stock.go');
      writeFileSync(
        file,
        'package stock\n\n// Two returns 2.\nfunc Two() int { return 2 }\n',
        'utf-8'
      );
      const result = await lintFileTool.execute({ file_path: file }, ctx);
      expect(result).toContain('No lint errors');
    },
    120_000
  );
});

describe('lint_file Rust support', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-lint-rust-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(
      join(testDir, 'Cargo.toml'),
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      'utf-8'
    );
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('finds the cargo root above a file', () => {
    const file = join(testDir, 'src', 'lib.rs');
    expect(findCargoRoot(file)).toBe(testDir);
  });

  it('returns null without Cargo.toml', () => {
    expect(findCargoRoot(join(tmpdir(), 'no-crate-here', 'x.rs'))).toBeNull();
  });

  it('builds the clippy command', () => {
    const { cmd } = buildLintCommand('clippy', join(testDir, 'src', 'lib.rs'), testDir);
    expect(cmd).toEqual(['cargo', 'clippy', '--all-targets', '--message-format=json']);
  });

  it('parses and filters clippy diagnostics to the target file', () => {
    const fixtureDir = new URL('./fixtures/rust', import.meta.url).pathname;
    const output = readFileSync(
      new URL('./fixtures/rust/clippy.jsonl', import.meta.url).pathname,
      'utf-8'
    );
    const target = join(fixtureDir, 'src', 'lib.rs');
    const parsed = parseClippyJson(output, target, fixtureDir);

    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBe(1);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('src/lib.rs:3:9 warning:');
    expect(parsed.warnings.join('\n')).not.toContain('nested/lib.rs');
  });

  it('reports a missing Cargo.toml', async () => {
    const dir = join(tmpdir(), `supertools-lint-rust-nomod-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.rs'), 'pub fn f() {}\n', 'utf-8');
    const result = await lintFileTool.execute({ file_path: join(dir, 'x.rs') }, mockCtx(dir));
    rmSync(dir, { recursive: true });
    expect(result).toContain('No Cargo.toml');
  });

  it.skipIf(!Bun.which('cargo'))(
    'reports a clippy warning',
    async () => {
      const file = join(testDir, 'src', 'lib.rs');
      writeFileSync(file, 'pub fn f() -> i32 {\n    let unused = 1;\n    0\n}\n', 'utf-8');
      const result = await lintFileTool.execute({ file_path: file }, mockCtx(testDir));
      expect(result).toContain('unused');
    },
    120_000
  );
});

describe('lint_file Rust workspace support', () => {
  const fixtureDir = new URL('./fixtures/rust', import.meta.url).pathname;
  const workspaceRoot = '/tmp/supertools-rust-workspace';

  it('parses the workspace root from cargo metadata', () => {
    const metadata = readFileSync(join(fixtureDir, 'workspace-metadata.json'), 'utf-8');
    expect(parseCargoWorkspaceRoot(metadata)).toBe(workspaceRoot);
  });

  it('returns null for invalid cargo metadata', () => {
    expect(parseCargoWorkspaceRoot('not json')).toBeNull();
    expect(parseCargoWorkspaceRoot('{}')).toBeNull();
  });

  it('returns diagnostics for a workspace member test target', () => {
    const output = readFileSync(join(fixtureDir, 'workspace-clippy.jsonl'), 'utf-8');
    const target = join(workspaceRoot, 'crates/a/tests/foo.rs');
    const parsed = parseClippyJson(output, target, join(workspaceRoot, 'crates/a'), workspaceRoot);

    expect(parsed.errorCount).toBe(1);
    expect(parsed.warningCount).toBe(0);
    expect(parsed.errors[0]).toContain('crates/a/tests/foo.rs:7:5 error:');
  });

  it('filters a member crate file against the workspace root', () => {
    const output = readFileSync(join(fixtureDir, 'workspace-clippy.jsonl'), 'utf-8');
    const target = join(workspaceRoot, 'crates/a/src/lib.rs');
    const parsed = parseClippyJson(output, target, join(workspaceRoot, 'crates/a'), workspaceRoot);

    expect(parsed.warningCount).toBe(1);
    expect(parsed.warnings[0]).toContain('crates/a/src/lib.rs:4:9 warning:');
    expect(parsed.warnings.join('\n')).not.toContain('crates/b/src/lib.rs');
  });

  it('does not leak diagnostics that only share a basename', () => {
    const output = readFileSync(join(fixtureDir, 'workspace-clippy.jsonl'), 'utf-8');
    const target = join(workspaceRoot, 'crates/a/tests/foo.rs');
    const parsed = parseClippyJson(output, target, join(workspaceRoot, 'crates/a'), workspaceRoot);

    expect(parsed.warningCount).toBe(0);
    expect(parsed.errors.join('\n')).not.toContain('other/foo.rs');
  });
});

describe('lint_file TypeScript/Deno support', () => {
  const fixtureDir = new URL('./fixtures/typescript', import.meta.url).pathname;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-lint-ts-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('builds the tsc command with a project root and type-check timeout', () => {
    const file = join(testDir, 'src', 'lib.ts');
    const { cmd, timeout } = buildLintCommand('tsc', file, testDir);

    expect(cmd).toEqual(['bun', 'x', 'tsc', '--noEmit', '-p', testDir]);
    expect(timeout).toBe(180000);
  });

  it('detects a local tsc binary for bun x', () => {
    const bin = join(testDir, 'node_modules', '.bin', 'tsc');
    mkdirSync(join(testDir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(bin, '', 'utf-8');

    expect(findTscBinary(testDir)).toBe(bin);
  });

  it('falls back to PATH when no local tsc exists', () => {
    expect(findTscBinary(testDir, { which: () => '/usr/bin/tsc', exists: () => false })).toBe(
      '/usr/bin/tsc'
    );
  });

  it('reports tsc as unavailable when neither local nor PATH binary exists', () => {
    expect(findTscBinary(testDir, { which: () => null, exists: () => false })).toBeNull();
  });

  it('builds the deno lint command', () => {
    const file = join(testDir, 'src', 'lib.ts');
    const { cmd, timeout } = buildLintCommand('deno', file);

    expect(cmd).toEqual(['deno', 'lint', '--json', file]);
    expect(timeout).toBe(30000);
  });

  it('finds the tsconfig root above a file', () => {
    writeFileSync(join(testDir, 'tsconfig.json'), '{}', 'utf-8');
    expect(findTsconfigRoot(join(testDir, 'src', 'lib.ts'))).toBe(testDir);
  });

  it('finds a deno.jsonc root above a file', () => {
    writeFileSync(join(testDir, 'deno.jsonc'), '{}', 'utf-8');
    expect(findDenoRoot(join(testDir, 'src', 'lib.ts'))).toBe(testDir);
  });

  it('returns null without a marker', () => {
    expect(findTsconfigRoot(join(testDir, 'src', 'lib.ts'))).toBeNull();
    expect(findDenoRoot(join(testDir, 'src', 'lib.ts'))).toBeNull();
  });

  it('parses and filters tsc diagnostics to the target file', () => {
    const output = readFileSync(join(fixtureDir, 'tsc-output.txt'), 'utf-8');
    const target = join(fixtureDir, 'src', 'lib.ts');
    const parsed = parseTscOutput(output, target, fixtureDir);

    expect(parsed.errorCount).toBe(2);
    expect(parsed.warningCount).toBe(0);
    expect(parsed.errors[0]).toContain('src/lib.ts:3:9 error:');
    expect(parsed.errors[0]).toContain('[TS2322]');
    expect(parsed.errors.join('\n')).not.toContain('other.ts');
  });

  it('parses deno lint JSON for the target file only', () => {
    const output = readFileSync(join(fixtureDir, 'deno-lint.json'), 'utf-8');
    const target = '/tmp/supertools-deno/src/lib.ts';
    const parsed = parseDenoLintJson(output, target);

    expect(parsed.errorCount).toBe(1);
    expect(parsed.warningCount).toBe(0);
    expect(parsed.errors[0]).toContain(':3:10 error:');
    expect(parsed.errors[0]).toContain('`value` is never used');
    expect(parsed.errors[0]).toContain('[no-unused-vars]');
    expect(parsed.errors.join('\n')).not.toContain('other.ts');
  });

  it('ignores malformed deno lint JSON', () => {
    expect(parseDenoLintJson('not json', '/tmp/x.ts')).toEqual({
      errors: [],
      warnings: [],
      errorCount: 0,
      warningCount: 0,
    });
  });

  it('parses deno check blocks for the target file only', () => {
    const output = readFileSync(join(fixtureDir, 'deno-check.txt'), 'utf-8');
    const target = '/tmp/supertools-deno/src/lib.ts';
    const parsed = parseDenoCheckOutput(output, target, '/tmp/supertools-deno');

    expect(parsed.errorCount).toBe(1);
    expect(parsed.warningCount).toBe(1);
    expect(parsed.errors[0]).toContain(':5:9 error:');
    expect(parsed.errors[0]).toContain('[TS2345]');
    expect(parsed.warnings[0]).toContain(':8:7 warning:');
    expect(parsed.warnings[0]).toContain('[TS6133]');
    expect([...parsed.errors, ...parsed.warnings].join('\n')).not.toContain('other.ts');
  });

  it('strips ANSI colour codes from deno check output', () => {
    const output =
      '\x1b[1mTS2322 \x1b[0m[ERROR]: bad assignment\n' +
      '    at \x1b[36mfile:///tmp/supertools-deno/src/lib.ts\x1b[0m:\x1b[33m2\x1b[0m:\x1b[33m7\x1b[0m\n';
    const parsed = parseDenoCheckOutput(
      output,
      '/tmp/supertools-deno/src/lib.ts',
      '/tmp/supertools-deno'
    );

    expect(parsed.errorCount).toBe(1);
    expect(parsed.errors[0]).toContain(':2:7 error: bad assignment [TS2322]');
  });

  it('resolves relative deno check paths against the deno root', () => {
    const root = '/tmp/supertools-deno';
    const output = 'TS2345 [ERROR]: bad argument\n    at src/lib.ts:5:9\n';
    const parsed = parseDenoCheckOutput(output, join(root, 'src', 'lib.ts'), root);

    expect(parsed.errorCount).toBe(1);
    expect(parsed.errors[0]).toContain('lib.ts:5:9 error: bad argument [TS2345]');
  });

  it('parses deno check blocks with an error: prefix', () => {
    const output =
      'error: TS2322 [ERROR]: bad assignment\n' +
      '    at file:///tmp/supertools-deno/src/lib.ts:2:7\n';
    const parsed = parseDenoCheckOutput(
      output,
      '/tmp/supertools-deno/src/lib.ts',
      '/tmp/supertools-deno'
    );

    expect(parsed.errorCount).toBe(1);
    expect(parsed.errors[0]).toContain(':2:7 error: bad assignment [TS2322]');
  });

  it('skips tsc for a Deno project even with typecheck and explicit eslint', async () => {
    writeFileSync(join(testDir, 'deno.json'), '{}', 'utf-8');
    writeFileSync(
      join(testDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
      'utf-8'
    );
    const file = join(testDir, 'bad.ts');
    writeFileSync(file, "const x: number = 'nope';\nexport { x };\n", 'utf-8');

    const result = await lintFileTool.execute(
      { file_path: file, linter: 'eslint', typecheck: true },
      mockCtx(testDir)
    );

    expect(result).not.toContain('TS2322');
  }, 60_000);

  it.skipIf(!Bun.which('tsc'))(
    'type-checks a file with tsc',
    async () => {
      writeFileSync(
        join(testDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
        'utf-8'
      );
      const file = join(testDir, 'bad.ts');
      writeFileSync(file, "const x: number = 'nope';\nexport { x };\n", 'utf-8');

      const result = await lintFileTool.execute(
        { file_path: file, linter: 'tsc' },
        mockCtx(testDir)
      );

      expect(result).toContain('error');
      expect(result).toContain('TS2322');
    },
    120_000
  );

  it.skipIf(!Bun.which('deno'))(
    'runs deno lint and check for a Deno project',
    async () => {
      writeFileSync(join(testDir, 'deno.json'), '{}', 'utf-8');
      const file = join(testDir, 'lib.ts');
      writeFileSync(
        file,
        "const unused = 1;\nconst value: number = 'nope';\nexport { value };\n",
        'utf-8'
      );

      const result = await lintFileTool.execute({ file_path: file }, mockCtx(testDir));

      expect(typeof result).toBe('string');
      expect(result).toContain('no-unused-vars');
      expect(result).toContain('TS2322');
    },
    120_000
  );
});
