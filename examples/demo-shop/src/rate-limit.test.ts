import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.ts';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('allows a burst, then asks the client to retry', () => {
    const time = clock();
    const limiter = new RateLimiter({ burstPerSecond: 3, perMinute: 120 }, time.now);
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    time.advance(334);
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('enforces the per-minute budget', () => {
    const time = clock();
    const limiter = new RateLimiter({ burstPerSecond: 100, perMinute: 5 }, time.now);
    for (let i = 0; i < 5; i += 1) expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 12 });
    time.advance(12_001);
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('keeps clients separate', () => {
    const limiter = new RateLimiter({ burstPerSecond: 1, perMinute: 60 }, clock().now);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });
});
