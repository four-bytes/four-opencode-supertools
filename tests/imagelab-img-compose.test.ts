// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPixel } from '../src/lib/imagelab/image.ts';
import { readPng } from '../src/lib/imagelab/png.ts';
import { imgComposeTool } from '../src/tools/img-compose.ts';
import { mockCtx, parseTool, writePngFile } from './imagelab-helpers.ts';

const RED = { r: 255, g: 0, b: 0, a: 255 };
const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const BACKGROUND = { r: 16, g: 16, b: 16, a: 255 };

interface PanelOut {
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ComposePayload {
  ok: boolean;
  output: string;
  width: number;
  height: number;
  layout: string;
  columns: number;
  gap: number;
  labels: boolean;
  panels: PanelOut[];
}

interface FailurePayload {
  available: boolean;
  error: string;
}

type ComposeArgs = Parameters<typeof imgComposeTool.execute>[0];

const dir = mkdtempSync(join(tmpdir(), 'imagelab-img-compose-'));
const ctx = mockCtx(dir);

function run(args: Partial<ComposeArgs>) {
  return imgComposeTool.execute(args as ComposeArgs, ctx);
}

beforeAll(() => {
  writePngFile(dir, 'red.png', 4, 4, [], '#ff0000');
  writePngFile(dir, 'green.png', 4, 4, [], '#00ff00');
  writePngFile(dir, 'blue.png', 4, 4, [], '#0000ff');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('img_compose tool', () => {
  it('composes a labelled horizontal strip and draws labels', async () => {
    const payload = parseTool<ComposePayload>(
      await run({
        directory: dir,
        inputs: [
          { path: 'red.png', label: 'A' },
          { path: 'green.png', label: 'B' },
          { path: 'blue.png', label: 'C' },
        ],
      })
    );

    expect(payload.width).toBe(28);
    expect(payload.height).toBe(16);
    expect(payload.labels).toBe(true);
    expect(payload.columns).toBe(1);
    expect(payload.panels).toEqual([
      { label: 'A', x: 0, y: 0, width: 4, height: 16 },
      { label: 'B', x: 12, y: 0, width: 4, height: 16 },
      { label: 'C', x: 24, y: 0, width: 4, height: 16 },
    ]);

    const image = readPng(join(dir, 'imagelab-compose.png'));
    expect(getPixel(image, 0, 12)).toEqual(RED);
    expect(getPixel(image, 12, 12)).toEqual(GREEN);
    expect(getPixel(image, 24, 12)).toEqual(BLUE);

    let labelPixels = 0;
    for (let y = 2; y <= 8; y++) {
      for (let x = 2; x <= 6; x++) {
        const pixel = getPixel(image, x, y);
        if (pixel.r !== BACKGROUND.r || pixel.g !== BACKGROUND.g || pixel.b !== BACKGROUND.b) {
          labelPixels++;
        }
      }
    }
    expect(labelPixels).toBeGreaterThan(0);
  });

  it('omits labels and the label band without inputs carrying labels', async () => {
    const payload = parseTool<ComposePayload>(
      await run({
        directory: dir,
        inputs: [{ path: 'red.png' }, { path: 'green.png' }, { path: 'blue.png' }],
      })
    );

    expect(payload.width).toBe(28);
    expect(payload.height).toBe(4);
    expect(payload.labels).toBe(false);
  });

  it('stacks vertically', async () => {
    const payload = parseTool<ComposePayload>(
      await run({
        directory: dir,
        layout: 'vertical',
        inputs: [
          { path: 'red.png', label: 'A' },
          { path: 'green.png', label: 'B' },
        ],
      })
    );

    expect(payload.width).toBe(4);
    expect(payload.height).toBe(40);
  });

  it('lays out a grid with an explicit column count', async () => {
    const payload = parseTool<ComposePayload>(
      await run({
        directory: dir,
        layout: 'grid',
        columns: 2,
        inputs: [
          { path: 'red.png', label: 'A' },
          { path: 'green.png', label: 'B' },
          { path: 'blue.png', label: 'C' },
        ],
      })
    );

    expect(payload.columns).toBe(2);
    expect(payload.width).toBe(16);
    expect(payload.height).toBe(40);
  });

  it('scales every panel', async () => {
    const payload = parseTool<ComposePayload>(
      await run({
        directory: dir,
        scale: 2,
        inputs: [{ path: 'red.png' }, { path: 'green.png' }],
      })
    );

    expect(payload.width).toBe(24);
    expect(payload.height).toBe(8);

    const image = readPng(payload.output);
    expect(getPixel(image, 0, 0)).toEqual(RED);
    // Default gap 8: panel 0 spans 0..7, the gap 8..15, panel 1 starts at 16.
    expect(getPixel(image, 8, 0)).toEqual(BACKGROUND);
    expect(getPixel(image, 16, 0)).toEqual(GREEN);
  });

  it('returns a failure for a missing input', async () => {
    const payload = parseTool<FailurePayload>(
      await run({ directory: dir, inputs: [{ path: 'missing.png' }] })
    );

    expect(payload.error).toContain('cannot read image');
  });

  it('caps grid columns at the panel count', async () => {
    const payload = parseTool<ComposePayload>(
      await run({
        directory: dir,
        layout: 'grid',
        columns: 8,
        inputs: [{ path: 'red.png' }, { path: 'green.png' }],
      })
    );

    expect(payload.columns).toBe(2);
  });
});
