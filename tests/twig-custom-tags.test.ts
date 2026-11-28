// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, afterEach } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isKnownTwigTag, scanTwig } from '../src/lib/twig/scanner';
import { discoverCustomTags } from '../src/lib/twig/custom-tags';
import { buildTemplateChain, resolveLoaderPaths } from '../src/lib/twig/resolver';
import { buildBlockChain } from '../src/lib/twig/blocks';
import { clearConfigCache } from '../src/lib/framework/config';
import { twigBlocksTool } from '../src/tools/twig-blocks';
import { toolObject } from './helpers';

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url).pathname;
const customRoot = fixture('twig/custom-tags');

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'supertools-twig-'));
  cpSync(customRoot, dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function mockCtx(dir: string) {
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

function parseOutput(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { output: string }).output) as Record<string, unknown>;
}

async function staticLoaders(root: string) {
  return resolveLoaderPaths({ root, consolePath: null });
}

afterEach(() => {
  clearConfigCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('custom tag discovery', () => {
  it('maps token parsers with a built-in parent to their semantics', async () => {
    const result = await discoverCustomTags({ root: customRoot });

    expect(result.tags).toEqual({ my_extends: 'extends', my_include: 'include' });
    expect(result.tags.my_other).toBeUndefined();
    expect(result.scannedFiles).toBeGreaterThan(0);
    expect(result.incomplete).toBe(false);
  });

  it('ignores token parsers whose parent is not a built-in parser', async () => {
    const result = await discoverCustomTags({ root: customRoot });

    expect(result.tags.my_other).toBeUndefined();
  });

  it('returns an empty result when src is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supertools-twig-empty-'));
    tempDirs.push(dir);

    const result = await discoverCustomTags({ root: dir });

    expect(result).toEqual({ tags: {}, scannedFiles: 0, incomplete: false });
  });

  it('marks the result incomplete when the file cap is reached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supertools-twig-cap-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(join(dir, 'src', `${name}.php`), '<?php\n', 'utf8');
    }

    const result = await discoverCustomTags({ root: dir, maxFiles: 2 });

    expect(result.incomplete).toBe(true);
    expect(result.scannedFiles).toBeLessThanOrEqual(2);
  });
});

describe('scanner tagMap', () => {
  it('keeps default behaviour unchanged without a tagMap', () => {
    const result = scanTwig("{% my_extends 'base.twig' %}");

    expect(result.extends).toBeNull();
    expect(result.unknownTags).toEqual(['my_extends']);
    expect(isKnownTwigTag('my_extends')).toBe(false);
  });

  it('treats a mapped tag as extends and reads the actual tag name', () => {
    const result = scanTwig("{% my_extends 'base.twig' %}", {
      tagMap: { my_extends: 'extends' },
    });

    expect(result.extends).toEqual({ target: 'base.twig', line: 1 });
    expect(result.unknownTags).toEqual([]);
    expect(isKnownTwigTag('my_extends', { my_extends: 'extends' })).toBe(true);
  });

  it('maps include, embed and use targets', () => {
    const tagMap = { my_include: 'include', my_embed: 'embed', my_use: 'use' } as const;
    const result = scanTwig(
      [
        "{% my_include 'x.twig' %}",
        "{% my_embed 'card.twig' %}",
        "{% my_use 'blocks.twig' %}",
      ].join('\n'),
      { tagMap }
    );

    expect(result.includes).toEqual([{ target: 'x.twig', line: 1 }]);
    expect(result.embeds).toEqual([{ target: 'card.twig', line: 2 }]);
    expect(result.uses).toEqual([{ target: 'blocks.twig', line: 3 }]);
    expect(result.unknownTags).toEqual([]);
  });

  it('keeps 1-based lines on CRLF input and survives malformed tags', () => {
    const tagMap = { my_extends: 'extends' } as const;
    const result = scanTwig("{% my_extends 'base.twig' %}\r\n{% foo %}\r\n", { tagMap });

    expect(result.extends).toEqual({ target: 'base.twig', line: 1 });
    expect(result.unknownTags).toEqual(['foo']);
    expect(() => scanTwig('{% my_extends "unterminated', { tagMap })).not.toThrow();
  });

  it('treats a custom block mapping as a known no-op', () => {
    const result = scanTwig('{% my_block foo %}', { tagMap: { my_block: 'block' } });

    expect(result.unknownTags).toEqual([]);
    expect(result.blocks).toEqual([]);
  });
});

