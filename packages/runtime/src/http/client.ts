// The HTTP adapter (design §11). It only talks to the origins it was given
// (zero egress, ADR-0003), paces requests, waits out 429s as the target asks,
// and reports failures as typed errors instead of throwing raw exceptions.

import type { BuiltRequest } from '@yokla/core';
import { type Clock, RateLimiter, type Limits, systemClock } from './rate-limit.ts';
import { retryAfterMs, type RetryAfterConfig } from './retry-after.ts';

export interface HttpClientOptions {
  /** Origins yokla may contact, e.g. http://127.0.0.1:3000. Everything else is refused. */
  readonly allowedOrigins: readonly string[];
  readonly timeoutMs: number;
  readonly limits?: Limits | undefined;
  readonly retryAfter?: (RetryAfterConfig & { readonly maxWaitMs: number }) | undefined;
  /** How many times a 429 is retried. */
  readonly maxRetries?: number;
  readonly maxResponseBytes?: number;
  readonly clock?: Clock;
}

export interface HttpResult {
  readonly status: number;
  /** Time to the full response of the last attempt, in milliseconds. */
  readonly latencyMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  /** The parsed body, or undefined when the body isn't JSON. */
  readonly json: unknown;
  readonly attempts: number;
  /** Time spent waiting on 429s. */
  readonly waitedMs: number;
}

export type HttpErrorKind = 'refused-host' | 'timeout' | 'network' | 'rate-limited' | 'too-large';

export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly kind: HttpErrorKind;

  constructor(kind: HttpErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const DEFAULT_RETRY: RetryAfterConfig & { maxWaitMs: number } = {
  headers: ['retry-after'],
  unit: 'seconds',
  maxWaitMs: 60_000,
};

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new HttpError('refused-host', `invalid url "${url}"`);
  }
}

export class HttpClient {
  readonly #origins: ReadonlySet<string>;
  readonly #options: HttpClientOptions;
  readonly #clock: Clock;
  readonly #limiter: RateLimiter | undefined;

  constructor(options: HttpClientOptions) {
    this.#options = options;
    this.#origins = new Set(options.allowedOrigins.map(originOf));
    this.#clock = options.clock ?? systemClock;
    this.#limiter =
      options.limits === undefined ? undefined : new RateLimiter(options.limits, this.#clock);
  }

  async send(request: BuiltRequest): Promise<HttpResult> {
    const origin = originOf(request.url);
    if (!this.#origins.has(origin)) {
      throw new HttpError('refused-host', `refusing to contact ${origin}: not a configured target`);
    }
    const retry = this.#options.retryAfter ?? DEFAULT_RETRY;
    const maxRetries = this.#options.maxRetries ?? 5;
    let waitedMs = 0;

    for (let attempt = 1; ; attempt += 1) {
      await this.#limiter?.acquire();
      const result = await this.#attempt(request);
      if (result.status !== 429) return { ...result, attempts: attempt, waitedMs };

      const wait = retryAfterMs(result.headers, retry, Date.now()) ?? 1_000;
      if (attempt > maxRetries) {
        throw new HttpError('rate-limited', `still rate limited after ${String(attempt)} attempts`);
      }
      if (wait > retry.maxWaitMs) {
        throw new HttpError(
          'rate-limited',
          `the target asks to wait ${String(wait)} ms, more than maxWaitMs (${String(retry.maxWaitMs)} ms)`,
        );
      }
      await this.#clock.sleep(wait);
      waitedMs += wait;
    }
  }

  async #attempt(request: BuiltRequest): Promise<Omit<HttpResult, 'attempts' | 'waitedMs'>> {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new HttpError('timeout', `no response within ${String(this.#options.timeoutMs)} ms`);
      }
      throw new HttpError('network', error instanceof Error ? error.message : String(error));
    }

    const limit = this.#options.maxResponseBytes ?? 10 * 1024 * 1024;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit)
      throw new HttpError('too-large', `response of ${String(declared)} bytes exceeds the limit`);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new HttpError(
          'timeout',
          `response body not complete within ${String(this.#options.timeoutMs)} ms`,
        );
      }
      throw new HttpError('network', error instanceof Error ? error.message : String(error));
    }
    if (Buffer.byteLength(text) > limit)
      throw new HttpError('too-large', 'response exceeds the size limit');
    const latencyMs = performance.now() - started;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, latencyMs, headers, text, json };
  }
}
