// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanTwig } from '../src/lib/twig/scanner';
import {
  buildTemplateChain,
  resolveLoaderPaths,
  resolveTemplate,
  type TwigLoaders,
} from '../src/lib/twig/resolver';
import { buildBlockChain } from '../src/lib/twig/blocks';
import { twigBlocksTool } from '../src/tools/twig-blocks';
import { toolObject } from './helpers';

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url).pathname;

const appRoot = fixture('twig/app');
const staticRoot = fixture('twig/static');
const emptyRoot = fixture('frameworks/empty');
const consolePath = fixture('twig/app/bin/console');

function twigData(): unknown {
  return JSON.parse(readFileSync(fixture('twig/console/twig.json'), 'utf8'));
}

function runtimeRunner(data: unknown = twigData()) {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (cmd: string[]) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
    },
  };
}

async function staticLoaders(): Promise<TwigLoaders> {
  return resolveLoaderPaths({ root: appRoot, consolePath: null });
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

describe('twig scanner', () => {
  it('finds blocks, endblock and parent() calls', () => {
    const result = scanTwig(
      '{% block title %}Hello{% endblock %}\n{% block content %}{{ parent() }}{% endblock %}'
    );

    expect(result.blocks).toEqual([
      { name: 'title', line: 1, parentCall: false },
      { name: 'content', line: 2, parentCall: true },
    ]);
    expect(result.tags.map((tag) => tag.name)).toEqual(['block', 'endblock', 'block', 'endblock']);
  });

  it('finds extends, use, embed and include', () => {
    const result = scanTwig(
      [
        "{% extends 'base.html.twig' %}",
        "{% use 'blocks.html.twig' %}",
        "{% embed 'card.html.twig' %}{% endembed %}",
        "{% include 'partial.html.twig' %}",
        "{{ include('other.html.twig') }}",
      ].join('\n')
    );

    expect(result.extends).toEqual({ target: 'base.html.twig', line: 1 });
    expect(result.uses).toEqual([{ target: 'blocks.html.twig', line: 2 }]);
    expect(result.embeds).toEqual([{ target: 'card.html.twig', line: 3 }]);
    expect(result.includes).toEqual([
      { target: 'partial.html.twig', line: 4 },
      { target: 'other.html.twig', line: 5 },
    ]);
  });

  it('tolerates extra whitespace after the extends directive', () => {
    const result = scanTwig("{% extends  'base.html.twig' %}");

    expect(result.extends).toEqual({ target: 'base.html.twig', line: 1 });
  });

  it('collects unknown tags without aborting the scan', () => {
    const result = scanTwig('{% customtag value %}\n{% block title %}x{% endblock %}');

    expect(result.unknownTags).toEqual(['customtag']);
    expect(result.blocks).toHaveLength(1);
  });

  it('never throws on malformed input', () => {
    expect(() => scanTwig('{% block title %}{{ "unterminated')).not.toThrow();
    expect(() => scanTwig('{# unterminated comment')).not.toThrow();

    const result = scanTwig('{% block title %}{{ "unterminated');
    expect(result.blocks).toEqual([{ name: 'title', line: 1, parentCall: false }]);
  });

  it('ignores tags inside comments and verbatim regions', () => {
    const commented = scanTwig('{# {% block hidden %} #}\n{% block shown %}{% endblock %}');
    expect(commented.blocks.map((block) => block.name)).toEqual(['shown']);

    const verbatim = scanTwig(
      [
        '{% verbatim %}',
        '{% block hidden %}x{% endblock %}',
        '{% endverbatim %}',
        '{% block shown %}{% endblock %}',
      ].join('\n')
    );
    expect(verbatim.blocks).toEqual([{ name: 'shown', line: 4, parentCall: false }]);
    expect(verbatim.tags.map((tag) => tag.name)).toEqual([
      'verbatim',
      'endverbatim',
      'block',
      'endblock',
    ]);
  });

  it('keeps 1-based line numbers on CRLF input', () => {
    const result = scanTwig(
      '{% block title %}\r\n{{ parent() }}\r\n{% endblock %}\r\n{% block content %}{% endblock %}\r\n'
    );

    expect(result.blocks).toEqual([
      { name: 'title', line: 1, parentCall: true },
      { name: 'content', line: 4, parentCall: false },
    ]);
  });
});

describe('twig loader paths', () => {
  it('normalises runtime debug:twig loader paths and namespaces', async () => {
    const { runner, calls } = runtimeRunner();
    const loaders = await resolveLoaderPaths({ root: appRoot, consolePath, runner });

    expect(loaders.source).toBe('runtime');
    expect(loaders.incomplete).toBe(false);
    expect(loaders.paths).toContain(join(appRoot, 'templates'));
    expect(loaders.paths).toContain(join(appRoot, 'src/AcmeBlog/Resources/views'));
    expect(loaders.namespaces['@AcmeBlog']).toBe(join(appRoot, 'src/AcmeBlog/Resources/views'));
    expect(calls[0]).toContain('debug:twig');
    expect(calls[0]).toContain('--format=json');
  });

  it('accepts object loader_paths, paths and namespaces shapes', async () => {
    const { runner } = runtimeRunner({
      loader_paths: { '@X': ['templates'] },
      namespaces: { '@X': 'src/X' },
    });
    const loaders = await resolveLoaderPaths({ root: appRoot, consolePath, runner });

    expect(loaders.paths).toContain(join(appRoot, 'templates'));
    expect(loaders.namespaces['@X']).toBe(join(appRoot, 'src/X'));

    const alias = runtimeRunner({ paths: ['templates'], namespaces: {} });
    const aliased = await resolveLoaderPaths({
      root: appRoot,
      consolePath,
      runner: alias.runner,
    });
    expect(aliased.paths).toContain(join(appRoot, 'templates'));
  });

  it('falls back to config/packages/twig.yaml and marks the result incomplete', async () => {
    const loaders = await resolveLoaderPaths({ root: appRoot, consolePath: null });

    expect(loaders.source).toBe('static');
    expect(loaders.incomplete).toBe(true);
    expect(loaders.reason).toBe('console-unavailable');
    expect(loaders.paths).toContain(join(appRoot, 'templates'));
    expect(loaders.paths).toContain(join(appRoot, 'src/AcmeBlog/Resources/views'));
    expect(loaders.namespaces['@AcmeBlog']).toBe(join(appRoot, 'src/AcmeBlog/Resources/views'));
  });

  it('parses the static-only fixture without a bin/console', async () => {
    const loaders = await resolveLoaderPaths({ root: staticRoot, consolePath: null });

    expect(loaders.source).toBe('static');
    expect(loaders.incomplete).toBe(true);
    expect(loaders.paths).toContain(join(staticRoot, 'templates'));
    expect(loaders.paths).toContain(join(staticRoot, 'templates/extra'));
  });
});

describe('twig template resolution', () => {
  it('prefers templates/bundles/<Bundle>/ over the bundle base', async () => {
    const loaders = await staticLoaders();
    const resolution = resolveTemplate('@AcmeBlog/post/list.html.twig', loaders, appRoot);

    expect(resolution.path).toBe(join(appRoot, 'templates/bundles/AcmeBlog/post/list.html.twig'));
    expect(resolution.candidates[0]).toMatchObject({
      kind: 'bundle-override',
      exists: true,
    });
    expect(
      resolution.candidates.some(
        (candidate) =>
          candidate.path === join(appRoot, 'src/AcmeBlog/Resources/views/post/list.html.twig') &&
          candidate.kind === 'namespace'
      )
    ).toBe(true);
  });

  it('resolves plain template names through templates and loaders', async () => {
    const loaders = await staticLoaders();
    const resolution = resolveTemplate('pages/home.html.twig', loaders, appRoot);

    expect(resolution.path).toBe(join(appRoot, 'templates/pages/home.html.twig'));
    expect(resolution.candidates[0]).toMatchObject({ kind: 'loader', exists: true });
  });

  it('follows the extends chain with blocks and parent calls', async () => {
    const loaders = await staticLoaders();
    const chain = buildTemplateChain('pages/detail.html.twig', loaders, appRoot);

    expect(chain.template).toBe('pages/detail.html.twig');
    expect(chain.path).toBe(join(appRoot, 'templates/pages/detail.html.twig'));
    expect(chain.parent?.name).toBe('pages/home.html.twig');
    expect(chain.extendsChain.map((entry) => entry.name)).toEqual([
      'pages/home.html.twig',
      'base.html.twig',
    ]);

    const detail = chain.blocks.find(
      (block) => block.template === 'pages/detail.html.twig' && block.name === 'content'
    );
    const home = chain.blocks.find(
      (block) => block.template === 'pages/home.html.twig' && block.name === 'content'
    );
    expect(detail).toMatchObject({ line: 3, parentCall: false });
    expect(home).toMatchObject({ line: 5, parentCall: true });
    expect(
      chain.blocks.some((block) => block.template === 'base.html.twig' && block.name === 'title')
    ).toBe(true);
  });

  it('surfaces unknown tags with their path and line', async () => {
    const loaders = await staticLoaders();
    const chain = buildTemplateChain('unknown.html.twig', loaders, appRoot);

    expect(chain.unknownTags).toContainEqual({
      tag: 'customtag',
      path: join(appRoot, 'templates/unknown.html.twig'),
      line: 3,
    });
  });
});

describe('twig block chain', () => {
  it('orders content base → home → detail with parentCall flags', async () => {
    const loaders = await staticLoaders();
    const result = buildBlockChain('content', loaders, appRoot);

    expect(result.total).toBe(3);
    expect(result.chain.map((entry) => entry.template)).toEqual([
      'base.html.twig',
      'pages/home.html.twig',
      'pages/detail.html.twig',
    ]);
    expect(result.chain.map((entry) => entry.parentCall)).toEqual([false, true, false]);
    expect(result.chain[0]).toMatchObject({
      path: join(appRoot, 'templates/base.html.twig'),
      line: 7,
    });
    expect(result.chain[1]).toMatchObject({
      path: join(appRoot, 'templates/pages/home.html.twig'),
      line: 5,
    });
    expect(result.chain[2]).toMatchObject({
      path: join(appRoot, 'templates/pages/detail.html.twig'),
      line: 3,
    });
  });

  it('can restrict the chain to one template and its ancestors', async () => {
    const loaders = await staticLoaders();
    const result = buildBlockChain('content', loaders, appRoot, {
      template: 'pages/home.html.twig',
    });

    expect(result.chain.map((entry) => entry.template)).toEqual([
      'base.html.twig',
      'pages/home.html.twig',
    ]);
  });

  it('orders a templates/bundles override after its bundle base', async () => {
    const loaders = await staticLoaders();
    const result = buildBlockChain('list_body', loaders, appRoot);

    expect(result.chain.map((entry) => entry.path)).toEqual([
      join(appRoot, 'src/AcmeBlog/Resources/views/post/list.html.twig'),
      join(appRoot, 'templates/bundles/AcmeBlog/post/list.html.twig'),
    ]);
  });

  it('reports unknown tags found during the scan', async () => {
    const loaders = await staticLoaders();
    const result = buildBlockChain('title', loaders, appRoot);

    expect(result.unknownTags).toContainEqual({
      tag: 'customtag',
      path: join(appRoot, 'templates/unknown.html.twig'),
      line: 3,
    });
  });
});

describe('twig_blocks tool', () => {
  it('returns unavailable for a non-Symfony directory', async () => {
    const result = toolObject(
      await twigBlocksTool.execute(
        { mode: 'block', name: 'content', limit: 50, directory: emptyRoot },
        mockCtx(emptyRoot)
      )
    );
    const output = parseOutput(result);

    expect(result.metadata.available).toBe(false);
    expect(output.available).toBe(false);
    expect(output.hint).toContain('No Symfony/Shopware');
  });

  it('returns a static block chain for the static fixture', async () => {
    const result = toolObject(
      await twigBlocksTool.execute(
        { mode: 'block', name: 'content', limit: 50, directory: staticRoot },
        mockCtx(staticRoot)
      )
    );
    const output = parseOutput(result) as {
      chain: Array<{ template: string; parentCall: boolean }>;
    };

    expect(result.metadata.available).toBe(true);
    expect(result.metadata.source).toBe('static');
    expect(result.metadata.incomplete).toBe(true);
    expect(output.chain.map((entry) => entry.template)).toEqual([
      'base.html.twig',
      'pages/home.html.twig',
    ]);
    expect(output.chain[1].parentCall).toBe(true);
  });

  it('returns a template outline with its extends chain', async () => {
    const result = toolObject(
      await twigBlocksTool.execute(
        { mode: 'template', name: 'pages/home.html.twig', limit: 50, directory: staticRoot },
        mockCtx(staticRoot)
      )
    );
    const output = parseOutput(result) as {
      template: string;
      extendsChain: Array<{ name: string }>;
      blocks: Array<{ name: string; template: string; parentCall: boolean }>;
    };

    expect(result.metadata.mode).toBe('template');
    expect(output.template).toBe('pages/home.html.twig');
    expect(output.extendsChain.map((entry) => entry.name)).toEqual(['base.html.twig']);
    expect(
      output.blocks.some(
        (block) =>
          block.name === 'content' && block.template === 'pages/home.html.twig' && block.parentCall
      )
    ).toBe(true);
  });
});
