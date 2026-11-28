// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ToolContext } from '@opencode-ai/plugin';
import { join } from 'node:path';
import { parseColour } from '../src/lib/imagelab/colour.ts';
import { createImage, setPixel, type Rgba } from '../src/lib/imagelab/image.ts';
import { writePng } from '../src/lib/imagelab/png.ts';

/** Minimal ToolContext matching tests/termlab-tools.test.ts. */
export function mockCtx(dir: string): ToolContext {
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

/** Unwrap a structured tool result and parse its JSON output. */
export function parseTool<T>(result: unknown): T {
  return JSON.parse((result as { output: string }).output) as T;
}

type ColourInput = string | Rgba;

function resolveColour(colour: ColourInput): Rgba {
  return typeof colour === 'string' ? parseColour(colour) : colour;
}

/**
 * Create a PNG on disk: fill the canvas, then paint the given pixels.
 * Returns the absolute path of the written file.
 */
export function writePngFile(
  dir: string,
  name: string,
  width: number,
  height: number,
  pixels?: Array<{ x: number; y: number; colour: ColourInput }>,
  fill?: ColourInput
): string {
  const image = createImage(width, height, fill === undefined ? undefined : resolveColour(fill));
  for (const pixel of pixels ?? []) {
    setPixel(image, pixel.x, pixel.y, resolveColour(pixel.colour));
  }
  const path = join(dir, name);
  writePng(path, image);
  return path;
}
