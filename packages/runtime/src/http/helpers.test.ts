import { describe, expect, it } from 'vitest';
import { RateLimiter, type Clock } from './rate-limit.ts';
import { retryAfterMs } from './retry-after.ts';
import { TEST_NET_SIZE, testNetAddress } from './test-net.ts';

function fakeClock(): Clock & { readonly sleeps: number[]; elapsed(): number } {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: (ms) => {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
    elapsed: () => time,
  };
}

describe('RateLimiter', () => {
  it('lets a burst through, then paces', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ burstPerSecond: 3 }, clock);
    for (let i = 0; i < 3; i += 1) await limiter.acquire();
    expect(clock.elapsed()).toBe(0);
    await limiter.acquire();
    expect(clock.sleeps).toEqual([334]);
  });

  it('honours the tightest window', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ burstPerSecond: 100, perMinute: 2 }, clock);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.elapsed()).toBe(30_000);
  });

  it('serves concurrent callers one after another', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ burstPerSecond: 1 }, clock);
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(clock.elapsed()).toBe(2_000);
  });

  it('does nothing without limits', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({}, clock);
    for (let i = 0; i < 50; i += 1) await limiter.acquire();
    expect(clock.elapsed()).toBe(0);
  });
});

describe('retryAfterMs', () => {
  const standard = { headers: ['retry-after'], unit: 'seconds' } as const;

  it('reads seconds from Retry-After', () => {
    expect(retryAfterMs({ 'retry-after': '2' }, standard, 0)).toBe(2_000);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-11-10T10:00:00Z');
    expect(retryAfterMs({ 'retry-after': 'Tue, 10 Nov 2026 10:00:05 GMT' }, standard, now)).toBe(
      5_000,
    );
  });

  it('takes the longest of several tiered headers, in milliseconds', () => {
    const tiered = { headers: ['retry-after-*'], unit: 'milliseconds' } as const;
    const headers = {
      'retry-after-burst': '300',
      'retry-after-minute': '20000',
      'x-other': '99999',
    };
    expect(retryAfterMs(headers, tiered, 0)).toBe(20_000);
  });

  it('matches header names without regard to case', () => {
    expect(
      retryAfterMs({ 'retry-after': '1' }, { headers: ['Retry-After'], unit: 'seconds' }, 0),
    ).toBe(1_000);
  });

  it('returns undefined when no named header is usable', () => {
    expect(retryAfterMs({ 'x-ratelimit-reset': '5' }, standard, 0)).toBeUndefined();
    expect(retryAfterMs({ 'retry-after': 'soon' }, standard, 0)).toBeUndefined();
  });
});

describe('testNetAddress', () => {
  it('gives distinct documentation addresses and wraps around', () => {
    const addresses = Array.from({ length: TEST_NET_SIZE }, (_unused, index) =>
      testNetAddress(index),
    );
    expect(new Set(addresses).size).toBe(TEST_NET_SIZE);
    expect(
      addresses.every((a) => /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.(?:\d{1,3})$/u.test(a)),
    ).toBe(true);
    expect(testNetAddress(0)).toBe('192.0.2.1');
    expect(testNetAddress(254)).toBe('198.51.100.1');
    expect(testNetAddress(TEST_NET_SIZE)).toBe('192.0.2.1');
    expect(testNetAddress(-1)).toBe('203.0.113.254');
  });
});
