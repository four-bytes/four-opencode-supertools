import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTestCommand,
  detectFramework,
  parseCargoTestOutput,
  parseDenoTestOutput,
  parseGoTestOutput,
  runTestsTool,
} from '../src/tools/run-tests';
import { toolString } from './helpers';

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

describe('run_tests tool', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-test-${Date.now()}`);
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

  it('returns error for missing test file', async () => {
    const result = await runTestsTool.execute(
      {
        test_file: join(testDir, 'nonexistent.test.ts'),
      },
      ctx
    );

    expect(result).toContain('Error');
    expect(result).toContain('Test file not found');
  });

  it('runs bun test on a valid test file', async () => {
    const testFilePath = join(testDir, 'simple.test.ts');
    writeFileSync(
      testFilePath,
      `
import { describe, it, expect } from 'bun:test';
describe('simple', () => {
  it('passes', () => {
    expect(1 + 1).toBe(2);
  });
});
`,
      'utf-8'
    );

    const result = await runTestsTool.execute(
      {
        test_file: testFilePath,
        framework: 'bun',
      },
      ctx
    );

    // Should contain pass indication — either JUnit XML or text output
    expect(typeof result).toBe('string');
    expect(toolString(result).length).toBeGreaterThan(0);
  });

  it('runs tests via a directory override into a foreign repo', async () => {
    const foreignDir = join(tmpdir(), `supertools-foreign-${Date.now()}`);
    mkdirSync(foreignDir, { recursive: true });
    try {
      const testFilePath = join(testDir, 'override.test.ts');
      writeFileSync(
        testFilePath,
        `import { describe, it, expect } from 'bun:test';\ndescribe('override', () => { it('passes', () => { expect(1).toBe(1); }); });\n`,
        'utf-8'
      );

      // ctx points at a different (foreign) dir; the override should win
      const result = await runTestsTool.execute(
        { test_file: testFilePath, framework: 'bun', directory: testDir },
        mockCtx(foreignDir)
      );

      expect(typeof result).toBe('string');
      expect(toolString(result).length).toBeGreaterThan(0);
    } finally {
      try {
        rmSync(foreignDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('handles test filter parameter', async () => {
    const testFilePath = join(testDir, 'filtered.test.ts');
    writeFileSync(
      testFilePath,
      `
import { describe, it, expect } from 'bun:test';
describe('suite', () => {
  it('test one', () => {
    expect(1).toBe(1);
  });
  it('test two', () => {
    expect(2).toBe(2);
  });
});
`,
      'utf-8'
    );

    const result = await runTestsTool.execute(
      {
        test_file: testFilePath,
        filter: 'test one',
        framework: 'bun',
      },
      ctx
    );

    expect(typeof result).toBe('string');
  });
});

describe('run_tests Go support', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-test-go-${Date.now()}`);
    mkdirSync(join(testDir, 'calc'), { recursive: true });
    writeFileSync(join(testDir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n', 'utf-8');
    writeFileSync(
      join(testDir, 'calc', 'calc.go'),
      'package calc\n\nfunc Add(a, b int) int { return a + b }\n',
      'utf-8'
    );
    ctx = mockCtx(testDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('detects go from go.mod', () => {
    expect(detectFramework(testDir)).toBe('go');
  });

  it('tests the package of the given file, with filter', () => {
    const { cmd } = buildTestCommand(
      'go',
      join(testDir, 'calc', 'calc_test.go'),
      'TestAdd',
      testDir
    );
    expect(cmd).toEqual(['go', 'test', '-count=1', './calc', '-run', 'TestAdd']);
  });

  it('detects go from a _test.go file when go.mod is in a subdirectory', () => {
    const outer = join(testDir, '..', `supertools-outer-${Date.now()}`);
    mkdirSync(join(outer, 'api', 'calc'), { recursive: true });
    writeFileSync(join(outer, 'composer.json'), '{}', 'utf-8');
    writeFileSync(join(outer, 'api', 'go.mod'), 'module example.com/api\n\ngo 1.22\n', 'utf-8');
    const file = join(outer, 'api', 'calc', 'calc_test.go');
    expect(detectFramework(outer, file)).toBe('go');
    rmSync(outer, { recursive: true });
  });

  it('keeps a dot-prefixed package directory relative', () => {
    const { cmd } = buildTestCommand(
      'go',
      join(testDir, '.tools', 'x_test.go'),
      undefined,
      testDir
    );
    expect(cmd).toEqual(['go', 'test', '-count=1', './.tools']);
  });

  it('parses a passing run', () => {
    expect(parseGoTestOutput('ok  \texample.com/demo/calc\t0.002s\n', 0)).toStartWith('✅ ok');
  });

  it('parses failures and keeps their details', () => {
    const out = [
      '--- FAIL: TestAdd (0.00s)',
      '    calc_test.go:6: got 3, want 4',
      'FAIL',
      'FAIL\texample.com/demo/calc\t0.002s',
    ].join('\n');
    const result = parseGoTestOutput(out, 1);
    expect(result).toContain('--- FAIL: TestAdd');
    expect(result).toContain('got 3, want 4');
  });

  it('parses build errors', () => {
    const out =
      '# example.com/demo/calc\ncalc/calc_test.go:5:2: undefined: Sub\nFAIL\texample.com/demo/calc [build failed]\n';
    expect(parseGoTestOutput(out, 1)).toContain('undefined: Sub');
  });

  it.skipIf(!Bun.which('go'))(
    'runs a failing go test end to end',
    async () => {
      const file = join(testDir, 'calc', 'calc_test.go');
      writeFileSync(
        file,
        'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 4 {\n\t\tt.Errorf("got %d, want 4", Add(1, 2))\n\t}\n}\n',
        'utf-8'
      );
      const result = await runTestsTool.execute({ test_file: file }, ctx);
      expect(result).toContain('--- FAIL: TestAdd');
    },
    120_000
  );

  it.skipIf(!Bun.which('go'))(
    'runs a passing go test end to end',
    async () => {
      const file = join(testDir, 'calc', 'calc_test.go');
      writeFileSync(
        file,
        'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fail()\n\t}\n}\n',
        'utf-8'
      );
      const result = await runTestsTool.execute({ test_file: file }, ctx);
      expect(result).toStartWith('✅');
    },
    120_000
  );
});

describe('run_tests Rust support', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-test-rust-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    mkdirSync(join(testDir, 'tests'), { recursive: true });
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

  it('detects cargo from a .rs file inside a crate', () => {
    expect(detectFramework(testDir, join(testDir, 'tests', 'foo.rs'))).toBe('cargo');
  });

  it('builds cargo test with an integration-test selector and filter', () => {
    const { cmd } = buildTestCommand('cargo', join(testDir, 'tests', 'foo.rs'), 'adds', testDir);
    expect(cmd).toEqual(['cargo', 'test', '--test', 'foo', '--', 'adds']);
  });

  it('parses a failing cargo test run', () => {
    const output = readFileSync(
      new URL('./fixtures/rust/cargo-test-fail.txt', import.meta.url).pathname,
      'utf-8'
    );
    const result = parseCargoTestOutput(output, 1);
    expect(result).toContain('FAILED');
    expect(result).toContain('adds');
    expect(result).toContain('assertion');
  });

  it('parses a passing cargo test run', () => {
    const result = parseCargoTestOutput('test result: ok. 3 passed; 0 failed; 0 ignored\n', 0);
    expect(result).toStartWith('✅');
  });

  it('reports a missing Cargo.toml', async () => {
    const dir = join(tmpdir(), `supertools-test-rust-nomod-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.rs'), 'fn f() {}\n', 'utf-8');
    const result = await runTestsTool.execute(
      { test_file: join(dir, 'x.rs'), framework: 'cargo' },
      mockCtx(dir)
    );
    rmSync(dir, { recursive: true });
    expect(result).toContain('No Cargo.toml');
  });

  it.skipIf(!Bun.which('cargo'))(
    'runs a failing cargo test end to end',
    async () => {
      const file = join(testDir, 'tests', 'it.rs');
      writeFileSync(file, '#[test]\nfn adds() {\n    assert_eq!(1 + 1, 3);\n}\n', 'utf-8');
      const result = await runTestsTool.execute({ test_file: file }, mockCtx(testDir));
      expect(result).toContain('FAILED');
    },
    180_000
  );
});

describe('run_tests Deno support', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-test-deno-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('prefers deno over bun when deno.json and package.json coexist', () => {
    writeFileSync(join(testDir, 'deno.json'), '{}', 'utf-8');
    writeFileSync(join(testDir, 'package.json'), '{}', 'utf-8');
    expect(detectFramework(testDir, join(testDir, 'calc_test.ts'))).toBe('deno');
    expect(detectFramework(testDir)).toBe('deno');
  });

  it('builds deno test with a filter', () => {
    const file = join(testDir, 'calc_test.ts');
    const { cmd, timeout } = buildTestCommand('deno', file, 'add', testDir);

    expect(cmd).toEqual(['deno', 'test', '--filter', 'add', file]);
    expect(timeout).toBe(180000);
  });

  it('builds deno test without a filter', () => {
    const file = join(testDir, 'calc_test.ts');
    expect(buildTestCommand('deno', file).cmd).toEqual(['deno', 'test', file]);
  });

  it('parses a failing deno test run without passing tests', () => {
    const output = readFileSync(
      new URL('./fixtures/typescript/deno-test-fail.txt', import.meta.url).pathname,
      'utf-8'
    );
    const result = parseDenoTestOutput(output, 1);

    expect(result).toContain('FAILED');
    expect(result).toContain('add');
    expect(result).toContain('AssertionError');
    expect(result).toContain('test result: FAILED. 1 passed; 1 failed');
    expect(result).not.toContain('sub ... ok');
  });

  it('parses a passing deno test run', () => {
    const result = parseDenoTestOutput(
      'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out (1ms)\n',
      0
    );
    expect(result).toStartWith('✅');
  });
});
