// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPixel } from '../src/lib/imagelab/image.ts';
import { readPng } from '../src/lib/imagelab/png.ts';
import { sixelDecodeTool } from '../src/tools/sixel-decode.ts';
import { mockCtx, parseTool } from './imagelab-helpers.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'imagelab', 'sample.sixel');

interface PaletteEntry {
  index: number;
  r: number;
  g: number;
  b: number;
  hex: string;
}

interface SixelPayload {
  ok: boolean;
  size: { width: number; height: number };
  bands: number;
  palette: PaletteEntry[];
  coloursUsed: number;
  output: { path: string; width: number; height: number };
  declared?: { width: number; height: number };
}

interface FailurePayload {
  available: boolean;
  error: string;
}

type SixelArgs = Parameters<typeof sixelDecodeTool.execute>[0];

const dir = mkdtempSync(join(tmpdir(), 'imagelab-sixel-decode-'));
const ctx = mockCtx(dir);

function run(args: Partial<SixelArgs>) {
  return sixelDecodeTool.execute(args as SixelArgs, ctx);
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sixel_decode tool', () => {
  it('decodes the fixture file and reports the palette', async () => {
    const output = join(dir, 'fixture.png');
    const payload = parseTool<SixelPayload>(await run({ path: FIXTURE, output, directory: dir }));

    expect(payload.size).toEqual({ width: 6, height: 12 });
    expect(payload.bands).toBe(2);
    expect(payload.coloursUsed).toBe(2);
    expect(payload.palette.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(payload.palette.map((entry) => entry.hex)).toEqual(['#000000', '#ff0000', '#00ff00']);
    expect(payload.declared).toEqual({ width: 6, height: 12 });

    const image = readPng(output);
    expect(image.width).toBe(6);
    expect(image.height).toBe(12);
    expect(getPixel(image, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(getPixel(image, 0, 6)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(getPixel(image, 5, 11)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it('decodes an inline stream', async () => {
    const output = join(dir, 'inline-red.png');
    const payload = parseTool<SixelPayload>(
      await run({ data: '#1;2;100;0;0#1@', output, directory: dir })
    );

    expect(payload.size).toEqual({ width: 1, height: 1 });
    expect(payload.bands).toBe(1);
    expect(getPixel(readPng(output), 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('decodes a DCS-wrapped inline stream', async () => {
    const output = join(dir, 'inline-blue.png');
    const payload = parseTool<SixelPayload>(
      await run({
        data: '\x1bP0;0;0q#1;2;0;0;100#1@\x1b\\',
        output,
        directory: dir,
      })
    );

    expect(payload.size).toEqual({ width: 1, height: 1 });
    expect(getPixel(readPng(output), 0, 0)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it('keeps unpainted pixels transparent unless a background is given', async () => {
    const data = '"1;1;2;1#1;2;100;0;0#1@';

    const transparentOutput = join(dir, 'transparent.png');
    const transparent = parseTool<SixelPayload>(
      await run({ data, output: transparentOutput, directory: dir })
    );
    expect(transparent.size).toEqual({ width: 2, height: 1 });
    expect(getPixel(readPng(transparentOutput), 1, 0)).toEqual({ r: 0, g: 0, b: 0, a: 0 });

    const filledOutput = join(dir, 'transparent-bg.png');
    await run({ data, output: filledOutput, directory: dir, background: '#ffffff' });
    expect(getPixel(readPng(filledOutput), 1, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('writes sixel-decoded.png beside the base when no output is given', async () => {
    const payload = parseTool<SixelPayload>(await run({ data: '#1;2;100;0;0#1@', directory: dir }));

    expect(payload.output.path).toBe(join(dir, 'sixel-decoded.png'));
  });

  it('requires exactly one of path or data', async () => {
    const both = parseTool<FailurePayload>(
      await run({ path: FIXTURE, data: '#1;2;100;0;0#1@', directory: dir })
    );
    expect(both.error).toContain('exactly one');

    const neither = parseTool<FailurePayload>(await run({ directory: dir }));
    expect(neither.error).toContain('exactly one');
  });
});
