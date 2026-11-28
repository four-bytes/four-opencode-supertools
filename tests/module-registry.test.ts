import { describe, it, expect } from 'bun:test';
import { buildToolMap } from '../src/lib/modules/registry';
import type { RegistryLogger } from '../src/lib/modules/registry';

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url).pathname;

function captureLogger() {
  const warnings: string[] = [];
  const logger: RegistryLogger = (level, message) => {
    if (level === 'warn') warnings.push(message);
  };
  return { warnings, logger };
}

describe('module registry — auto detection', () => {
  it('enables the php module for a composer project', async () => {
    const { warnings, logger } = captureLogger();
    const tools = await buildToolMap(undefined, { directory: fixture('php/composer'), logger });
    const names = Object.keys(tools);

    expect(names).toHaveLength(18);
    expect(names).toContain('extract_method');
    expect(names).toContain('lsp_code_action');
    expect(warnings).toHaveLength(0);
  });

  it('enables go without php refactoring tools', async () => {
    const { logger } = captureLogger();
    const tools = await buildToolMap(undefined, { directory: fixture('go'), logger });
    const names = Object.keys(tools);

    expect(names).toContain('batch_edit');
    expect(names).toContain('sonar_search');
    expect(names).toContain('file_outline');
    expect(names).toContain('rename_symbol');
    expect(names).not.toContain('extract_method');
    expect(names).not.toContain('move_class');
  });

  it('enables rust without php refactoring tools', async () => {
    const { logger } = captureLogger();
    const tools = await buildToolMap(undefined, { directory: fixture('rust'), logger });
    const names = Object.keys(tools);

    expect(names).toContain('batch_edit');
    expect(names).toContain('rename_symbol');
    expect(names).not.toContain('extract_method');
    expect(names).not.toContain('move_class');
  });

  it('enables the typescript module for a tsconfig project', async () => {
    const { warnings, logger } = captureLogger();
    const tools = await buildToolMap(undefined, { directory: fixture('typescript'), logger });
    const names = Object.keys(tools);

    expect(names).toContain('batch_edit');
    expect(names).toContain('file_outline');
    expect(names).toContain('rename_symbol');
    expect(names).not.toContain('extract_method');
    expect(warnings).toHaveLength(0);
  });
});

describe('module registry — rename_symbol registration', () => {
  it('registers rename_symbol for php, go, rust and typescript', async () => {
    for (const module of ['php', 'go', 'rust', 'typescript']) {
      const tools = await buildToolMap({ modules: [module] }, { logger: () => {} });
      expect(Object.keys(tools)).toContain('rename_symbol');
    }
  });

  it('does not register rename_symbol for core only', async () => {
    const tools = await buildToolMap({ modules: ['core'] }, { logger: () => {} });
    expect(Object.keys(tools)).not.toContain('rename_symbol');
  });

  it('keeps exactly one rename_symbol key when all four modules are active', async () => {
    const tools = await buildToolMap(
      { modules: ['php', 'go', 'rust', 'typescript'] },
      { logger: () => {} }
    );
    expect(Object.keys(tools).filter((name) => name === 'rename_symbol')).toHaveLength(1);
  });
});

describe('module registry — explicit selection', () => {
  it('registers only the core module for modules:["core"]', async () => {
    const { logger } = captureLogger();
    const tools = await buildToolMap({ modules: ['core'] }, { logger });
    const names = Object.keys(tools);

    expect(names).toHaveLength(9);
    expect(names).not.toContain('sonar_search');
    expect(names).not.toContain('lsp_references');
  });

  it('registers both Symfony tools for modules:["symfony"]', async () => {
    const { logger } = captureLogger();
    const tools = await buildToolMap({ modules: ['symfony'] }, { logger });
    const names = Object.keys(tools);

    expect(names).toContain('symfony_service');
    expect(names).toContain('symfony_events');
  });

  it('pulls php in through shopware → symfony → php', async () => {
    const { logger } = captureLogger();
    const tools = await buildToolMap({ modules: ['shopware'] }, { logger });
    const names = Object.keys(tools);

    expect(names).toContain('extract_method');
    expect(names).toContain('rename_symbol');
    expect(names).toContain('move_class');
    expect(names).toContain('batch_edit');
  });

  it('pulls php in through symfony → php', async () => {
    const { logger } = captureLogger();
    const tools = await buildToolMap({ modules: ['symfony'] }, { logger });
    const names = Object.keys(tools);

    expect(names).toContain('extract_method');
    expect(names).toContain('move_class');
  });

  it('always unions in core for an explicit list', async () => {
    const { logger } = captureLogger();
    const tools = await buildToolMap({ modules: ['php'] }, { logger });
    const names = Object.keys(tools);

    expect(names).toContain('batch_edit');
    expect(names).toContain('extract_method');
    expect(names).not.toContain('sonar_search');
  });
});

describe('module registry — disable option', () => {
  it('removes a known tool without warning', async () => {
    const { warnings, logger } = captureLogger();
    const tools = await buildToolMap(
      { modules: 'auto', disable: ['sonar_search'] },
      { directory: fixture('php/composer'), logger }
    );

    expect(Object.keys(tools)).not.toContain('sonar_search');
    expect(Object.keys(tools)).toHaveLength(17);
    expect(warnings).toHaveLength(0);
  });

  it('warns instead of throwing for an unknown tool', async () => {
    const { warnings, logger } = captureLogger();
    const tools = await buildToolMap(
      { modules: ['core'], disable: ['does_not_exist'] },
      { logger }
    );

    expect(Object.keys(tools)).toHaveLength(9);
    expect(warnings.some((warning) => warning.includes('does_not_exist'))).toBe(true);
  });
});

describe('module registry — invalid options', () => {
  it('warns and falls back to core for an unknown module id', async () => {
    const { warnings, logger } = captureLogger();
    const tools = await buildToolMap({ modules: ['nope'] }, { logger });
    const core = await buildToolMap({ modules: ['core'] }, { logger: () => {} });

    expect(warnings.some((warning) => warning.includes('nope'))).toBe(true);
    expect(Object.keys(tools).sort()).toEqual(Object.keys(core).sort());
    expect(Object.keys(tools)).toHaveLength(9);
  });

  it('fails closed to core for a string modules value', async () => {
    const { warnings, logger } = captureLogger();
    const tools = await buildToolMap({ modules: 'core' }, { logger });
    const names = Object.keys(tools);

    expect(names).toHaveLength(9);
    expect(names).not.toContain('sonar_search');
    expect(names).not.toContain('lsp_references');
    expect(warnings.some((warning) => warning.includes('Invalid "modules" option'))).toBe(true);
  });

  it('fails closed to core for a mixed non-string array', async () => {
    const { warnings, logger } = captureLogger();
    const tools = await buildToolMap({ modules: ['core', 5] }, { logger });

    expect(Object.keys(tools)).toHaveLength(9);
    expect(warnings.some((warning) => warning.includes('Invalid "modules" option'))).toBe(true);
  });
});
