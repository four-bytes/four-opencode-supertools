// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPixel } from '../src/lib/imagelab/image.ts';
import { readPng } from '../src/lib/imagelab/png.ts';
import { imgCropScaleTool } from '../src/tools/img-crop-scale.ts';
import { mockCtx, parseTool, writePngFile } from './imagelab-helpers.ts';

const RED = { r: 255, g: 0, b: 0, a: 255 };
const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

interface CropPayload {
  ok: boolean;
  path: string;
  source: { width: number; height: number };
  region: { x: number; y: number; width: number; height: number };
  scale: number;
  output: { path: string; width: number; height: number };
}

interface FailurePayload {
  available: boolean;
  error: string;
}

type CropArgs = Parameters<typeof imgCropScaleTool.execute>[0];

const dir = mkdtempSync(join(tmpdir(), 'imagelab-img-crop-scale-'));
const ctx = mockCtx(dir);

function run(args: Partial<CropArgs>) {
  return imgCropScaleTool.execute(args as CropArgs, ctx);
}

beforeAll(() => {
  writePngFile(dir, 'quad.png', 2, 2, [
    { x: 0, y: 0, colour: '#ff0000' },
    { x: 1, y: 0, colour: '#00ff00' },
    { x: 0, y: 1, colour: '#0000ff' },
    { x: 1, y: 1, colour: '#ffffff' },
  ]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('img_crop_scale tool', () => {
  it('crops a single pixel and scales it with nearest neighbour', async () => {
    const payload = parseTool<CropPayload>(
      await run({
        path: 'quad.png',
        directory: dir,
        region: { x: 0, y: 0, width: 1, height: 1 },
        scale: 3,
      })
    );

    expect(payload.source).toEqual({ width: 2, height: 2 });
    expect(payload.output).toEqual({
      path: join(dir, 'quad.crop.png'),
      width: 3,
      height: 3,
    });

    const image = readPng(payload.output.path);
    expect(image.width).toBe(3);
    expect(image.height).toBe(3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        expect(getPixel(image, x, y)).toEqual(RED);
      }
    }
  });

  it('scales the whole image into nearest-neighbour blocks', async () => {
    const payload = parseTool<CropPayload>(
      await run({ path: 'quad.png', directory: dir, scale: 2 })
    );

    const image = readPng(payload.output.path);
    expect(image.width).toBe(4);
    expect(image.height).toBe(4);

    expect(getPixel(image, 0, 0)).toEqual(RED);
    expect(getPixel(image, 1, 0)).toEqual(RED);
    expect(getPixel(image, 0, 1)).toEqual(RED);
    expect(getPixel(image, 2, 0)).toEqual(GREEN);
    expect(getPixel(image, 3, 1)).toEqual(GREEN);
    expect(getPixel(image, 0, 2)).toEqual(BLUE);
    expect(getPixel(image, 1, 3)).toEqual(BLUE);
    expect(getPixel(image, 3, 3)).toEqual(WHITE);
  });

  it('honours an explicit output path', async () => {
    const payload = parseTool<CropPayload>(
      await run({ path: 'quad.png', directory: dir, output: 'out.png' })
    );

    expect(payload.output.path).toBe(join(dir, 'out.png'));
  });

  it('rejects a region outside the image bounds', async () => {
    const payload = parseTool<FailurePayload>(
      await run({
        path: 'quad.png',
        directory: dir,
        region: { x: 1, y: 0, width: 2, height: 1 },
      })
    );

    expect(payload.error).toContain('outside');
  });

  it('returns a failure for a missing image', async () => {
    const payload = parseTool<FailurePayload>(await run({ path: 'missing.png', directory: dir }));

    expect(payload.error).toContain('cannot read image');
  });
});
