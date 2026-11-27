// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ToolDefinition } from '@opencode-ai/plugin';
import type { ModuleId } from './detect';
import { detectModules } from './detect';
import { coreModule } from '../../modules/core';
import { searchModule } from '../../modules/search';
import { lspModule } from '../../modules/lsp';
import { phpModule } from '../../modules/php';
import { goModule } from '../../modules/go';
import { rustModule } from '../../modules/rust';
import { symfonyModule } from '../../modules/symfony';
import { doctrineModule } from '../../modules/doctrine';
import { shopwareModule } from '../../modules/shopware';

export interface ModuleDefinition {
  id: ModuleId;
  requires: ModuleId[];
  tools: () => Promise<Record<string, ToolDefinition>>;
}

export interface RegistryLogger {
  (level: 'warn' | 'info' | 'debug', message: string): void;
}

export interface BuildToolsInput {
  directory?: string;
  worktree?: string;
  logger?: RegistryLogger;
}

const CANONICAL_ORDER: ModuleId[] = [
  'core',
  'search',
  'lsp',
  'php',
  'go',
  'rust',
  'symfony',
  'doctrine',
  'shopware',
];

const MODULE_DEFINITIONS: Record<ModuleId, ModuleDefinition> = {
  core: coreModule,
  search: searchModule,
  lsp: lspModule,
  php: phpModule,
  go: goModule,
  rust: rustModule,
  symfony: symfonyModule,
  doctrine: doctrineModule,
  shopware: shopwareModule,
};

const KNOWN_MODULE_IDS = new Set<string>(CANONICAL_ORDER);

function isModuleId(value: string): value is ModuleId {
  return KNOWN_MODULE_IDS.has(value);
}

function autoModules(input: BuildToolsInput): ModuleId[] {
  return ['core', 'search', 'lsp', ...detectModules(input)];
}

function withDependencies(ids: ModuleId[]): ModuleId[] {
  const active = new Set<ModuleId>(ids);
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop() as ModuleId;
    for (const dependency of MODULE_DEFINITIONS[id].requires) {
      if (!active.has(dependency)) {
        active.add(dependency);
        stack.push(dependency);
      }
    }
  }
  return CANONICAL_ORDER.filter((id) => active.has(id));
}

export async function resolveModuleIds(
  options: Record<string, unknown> | undefined,
  input: BuildToolsInput
): Promise<ModuleId[]> {
  const raw = options?.modules;
  let requested: ModuleId[];

  if (raw === undefined || raw === 'auto') {
    requested = autoModules(input);
  } else if (Array.isArray(raw) && raw.every((value) => typeof value === 'string')) {
    requested = [];
    for (const name of raw as string[]) {
      if (isModuleId(name)) {
        if (!requested.includes(name)) requested.push(name);
      } else {
        input.logger?.('warn', `Unknown module "${name}" ignored`);
      }
    }
  } else {
    input.logger?.('warn', 'Invalid "modules" option, falling back to core');
    requested = ['core'];
  }

  // core is the safety net: it is always present, whatever the configuration.
  if (!requested.includes('core')) requested.push('core');

  const resolved = withDependencies(requested);
  return resolved.length > 0 ? resolved : ['core'];
}

export async function buildToolMap(
  options: Record<string, unknown> | undefined,
  input: BuildToolsInput
): Promise<Record<string, ToolDefinition>> {
  const ids = await resolveModuleIds(options, input);
  const merged: Record<string, ToolDefinition> = {};

  for (const id of ids) {
    const tools = await MODULE_DEFINITIONS[id].tools();
    Object.assign(merged, tools);
  }

  const disable = options?.disable;
  if (disable !== undefined) {
    if (!Array.isArray(disable) || !disable.every((value) => typeof value === 'string')) {
      input.logger?.('warn', 'Invalid "disable" option (expected string[])');
    } else {
      for (const name of disable as string[]) {
        if (Object.prototype.hasOwnProperty.call(merged, name)) {
          delete merged[name];
        } else {
          input.logger?.('warn', `Cannot disable unknown or inactive tool "${name}"`);
        }
      }
    }
  }

  return merged;
}
