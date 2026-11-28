// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { assertImageSize, type RasterImage, type Rect } from './image.ts';
import { decodePng, pngInfo, writePng } from './png.ts';

export const MAX_IMAGE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;

export function readFileLimited(path: string, maxBytes: number, label: string): Buffer {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    throw new Error(`cannot read ${label} "${path}": ${errorMessage(error)}`, { cause: error });
  }
  if (size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
  }
  return readFileSync(path);
}

export interface ToolFailure {
  available: true;
  error: string;
  hint: string;
}

export function failure(error: string, hint: string): ToolFailure {
  return { available: true, error, hint };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveBase(
  directory: string | undefined,
  ctxDirectory: string | undefined
): string {
  return directory ?? ctxDirectory ?? process.cwd();
}

export function resolveToolPath(base: string, path: string): string {
  return resolve(base, path);
}

/** Same directory as the input, extension stripped, suffix + ".png" appended. */
export function defaultOutputPath(base: string, input: string, suffix: string): string {
  const resolved = resolve(base, input);
  const ext = extname(resolved);
  const stem = ext ? resolved.slice(0, resolved.length - ext.length) : resolved;
  return `${stem}${suffix}.png`;
}

export function readImage(base: string, path: string): RasterImage {
  const resolved = resolveToolPath(base, path);
  try {
    const bytes = readFileLimited(resolved, MAX_IMAGE_FILE_BYTES, 'image');
    const info = pngInfo(bytes);
    assertImageSize(info.width, info.height);
    return decodePng(bytes);
  } catch (error) {
    throw new Error(`cannot read image "${path}": ${errorMessage(error)}`, { cause: error });
  }
}

export function writeImage(base: string, path: string, image: RasterImage): string {
  const resolved = resolveToolPath(base, path);
  writePng(resolved, image);
  return resolved;
}

export function assertRectWithin(image: RasterImage, rect: Rect, what = 'rect'): void {
  const within =
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.width) &&
    Number.isInteger(rect.height) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= 1 &&
    rect.height >= 1 &&
    rect.x + rect.width <= image.width &&
    rect.y + rect.height <= image.height;
  if (!within) {
    throw new Error(
      `${what} ${rect.x},${rect.y} ${rect.width}x${rect.height} is outside the image bounds ` +
        `${image.width}x${image.height}`
    );
  }
}