describe('inheritance with auto-detected tags', () => {
  it('follows a custom extends tag in the template chain', async () => {
    const loaders = await staticLoaders(customRoot);
    const discovery = await discoverCustomTags({ root: customRoot });
    const chain = buildTemplateChain('child.twig', loaders, customRoot, {
      tagMap: discovery.tags,
    });

    expect(chain.parent?.name).toBe('base.twig');
    expect(chain.extendsChain.map((entry) => entry.name)).toEqual(['base.twig']);
    expect(chain.unknownTags).toEqual([]);
  });

  it('orders a custom-extends block chain base → child', async () => {
    const loaders = await staticLoaders(customRoot);
    const discovery = await discoverCustomTags({ root: customRoot });
    const result = buildBlockChain('content', loaders, customRoot, {
      template: 'child.twig',
      tagMap: discovery.tags,
    });

    expect(result.chain.map((entry) => entry.template)).toEqual(['base.twig', 'child.twig']);
    expect(result.chain[1].parentCall).toBe(true);
  });

  it('recognises a custom include without reporting it unknown', async () => {
    const loaders = await staticLoaders(customRoot);
    const discovery = await discoverCustomTags({ root: customRoot });
    const chain = buildTemplateChain('includes.twig', loaders, customRoot, {
      tagMap: discovery.tags,
    });

    expect(chain.includes).toEqual([
      {
        target: 'x.twig',
        template: 'includes.twig',
        path: join(customRoot, 'templates/x.twig'),
        line: 1,
      },
    ]);
    expect(chain.unknownTags).toEqual([]);
  });
});

describe('config overrides', () => {
  it('lets .supertools.json win over auto-detection', async () => {
    const dir = tempProject();
    writeFileSync(
      join(dir, '.supertools.json'),
      '{"twig":{"tags":{"my_include":"embed"}}}',
      'utf8'
    );
    clearConfigCache();

    const result = toolObject(
      await twigBlocksTool.execute(
        { mode: 'template', name: 'includes.twig', limit: 50, directory: dir },
        mockCtx(dir)
      )
    );
    const output = parseOutput(result) as {
      embeds: Array<{ target: string }>;
      includes: unknown[];
      configError?: string;
    };

    expect(output.configError).toBeUndefined();
    expect(output.embeds.map((entry) => entry.target)).toContain('x.twig');
    expect(output.includes).toEqual([]);
    expect(result.metadata.configTags).toBe(1);
    expect(result.metadata.customTags).toBe(2);
  });

  it('reports invalid config typing without failing the tool', async () => {
    const dir = tempProject();
    writeFileSync(join(dir, '.supertools.json'), '{"twig":{"tags":{"x":5}}}', 'utf8');
    clearConfigCache();

    const result = toolObject(
      await twigBlocksTool.execute(
        { mode: 'template', name: 'child.twig', limit: 50, directory: dir },
        mockCtx(dir)
      )
    );
    const output = parseOutput(result) as {
      extendsChain: Array<{ name: string }>;
      configError?: string;
    };

    expect(result.metadata.available).toBe(true);
    expect(output.configError).toContain('twig.tags.x');
    expect(output.extendsChain.map((entry) => entry.name)).toEqual(['base.twig']);
  });
});

describe('twig_blocks tool custom tags', () => {
  it('reports an unmapped custom tag with a mapping hint', async () => {
    const result = toolObject(
      await twigBlocksTool.execute(
        { mode: 'template', name: 'unknown.twig', limit: 50, directory: customRoot },
        mockCtx(customRoot)
      )
    );
    const output = parseOutput(result) as {
      unknownTags: Array<{ tag: string; path: string; line: number }>;
      hint?: string;
    };

    expect(output.unknownTags).toContainEqual({
      tag: 'foo',
      path: join(customRoot, 'templates/unknown.twig'),
      line: 1,
    });
    expect(output.hint).toContain('twig.tags');
    expect(result.metadata.discoveryIncomplete).toBe(false);
    expect(result.metadata.customTags).toBe(2);
  });
});
