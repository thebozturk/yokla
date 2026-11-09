export interface RateLimitOptions {
  readonly burstPerSecond: number;
  readonly perMinute: number;
}

export type RateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Two token buckets per client: a per-second burst and a per-minute budget. */
export class RateLimiter {
  readonly #limits: readonly { readonly capacity: number; readonly perMs: number }[];
  readonly #now: () => number;
  readonly #clients = new Map<string, Bucket[]>();

  constructor(options: RateLimitOptions, now: () => number = Date.now) {
    this.#limits = [
      { capacity: options.burstPerSecond, perMs: options.burstPerSecond / 1_000 },
      { capacity: options.perMinute, perMs: options.perMinute / 60_000 },
    ];
    this.#now = now;
  }

  take(client: string): RateDecision {
    const now = this.#now();
    const buckets =
      this.#clients.get(client) ??
      this.#limits.map((limit) => ({ tokens: limit.capacity, updatedAt: now }));
    this.#clients.set(client, buckets);

    let waitMs = 0;
    this.#limits.forEach((limit, index) => {
      const bucket = buckets[index];
      if (bucket === undefined) return;
      bucket.tokens = Math.min(
        limit.capacity,
        bucket.tokens + (now - bucket.updatedAt) * limit.perMs,
      );
      bucket.updatedAt = now;
      if (bucket.tokens < 1) waitMs = Math.max(waitMs, (1 - bucket.tokens) / limit.perMs);
    });
    if (waitMs > 0)
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)) };

    for (const bucket of buckets) bucket.tokens -= 1;
    return { allowed: true };
  }
}
