// The runner's side of the model proxy's control endpoint (ADR-0012): check
// that the proxy answers, and open and close a recording around a run. It
// talks only to the proxy's own local address.

import { ProxyRecord, z } from '@yokla/core';

export class ProxyControlError extends Error {
  override readonly name = 'ProxyControlError';
}

const Health = z.object({
  ok: z.literal(true),
  upstreams: z.array(z.string()),
  recording: z.string().nullable(),
});
const Opened = z.object({ id: z.string().min(1), startedAt: z.iso.datetime() });
const Closed = z.object({ id: z.string().min(1), records: z.array(ProxyRecord) });
const Marked = z.object({ id: z.string().min(1), mark: z.string().min(1) });

export class ProxyControl {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 5_000) {
    const url = new URL(baseUrl);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new ProxyControlError(`the model proxy must be local, not ${url.host}`);
    }
    this.#base = url.origin;
    this.#timeoutMs = timeoutMs;
  }

  async #call<T>(method: string, path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, {
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProxyControlError(`the model proxy at ${this.#base} doesn't answer: ${reason}`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message: unknown =
        typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
      throw new ProxyControlError(
        `the model proxy answered ${String(response.status)}${typeof message === 'string' ? `: ${message}` : ''}`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProxyControlError('the model proxy sent an unexpected answer');
    return parsed.data;
  }

  health(): Promise<z.output<typeof Health>> {
    return this.#call('GET', '/_yokla/health', Health);
  }

  open(): Promise<z.output<typeof Opened>> {
    return this.#call('POST', '/_yokla/recordings', Opened);
  }

  /** Tells the proxy which turn is in flight; its calls carry this mark. */
  async mark(id: string, turn: string): Promise<void> {
    await this.#call(
      'PUT',
      `/_yokla/recordings/${encodeURIComponent(id)}/mark?turn=${encodeURIComponent(turn)}`,
      Marked,
    );
  }

  async close(id: string): Promise<ProxyRecord[]> {
    const closed = await this.#call(
      'DELETE',
      `/_yokla/recordings/${encodeURIComponent(id)}`,
      Closed,
    );
    return closed.records;
  }
}
