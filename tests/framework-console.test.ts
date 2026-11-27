import { describe, it, expect } from 'bun:test';
import { dirname, join } from 'node:path';
import {
  runConsole,
  runConsoleJson,
  type ConsoleRunner,
  type ConsoleRunOptions,
} from '../src/lib/framework/console';

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url).pathname;
const consolePath = fixture('frameworks/symfony/bin/console');

function capture(
  result: { exitCode: number; stdout: string; stderr: string } | Error
): { runner: ConsoleRunner; calls: { cmd: string[]; opts: ConsoleRunOptions }[] } {
  const calls: { cmd: string[]; opts: ConsoleRunOptions }[] = [];
  const runner: ConsoleRunner = async (cmd, opts) => {
    calls.push({ cmd, opts });
    if (result instanceof Error) throw result;
    return result;
  };
  return { runner, calls };
}

describe('runConsoleJson', () => {
  it('parses JSON and appends exactly one --format=json', async () => {
    const { runner, calls } = capture({
      exitCode: 0,
      stdout: '{"ok":true,"items":[1]}',
      stderr: '',
    });

    const result = await runConsoleJson(consolePath, ['debug:foo'], { runner });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ ok: true, items: [1] });
    }
    const count = calls[0]?.cmd.filter((arg) => arg === '--format=json').length;
    expect(count).toBe(1);
  });

  it('does not duplicate an existing --format=json', async () => {
    const { runner, calls } = capture({ exitCode: 0, stdout: '{"ok":true}', stderr: '' });

    const result = await runConsoleJson(consolePath, ['debug:foo', '--format=json'], { runner });

    expect(result.ok).toBe(true);
    const count = calls[0]?.cmd.filter((arg) => arg === '--format=json').length;
    expect(count).toBe(1);
  });

  it('does not append when --format json is already present as separate args', async () => {
    const { runner, calls } = capture({ exitCode: 0, stdout: '{"ok":true}', stderr: '' });

    const result = await runConsoleJson(consolePath, ['list', '--format', 'json'], { runner });

    expect(result.ok).toBe(true);
    const cmd = calls[0]?.cmd ?? [];
    expect(cmd).toContain('--format');
    expect(cmd.filter((arg) => arg === '--format=json').length).toBe(0);
  });

  it('maps an invalid JSON payload to invalid-json', async () => {
    const { runner } = capture({ exitCode: 0, stdout: 'not json', stderr: '' });

    const result = await runConsoleJson(consolePath, ['debug:foo'], { runner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-json');
    }
  });
});

describe('runConsole', () => {
  it('maps a spawn ENOENT error to console-unavailable without throwing', async () => {
    const { runner } = capture(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    const result = await runConsole(consolePath, ['debug:foo'], { runner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('console-unavailable');
    }
  });

  it('maps an EACCES error to console-unavailable', async () => {
    const { runner } = capture(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );

    const result = await runConsole(consolePath, ['debug:foo'], { runner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('console-unavailable');
    }
  });

  it('maps database errors to db-unavailable', async () => {
    const { runner } = capture({
      exitCode: 1,
      stdout: '',
      stderr: 'SQLSTATE[HY000] [2002] Connection refused',
    });

    const result = await runConsole(consolePath, ['doctrine:query'], { runner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('db-unavailable');
    }
  });

  it('maps a generic non-zero exit to console-failed with the stderr tail', async () => {
    const { runner } = capture({ exitCode: 1, stdout: '', stderr: 'Something bad happened' });

    const result = await runConsole(consolePath, ['bad:command'], { runner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('console-failed');
      expect(result.message).toContain('Something bad happened');
      expect(result.exitCode).toBe(1);
    }
  });

  it('times out a never-resolving runner', async () => {
    const hangingRunner: ConsoleRunner = () => new Promise(() => {});

    const result = await runConsole(consolePath, ['slow:command'], {
      runner: hangingRunner,
      timeoutMs: 20,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
  });

  it('reports console-unavailable for a null path without calling the runner', async () => {
    const { runner, calls } = capture({ exitCode: 0, stdout: '', stderr: '' });

    const result = await runConsole(null, ['debug:foo'], { runner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('console-unavailable');
    }
    expect(calls.length).toBe(0);
  });

  it('reports console-unavailable for a non-existent path', async () => {
    const { runner } = capture({ exitCode: 0, stdout: '', stderr: '' });
    const missing = join(fixture('frameworks/plain'), 'bin', 'console');

    const result = await runConsole(missing, ['debug:foo'], { runner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('console-unavailable');
    }
  });

  it('passes APP_ENV and defaults cwd to dirname(consolePath)', async () => {
    const { runner, calls } = capture({ exitCode: 0, stdout: '', stderr: '' });

    const result = await runConsole(consolePath, ['debug:foo'], { runner, appEnv: 'test' });

    expect(result.ok).toBe(true);
    expect(calls[0]?.opts.env.APP_ENV).toBe('test');
    expect(calls[0]?.opts.cwd).toBe(dirname(consolePath));
  });

  it("defaults APP_ENV to 'dev' when no appEnv is passed", async () => {
    const { runner, calls } = capture({ exitCode: 0, stdout: '', stderr: '' });

    const result = await runConsole(consolePath, ['debug:foo'], { runner });

    expect(result.ok).toBe(true);
    expect(calls[0]?.opts.env.APP_ENV).toBe('dev');
  });
});
