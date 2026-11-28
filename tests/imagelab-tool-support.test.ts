// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileLimited } from '../src/lib/imagelab/tool-support.ts';

const dir = mkdtempSync(join(tmpdir(), 'imagelab-tool-support-'));
const file = join(dir, 'eight.bin');

beforeAll(() => {
  writeFileSync(file, Buffer.alloc(8, 0x41));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readFileLimited', () => {
  it('reads a file within the byte limit', () => {
    expect(readFileLimited(file, 8, 'x').length).toBe(8);
  });

  it('rejects a file above the byte limit', () => {
    expect(() => readFileLimited(file, 7, 'x')).toThrow(/exceeds 7 bytes/);
  });

  it('wraps a missing path in a readable error', () => {
    expect(() => readFileLimited(join(dir, 'missing.bin'), 8, 'x')).toThrow(/cannot read/);
  });
});
