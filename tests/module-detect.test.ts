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
      termlab: false,
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
      termlab: false,
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
      termlab: false,
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
      termlab: false,
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

describe('termlab detection', () => {
  it('detects a Rust TUI dependency', () => {
    const markers = detectMarkers({ directory: fixture('termlab-detect/rust-tui') });
    expect(markers.termlab).toBe(true);
    expect(markers.rust).toBe(true);
    expect(detectModules({ directory: fixture('termlab-detect/rust-tui') })).toEqual([
      'rust',
      'termlab',
    ]);
  });

  it('detects a TypeScript ink dependency', () => {
    const markers = detectMarkers({ directory: fixture('termlab-detect/ts-ink') });
    expect(markers.termlab).toBe(true);
    expect(detectModules({ directory: fixture('termlab-detect/ts-ink') })).toEqual([
      'typescript',
      'termlab',
    ]);
  });

  it('detects a Go bubbletea dependency', () => {
    const markers = detectMarkers({ directory: fixture('termlab-detect/go-tui') });
    expect(markers.termlab).toBe(true);
    expect(detectModules({ directory: fixture('termlab-detect/go-tui') })).toEqual([
      'go',
      'termlab',
    ]);
  });

  it('detects an examples-only project with a language root', () => {
    const markers = detectMarkers({ directory: fixture('termlab-detect/examples-only') });
    expect(markers.termlab).toBe(true);
    expect(detectModules({ directory: fixture('termlab-detect/examples-only') })).toEqual([
      'rust',
      'termlab',
    ]);
  });

  it('does not flag plain language projects without a TUI dependency', () => {
    expect(detectMarkers({ directory: fixture('rust') }).termlab).toBe(false);
    expect(detectMarkers({ directory: fixture('go') }).termlab).toBe(false);
    expect(detectMarkers({ directory: fixture('typescript') }).termlab).toBe(false);
  });
});
