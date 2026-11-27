import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, loadSupertoolsConfig } from '../src/lib/framework/config';

let dir: string;

function writeConfig(content: string): void {
  writeFileSync(join(dir, '.supertools.json'), content, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'supertools-config-'));
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadSupertoolsConfig', () => {
  it('returns defaults when no config file exists', () => {
    const result = loadSupertoolsConfig(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({
        twig: { tags: {} },
        lsp: { idleTimeoutMs: null, servers: [] },
      });
      expect(result.path).toBeNull();
    }
  });

  it('parses a valid twig tag map', () => {
    writeConfig('{"twig":{"tags":{"my_tag":"block"}}}');

    const result = loadSupertoolsConfig(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.twig.tags).toEqual({ my_tag: 'block' });
      expect(result.path).toBe(join(dir, '.supertools.json'));
    }
  });

  it('caches per root until cleared', () => {
    writeConfig('{"twig":{"tags":{"v":"one"}}}');
    const first = loadSupertoolsConfig(dir);

    writeConfig('{"twig":{"tags":{"v":"two"}}}');
    const second = loadSupertoolsConfig(dir);

    clearConfigCache();
    const third = loadSupertoolsConfig(dir);

    expect(first.ok && first.config.twig.tags.v).toBe('one');
    expect(second.ok && second.config.twig.tags.v).toBe('one');
    expect(third.ok && third.config.twig.tags.v).toBe('two');
  });

  it('reports invalid JSON without throwing', () => {
    writeConfig('{not json');

    const result = loadSupertoolsConfig(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('JSON');
    }
  });

  it('rejects a non-object root with the (root) key', () => {
    writeConfig('[]');

    const result = loadSupertoolsConfig(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.key).toBe('(root)');
    }
  });

  it('rejects an array for twig', () => {
    writeConfig('{"twig":[]}');

    const result = loadSupertoolsConfig(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.key).toBe('twig');
    }
  });

  it('rejects an array for twig.tags', () => {
    writeConfig('{"twig":{"tags":[]}}');

    const result = loadSupertoolsConfig(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.key).toBe('twig.tags');
    }
  });

  it('rejects a non-string tag value and names the key', () => {
    writeConfig('{"twig":{"tags":{"x":5}}}');

    const result = loadSupertoolsConfig(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.key).toBe('twig.tags.x');
    }
  });
});

describe('loadSupertoolsConfig — lsp', () => {
  it('parses idleTimeoutMs and server overrides', () => {
    writeConfig(
      JSON.stringify({
        lsp: {
          idleTimeoutMs: 1234,
          servers: [
            {
              id: 'typescript',
              command: ['custom-ts', '--stdio'],
              extensions: ['.ts'],
              markers: ['tsconfig.json'],
              rootMarkers: ['tsconfig.json'],
              rootStrategy: 'nearest',
              installHint: 'install it',
              disable: false,
            },
          ],
        },
      })
    );

    const result = loadSupertoolsConfig(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.lsp.idleTimeoutMs).toBe(1234);
      expect(result.config.lsp.servers).toHaveLength(1);
      expect(result.config.lsp.servers[0].id).toBe('typescript');
      expect(result.config.lsp.servers[0].command).toEqual(['custom-ts', '--stdio']);
      expect(result.config.lsp.servers[0].rootStrategy).toBe('nearest');
    }
  });

  it('defaults lsp settings when the section is absent', () => {
    writeConfig('{"twig":{"tags":{}}}');
    const result = loadSupertoolsConfig(dir);
    expect(result.ok && result.config.lsp).toEqual({ idleTimeoutMs: null, servers: [] });
  });

  it('rejects a non-numeric idleTimeoutMs and names the key', () => {
    writeConfig('{"lsp":{"idleTimeoutMs":"soon"}}');
    const result = loadSupertoolsConfig(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.key).toBe('lsp.idleTimeoutMs');
  });

  it('rejects a server override without id', () => {
    writeConfig('{"lsp":{"servers":[{"command":["x"]}]}}');
    const result = loadSupertoolsConfig(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.key).toBe('lsp.servers[0].id');
  });

  it('rejects an unknown rootStrategy', () => {
    writeConfig('{"lsp":{"servers":[{"id":"x","rootStrategy":"magic"}]}}');
    const result = loadSupertoolsConfig(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.key).toBe('lsp.servers[0].rootStrategy');
  });
});
