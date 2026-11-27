// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * LSP Registry — maps files to language servers, resolves project roots and
 * pools clients per (server, canonical root). Idle clients shut down so we do
 * not keep a second server fleet alive next to opencode's own instances.
 */

import { pathToFileURL } from 'node:url';
import { LspClient } from './lsp-client';
import { logDebugEvent } from './debug-logger';
import { loadSupertoolsConfig, type LspServerOverride } from './framework/config';
import { findConfigRoot, nearestMarker, resolveProjectRoot, type RootStrategy } from './lsp-roots';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ServerConfig {
  /** Stable id used by `.supertools.json` overrides (e.g. "typescript", "deno"). */
  id?: string;
  /** Command to spawn the language server (e.g. ["typescript-language-server", "--stdio"]) */
  command: string[];
  /** Language ID for textDocument/didOpen */
  languageId: string;
  /** File extensions this server handles */
  extensions: string[];
  /** Files that select this server; the nearest marker wins. */
  markers?: string[];
  /** Files that mark the project root for this server. */
  rootMarkers?: string[];
  rootStrategy?: RootStrategy;
  /** Hint for installing the server (shown to the user if missing) */
  installHint?: string;
  disable?: boolean;
}

export interface LspRegistryOptions {
  /** Default idle timeout in ms. Negative disables idle shutdown. */
  idleTimeoutMs?: number;
}

export interface ResolveServerOptions {
  /** Directory whose `.supertools.json` should be used (defaults: nearest ancestor). */
  configRoot?: string;
}

export interface ResolvedServer {
  client: LspClient;
  languageId: string;
}

interface PooledClient {
  client: LspClient;
  serverId: string;
  languageId: string;
  root: string;
  lastUsedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

// ────────────────────────────────────────────────────────────────
// Default Server Configurations
// ────────────────────────────────────────────────────────────────

export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

export const DEFAULT_SERVERS: ServerConfig[] = [
  {
    id: 'typescript',
    command: ['typescript-language-server', '--stdio'],
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    markers: ['tsconfig.json', 'package.json'],
    rootMarkers: ['tsconfig.json', 'package.json'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  {
    id: 'deno',
    command: ['deno', 'lsp'],
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    markers: ['deno.json', 'deno.jsonc'],
    rootMarkers: ['deno.json', 'deno.jsonc'],
    installHint: 'Install Deno: https://deno.land/#installation',
  },
  {
    id: 'gopls',
    command: ['gopls'],
    languageId: 'go',
    extensions: ['.go'],
    rootMarkers: ['go.work', 'go.mod'],
    rootStrategy: 'go-work',
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'pyright',
    command: ['pyright-langserver', '--stdio'],
    languageId: 'python',
    extensions: ['.py', '.pyi'],
    installHint: 'pip install pyright',
  },
  {
    id: 'rust-analyzer',
    command: ['rust-analyzer'],
    languageId: 'rust',
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml'],
    rootStrategy: 'cargo-workspace',
    installHint: 'rustup component add rust-analyzer',
  },
  {
    id: 'intelephense',
    command: ['intelephense', '--stdio'],
    languageId: 'php',
    extensions: ['.php'],
    rootMarkers: ['composer.json'],
    installHint: 'npm install -g intelephense',
  },
];

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function cloneConfig(config: ServerConfig): ServerConfig {
  return {
    ...config,
    command: [...config.command],
    extensions: [...config.extensions],
    markers: config.markers ? [...config.markers] : undefined,
    rootMarkers: config.rootMarkers ? [...config.rootMarkers] : undefined,
  };
}

function getExtension(filePath: string): string | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return null;
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot < lastSlash) return null;
  return filePath.slice(lastDot).toLowerCase();
}

/**
 * Marker-based server selection. A server whose marker is nearest wins; on a
 * tie the later config wins (deno over typescript when both markers share a dir).
 * Without any marker hit, an explicit (marker-less) config wins, else the first
 * declared candidate (the base server).
 */
export function selectServerConfig(filePath: string, configs: ServerConfig[]): ServerConfig | null {
  const ext = getExtension(filePath);
  if (!ext) return null;

  const candidates = configs.filter((config) => !config.disable && config.extensions.includes(ext));
  if (candidates.length === 0) return null;

  let best: { config: ServerConfig; distance: number; index: number } | null = null;
  for (let index = 0; index < candidates.length; index++) {
    const config = candidates[index];
    if (!config.markers || config.markers.length === 0) continue;
    const hit = nearestMarker(filePath, config.markers);
    if (!hit) continue;
    if (
      !best ||
      hit.distance < best.distance ||
      (hit.distance === best.distance && index > best.index)
    ) {
      best = { config, distance: hit.distance, index };
    }
  }
  if (best) return best.config;

  const markerless = candidates.filter((config) => !config.markers || config.markers.length === 0);
  if (markerless.length > 0) return markerless[markerless.length - 1];
  return candidates[0];
}

/** Merge `.supertools.json` `lsp.servers` overrides onto the base configs. */
export function applyServerOverrides(
  base: ServerConfig[],
  overrides: LspServerOverride[]
): ServerConfig[] {
  const configs = base.map(cloneConfig);

  for (const override of overrides) {
    const index = configs.findIndex((config) => config.id === override.id);
    if (index >= 0) {
      const target = configs[index];
      if (override.command) target.command = [...override.command];
      if (override.languageId) target.languageId = override.languageId;
      if (override.extensions) target.extensions = [...override.extensions];
      if (override.markers) target.markers = [...override.markers];
      if (override.rootMarkers) target.rootMarkers = [...override.rootMarkers];
      if (override.rootStrategy) target.rootStrategy = override.rootStrategy;
      if (override.installHint) target.installHint = override.installHint;
      if (override.disable !== undefined) target.disable = override.disable;
      continue;
    }

    if (override.command?.length && override.languageId && override.extensions?.length) {
      configs.push({
        id: override.id,
        command: [...override.command],
        languageId: override.languageId,
        extensions: [...override.extensions],
        markers: override.markers ? [...override.markers] : undefined,
        rootMarkers: override.rootMarkers ? [...override.rootMarkers] : undefined,
        rootStrategy: override.rootStrategy,
        installHint: override.installHint,
        disable: override.disable,
      });
      continue;
    }

    logDebugEvent('lsp.config.override-ignored', { id: override.id });
  }

  return configs.filter((config) => !config.disable);
}

// ────────────────────────────────────────────────────────────────
// LspRegistry
// ────────────────────────────────────────────────────────────────

export class LspRegistry {
  private baseConfigs: ServerConfig[];
  private clients = new Map<string, PooledClient>();
  private defaultIdleTimeoutMs: number;

