import { describe, it, expect } from 'bun:test';
import { detectMarkers, detectModules } from '../src/lib/modules/detect';

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url).pathname;

describe('detectMarkers', () => {
  it('detects a symfony project', () => {
    const markers = detectMarkers({ directory: fixture('frameworks/symfony') });
    expect(markers).toEqual({
      php: true,
      go: false,
      rust: false,
      typescript: false,
      symfony: true,
      doctrine: false,
      shopware: false,
    });
  });

  it('detects a shopware project as shopware + symfony + php', () => {
    const markers = detectMarkers({ directory: fixture('frameworks/shopware') });
    expect(markers).toEqual({
      php: true,
      go: false,
      rust: false,
      typescript: false,
      symfony: true,
      doctrine: false,
      shopware: true,
    });
  });

  it('detects a doctrine project as doctrine + php', () => {
    const markers = detectMarkers({ directory: fixture('frameworks/doctrine') });
    expect(markers).toEqual({
      php: true,
      go: false,
      rust: false,
      typescript: false,
      symfony: false,
      doctrine: true,
      shopware: false,
    });
  });

  it('reports nothing for an empty directory', () => {
    const markers = detectMarkers({ directory: fixture('frameworks/empty') });
    expect(markers).toEqual({
      php: false,
      go: false,
      rust: false,
      typescript: false,
      symfony: false,
      doctrine: false,
      shopware: false,
    });
  });

  it('detects go and rust marker files', () => {
    expect(detectMarkers({ directory: fixture('go') }).go).toBe(true);
    expect(detectMarkers({ directory: fixture('rust') }).rust).toBe(true);
  });

  it('detects a typescript marker file', () => {
    expect(detectMarkers({ directory: fixture('typescript') }).typescript).toBe(true);
  });

  it('deduplicates directory and worktree', () => {
    const markers = detectMarkers({
      directory: fixture('go'),
      worktree: fixture('go'),
    });
    expect(markers.go).toBe(true);
  });
});

describe('detectModules', () => {
  it('returns framework modules in canonical order', () => {
    expect(detectModules({ directory: fixture('frameworks/shopware') })).toEqual([
      'php',
      'symfony',
      'shopware',
    ]);
    expect(detectModules({ directory: fixture('frameworks/doctrine') })).toEqual([
      'php',
      'doctrine',
    ]);
  });

  it('returns an empty list for an empty directory', () => {
    expect(detectModules({ directory: fixture('frameworks/empty') })).toEqual([]);
  });

  it('returns the typescript module for a tsconfig project', () => {
    expect(detectModules({ directory: fixture('typescript') })).toEqual(['typescript']);
  });
});
