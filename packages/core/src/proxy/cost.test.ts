import { describe, expect, it } from 'vitest';
import type { ProxyUsage } from '../schema/proxy.ts';
import { callCost } from './cost.ts';

const usage = (change: Partial<ProxyUsage> = {}): ProxyUsage => ({
  input: 1_000_000,
  output: 500_000,
  cachedInput: null,
  cacheWrite: null,
  reasoning: null,
  ...change,
});

describe('callCost', () => {
  it('prices input and output per million tokens', () => {
    expect(callCost(usage(), { input: 0.3, output: 2.5 })).toBeCloseTo(0.3 + 1.25, 12);
    expect(callCost(usage({ input: 1200, output: 300 }), { input: 1, output: 4 })).toBeCloseTo(
      0.0024,
      12,
    );
  });

  it('prices cached and cache-write tokens apart from the rest of the input', () => {
    const cached = usage({
      input: 1_000_000,
      cachedInput: 800_000,
      cacheWrite: 100_000,
      output: 0,
    });
    expect(
      callCost(cached, { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }),
    ).toBeCloseTo(0.1 * 3 + 0.8 * 0.3 + 0.1 * 3.75, 12);
  });

  it('falls back to the input price for cache tokens, so cost is never understated', () => {
    const cached = usage({ input: 1_000_000, cachedInput: 500_000, output: 0 });
    expect(callCost(cached, { input: 2, output: 8 })).toBeCloseTo(2, 12);
  });

  it('has no cost without a price or with unmeasured input or output', () => {
    expect(callCost(usage(), undefined)).toBeNull();
    expect(callCost(usage({ input: null }), { input: 1, output: 1 })).toBeNull();
    expect(callCost(usage({ output: null }), { input: 1, output: 1 })).toBeNull();
    expect(callCost(usage({ input: 0, output: 0 }), { input: 1, output: 1 })).toBe(0);
  });
});
