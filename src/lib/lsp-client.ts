// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * LSP Client — JSON-RPC 2.0 over stdio with Content-Length framing.
 * Foundation for Wave S6 (IDE Integration): hover, references, diagnostics.
 */

import { logDebugEvent } from './debug-logger';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface HoverResult {
  contents: string;
  range?: LspRange;
}

export type ReferenceResult = Array<{
  uri: string;
  range: LspRange;
}>;

export interface Diagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: Timer;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ────────────────────────────────────────────────────────────────
// LspClient
// ────────────────────────────────────────────────────────────────

export class LspClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private diagnosticsCache = new Map<string, Diagnostic[]>();
  private buffer = '';
  private readLoopRunning = false;
  private shutdownRequested = false;
  private _initPromise: Promise<unknown> | null = null;
  private openDocuments = new Set<string>();

  /** Spawn the LSP server process. */
  spawn(serverCommand: string[], opts?: { env?: Record<string, string> }): void {
    if (this.proc) {
      logDebugEvent('lsp.spawn.skip', { reason: 'already-spawned' });
      return;
    }

    try {
      this.proc = Bun.spawn(serverCommand, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: opts?.env,
      });

      this.readLoopRunning = false;
      this.shutdownRequested = false;
      logDebugEvent('lsp.spawn.ok', { command: serverCommand[0], pid: this.proc.pid });

      // Begin async LSP handshake (initialize + initialized) — non-blocking
      this._startInit();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebugEvent('lsp.spawn.error', { command: serverCommand[0], error: msg });
      this.proc = null;
    }
  }

  /**
   * Start the LSP handshake asynchronously (initialize + initialized notification).
   * Idempotent — only the first call initiates the handshake.
   */
  private _startInit(rootUri = ''): Promise<unknown> {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await this.initialize(rootUri, 30000);
      this.initialized();
    })();
    return this._initPromise;
  }

  /** Await this before sending requests to guarantee the LSP handshake is done. */
  private async _ensureInitialized(): Promise<void> {
    if (this._initPromise) await this._initPromise;
  }

  /**
   * Send initialize request. Must be called after spawn.
   * Returns the server capabilities.
   */
  async initialize(rootUri: string, timeout = 30000): Promise<unknown> {
    if (!this.proc) {
      logDebugEvent('lsp.initialize.skip', { reason: 'no-process' });
      return {};
    }

    this.startReadLoop();

    const params = {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          references: {},
          documentSymbol: {},
          publishDiagnostics: {},
        },
      },
    };

    try {
      const result = await this.request<unknown>('initialize', params, timeout);
      logDebugEvent('lsp.initialize.ok', { rootUri });
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebugEvent('lsp.initialize.error', { rootUri, error: msg });
      return {};
    }
  }

  /** Send initialized notification (must follow initialize). */
  initialized(): void {
    this.notify('initialized', {});
    logDebugEvent('lsp.initialized', {});
  }

  /** Send textDocument/didOpen notification. */
  async openDocument(uri: string, text: string, languageId: string): Promise<void> {
    // Ensure LSP handshake is complete before sending didOpen
    await this._ensureInitialized();
    this.openDocuments.add(uri);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
    logDebugEvent('lsp.didOpen', { uri, languageId });
  }

  // ── LSP API Methods ────────────────────────────────────────

  /**
   * Request hover information at a position.
   * Returns empty result on timeout/error.
   */
  async hover(
    uri: string,
    line: number,
    character: number,
    timeout = 10000
  ): Promise<HoverResult | null> {
    if (!this.proc) return null;
    await this._ensureInitialized();

    try {
      const result = await this.request<{ contents: unknown; range?: LspRange }>(
        'textDocument/hover',
        { textDocument: { uri }, position: { line, character } },
        timeout
      );

      if (!result) return null;

      let contents = '';
      if (typeof result.contents === 'string') {
        contents = result.contents;
      } else if (
        result.contents &&
        typeof result.contents === 'object' &&
        'value' in (result.contents as Record<string, unknown>)
      ) {
        contents = String((result.contents as Record<string, unknown>).value);
      } else if (result.contents) {
        contents = String(result.contents);
      }

      return { contents, range: result.range };
    } catch {
      return null;
    }
  }

  /**
   * Request references at a position.
   * Returns empty array on timeout/error.
   */
  async references(
    uri: string,
    line: number,
    character: number,
    timeout = 10000
  ): Promise<ReferenceResult> {
    if (!this.proc) return [];
    await this._ensureInitialized();

    try {
      const result = await this.request<Array<{ uri: string; range: LspRange }>>(
        'textDocument/references',
        {
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: true },
        },
        timeout
      );
      return result ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Get diagnostics for a URI from the cache (populated by publishDiagnostics).
   */
  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnosticsCache.get(uri) ?? [];
  }

  /**
   * Request document symbols.
   * Returns empty array on timeout/error.
   */
  async documentSymbol(uri: string, timeout = 10000): Promise<unknown[]> {
    if (!this.proc) return [];
    await this._ensureInitialized();

    try {
      const result = await this.request<unknown[]>(
        'textDocument/documentSymbol',
        { textDocument: { uri } },
        timeout
      );
      return result ?? [];
    } catch {
      return [];
    }
  }

  // ── Shutdown ───────────────────────────────────────────────

  /** Graceful shutdown: shutdown request → exit notification → kill process. */
  async shutdown(): Promise<void> {
    if (!this.proc) return;

    this.shutdownRequested = true;

    try {
      await this.request<null>('shutdown', null, 5000);
    } catch {
      // Shutdown may fail, continue with exit
    }

    this.notify('exit', null);

    try {
      this.proc.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }

    this.pending.clear();
    this.proc = null;
    this._initPromise = null;
    logDebugEvent('lsp.shutdown', {});
  }

  /** Check if the client has an active process. */
  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  // ── JSON-RPC Communication ─────────────────────────────────

  /**
   * Send a JSON-RPC 2.0 request and wait for the matching response.
   */
  private request<T>(method: string, params: unknown, timeout: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error('LSP server not running'));
        return;
      }

      const id = this.nextId++;
      const message: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Kill stale process on timeout
        this.killProcess();
        reject(new Error(`Request timeout: ${method} (id=${id})`));
      }, timeout);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

      try {
        this.sendMessage(message);
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to send request: ${msg}`));
      }
    });
  }

  /**
   * Send a JSON-RPC 2.0 notification (no response expected).
   */
  private notify(method: string, params: unknown): void {
    if (!this.proc || this.proc.killed) return;

    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };

    try {
      this.sendMessage(message);
    } catch {
      // Notifications are fire-and-forget
    }
  }

  /**
   * Write a JSON-RPC message to stdin with Content-Length framing.
   */
  private sendMessage(message: JsonRpcMessage): void {
    if (!this.proc?.stdin) return;

    const json = JSON.stringify(message);
    const content = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
    this.proc.stdin.write(content);
  }

  // ── Read Loop ──────────────────────────────────────────────

  /**
   * Start the stdout read loop. Idempotent — only starts once.
   */
  private startReadLoop(): void {
    if (this.readLoopRunning) return;
    if (!this.proc?.stdout) return;

    this.readLoopRunning = true;
    this.readLoop().catch((err: unknown) => {
      logDebugEvent('lsp.readloop.error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Continuously read stdout and parse Content-Length-delimited JSON messages.
   */
  private async readLoop(): Promise<void> {
    if (!this.proc?.stdout) return;

    const reader = this.proc.stdout.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += new TextDecoder().decode(value);

        // Parse all complete messages in the buffer
        this.parseBuffer();
      }
    } catch (err: unknown) {
      if (!this.shutdownRequested) {
        logDebugEvent('lsp.readloop.exception', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse complete JSON-RPC messages from the buffer.
   * Messages are framed by Content-Length headers.
   */
  private parseBuffer(): void {
    while (this.buffer.length > 0) {
      // Find Content-Length header
      const headerMatch = this.buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch || headerMatch.index === undefined) {
        // No complete header yet — wait for more data
        // Skip any non-header bytes at the start
        const nextHeader = this.buffer.search(/Content-Length:/);
        if (nextHeader > 0) {
          this.buffer = this.buffer.slice(nextHeader);
          continue;
        }
        break;
      }

      const contentLength = parseInt(headerMatch[1], 10);
      const headerEnd = headerMatch.index + headerMatch[0].length;

      // Check if we have the full content
      if (this.buffer.length < headerEnd + contentLength) {
        // Not enough data yet — wait for more
        break;
      }

      const content = this.buffer.slice(headerEnd, headerEnd + contentLength);
      this.buffer = this.buffer.slice(headerEnd + contentLength);

      try {
        const message: JsonRpcMessage = JSON.parse(content);
        this.dispatchMessage(message);
      } catch {
        logDebugEvent('lsp.parse.error', { content: content.slice(0, 200) });
        // Continue — skip malformed messages
      }
    }
  }

  /**
   * Dispatch a parsed JSON-RPC message to the appropriate handler.
   */
  private dispatchMessage(message: JsonRpcMessage): void {
    // Handle responses (result or error with matching id)
    if (message.id !== undefined && message.id !== null) {
      if ('result' in message || 'error' in message) {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);

          if (message.error) {
            pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }
    }

    // Handle server-initiated requests
    if (message.method && message.id !== undefined && message.id !== null) {
      logDebugEvent('lsp.server-request', { method: message.method });
      if (this.proc) {
        const errorResponse: JsonRpcMessage = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
        try {
          this.sendMessage(errorResponse);
        } catch {
          // Best effort
        }
      }
      return;
    }

    // Handle notifications
    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  /**
   * Handle incoming notifications from the server.
   */
  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        const p = params as {
          uri: string;
          diagnostics: Array<{
            range: LspRange;
            severity?: 1 | 2 | 3 | 4;
            message: string;
            source?: string;
          }>;
        };
        if (p?.uri) {
          this.diagnosticsCache.set(
            p.uri,
            (p.diagnostics ?? []).map((d) => ({
              range: d.range,
              severity: d.severity ?? 1,
              message: d.message,
              source: d.source,
            }))
          );
        }
        break;
      }
      case 'window/logMessage': {
        const p = params as { type: number; message: string };
        logDebugEvent('lsp.logMessage', { type: p?.type, message: p?.message });
        break;
      }
      case 'window/showMessage': {
        const p = params as { type: number; message: string };
        logDebugEvent('lsp.showMessage', { type: p?.type, message: p?.message });
        break;
      }
      default:
        // Unknown notification — silently ignore
        break;
    }
  }

  /**
   * Kill the server process and clean up all pending requests.
   */
  private killProcess(): void {
    if (!this.proc) return;

    try {
      this.proc.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }

    // Reject all pending requests
    for (const [_id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('LSP server terminated'));
    }
    this.pending.clear();
    this.proc = null;
    this._initPromise = null;
    logDebugEvent('lsp.kill', {});
  }
}
