// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * symfony_service core: runtime lookup via `debug:container --format=json`,
 * with a static fallback from config/services.(yaml|yml|xml). Static results
 * are always marked incomplete — no compiler passes or autowiring run.
 */

import { existsSync } from 'node:fs';
import { runConsoleJson, type ConsoleRunner } from './console';
import {
  normalizeTags,
  readStaticServices,
  type ServiceTag,
  type StaticService,
} from './symfony-static';

export interface ServiceInfo {
  id: string;
  class?: string;
  public?: boolean;
  alias?: string;
  decorates?: string;
  decoratedBy?: string[];
  tags: ServiceTag[];
  arguments: string[];
}

export interface ServiceLookupOptions {
  root: string;
  query?: string;
  tag?: string;
  limit?: number;
  consolePath?: string | null;
  runner?: ConsoleRunner;
  timeoutMs?: number;
}

export interface ServiceLookupResult {
  available: boolean;
  source: 'runtime' | 'static';
  incomplete?: boolean;
  query: string;
  tag?: string;
  count: number;
  total: number;
  services: ServiceInfo[];
  truncated: boolean;
  hint?: string;
  reason?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeArguments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(compactValue);
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** Normalise the JSON shape of `debug:container --format=json`. */
export function normalizeRuntimeContainer(data: unknown): ServiceInfo[] {
  if (!isPlainObject(data)) return [];

  const services: ServiceInfo[] = [];
  for (const [id, raw] of Object.entries(data)) {
    if (!isPlainObject(raw)) continue;

    const service: ServiceInfo = {
      id,
      class: typeof raw.class === 'string' ? raw.class : undefined,
      public: typeof raw.public === 'boolean' ? raw.public : undefined,
      alias: typeof raw.alias === 'string' ? raw.alias : undefined,
      tags: normalizeTags(raw.tags),
      arguments: normalizeArguments(raw.arguments),
    };

    const decorated = raw.decorated_services ?? raw.decorates;
    if (Array.isArray(decorated)) {
      const first = decorated.find((entry) => typeof entry === 'string');
      if (typeof first === 'string') service.decorates = first;
    } else if (typeof decorated === 'string') {
      service.decorates = decorated;
    }

    services.push(service);
  }
  return services;
}

function staticToInfo(service: StaticService): ServiceInfo {
  return {
    id: service.id,
    class: service.class,
    public: service.public,
    alias: service.alias,
    decorates: service.decorates,
    tags: service.tags,
    arguments: service.arguments,
  };
}

/** Resolve alias classes and compute the reverse decorator chain. */
export function enrichServices(services: ServiceInfo[]): ServiceInfo[] {
  const byId = new Map(services.map((service) => [service.id, service]));

  // Alias chains can be longer than one hop; resolve until stable.
  for (let pass = 0; pass < services.length; pass++) {
    let changed = false;
    for (const service of services) {
      if (!service.class && service.alias) {
        const target = byId.get(service.alias)?.class;
        if (target) {
          service.class = target;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  for (const service of services) {
    if (!service.decorates) continue;
    const target =
      byId.get(service.decorates) ?? services.find((s) => s.class === service.decorates);
    if (!target) continue;
    target.decoratedBy = [...(target.decoratedBy ?? []), service.id];
  }

  return services;
}

export function selectServices(
  services: ServiceInfo[],
  query: string | undefined,
  tag: string | undefined,
  limit: number
): { page: ServiceInfo[]; total: number; truncated: boolean } {
  let matched: ServiceInfo[];

  if (tag) {
    const wanted = tag.toLowerCase();
    matched = services.filter((service) =>
      service.tags.some((entry) => entry.name.toLowerCase() === wanted)
    );
  } else if (!query) {
    matched = [];
  } else {
    const exact = services.filter((service) => service.id === query || service.class === query);
    const pool =
      exact.length > 0
        ? exact
        : services.filter(
            (service) =>
              service.id.toLowerCase().includes(query.toLowerCase()) ||
              (service.class ?? '').toLowerCase().includes(query.toLowerCase())
          );
    matched = pool;
  }

  return {
    page: matched.slice(0, limit),
    total: matched.length,
    truncated: matched.length > limit,
  };
}

function buildResult(
  services: ServiceInfo[],
  source: 'runtime' | 'static',
  query: string,
  tag: string | undefined,
  limit: number,
  reason?: string
): ServiceLookupResult {
  const enriched = enrichServices(services);
  const { page, total, truncated } = selectServices(enriched, tag ? undefined : query, tag, limit);

  const result: ServiceLookupResult = {
    available: true,
    source,
    query,
    count: page.length,
    total,
    services: page,
    truncated,
  };
  if (tag) result.tag = tag;
  if (source === 'static') result.incomplete = true;
  if (reason) result.reason = reason;

  if (truncated) {
    result.hint = `…and ${total - page.length} more matches; raise limit.`;
  } else if (total === 0) {
    result.hint = tag ? `No services tagged "${tag}".` : `No service matched "${query}".`;
  } else if (source === 'static') {
    result.hint = 'Static fallback: resources, autowiring and compiler passes are not expanded.';
  }

  return result;
}

function staticLookup(
  root: string,
  query: string,
  tag: string | undefined,
  limit: number,
  reason?: string
): ServiceLookupResult {
  return buildResult(
    readStaticServices(root).map(staticToInfo),
    'static',
    query,
    tag,
    limit,
    reason
  );
}

export async function lookupSymfonyServices(
  options: ServiceLookupOptions
): Promise<ServiceLookupResult> {
  const limit = normalizeLimit(options.limit);
  const rawQuery = options.query?.trim() ?? '';
  let tag = options.tag?.trim() || undefined;
  let query = rawQuery;

  if (!tag && rawQuery.startsWith('tag:')) {
    tag = rawQuery.slice(4).trim();
    query = '';
  }

  if (!query && !tag) {
    return {
      available: true,
      source: 'static',
      incomplete: true,
      query,
      count: 0,
      total: 0,
      services: [],
      truncated: false,
      hint: 'Pass a service id/class, a partial id, or tag:<name>.',
    };
  }

  if (options.consolePath && existsSync(options.consolePath)) {
    const runtime = await runConsoleJson(options.consolePath, ['debug:container'], {
      cwd: options.root,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
    });
    if (runtime.ok) {
      return buildResult(normalizeRuntimeContainer(runtime.data), 'runtime', query, tag, limit);
    }
    return staticLookup(
      options.root,
      query,
      tag,
      limit,
      `runtime ${runtime.reason}: ${runtime.message}`
    );
  }

  return staticLookup(options.root, query, tag, limit, 'console-unavailable');
}
