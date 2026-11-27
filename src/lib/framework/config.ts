// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface SupertoolsConfig {
  twig: { tags: Record<string, string> };
}

export type ConfigLoadResult =
  | { ok: true; config: SupertoolsConfig; path: string | null } // path null = no file, defaults
  | { ok: false; error: string; key?: string; path: string };

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
  return deepFreeze({ twig: { tags: {} } });
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

  const tags: Record<string, string> = {};
  const twig = parsed.twig;
  if (twig !== undefined) {
    if (!isPlainObject(twig)) {
      return {
        ok: false,
        error: `Expected "twig" to be a JSON object in ${path}`,
        key: 'twig',
        path,
      };
    }

    const rawTags = twig.tags;
    if (rawTags !== undefined) {
      if (!isPlainObject(rawTags)) {
        return {
          ok: false,
          error: `Expected "twig.tags" to be a JSON object in ${path}`,
          key: 'twig.tags',
          path,
        };
      }

      for (const [name, value] of Object.entries(rawTags)) {
        if (typeof value !== 'string') {
          return {
            ok: false,
            error: `Expected "twig.tags.${name}" to be a string in ${path}`,
            key: `twig.tags.${name}`,
            path,
          };
        }
        tags[name] = value;
      }
    }
  }

  return { ok: true, config: deepFreeze({ twig: { tags } }), path };
}

export function loadSupertoolsConfig(root: string): ConfigLoadResult {
  const resolved = resolve(root);
  const cached = cache.get(resolved);
  if (cached) return cached;
  const result = load(resolved);
  cache.set(resolved, result);
  return result;
}
