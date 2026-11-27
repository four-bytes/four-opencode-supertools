import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { lookupSymfonyEvents, normalizeRuntimeEvents } from '../src/lib/framework/symfony-events';
import { parseSubscribedEvents } from '../src/lib/framework/symfony-static';
import { symfonyEventsTool } from '../src/tools/symfony-events';

const fixtureRoot = (path: string) =>
  new URL(`./fixtures/symfony/${path}`, import.meta.url).pathname;

const appRoot = fixtureRoot('app');
const consolePath = fixtureRoot('app/bin/console');

function eventsData(): unknown {
  return JSON.parse(readFileSync(fixtureRoot('console/events.json'), 'utf8'));
}

function capture(
  result:
    | { exitCode: number; stdout: string; stderr: string }
    | Error = { exitCode: 0, stdout: JSON.stringify(eventsData()), stderr: '' }
) {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (cmd: string[]) => {
      calls.push(cmd);
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

describe('lookupSymfonyEvents — runtime', () => {
  it('sorts listeners by priority descending', async () => {
    const { runner, calls } = capture();
    const result = await lookupSymfonyEvents({
      root: appRoot,
      event: 'kernel.request',
      consolePath,
      runner,
    });

    expect(result.source).toBe('runtime');
    expect(result.count).toBe(2);
    expect(result.listeners.map((listener) => listener.priority)).toEqual([32, 0]);
    expect(result.listeners[0].class).toBe('App\\Listener\\Earlier');
    expect(calls[0]).toContain('debug:event-dispatcher');
    expect(calls[0]).toContain('--format=json');
  });

  it('accepts the { listeners: [...] } event shape', async () => {
    const { runner } = capture();
    const result = await lookupSymfonyEvents({
      root: appRoot,
      event: 'order.created',
      consolePath,
      runner,
    });
    expect(result.select).toBeUndefined();
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0].method).toBe('onCreatedHigh');
    expect(result.listeners[0].priority).toBe(20);
  });
});

describe('lookupSymfonyEvents — static fallback', () => {
  it('merges getSubscribedEvents listeners sorted by priority', async () => {
    const { runner } = capture({ exitCode: 1, stdout: '', stderr: 'no dispatcher' });
    const result = await lookupSymfonyEvents({
      root: appRoot,
      event: 'order.created',
      consolePath,
      runner,
    });

    expect(result.source).toBe('static');
    expect(result.incomplete).toBe(true);
    expect(result.listeners.map((listener) => listener.method)).toEqual([
      'onCreatedHigh',
      'onCreatedLow',
    ]);
    expect(result.listeners.map((listener) => listener.priority)).toEqual([20, 0]);
    expect(result.listeners.every((listener) => listener.source === 'subscriber')).toBe(true);
  });

  it('merges kernel.event_listener tags with subscribers', async () => {
    const result = await lookupSymfonyEvents({
      root: appRoot,
      event: 'kernel.request',
      consolePath: null,
    });

    expect(result.source).toBe('static');
    expect(result.listeners.map((listener) => listener.priority)).toEqual([10, 0]);
    expect(result.listeners[0].source).toBe('tag');
    expect(result.listeners[0].method).toBe('onRequest');
    expect(result.listeners[1].source).toBe('subscriber');
  });

  it('lists known events when the event has no listeners', async () => {
    const result = await lookupSymfonyEvents({
      root: appRoot,
      event: 'missing.event',
      consolePath: null,
    });
    expect(result.count).toBe(0);
    expect(result.hint).toContain('Known events');
  });
});

describe('parseSubscribedEvents', () => {
  it('extracts flat and nested priority forms', async () => {
    const source = readFileSync(
      fixtureRoot('app/src/EventListener/OrderSubscriber.php'),
      'utf8'
    );
    const listeners = await parseSubscribedEvents(source);

    expect(listeners).toHaveLength(3);
    const created = listeners.filter((listener) => listener.event === 'order.created');
    expect(created.map((listener) => listener.method)).toEqual(['onCreatedHigh', 'onCreatedLow']);
    expect(created.map((listener) => listener.priority)).toEqual([20, 0]);
    expect(listeners[0].class).toBe('App\\EventListener\\OrderSubscriber');
  });
});

describe('normalizeRuntimeEvents', () => {
  it('normalises both array and listeners-wrapper shapes', () => {
    const fromArray = normalizeRuntimeEvents(eventsData(), 'kernel.request');
    expect(fromArray.map((listener) => listener.priority)).toEqual([32, 0]);

    const fromWrapper = normalizeRuntimeEvents(eventsData(), 'order.created');
    expect(fromWrapper).toHaveLength(1);
    expect(fromWrapper[0].service).toBe('App\\EventListener\\OrderSubscriber');
  });
});

describe('symfony_events tool', () => {
  it('returns a static listener list for the fixture project', async () => {
    const output = parseOutput(
      await symfonyEventsTool.execute(
        { event: 'order.created', directory: appRoot },
        mockCtx(appRoot)
      )
    );

    expect(output.available).toBe(true);
    expect(output.source).toBe('static');
    expect(output.incomplete).toBe(true);
    expect(output.count).toBe(2);
    expect(output.listeners[0].priority).toBe(20);
  });
});
