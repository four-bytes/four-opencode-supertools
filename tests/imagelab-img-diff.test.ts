// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPixel } from '../src/lib/imagelab/image.ts';
import { readPng } from '../src/lib/imagelab/png.ts';
import { imgDiffTool } from '../src/tools/img-diff.ts';
import { mockCtx, parseTool, writePngFile } from './imagelab-helpers.ts';

interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

interface DiffPayload {
  ok: boolean;
  a: { width: number; height: number };
  b: { width: number; height: number };
  canvas: { width: number; height: number };
  changedPixels: number;
  totalPixels: number;
  changedRatio: number;
  maxDelta: number;
  meanDelta: number;
  regions: DiffRegion[];
  regionsTotal: number;
  truncated: boolean;
  diffImage: string;
  sizeMismatch?: { a: { width: number; height: number }; b: { width: number; height: number } };
  sideBySide?: boolean;
}

interface FailurePayload {
  available: boolean;
  error: string;
}

type DiffArgs = Parameters<typeof imgDiffTool.execute>[0];

const dir = mkdtempSync(join(tmpdir(), 'imagelab-img-diff-'));
const ctx = mockCtx(dir);

function run(args: Partial<DiffArgs>) {
  return imgDiffTool.execute(args as DiffArgs, ctx);
}

beforeAll(() => {
  writePngFile(dir, 'a.png', 4, 4, [], '#000000');
  writePngFile(
    dir,
    'b.png',
    4,
    4,
    [
      { x: 1, y: 1, colour: '#ffffff' },
      { x: 2, y: 2, colour: '#808080' },
    ],
    '#000000'
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('img_diff tool', () => {
  it('diffs two images and writes a highlighted diff PNG', async () => {
    const payload = parseTool<DiffPayload>(await run({ a: 'a.png', b: 'b.png', directory: dir }));

    expect(payload.ok).toBe(true);
    expect(payload.a).toEqual({ width: 4, height: 4 });
    expect(payload.b).toEqual({ width: 4, height: 4 });
    expect(payload.canvas).toEqual({ width: 4, height: 4 });
    expect(payload.changedPixels).toBe(2);
    expect(payload.totalPixels).toBe(16);
    expect(payload.changedRatio).toBe(0.125);
    expect(payload.maxDelta).toBe(255);
    expect(payload.meanDelta).toBe(23.94);
    expect(payload.regionsTotal).toBe(2);
    expect(payload.regions).toEqual([
      { x: 1, y: 1, width: 1, height: 1, pixels: 1 },
      { x: 2, y: 2, width: 1, height: 1, pixels: 1 },
    ]);
    expect(payload.truncated).toBe(false);
    expect(payload.sizeMismatch).toBeUndefined();
    expect(payload.diffImage).toBe(join(dir, 'a.diff.png'));

    const diff = readPng(join(dir, 'a.diff.png'));
    expect(getPixel(diff, 1, 1)).toEqual({ r: 255, g: 0, b: 68, a: 255 });
    expect(getPixel(diff, 2, 2)).toEqual({ r: 255, g: 0, b: 68, a: 255 });
    expect(getPixel(diff, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('drops sub-threshold pixels', async () => {
    const payload = parseTool<DiffPayload>(
      await run({ a: 'a.png', b: 'b.png', directory: dir, threshold: 200 })
    );

    expect(payload.changedPixels).toBe(1);
    expect(payload.regionsTotal).toBe(1);
  });

  it('reports a size mismatch on the union canvas', async () => {
    writePngFile(dir, 'small.png', 2, 2, [], '#000000');
    const payload = parseTool<DiffPayload>(
      await run({ a: 'a.png', b: 'small.png', directory: dir })
    );

    expect(payload.canvas).toEqual({ width: 4, height: 4 });
    expect(payload.changedPixels).toBe(12);
    expect(payload.totalPixels).toBe(16);
    expect(payload.sizeMismatch).toEqual({
      a: { width: 4, height: 4 },
      b: { width: 2, height: 2 },
    });
  });

  it('writes a labelled side-by-side composite', async () => {
    const payload = parseTool<DiffPayload>(
      await run({
        a: 'a.png',
        b: 'b.png',
        directory: dir,
        sideBySide: true,
        labels: ['REF', 'OURS', 'DIFF'],
      })
    );

    expect(payload.sideBySide).toBe(true);
    expect(payload.diffImage).toBe(join(dir, 'a.compose.png'));

    const composed = readPng(join(dir, 'a.compose.png'));
    expect(composed.width).toBe(28);
    expect(composed.height).toBe(16);
  });

  it('caps the reported regions', async () => {
    const payload = parseTool<DiffPayload>(
      await run({ a: 'a.png', b: 'b.png', directory: dir, maxRegions: 1 })
    );

    expect(payload.regions).toHaveLength(1);
    expect(payload.regionsTotal).toBe(2);
    expect(payload.truncated).toBe(true);
  });

  it('returns a failure for a missing image', async () => {
    const payload = parseTool<FailurePayload>(
      await run({ a: 'missing.png', b: 'b.png', directory: dir })
    );

    expect(payload.available).toBe(true);
    expect(payload.error).toContain('cannot read image');
  });
});
