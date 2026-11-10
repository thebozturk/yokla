// Client-side pacing from the profile's limits (design §11): one token bucket
// per window. Requests wait until every bucket has a token.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export interface Limits {
  readonly burstPerSecond?: number | undefined;
  readonly perMinute?: number | undefined;
  readonly perHour?: number | undefined;
}

interface Bucket {
  readonly capacity: number;
  readonly perMs: number;
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly #buckets: Bucket[];
  readonly #clock: Clock;
  #queue: Promise<void> = Promise.resolve();

  constructor(limits: Limits, clock: Clock = systemClock) {
    this.#clock = clock;
    const now = clock.now();
    const windows: [number | undefined, number][] = [
      [limits.burstPerSecond, 1_000],
      [limits.perMinute, 60_000],
      [limits.perHour, 3_600_000],
    ];
    this.#buckets = windows
      .filter((window): window is [number, number] => window[0] !== undefined)
      .map(([capacity, windowMs]) => ({
        capacity,
        perMs: capacity / windowMs,
        tokens: capacity,
        updatedAt: now,
      }));
  }

  /** Waits for a token in every bucket, then takes it. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.#queue.then(() => this.#take());
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #take(): Promise<void> {
    for (;;) {
      const now = this.#clock.now();
      let waitMs = 0;
      for (const bucket of this.#buckets) {
        bucket.tokens = Math.min(
          bucket.capacity,
          bucket.tokens + (now - bucket.updatedAt) * bucket.perMs,
        );
        bucket.updatedAt = now;
        if (bucket.tokens < 1) waitMs = Math.max(waitMs, (1 - bucket.tokens) / bucket.perMs);
      }
      if (waitMs === 0) {
        for (const bucket of this.#buckets) bucket.tokens -= 1;
        return;
      }
      await this.#clock.sleep(Math.ceil(waitMs));
    }
  }
}
