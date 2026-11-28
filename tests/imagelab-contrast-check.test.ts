// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contrastCheckTool } from '../src/tools/contrast-check.ts';
import { toolObject } from './helpers.ts';
import { mockCtx, parseTool } from './imagelab-helpers.ts';

interface ContrastEntryOut {
  label?: string;
  foreground: string;
  background: string;
  ratio: number;
  aa: boolean;
  aaa: boolean;
  largeTextAa: boolean;
  largeTextAaa: boolean;
}

interface ContrastPayload {
  ok: boolean;
  total: number;
  failed: number;
  pairs: ContrastEntryOut[];
}

interface FailurePayload {
  available: boolean;
  error: string;
}

type ContrastArgs = Parameters<typeof contrastCheckTool.execute>[0];

const dir = mkdtempSync(join(tmpdir(), 'imagelab-contrast-check-'));
const ctx = mockCtx(dir);

function run(args: Partial<ContrastArgs>) {
  return contrastCheckTool.execute(args as ContrastArgs, ctx);
}

beforeAll(() => {
  writeFileSync(
    join(dir, 'skin.json'),
    JSON.stringify({
      name: 'demo',
      pens: [
        { label: 'body', fg: '#ffffff', bg: '#000000' },
        { label: 'accent', foreground: '#ffcc00', background: '#202020' },
        { label: 'muted', text: '#777777', background: '#ffffff' },
      ],
      chrome: { fg: '#00ff00' },
    })
  );
  writeFileSync(join(dir, 'bad.json'), '{ not valid json');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('contrast_check tool', () => {
  it('scores explicit pairs and counts failures', async () => {
    const result = toolObject(
      await run({
        directory: dir,
        pairs: [
          { foreground: '#ffffff', background: '#000000' },
          { foreground: '#777777', background: '#ffffff' },
          { foreground: '#000000', background: '#000000' },
        ],
      })
    );
    const payload = parseTool<ContrastPayload>(result);

    expect(result.metadata.total).toBe(3);
    expect(result.metadata.failed).toBe(2);

    expect(payload.total).toBe(3);
    expect(payload.failed).toBe(2);

    const [whiteOnBlack, greyOnWhite, blackOnBlack] = payload.pairs;
    expect(whiteOnBlack.ratio).toBe(21);
    expect(whiteOnBlack.aa).toBe(true);
    expect(whiteOnBlack.aaa).toBe(true);
    expect(whiteOnBlack.largeTextAa).toBe(true);
    expect(whiteOnBlack.largeTextAaa).toBe(true);

    expect(greyOnWhite.ratio).toBe(4.48);
    expect(greyOnWhite.aa).toBe(false);
    expect(greyOnWhite.aaa).toBe(false);
    expect(greyOnWhite.largeTextAa).toBe(true);
    expect(greyOnWhite.largeTextAaa).toBe(false);

    expect(blackOnBlack.ratio).toBe(1);
    expect(blackOnBlack.aa).toBe(false);
    expect(blackOnBlack.aaa).toBe(false);
    expect(blackOnBlack.largeTextAa).toBe(false);
    expect(blackOnBlack.largeTextAaa).toBe(false);
  });

  it('extracts pairs from a skin file with the fallback background', async () => {
    const payload = parseTool<ContrastPayload>(
      await run({ directory: dir, skin: 'skin.json', background: '#101010' })
    );

    expect(payload.total).toBe(4);
    expect(payload.failed).toBe(1);

    const labels = payload.pairs.map((entry) => entry.label);
    expect(labels).toContain('pens[0].fg');
    expect(labels).toContain('pens[1].foreground');
    expect(labels).toContain('pens[2].text');
    expect(labels).toContain('chrome.fg');
  });

  it('combines explicit pairs with skin pairs', async () => {
    const payload = parseTool<ContrastPayload>(
      await run({
        directory: dir,
        skin: 'skin.json',
        background: '#101010',
        pairs: [{ foreground: '#000000', background: '#ffffff' }],
      })
    );

    expect(payload.total).toBe(5);
  });

  it('rejects an invalid skin JSON file', async () => {
    const payload = parseTool<FailurePayload>(await run({ directory: dir, skin: 'bad.json' }));

    expect(payload.error.includes('JSON') || payload.error.includes('Unexpected')).toBe(true);
  });

  it('rejects a request without any pairs or skin', async () => {
    const payload = parseTool<FailurePayload>(await run({ directory: dir }));
    expect(payload.error).toContain('no colour pairs');
  });
});
