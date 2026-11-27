import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFramework } from '../src/lib/framework/detect';

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url).pathname;

let isolatedDir: string | undefined;

afterEach(() => {
  if (isolatedDir) {
    rmSync(isolatedDir, { recursive: true, force: true });
    isolatedDir = undefined;
  }
});

describe('detectFramework', () => {
  it('detects a symfony fixture', () => {
    const root = fixture('frameworks/symfony');
    const info = detectFramework(root);
    expect(info.framework).toBe('symfony');
    expect(info.root).toBe(root);
    expect(info.composerPath).toBe(join(root, 'composer.json'));
    expect(info.consolePath).not.toBeNull();
    expect(info.consolePath?.endsWith('/bin/console')).toBe(true);
  });

  it('detects a shopware fixture without a symfony entry', () => {
    const root = fixture('frameworks/shopware');
    const info = detectFramework(root);
    expect(info.framework).toBe('shopware');
    expect(info.root).toBe(root);
    expect(info.consolePath).not.toBeNull();
    expect(info.consolePath?.endsWith('/bin/console')).toBe(true);
  });

  it('reports plain php projects as none with no console', () => {
    const root = fixture('frameworks/plain');
    const info = detectFramework(root);
    expect(info.framework).toBe('none');
    expect(info.root).toBe(root);
    expect(info.consolePath).toBeNull();
  });

  it('treats doctrine alone as none', () => {
    const root = fixture('frameworks/doctrine');
    const info = detectFramework(root);
    expect(info.framework).toBe('none');
    expect(info.root).toBe(root);
  });

  it('reports nothing for an empty isolated directory', () => {
    isolatedDir = mkdtempSync(join(tmpdir(), 'supertools-detect-'));
    const info = detectFramework(isolatedDir);
    expect(info).toEqual({
      framework: 'none',
      root: null,
      composerPath: null,
      consolePath: null,
    });
  });

  it('walks up from a nested file path that does not exist', () => {
    const root = fixture('frameworks/symfony');
    const info = detectFramework(join(root, 'src', 'Service', 'Foo.php'));
    expect(info.root).toBe(root);
    expect(info.framework).toBe('symfony');
  });
});
