// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { measureEmulatorWidths } from '../src/lib/termlab/width-emulator';
import type { TmuxResult, TmuxRunner } from '../src/lib/termlab/tmux';

const hasTmux = Bun.which('tmux') !== null;

describe('measureEmulatorWidths — real tmux', () => {
  it.skipIf(!hasTmux)(
    'measures ASCII, CJK, VS16 emoji and ZWJ family through the emulator',
    async () => {
      const widths = await measureEmulatorWidths(['a', '—', '❤️', '世', '👨‍👩‍👧‍👦']);
      expect(widths).not.toBeNull();

      const [ascii, emDash, heart, cjk, family] = widths as number[];
      expect(ascii).toBe(1);
      expect(emDash).toBe(1);
      expect(cjk).toBe(2);
      expect(heart).toBe(2);
      expect(family).toBe(2);
    },
    30000
  );
});

describe('measureEmulatorWidths — runner seam', () => {
  function fakeRunner(captures: string[]): { runner: TmuxRunner; calls: string[][] } {
    const calls: string[][] = [];
    let captureIndex = 0;

    const runner: TmuxRunner = async (args): Promise<TmuxResult> => {
      calls.push(args);
      const ok = (stdout = ''): TmuxResult => ({ exitCode: 0, stdout, stderr: '' });

      if (args.includes('-V')) return ok('tmux 3.4');
      if (args.includes('capture-pane')) {
        const stdout = captures[captureIndex] ?? '';
        captureIndex += 1;
        return ok(stdout);
      }
      return ok();
    };

    return { runner, calls };
  }

  it('tears the session down with kill-server and maps sentinels to widths', async () => {
    const { runner, calls } = fakeRunner(['a|\n世|\n']);
    const widths = await measureEmulatorWidths(['a', '世'], { runner, settleMs: 0 });

    expect(widths).toEqual([1, 2]);
    expect(calls.some((args) => args.includes('kill-server'))).toBe(true);
  });

  it('returns null when tmux is unavailable', async () => {
    const unavailable: TmuxRunner = async () => ({
      exitCode: 127,
      stdout: '',
      stderr: 'missing',
    });

    expect(await measureEmulatorWidths(['a'], { runner: unavailable })).toBeNull();
  });

  it('returns null for a probe whose sentinel is missing', async () => {
    const { runner } = fakeRunner(['a|\n\n']);
    const widths = await measureEmulatorWidths(['a', 'b'], { runner, settleMs: 0 });

    expect(widths).toEqual([1, null]);
  });

  it('returns null when the session fails', async () => {
    const failing: TmuxRunner = async (args) => {
      if (args.includes('-V')) return { exitCode: 0, stdout: 'tmux 3.4', stderr: '' };
      if (args.includes('new-session')) return { exitCode: 1, stdout: '', stderr: 'boom' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    expect(await measureEmulatorWidths(['a'], { runner: failing, settleMs: 0 })).toBeNull();
  });
});
