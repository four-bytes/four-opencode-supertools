// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * symfony_events core: runtime lookup via `debug:event-dispatcher --format=json`,
 * with a static fallback from kernel.event_listener tags and getSubscribedEvents().
 * Static results are always marked incomplete.
 */

import { existsSync } from 'node:fs';
import { runConsoleJson, type ConsoleRunner } from './console';
import { collectStaticListeners, type StaticListener } from './symfony-static';

export interface EventListenerInfo {
  event: string;
  service: string;
  class?: string;
  method: string;
  priority: number;
  source?: 'tag' | 'subscriber';
}

export interface EventLookupOptions {
  root: string;
  event: string;
  limit?: number;
  consolePath?: string | null;
  runner?: ConsoleRunner;
  timeoutMs?: number;
}

export interface EventLookupResult {
  available: boolean;
  source: 'runtime' | 'static';
  incomplete?: boolean;
  event: string;
  count: number;
  total: number;
  listeners: EventListenerInfo[];
  truncated: boolean;
  hint?: string;
  reason?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function toListener(raw: unknown, event: string): EventListenerInfo | null {
  if (!isPlainObject(raw)) return null;
  const service =
    typeof raw.service === 'string'
      ? raw.service
      : typeof raw.class === 'string'
        ? raw.class
        : '(unknown service)';
  const method = typeof raw.method === 'string' ? raw.method : '__invoke';
  const priorityValue =
    typeof raw.priority === 'number' ? raw.priority : Number(raw.priority ?? 0) || 0;
  return {
    event: typeof raw.event === 'string' ? raw.event : event,
    service,
    class: typeof raw.class === 'string' ? raw.class : undefined,
    method,
    priority: priorityValue,
  };
}

function listenerList(data: unknown, event: string): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isPlainObject(data)) return [];

  const direct = data[event];
  if (Array.isArray(direct)) return direct;
  if (isPlainObject(direct)) {
    if (Array.isArray(direct.listeners)) return direct.listeners;
    if (Array.isArray(direct.calls)) return direct.calls;
  }
  if (Array.isArray(data.listeners)) return data.listeners;
  return [];
}

/** Normalise the JSON shape of `debug:event-dispatcher --format=json`. */
export function normalizeRuntimeEvents(data: unknown, event: string): EventListenerInfo[] {
  const listeners: EventListenerInfo[] = [];
  for (const raw of listenerList(data, event)) {
    const listener = toListener(raw, event);
    if (listener) listeners.push(listener);
  }
  return sortListeners(listeners);
}

function sortListeners(listeners: EventListenerInfo[]): EventListenerInfo[] {
  return [...listeners].sort(
    (a, b) =>
      b.priority - a.priority ||
      (a.class ?? a.service).localeCompare(b.class ?? b.service) ||
      a.method.localeCompare(b.method)
  );
}

function staticToInfo(listener: StaticListener): EventListenerInfo {
  return {
    event: listener.event,
    service: listener.service,
    class: listener.class,
    method: listener.method,
    priority: listener.priority,
    source: listener.source,
  };
}

function dedupe(listeners: EventListenerInfo[]): EventListenerInfo[] {
  const seen = new Set<string>();
  const unique: EventListenerInfo[] = [];
  for (const listener of listeners) {
    const key = `${listener.service}::${listener.method}@${listener.priority}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(listener);
  }
  return unique;
}

function buildStaticResult(
  all: EventListenerInfo[],
  event: string,
  limit: number,
  reason: string
): EventLookupResult {
  const wanted = event.toLowerCase();
  const matched = dedupe(all.filter((listener) => listener.event.toLowerCase() === wanted));
  const sorted = sortListeners(matched);
  const page = sorted.slice(0, limit);
  const result: EventLookupResult = {
    available: true,
    source: 'static',
    incomplete: true,
    event,
    count: page.length,
    total: sorted.length,
    listeners: page,
    truncated: sorted.length > limit,
    reason,
  };

  if (result.truncated) {
    result.hint = `…and ${sorted.length - page.length} more listeners; raise limit.`;
  } else if (sorted.length === 0) {
    const known = [...new Set(all.map((listener) => listener.event))].sort();
    const preview = known.slice(0, 10).join(', ');
    result.hint = known.length
      ? `No static listeners for "${event}". Known events: ${preview}${known.length > 10 ? ', …' : ''}.`
      : `No static listeners found for "${event}".`;
  } else {
    result.hint =
      'Static fallback: listener tags and src/**/*.php getSubscribedEvents() only; compiler passes are not evaluated.';
  }

  return result;
}

export async function lookupSymfonyEvents(options: EventLookupOptions): Promise<EventLookupResult> {
  const event = options.event?.trim() ?? '';
  const limit = normalizeLimit(options.limit);

  if (!event) {
    return {
      available: true,
      source: 'static',
      incomplete: true,
      event,
      count: 0,
      total: 0,
      listeners: [],
      truncated: false,
      hint: 'Pass an event name, e.g. kernel.request.',
    };
  }

  if (options.consolePath && existsSync(options.consolePath)) {
    const runtime = await runConsoleJson(options.consolePath, ['debug:event-dispatcher'], {
      cwd: options.root,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
    });
    if (runtime.ok) {
      const listeners = normalizeRuntimeEvents(runtime.data, event);
      const page = listeners.slice(0, limit);
      const result: EventLookupResult = {
        available: true,
        source: 'runtime',
        event,
        count: page.length,
        total: listeners.length,
        listeners: page,
        truncated: listeners.length > limit,
      };
      if (result.truncated) {
        result.hint = `…and ${listeners.length - page.length} more listeners; raise limit.`;
      } else if (listeners.length === 0) {
        result.hint = `No runtime listeners for "${event}".`;
      }
      return result;
    }
    const all = (await collectStaticListeners(options.root)).map(staticToInfo);
    return buildStaticResult(all, event, limit, `runtime ${runtime.reason}: ${runtime.message}`);
  }

  const all = (await collectStaticListeners(options.root)).map(staticToInfo);
  return buildStaticResult(all, event, limit, 'console-unavailable');
}
