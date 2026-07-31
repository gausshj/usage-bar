// ============================================================================
// src/quota/providers/codex-app-server.ts
// Minimal JSON-RPC client for the local Codex App Server.
//
// The App Server speaks newline-delimited JSON (JSONL) over stdio when launched
// with `codex app-server --listen stdio://`. It owns the local Codex OAuth
// credentials (in CODEX_HOME), so this client never touches access tokens —
// it only drives the protocol. This is the "official_protocol" data source.
//
// Lifecycle: spawn → initialize handshake → call methods → keep process alive
// for the session (we re-spawn per refresh to keep things stateless and simple
// for v1; a persistent client is a later optimization).
// ============================================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';

import { redact } from '../http.js';

/** A response or notification received from the server. */
interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface AppServerConfig {
  /** Path to the codex binary. Defaults to resolving from PATH / known locations. */
  binaryPath?: string;
  /** CODEX_HOME override. Defaults to ~/.codex. */
  codexHome?: string;
  /** Per-request timeout in ms (default 8000). */
  requestTimeoutMs?: number;
  /** Handshake/initialize timeout in ms (default 5000). */
  initTimeoutMs?: number;
}

/**
 * A short-lived JSON-RPC client that spawns the App Server, performs the
 * mandatory initialize handshake, and issues a sequence of method calls.
 * The process is terminated when done() is called.
 *
 * Design: deliberately stateless across refreshes (spawn → query → kill) so we
 * never hold a zombie process or stale auth state. The handshake cost (~0.5s)
 * is acceptable for a manual/on-interval dashboard refresh.
 */
export class CodexAppServerClient {
  private readonly binaryPath: string;
  private readonly codexHome: string;
  private readonly requestTimeoutMs: number;
  private readonly initTimeoutMs: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 0;
  private initialized = false;
  /** The initialize result, carrying userAgent/version (issue #14). */
  private serverInfo: { userAgent?: string } | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(config: AppServerConfig = {}) {
    this.binaryPath = config.binaryPath ?? resolveCodexBinary();
    this.codexHome = config.codexHome ?? `${homedir()}/.codex`;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 8000;
    this.initTimeoutMs = config.initTimeoutMs ?? 5000;
  }

  /** Spawn the server and complete the initialize handshake. */
  async connect(): Promise<void> {
    if (this.proc) return;
    if (!this.binaryPath) {
      throw new Error('codex binary not found');
    }

    this.proc = spawn(
      this.binaryPath,
      ['app-server', '--listen', 'stdio://'],
      {
        // Security (issue #14): do NOT inherit the full process.env — it may
        // contain GLM/Kimi tokens. Only pass what the App Server needs.
        env: buildSandboxEnv(this.codexHome),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.on('error', (err) => this.failAll(err));

    // Perform the mandatory initialize request, and retain the server's
    // reported userAgent for capability detection / source.version (#14).
    this.serverInfo = (await this.request(
      'initialize',
      {
        clientInfo: { name: 'usage-bar', title: 'Usage Bar', version: '0.1.0' },
      },
      this.initTimeoutMs,
    )) as { userAgent?: string } | null;
    // Then the initialized notification (no id, no response expected).
    this.notify('initialized');
    this.initialized = true;
  }

  /** The server's userAgent from the initialize handshake (e.g. "codex 0.x.y"). */
  getServerInfo(): { userAgent?: string } | null {
    return this.serverInfo;
  }

  /** Send a method call and await its result. */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.initialized) {
      throw new Error('CodexAppServerClient not initialized; call connect() first');
    }
    return (await this.request(method, params, this.requestTimeoutMs)) as T;
  }

  /** Terminate the server process. Safe to call multiple times. */
  done(): void {
    this.initialized = false;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.failAll(new Error('client closed'));
  }

  // -----------------------------------------------------------------
  // Private: transport plumbing
  // -----------------------------------------------------------------

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        },
      });

      const msg = params !== undefined ? { method, id, params } : { method, id };
      this.write(msg);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write(params !== undefined ? { method, params } : { method });
  }

  private write(msg: unknown): void {
    if (!this.proc?.stdin.writable) {
      this.failAll(new Error('codex app-server stdin not writable'));
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // ignore malformed lines
    }

    // A response to one of our requests.
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const handler = this.pending.get(msg.id)!;
      if (msg.error) {
        // Redact anything token-like from the server's error text (issue #14).
        const safeMsg = redact(String(msg.error.message));
        handler.reject(new Error(`codex app-server error ${msg.error.code}: ${safeMsg}`));
      } else {
        handler.resolve(msg.result);
      }
      return;
    }
    // Otherwise it's a notification (method present, no id) — we ignore these
    // in the stateless client. (A persistent client would merge them.)
  }

  private failAll(err: Error): void {
    for (const [, handler] of this.pending) handler.reject(err);
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Binary resolution & process sandboxing
// ---------------------------------------------------------------------------

/**
 * Build a minimal environment for the spawned App Server process — WITHOUT
 * inheriting the full process.env (which may carry GLM/Kimi tokens, issue #14).
 * We pass through only what the binary needs to run and locate its home/config.
 */
function buildSandboxEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    CODEX_HOME: codexHome,
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
  if (process.env.USER) env.USER = process.env.USER;
  return env;
}

/**
 * Locate the codex binary. Checks PATH first, then the known macOS app bundle
 * locations for the ChatGPT desktop app and the VS Code extension.
 */
function resolveCodexBinary(): string {
  // The caller may set CODEX_BINARY_PATH to pin a specific binary.
  if (process.env.CODEX_BINARY_PATH) return process.env.CODEX_BINARY_PATH;
  // Known app-bundle paths (checked without spawning `which`).
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    `${homedir()}/.vscode/extensions/openai.chatgpt-26.721.41059-darwin-arm64/bin/macos-aarch64/codex`,
  ];
  for (const c of candidates) {
    // We can't synchronously stat here without fs; the spawn will fail loudly
    // if missing, and the adapter maps that to `unavailable`.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').accessSync(c);
      return c;
    } catch {
      continue;
    }
  }
  // Fall back to relying on PATH resolution at spawn time.
  return 'codex';
}
