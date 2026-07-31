import { describe, expect, it } from 'vitest';

import { CodexAppServerClient } from '../../src/quota/providers/codex-app-server.js';

/**
 * The App Server client spawns a child process and speaks JSONL over stdio.
 * We can't easily mock spawn here without injecting, so these tests focus on
 * the message-routing/dispatch logic via the private onData path using a
 * minimal fake. The real end-to-end (live App Server) is covered by a manual
 * smoke check.
 *
 * To keep this unit-testable, we drive a client whose process is faked by
 * intercepting write and feeding responses through the public surface. Since
 * connect() spawns a real process, we instead test the pure helpers exposed
 * indirectly: message parsing, id routing, timeout.
 */

describe('CodexAppServerClient (message routing)', () => {
  it('dispatches a response line to the matching pending request', async () => {
    const client = new CodexAppServerClient({ binaryPath: '/nonexistent' });
    const internal = client as unknown as {
      onData: (chunk: string) => void;
      pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
      nextId: number;
    };

    // Manually register a pending handler (bypassing request(), which would
    // try to write to a non-existent process). This isolates the dispatch logic.
    const id = internal.nextId++;
    const pending = new Promise<unknown>((resolve, reject) => {
      internal.pending.set(id, { resolve, reject });
    });

    // Feed a simulated server response for that id.
    internal.onData(`${JSON.stringify({ id, result: { rateLimits: { planType: 'pro' } } })}\n`);

    const result = (await pending) as { rateLimits: { planType: string } };
    expect(result.rateLimits.planType).toBe('pro');

    client.done();
  });

  it('dispatches an error response as a rejection', async () => {
    const client = new CodexAppServerClient({ binaryPath: '/nonexistent' });
    const internal = client as unknown as {
      onData: (chunk: string) => void;
      pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
      nextId: number;
    };

    const id = internal.nextId++;
    const pending = new Promise<unknown>((resolve, reject) => {
      internal.pending.set(id, { resolve, reject });
    });

    internal.onData(`${JSON.stringify({ id, error: { code: -32601, message: 'method not found' } })}\n`);

    await expect(pending).rejects.toThrow(/method not found/);
    client.done();
  });

  it('rejects immediately when the process stdin is not writable (no spawn)', async () => {
    // Without connect(), there's no process, so write() fails fast — the
    // request rejects rather than hanging. This is the correct safety behavior.
    const client = new CodexAppServerClient({ binaryPath: '/nonexistent' });
    const internal = client as unknown as {
      request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
    };

    await expect(internal.request('account/usage/read', undefined, 1000)).rejects.toThrow(
      /stdin not writable|closed/,
    );
    client.done();
  });

  it('ignores malformed JSON lines without crashing', () => {
    const client = new CodexAppServerClient({ binaryPath: '/nonexistent' });
    const internal = client as unknown as { onData: (chunk: string) => void };

    // These should not throw.
    expect(() => internal.onData('not json\n')).not.toThrow();
    expect(() => internal.onData('{ incomplete\n')).not.toThrow();
    expect(() => internal.onData('\n\n')).not.toThrow();
    client.done();
  });
});
