import { describe, it, expect } from 'bun:test';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  changeRoutePathTool,
  rewriteRoutePaths,
  type ChangeRoutePathOutput,
} from '../src/tools/change-route-path';
import { parsePhpStrict } from '../src/lib/php-parser';

const OLD = '/api/orders';
const NEW = '/api/v2/orders';

const fixture = (...parts: string[]): string =>
  resolve(import.meta.dir, 'fixtures', 'php', ...parts);

const readFixture = (...parts: string[]): Promise<string> => readFile(fixture(...parts), 'utf-8');

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

async function runTool(
  args: Parameters<typeof changeRoutePathTool.execute>[0],
  dir: string
): Promise<ChangeRoutePathOutput> {
  const raw = await changeRoutePathTool.execute(args, mockCtx(dir) as never);
  const text = typeof raw === 'string' ? raw : raw.output;
  return JSON.parse(text) as ChangeRoutePathOutput;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'supertools-routes-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('change_route_path rewriting', () => {
  it('rewrites a positional path and leaves the other arguments alone', async () => {
    const source = await readFixture('routes', 'positional.php');
    const result = await rewriteRoutePaths(source, OLD, NEW);

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([{ line: 9, oldText: OLD, newText: NEW }]);
    expect(result.output).toBe(source.replace(`'${OLD}'`, `'${NEW}'`));
    expect(result.output).toContain(`#[Route('${NEW}', methods: ['GET'])]`);
    await parsePhpStrict(result.output);
  });

  it('rewrites a named path and preserves single quotes', async () => {
    const source = await readFixture('routes', 'named-single.php');
    const result = await rewriteRoutePaths(source, OLD, NEW);

    expect(result.changed).toBe(true);
    expect(result.output).toContain(`path: '${NEW}'`);
    expect(result.output).not.toContain(OLD);
  });

  it('rewrites a named path and preserves double quotes', async () => {
    const source = await readFixture('routes', 'named-double.php');
    const result = await rewriteRoutePaths(source, OLD, NEW);

    expect(result.changed).toBe(true);
    expect(result.output).toContain(`path: "${NEW}"`);
    expect(result.output).not.toContain(OLD);
  });

  it('rewrites class-level and method routes, reporting both 1-based lines', async () => {
    const source = await readFixture('routes', 'class-and-method.php');
    const result = await rewriteRoutePaths(source, OLD, NEW);

    expect(result.changed).toBe(true);
    expect(result.changes).toHaveLength(2);
    expect(result.changes.map((change) => change.line)).toEqual([7, 10]);
    expect(result.output.split(NEW)).toHaveLength(3);
  });

  it('is a byte-identical no-op when no route matches', async () => {
    const source = await readFixture('routes', 'positional.php');
    const result = await rewriteRoutePaths(source, '/no/such/route', NEW);

    expect(result.changed).toBe(false);
    expect(result.output).toBe(source);
    expect(result.changes).toEqual([]);
  });

  it('does not touch docblocks, comments or an AsRoute attribute', async () => {
    const source = await readFixture('routes', 'untouched.php');
    const result = await rewriteRoutePaths(source, OLD, NEW);

    expect(source).toContain('Docblock mentioning /api/orders');
    expect(source).toContain("#[AsRoute('/api/orders')]");
    expect(result.changed).toBe(false);
    expect(result.output).toBe(source);
  });

  it('rewrites a fully-qualified Route attribute', async () => {
    const source = await readFixture('routes', 'fqcn.php');
    const result = await rewriteRoutePaths(source, OLD, NEW);

    expect(result.changed).toBe(true);
    expect(result.output).toContain(`#[\\Symfony\\Component\\Routing\\Attribute\\Route('${NEW}')]`);
    await parsePhpStrict(result.output);
  });

  it('rewrites a CRLF file without changing its line endings', async () => {
    const lfSource = await readFixture('routes', 'positional.php');
    const source = lfSource.replace(/\n/g, '\r\n');
    expect(source).toContain('\r\n');
    const result = await rewriteRoutePaths(source, OLD, NEW);

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([{ line: 9, oldText: OLD, newText: NEW }]);
    expect(result.output).toBe(source.replace(`'${OLD}'`, `'${NEW}'`));
    expect(result.output).toContain('\r\n');
    expect(result.output.replace(/\r\n/g, '')).not.toContain('\n');
    await parsePhpStrict(result.output);
  });
});

