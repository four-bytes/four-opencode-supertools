// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasGoldenSnapshots } from '../src/lib/imagelab/detect.ts';

describe('hasGoldenSnapshots', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imagelab-detect-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const touch = (relative: string): void => {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  };

  it('finds PNGs in a snapshots directory', () => {
    touch('tests/snapshots/button.png');
    expect(hasGoldenSnapshots(root)).toBe(true);
  });

  it('finds PNGs in a golden directory', () => {
    touch('golden/header.png');
    expect(hasGoldenSnapshots(root)).toBe(true);
  });

  it('finds .golden.png files anywhere in scope', () => {
    touch('nested/deep/widget.golden.png');
    expect(hasGoldenSnapshots(root)).toBe(true);
  });

  it('finds .snap.png and .expected.png files', () => {
    touch('a.snap.png');
    expect(hasGoldenSnapshots(root)).toBe(true);

    const other = mkdtempSync(join(tmpdir(), 'imagelab-detect-'));
    try {
      const target = join(other, 'b.expected.png');
      writeFileSync(target, new Uint8Array([0]));
      expect(hasGoldenSnapshots(other)).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('ignores plain PNGs outside snapshot directories', () => {
    touch('assets/logo.png');
    touch('images/photo.png');
    expect(hasGoldenSnapshots(root)).toBe(false);
  });

  it('skips node_modules and dot directories', () => {
    touch('node_modules/pkg/golden/thing.png');
    touch('node_modules/pkg/a.golden.png');
    touch('.cache/snapshots/b.png');
    expect(hasGoldenSnapshots(root)).toBe(false);
  });

  it('returns false for a missing directory without throwing', () => {
    expect(hasGoldenSnapshots(join(root, 'does-not-exist'))).toBe(false);
  });
});
