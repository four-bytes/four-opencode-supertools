import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  lookupSymfonyServices,
  normalizeRuntimeContainer,
} from '../src/lib/framework/symfony-services';
import { symfonyServiceTool } from '../src/tools/symfony-service';

const fixtureRoot = (path: string) =>
  new URL(`./fixtures/symfony/${path}`, import.meta.url).pathname;

const appRoot = fixtureRoot('app');
const xmlRoot = fixtureRoot('xmlapp');
const consolePath = fixtureRoot('app/bin/console');

function containerData(): unknown {
  return JSON.parse(readFileSync(fixtureRoot('console/container.json'), 'utf8'));
}

function capture(
  result:
    | { exitCode: number; stdout: string; stderr: string }
    | Error = { exitCode: 0, stdout: JSON.stringify(containerData()), stderr: '' }
) {
  const calls: { cmd: string[]; cwd?: string }[] = [];
  return {
    calls,
    runner: async (cmd: string[], opts: { cwd: string }) => {
      calls.push({ cmd, cwd: opts.cwd });
      if (result instanceof Error) throw result;
      return result;
    },
  };
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

function parseOutput(result: unknown): Record<string, any> {
  return JSON.parse((result as { output: string }).output);
}

describe('lookupSymfonyServices — runtime', () => {
  it('returns the decorator chain and tags from console JSON', async () => {
    const { runner, calls } = capture();
    const result = await lookupSymfonyServices({
      root: appRoot,
      query: 'App\\Service\\Mailer',
      consolePath,
      runner,
    });

    expect(result.source).toBe('runtime');
    expect(result.incomplete).toBeUndefined();
    // The class query also matches the app.mailer alias, which resolves to the same class.
    const service = result.services.find((entry) => entry.id === 'App\\Service\\Mailer');
    expect(service).toBeDefined();
    if (!service) throw new Error('Mailer service missing');
    expect(service.class).toBe('App\\Service\\Mailer');
    expect(service.tags[0].name).toBe('kernel.event_listener');
    expect(service.tags[0].attributes.priority).toBe('10');
    expect(service.arguments[0]).toBe('@mailer.transport');
    expect(service.decoratedBy).toContain('App\\Service\\DecoratingMailer');

    expect(calls[0].cmd).toContain('debug:container');
    expect(calls[0].cmd).toContain('--format=json');
    expect(calls[0].cwd).toBe(appRoot);
  });

  it('treats class as a service lookup key', async () => {
    const { runner } = capture();
    const result = await lookupSymfonyServices({
      root: appRoot,
      query: 'App\\Service\\DecoratingMailer',
      consolePath,
      runner,
    });
    expect(result.services[0].decorates).toBe('App\\Service\\Mailer');
  });

  it('resolves an alias to the target class', async () => {
    const { runner } = capture();
    const result = await lookupSymfonyServices({
      root: appRoot,
      query: 'app.mailer',
      consolePath,
      runner,
    });
    expect(result.services[0].alias).toBe('App\\Service\\Mailer');
    expect(result.services[0].class).toBe('App\\Service\\Mailer');
  });

  it('supports tag filtering with tag:<name>', async () => {
    const { runner } = capture();
    const result = await lookupSymfonyServices({
      root: appRoot,
      query: 'tag:kernel.event_listener',
      consolePath,
      runner,
    });
    expect(result.tag).toBe('kernel.event_listener');
    expect(result.total).toBe(1);
    expect(result.services[0].id).toBe('App\\Service\\Mailer');
  });

  it('supports partial ids with limit and truncation', async () => {
    const { runner } = capture();
    const result = await lookupSymfonyServices({
      root: appRoot,
      query: 'App\\Service',
      limit: 2,
      consolePath,
      runner,
    });
    expect(result.total).toBe(4);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('2 more');
  });
});

describe('lookupSymfonyServices — static fallback', () => {
  it('falls back to services.yaml and marks the result incomplete', async () => {
    const { runner } = capture({ exitCode: 1, stdout: '', stderr: 'container exploded' });
    const result = await lookupSymfonyServices({
      root: appRoot,
      query: 'App\\Service\\Mailer',
      consolePath,
      runner,
    });

    expect(result.source).toBe('static');
    expect(result.incomplete).toBe(true);
    expect(result.reason).toContain('console-failed');
    expect(result.services[0].class).toBe('App\\Service\\Mailer');
    expect(result.services[0].decoratedBy).toContain('App\\Service\\DecoratingMailer');
  });

  it('parses XML service definitions and alias classes', async () => {
    const result = await lookupSymfonyServices({
      root: xmlRoot,
      query: 'app.xml_service',
      consolePath: null,
    });

    expect(result.source).toBe('static');
    expect(result.services[0].class).toBe('App\\Xml\\Service');
    expect(result.services[0].public).toBe(true);
    expect(result.services[0].arguments).toEqual(['@dep.service', '@logger.service']);
    expect(result.services[0].tags[0].attributes.priority).toBe('5');

    const alias = await lookupSymfonyServices({
      root: xmlRoot,
      query: 'app.xml_alias',
      consolePath: null,
    });
    expect(alias.services[0].class).toBe('App\\Xml\\Service');
  });

  it('asks for a query when neither service nor tag is given', async () => {
    const result = await lookupSymfonyServices({ root: appRoot, consolePath: null });
    expect(result.count).toBe(0);
    expect(result.hint).toContain('tag:<name>');
  });
});

describe('normalizeRuntimeContainer', () => {
  it('normalises tag arrays and decorated_services', () => {
    const services = normalizeRuntimeContainer(containerData());
    const mailer = services.find((service) => service.id === 'App\\Service\\Mailer');
    expect(mailer?.tags).toHaveLength(2);
    const decorator = services.find((service) => service.id === 'App\\Service\\DecoratingMailer');
    expect(decorator?.decorates).toBe('App\\Service\\Mailer');
  });
});

describe('symfony_service tool', () => {
  it('returns a static result for the fixture project', async () => {
    const output = parseOutput(
      await symfonyServiceTool.execute(
        { service: 'App\\Service\\Mailer', directory: appRoot },
        mockCtx(appRoot)
      )
    );

    expect(output.available).toBe(true);
    expect(output.source).toBe('static');
    expect(output.incomplete).toBe(true);
    expect(output.services[0].class).toBe('App\\Service\\Mailer');
  });

  it('reports when no Symfony project is found', async () => {
    const output = parseOutput(
      await symfonyServiceTool.execute(
        { service: 'x', directory: xmlRoot },
        mockCtx(xmlRoot)
      )
    );
    expect(output.available).toBe(false);
    expect(output.hint).toContain('No Symfony/Shopware');
  });
});
