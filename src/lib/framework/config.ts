// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RootStrategy } from '../lsp-roots';

export interface LspServerOverride {
  /** Stable server identifier, e.g. "typescript", "deno", "gopls". */
  id: string;
  command?: string[];
  languageId?: string;
  extensions?: string[];
  /** Files that select this server (nearest marker wins). */
  markers?: string[];
  /** Files that mark the project root. */
  rootMarkers?: string[];
  rootStrategy?: RootStrategy;
  installHint?: string;
  disable?: boolean;
}

export interface LspConfig {
  /** Idle shutdown in ms: 0/absent = default, negative = disabled. */
  idleTimeoutMs: number | null;
  servers: LspServerOverride[];
}

export interface SupertoolsConfig {
  twig: { tags: Record<string, string> };
  lsp: LspConfig;
}

export type ConfigLoadResult =
  | { ok: true; config: SupertoolsConfig; path: string | null } // path null = no file, defaults
  | { ok: false; error: string; key?: string; path: string };

type ParseOk<T> = { ok: true; value: T };
type ParseFailure = { ok: false; error: string; key?: string; path: string };

const ROOT_STRATEGIES: ReadonlySet<string> = new Set(['nearest', 'cargo-workspace', 'go-work']);

const cache = new Map<string, ConfigLoadResult>();

export function clearConfigCache(): void {
  cache.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function defaults(): SupertoolsConfig {
  return deepFreeze({ twig: { tags: {} }, lsp: { idleTimeoutMs: null, servers: [] } });
}

function fail(path: string, key: string, message: string): ParseFailure {
  return { ok: false, error: `${message} in ${path}`, key, path };
}

function parseStringArray(
  value: unknown,
  key: string,
  path: string
): ParseOk<string[]> | ParseFailure {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return fail(path, key, `Expected "${key}" to be a string array`);
  }
  return { ok: true, value: [...(value as string[])] };
}

function parseOptionalString(
  raw: Record<string, unknown>,
  field: string,
  key: string,
  path: string,
  entry: Record<string, unknown>
): ParseOk<string | undefined> | ParseFailure {
  const value = raw[field];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return fail(path, `${key}.${field}`, `Expected "${key}.${field}" to be a string`);
  }
  entry[field] = value;
  return { ok: true, value };
}

function parseOptionalStringArray(
  raw: Record<string, unknown>,
  field: string,
  key: string,
  path: string,
  entry: Record<string, unknown>
): ParseOk<string[] | undefined> | ParseFailure {
  const value = raw[field];
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = parseStringArray(value, `${key}.${field}`, path);
  if (!parsed.ok) return parsed;
  entry[field] = parsed.value;
  return parsed;
}

function parseServerOverride(
  raw: unknown,
  index: number,
  path: string
): ParseOk<LspServerOverride> | ParseFailure {
  const key = `lsp.servers[${index}]`;
  if (!isPlainObject(raw)) return fail(path, key, `Expected "${key}" to be a JSON object`);
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    return fail(path, `${key}.id`, `Expected "${key}.id" to be a non-empty string`);
  }

  const entry: Record<string, unknown> = { id: raw.id };

  for (const field of ['languageId', 'installHint'] as const) {
    const parsed = parseOptionalString(raw, field, key, path, entry);
    if (!parsed.ok) return parsed;
  }
  for (const field of ['command', 'extensions', 'markers', 'rootMarkers'] as const) {
    const parsed = parseOptionalStringArray(raw, field, key, path, entry);
    if (!parsed.ok) return parsed;
  }

  if (raw.rootStrategy !== undefined) {
    if (typeof raw.rootStrategy !== 'string' || !ROOT_STRATEGIES.has(raw.rootStrategy)) {
      return fail(
        path,
        `${key}.rootStrategy`,
        `Expected "${key}.rootStrategy" to be "nearest", "cargo-workspace" or "go-work"`
      );
    }
    entry.rootStrategy = raw.rootStrategy;
  }

  if (raw.disable !== undefined) {
    if (typeof raw.disable !== 'boolean') {
      return fail(path, `${key}.disable`, `Expected "${key}.disable" to be a boolean`);
    }
    entry.disable = raw.disable;
  }

  if (Array.isArray(entry.command) && entry.command.length === 0) {
    return fail(path, `${key}.command`, `Expected "${key}.command" to be a non-empty string array`);
  }

  return { ok: true, value: entry as unknown as LspServerOverride };
}

function parseLsp(value: unknown, path: string): ParseOk<LspConfig> | ParseFailure {
  if (!isPlainObject(value)) return fail(path, 'lsp', 'Expected "lsp" to be a JSON object');

  let idleTimeoutMs: number | null = null;
  if (value.idleTimeoutMs !== undefined) {
    if (typeof value.idleTimeoutMs !== 'number' || !Number.isFinite(value.idleTimeoutMs)) {
      return fail(path, 'lsp.idleTimeoutMs', 'Expected "lsp.idleTimeoutMs" to be a finite number');
    }
    idleTimeoutMs = Math.floor(value.idleTimeoutMs);
  }

  const servers: LspServerOverride[] = [];
  if (value.servers !== undefined) {
    if (!Array.isArray(value.servers)) {
      return fail(path, 'lsp.servers', 'Expected "lsp.servers" to be an array');
    }
    for (let index = 0; index < value.servers.length; index++) {
      const parsed = parseServerOverride(value.servers[index], index, path);
      if (!parsed.ok) return parsed;
      servers.push(parsed.value);
    }
  }

  return { ok: true, value: { idleTimeoutMs, servers } };
}

function parseTwigTags(
  value: unknown,
  path: string
): ParseOk<Record<string, string>> | ParseFailure {
  const tags: Record<string, string> = {};
  if (value === undefined) return { ok: true, value: tags };
  if (!isPlainObject(value)) return fail(path, 'twig', 'Expected "twig" to be a JSON object');

  const rawTags = value.tags;
  if (rawTags === undefined) return { ok: true, value: tags };
  if (!isPlainObject(rawTags))
    return fail(path, 'twig.tags', 'Expected "twig.tags" to be a JSON object');

  for (const [name, tagValue] of Object.entries(rawTags)) {
    if (typeof tagValue !== 'string') {
      return fail(path, `twig.tags.${name}`, `Expected "twig.tags.${name}" to be a string`);
    }
    tags[name] = tagValue;
  }
  return { ok: true, value: tags };
}

function load(root: string): ConfigLoadResult {
  const path = join(root, '.supertools.json');
  if (!existsSync(path)) {
    return { ok: true, config: defaults(), path: null };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, error: `Invalid JSON in ${path}: ${errorMessage(error)}`, path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `Invalid JSON in ${path}: ${errorMessage(error)}`, path };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: `Expected a JSON object in ${path}`, key: '(root)', path };
  }

  const twig = parseTwigTags(parsed.twig, path);
  if (!twig.ok) return twig;

  const lsp =
    parsed.lsp === undefined
      ? ({ ok: true, value: { idleTimeoutMs: null, servers: [] } } as ParseOk<LspConfig>)
      : parseLsp(parsed.lsp, path);
  if (!lsp.ok) return lsp;

  return { ok: true, config: deepFreeze({ twig: { tags: twig.value }, lsp: lsp.value }), path };
}

export function loadSupertoolsConfig(root: string): ConfigLoadResult {
  const resolved = resolve(root);
  const cached = cache.get(resolved);
  if (cached) return cached;
  const result = load(resolved);
  cache.set(resolved, result);
  return result;
}
