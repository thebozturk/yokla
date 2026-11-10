// The runner's side of the model proxy's control endpoint (ADR-0012): check
// that the proxy answers, and open and close a recording around a run. It
// talks only to the proxy's own local address.

import { ProxyRecord, z, type FaultPlan } from '@yokla/core';

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
const Armed = z.object({ id: z.string().min(1), turn: z.string().min(1) });

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

  async #call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    payload?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, {
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(payload === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
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

  /**
   * Tells the proxy about a turn: in flight (serial correlation, its calls carry
   * this mark), and the faults to inject into its calls (ADR-0013).
   */
  async turn(
    id: string,
    turn: string,
    arming: { readonly inFlight: boolean; readonly faults?: readonly FaultPlan[] },
  ): Promise<void> {
    await this.#call(
      'PUT',
      `/_yokla/recordings/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn)}`,
      Armed,
      { inFlight: arming.inFlight, faults: arming.faults ?? [] },
    );
  }

  /** The records of an open recording so far, without closing it. */
  async records(id: string): Promise<ProxyRecord[]> {
    const open = await this.#call('GET', `/_yokla/recordings/${encodeURIComponent(id)}`, Closed);
    return open.records;
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