  constructor(configs: ServerConfig[] = DEFAULT_SERVERS, options: LspRegistryOptions = {}) {
    this.baseConfigs = configs.map(cloneConfig);
    this.defaultIdleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  private runtimeFor(
    filePath: string,
    configRoot?: string
  ): { configs: ServerConfig[]; idleTimeoutMs: number } {
    const loaded = loadSupertoolsConfig(configRoot ?? findConfigRoot(filePath));
    const overrides = loaded.ok ? loaded.config.lsp.servers : [];
    const configured = loaded.ok ? loaded.config.lsp.idleTimeoutMs : null;
    const idleTimeoutMs =
      configured === null || configured === 0 ? this.defaultIdleTimeoutMs : configured;
    return { configs: applyServerOverrides(this.baseConfigs, overrides), idleTimeoutMs };
  }

  /**
   * Find the server config for a file path based on extension and markers.
   * Returns null if no matching server is found.
   */
  findConfig(filePath: string, configRoot?: string): ServerConfig | null {
    return selectServerConfig(filePath, this.runtimeFor(filePath, configRoot).configs);
  }

  /**
   * Resolve (and lazily start) the pooled client for a file.
   * The key is (server, canonical project root); the idle timer is reset on use.
   */
  resolveServer(filePath: string, options: ResolveServerOptions = {}): ResolvedServer | null {
    const { configs, idleTimeoutMs } = this.runtimeFor(filePath, options.configRoot);
    const config = selectServerConfig(filePath, configs);
    if (!config) {
      logDebugEvent('lsp.resolve.no-config', { filePath });
      return null;
    }

    if (!this.isInstalled(config.command)) {
      logDebugEvent('lsp.resolve.not-installed', {
        command: config.command[0],
        installHint: config.installHint,
      });
      return null;
    }

    const root = resolveProjectRoot(filePath, config);
    const serverId = config.id ?? config.command.join(' ');
    const key = `${serverId}::${root}`;

    // resolveServer is synchronous end-to-end: there is no await between the
    // pool lookup and the set, so concurrent callers cannot double-spawn.

    const existing = this.clients.get(key);
    if (existing?.client.isRunning) {
      existing.lastUsedAt = Date.now();
      this.armIdleTimer(key, existing, idleTimeoutMs);
      logDebugEvent('lsp.resolve.reuse', { server: serverId, root });
      return { client: existing.client, languageId: existing.languageId };
    }
    if (existing) {
      this.clients.delete(key);
      this.clearTimer(existing);
      void existing.client.shutdown().catch(() => {});
    }

    const client = new LspClient();
    client.spawn(config.command, { rootUri: pathToFileURL(root).href });
    if (!client.isRunning) return null;

    const entry: PooledClient = {
      client,
      serverId,
      languageId: config.languageId,
      root,
      lastUsedAt: Date.now(),
      timer: null,
    };
    this.clients.set(key, entry);
    this.armIdleTimer(key, entry, idleTimeoutMs);
    logDebugEvent('lsp.resolve.new-client', {
      server: serverId,
      languageId: config.languageId,
      root,
      idleTimeoutMs,
    });

    return { client, languageId: config.languageId };
  }

  private clearTimer(entry: PooledClient): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private armIdleTimer(key: string, entry: PooledClient, idleTimeoutMs: number): void {
    this.clearTimer(entry);
    if (idleTimeoutMs < 0) return;

    entry.timer = setTimeout(() => {
      void this.evictIdle(key);
    }, idleTimeoutMs);
    // Must not keep the host process alive.
    (entry.timer as { unref?: () => void }).unref?.();
  }

  private async evictIdle(key: string): Promise<void> {
    const entry = this.clients.get(key);
    if (!entry) return;
    this.clients.delete(key);
    this.clearTimer(entry);
    try {
      await entry.client.shutdown();
    } catch {
      // Best-effort shutdown
    }
    logDebugEvent('lsp.registry.idle-evict', { server: entry.serverId, root: entry.root });
  }

  /**
   * Check if a binary is installed by running `which`.
   * Returns true if the binary exists and is executable.
   */
  isInstalled(command: string[]): boolean {
    if (!command || command.length === 0) return false;

    const binary = command[0];
    const proc = Bun.spawnSync(['which', binary], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return proc.exitCode === 0;
  }

  /**
   * Shut down all cached LSP clients and cancel pending idle timers.
   */
  async shutdownAll(): Promise<void> {
    const entries = Array.from(this.clients.values());
    this.clients.clear();
    const promises = entries.map((entry) => {
      this.clearTimer(entry);
      return entry.client.shutdown().catch(() => {
        // Best-effort shutdown
      });
    });
    await Promise.allSettled(promises);
    logDebugEvent('lsp.registry.shutdown-all', {});
  }

  /** Alias for shutdownAll, for a plugin dispose hook. */
  async dispose(): Promise<void> {
    await this.shutdownAll();
  }

  /**
   * Add or override a server config at runtime.
   */
  register(config: ServerConfig): void {
    this.baseConfigs.push(cloneConfig(config));
    logDebugEvent('lsp.registry.register', {
      command: config.command[0],
      extensions: config.extensions,
    });
  }

  /**
   * Get all registered server configs (including defaults).
   */
  getConfigs(): ServerConfig[] {
    return this.baseConfigs.map(cloneConfig);
  }

  /**
   * Get all document URIs that have been opened across all LSP clients.
   * Useful for project-wide diagnostic operations.
   */
  getOpenDocuments(): string[] {
    const docs: string[] = [];
    for (const entry of this.clients.values()) {
      const openDocs = entry.client.openDocuments;
      if (openDocs) {
        for (const uri of openDocs) {
          docs.push(uri);
        }
      }
    }
    return docs;
  }

  /** Number of pooled clients (including ones whose idle timer is pending). */
  get poolSize(): number {
    return this.clients.size;
  }
}

/** Singleton instance for convenience. */
let registryInstance: LspRegistry | null = null;

export function getLspRegistry(
  configs?: ServerConfig[],
  options?: LspRegistryOptions
): LspRegistry {
  if (!registryInstance) {
    registryInstance = new LspRegistry(configs, options);
  }
  return registryInstance;
}

export function resetLspRegistry(): void {
  registryInstance = null;
}

/**
 * Return the current singleton instance, or null if it was never created.
 * Never constructs a registry as a side effect.
 */
export function peekLspRegistry(): LspRegistry | null {
  return registryInstance;
}
