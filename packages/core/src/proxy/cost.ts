// The cost of one provider call (ADR-0012), from its usage and the price the
// config gives its model. Without a price, or with input or output tokens
// unmeasured, the cost is null: an unmeasured call never costs 0.

import type { Price } from '../schema/config.ts';
import type { ProxyUsage } from '../schema/proxy.ts';

export function callCost(usage: ProxyUsage, price: Price | undefined): number | null {
  if (price === undefined || usage.input === null || usage.output === null) return null;
  const cached = usage.cachedInput ?? 0;
  const written = usage.cacheWrite ?? 0;
  const plain = Math.max(0, usage.input - cached - written);
  const microUsd =
    plain * price.input +
    cached * (price.cachedInput ?? price.input) +
    written * (price.cacheWrite ?? price.input) +
    usage.output * price.output;
  return microUsd / 1_000_000;
}
