import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTestCommand,
  detectFramework,
  parseGoTestOutput,
  runTestsTool,
} from '../src/tools/run-tests';

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
    expect(result.length).toBeGreaterThan(0);
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

  it.skipIf(!Bun.which('go'))('runs a failing go test end to end', async () => {
    const file = join(testDir, 'calc', 'calc_test.go');
    writeFileSync(
      file,
      'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 4 {\n\t\tt.Errorf("got %d, want 4", Add(1, 2))\n\t}\n}\n',
      'utf-8'
    );
    const result = await runTestsTool.execute({ test_file: file }, ctx);
    expect(result).toContain('--- FAIL: TestAdd');
  });

  it.skipIf(!Bun.which('go'))('runs a passing go test end to end', async () => {
    const file = join(testDir, 'calc', 'calc_test.go');
    writeFileSync(
      file,
      'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fail()\n\t}\n}\n',
      'utf-8'
    );
    const result = await runTestsTool.execute({ test_file: file }, ctx);
    expect(result).toStartWith('✅');
  });
});
