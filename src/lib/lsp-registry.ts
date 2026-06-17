// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * LSP Registry — Maps file extensions to language server commands.
 * Singleton that creates and caches LspClient instances per server config.
 * Foundation for Wave S6 (IDE Integration).
 */

import { LspClient } from './lsp-client';
import { logDebugEvent } from './debug-logger';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ServerConfig {
  /** Command to spawn the language server (e.g. ["typescript-language-server", "--stdio"]) */
  command: string[];
  /** Language ID for textDocument/didOpen */
  languageId: string;
  /** File extensions this server handles */
  extensions: string[];
  /** Hint for installing the server (shown to the user if missing) */
  installHint?: string;
}

// ────────────────────────────────────────────────────────────────
// Default Server Configurations
// ────────────────────────────────────────────────────────────────

export const DEFAULT_SERVERS: ServerConfig[] = [
  {
    command: ['typescript-language-server', '--stdio'],
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  {
    command: ['gopls'],
    languageId: 'go',
    extensions: ['.go'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    command: ['pyright-langserver', '--stdio'],
    languageId: 'python',
    extensions: ['.py', '.pyi'],
    installHint: 'pip install pyright',
  },
  {
    command: ['rust-analyzer'],
    languageId: 'rust',
    extensions: ['.rs'],
    installHint: 'rustup component add rust-analyzer',
  },
  {
    command: ['intelephense', '--stdio'],
    languageId: 'php',
    extensions: ['.php'],
    installHint: 'npm install -g intelephense',
  },
];

// ────────────────────────────────────────────────────────────────
// LspRegistry
// ────────────────────────────────────────────────────────────────

export class LspRegistry {
  private configs: ServerConfig[];
  private clients = new Map<string, LspClient>();

  constructor(configs: ServerConfig[] = DEFAULT_SERVERS) {
    // Copy to prevent mutation of the shared DEFAULT_SERVERS array
    this.configs = [...configs];
  }

  /**
   * Find the server config for a given file path based on extension.
   * Returns null if no matching server is found or the binary is not installed.
   */
  findConfig(filePath: string): ServerConfig | null {
    const ext = this.getExtension(filePath);
    if (!ext) return null;

    return this.configs.findLast((c) => c.extensions.includes(ext)) ?? null;
  }

  /**
   * Resolve the LSP client for a file path.
   * Creates or returns a cached client for the matching server config.
   * Returns null if no server matches or the binary is missing.
   */
  resolveServer(filePath: string): { client: LspClient; languageId: string } | null {
    const config = this.findConfig(filePath);
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

    const key = config.command.join(' ');
    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient();
      client.spawn(config.command);
      this.clients.set(key, client);
      logDebugEvent('lsp.resolve.new-client', {
        command: config.command[0],
        languageId: config.languageId,
      });
    }

    return { client, languageId: config.languageId };
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
   * Shut down all cached LSP clients.
   */
  async shutdownAll(): Promise<void> {
    const promises = Array.from(this.clients.values()).map((client) =>
      client.shutdown().catch(() => {
        // Best-effort shutdown
      })
    );
    await Promise.allSettled(promises);
    this.clients.clear();
    logDebugEvent('lsp.registry.shutdown-all', {});
  }

  /**
   * Add or override a server config at runtime.
   */
  register(config: ServerConfig): void {
    this.configs.push(config);
    logDebugEvent('lsp.registry.register', {
      command: config.command[0],
      extensions: config.extensions,
    });
  }

  /**
   * Get all registered server configs (including defaults).
   */
  getConfigs(): ServerConfig[] {
    return [...this.configs];
  }

  /**
   * Get all document URIs that have been opened across all LSP clients.
   * Useful for project-wide diagnostic operations.
   */
  getOpenDocuments(): string[] {
    const docs: string[] = [];
    for (const client of this.clients.values()) {
      const openDocs = (client as unknown as { openDocuments: Set<string> }).openDocuments;
      if (openDocs) {
        for (const uri of openDocs) {
          docs.push(uri);
        }
      }
    }
    return docs;
  }

  /**
   * Extract file extension from a path (lowercase, with dot).
   */
  private getExtension(filePath: string): string | null {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return null;

    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    if (lastDot < lastSlash) return null;

    return filePath.slice(lastDot).toLowerCase();
  }
}

/** Singleton instance for convenience. */
let registryInstance: LspRegistry | null = null;

export function getLspRegistry(configs?: ServerConfig[]): LspRegistry {
  if (!registryInstance) {
    registryInstance = new LspRegistry(configs);
  }
  return registryInstance;
}

export function resetLspRegistry(): void {
  registryInstance = null;
}
