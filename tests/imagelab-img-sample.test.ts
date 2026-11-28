// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imgSampleTool } from '../src/tools/img-sample.ts';
import { mockCtx, parseTool, writePngFile } from './imagelab-helpers.ts';

interface PointOut {
  label?: string;
  x: number;
  y: number;
  hex: string;
  rgba: { r: number; g: number; b: number; a: number };
}

interface PaletteColour {
  hex: string;
  share: number;
  count: number;
}

interface SamplePayload {
  ok: boolean;
  path: string;
  size: { width: number; height: number };
  points: PointOut[];
  regions: Array<{
    label?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    uniqueColors: number;
    mean: string;
    dominant: PaletteColour[];
  }>;
  palette?: {
    region: { x: number; y: number; width: number; height: number };
    sampled: number;
    colors: PaletteColour[];
  };
}

interface FailurePayload {
  available: boolean;
  error: string;
}

type SampleArgs = Parameters<typeof imgSampleTool.execute>[0];

const dir = mkdtempSync(join(tmpdir(), 'imagelab-img-sample-'));
const ctx = mockCtx(dir);

function run(args: Partial<SampleArgs>) {
  return imgSampleTool.execute(args as SampleArgs, ctx);
}

beforeAll(() => {
  writePngFile(dir, 'sample.png', 3, 2, [
    { x: 0, y: 0, colour: '#ff0000' },
    { x: 1, y: 0, colour: '#ff0000' },
    { x: 2, y: 0, colour: '#0000ff' },
    { x: 0, y: 1, colour: '#00ff00' },
    { x: 1, y: 1, colour: '#00ff00' },
    { x: 2, y: 1, colour: '#00ff00' },
  ]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('img_sample tool', () => {
  it('samples individual points', async () => {
    const payload = parseTool<SamplePayload>(
      await run({
        path: 'sample.png',
        directory: dir,
        points: [
          { x: 0, y: 0, label: 'red' },
          { x: 2, y: 0 },
        ],
      })
    );

    expect(payload.size).toEqual({ width: 3, height: 2 });
    expect(payload.points[0]).toEqual({
      label: 'red',
      x: 0,
      y: 0,
      hex: '#ff0000',
      rgba: { r: 255, g: 0, b: 0, a: 255 },
    });
    expect(payload.points[1].hex).toBe('#0000ff');
    expect(payload.points[1].label).toBeUndefined();
  });

  it('summarises a region with its dominant colours', async () => {
    const payload = parseTool<SamplePayload>(
      await run({
        path: 'sample.png',
        directory: dir,
        regions: [{ x: 0, y: 0, width: 2, height: 2, label: 'left' }],
      })
    );

    const region = payload.regions[0];
    expect(region.label).toBe('left');
    expect(region.uniqueColors).toBe(2);
    expect(region.mean).toBe('#808000');
    expect(region.dominant).toHaveLength(2);
    for (const colour of region.dominant) {
      expect(colour.count).toBe(2);
      expect(colour.share).toBe(0.5);
    }
    expect(region.dominant[0].hex).toBe('#00ff00');
    expect(region.dominant[1].hex).toBe('#ff0000');
  });

  it('builds a whole-image palette and truncates it to the requested count', async () => {
    const payload = parseTool<SamplePayload>(
      await run({ path: 'sample.png', directory: dir, palette: { colors: 2 } })
    );

    const palette = payload.palette;
    expect(palette).toBeDefined();
    expect(palette?.region).toEqual({ x: 0, y: 0, width: 3, height: 2 });
    expect(palette?.sampled).toBe(6);
    expect(palette?.colors).toEqual([
      { hex: '#00ff00', share: 0.5, count: 3 },
      { hex: '#ff0000', share: 0.3333, count: 2 },
    ]);
  });

  it('builds a palette for an explicit region', async () => {
    const payload = parseTool<SamplePayload>(
      await run({
        path: 'sample.png',
        directory: dir,
        palette: { colors: 8, region: { x: 2, y: 0, width: 1, height: 1 } },
      })
    );

    const palette = payload.palette;
    expect(palette?.sampled).toBe(1);
    expect(palette?.colors).toEqual([{ hex: '#0000ff', share: 1, count: 1 }]);
  });

  it('rejects requests with nothing to sample', async () => {
    const payload = parseTool<FailurePayload>(await run({ path: 'sample.png', directory: dir }));
    expect(payload.error).toContain('nothing to sample');
  });

  it('rejects points outside the image bounds', async () => {
    const payload = parseTool<FailurePayload>(
      await run({ path: 'sample.png', directory: dir, points: [{ x: 3, y: 0 }] })
    );
    expect(payload.error).toContain('outside');
  });

  it('returns a failure for a missing image', async () => {
    const payload = parseTool<FailurePayload>(
      await run({ path: 'missing.png', directory: dir, points: [{ x: 0, y: 0 }] })
    );
    expect(payload.error).toContain('cannot read image');
  });
});