describe('change_route_path tool', () => {
  it('preview reports changes and writes nothing', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'Controller.php');
      const source = await readFixture('routes', 'positional.php');
      await writeFile(file, source, 'utf-8');

      const output = await runTool(
        { oldPath: OLD, newPath: NEW, directory: dir, preview: true },
        dir
      );

      expect(output.success).toBe(true);
      expect(output.scanned).toBe(1);
      expect(output.changedFiles).toBe(1);
      expect(output.changes).toEqual([{ file, line: 9, oldText: OLD, newText: NEW }]);
      expect(await readFile(file, 'utf-8')).toBe(source);
    });
  });

  it('writes the rewritten file when preview is false', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'Controller.php');
      const source = await readFixture('routes', 'positional.php');
      await writeFile(file, source, 'utf-8');

      const output = await runTool(
        { oldPath: OLD, newPath: NEW, directory: dir, preview: false },
        dir
      );

      expect(output.success).toBe(true);
      expect(output.changedFiles).toBe(1);
      expect(await readFile(file, 'utf-8')).toContain(`#[Route('${NEW}', methods: ['GET'])]`);
    });
  });

  it('preserves CRLF line endings when writing a rewritten file', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'CrlfController.php');
      const lfSource = await readFixture('routes', 'positional.php');
      const source = lfSource.replace(/\n/g, '\r\n');
      await writeFile(file, source, 'utf-8');

      const output = await runTool(
        { oldPath: OLD, newPath: NEW, directory: dir, preview: false },
        dir
      );

      expect(output.success).toBe(true);
      expect(output.changedFiles).toBe(1);

      const written = await readFile(file, 'utf-8');
      expect(written).toContain(`#[Route('${NEW}', methods: ['GET'])]`);
      expect(written).toContain('\r\n');
      expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    });
  });

  it('limits the scan to the explicit files list', async () => {
    await withTempDir(async (dir) => {
      const first = join(dir, 'FirstController.php');
      const second = join(dir, 'SecondController.php');
      const source = await readFixture('routes', 'positional.php');
      await writeFile(first, source, 'utf-8');
      await writeFile(second, source, 'utf-8');

      const output = await runTool(
        { oldPath: OLD, newPath: NEW, directory: dir, files: [first], preview: false },
        dir
      );

      expect(output.success).toBe(true);
      expect(output.scanned).toBe(1);
      expect(output.changedFiles).toBe(1);
      expect(output.changes.every((change) => change.file === first)).toBe(true);
      expect(await readFile(first, 'utf-8')).toContain(NEW);
      expect(await readFile(second, 'utf-8')).toBe(source);
    });
  });

  it('truncates the scan at maxFiles and warns', async () => {
    await withTempDir(async (dir) => {
      const source = await readFixture('routes', 'positional.php');
      await writeFile(join(dir, 'FirstController.php'), source, 'utf-8');
      await writeFile(join(dir, 'SecondController.php'), source, 'utf-8');

      const output = await runTool(
        { oldPath: OLD, newPath: NEW, directory: dir, maxFiles: 1, preview: true },
        dir
      );

      expect(output.success).toBe(true);
      expect(output.scanned).toBe(1);
      expect(output.warnings?.join(' ')).toContain('maxFiles');
    });
  });

  it('reports an unparsable PHP file in failedFiles without writing it', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'Broken.php');
      const broken = "<?php\n#[Route('/api/orders'\n";
      await writeFile(file, broken, 'utf-8');

      const output = await runTool(
        { oldPath: OLD, newPath: NEW, directory: dir, files: [file], preview: false },
        dir
      );

      expect(output.success).toBe(false);
      expect(output.failedFiles).toHaveLength(1);
      expect(output.failedFiles?.[0].file).toBe(file);
      expect(await readFile(file, 'utf-8')).toBe(broken);
    });
  });

  it('errors and writes nothing when oldPath equals newPath', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'Controller.php');
      const source = await readFixture('routes', 'positional.php');
      await writeFile(file, source, 'utf-8');

      const output = await runTool(
        { oldPath: OLD, newPath: OLD, directory: dir, preview: false },
        dir
      );

      expect(output.success).toBe(false);
      expect(output.error).toContain('identical');
      expect(await readFile(file, 'utf-8')).toBe(source);
    });
  });
});
