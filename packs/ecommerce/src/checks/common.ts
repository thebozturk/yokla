// Helpers shared by the ecommerce checks.

import type { TurnView } from '@yokla/core';
import { productOf, type EcommerceData, type Product } from '../data.ts';

/** The evidence collection the ecommerce checks read. */
export const PRODUCTS = 'products';

/** The products of a turn's response, completed from the catalog. */
export function productsOf(turn: TurnView, data: EcommerceData): Product[] | undefined {
  return turn.response.evidence[PRODUCTS]?.map((item) => productOf(item, data.catalog));
}

/** Splits an answer into lines and sentences; decimal points inside numbers stay. */
export function segments(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+(?=\S)/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export function notApplicable(reason: string): { applicable: false; reason: string } {
  return { applicable: false, reason };
}

/**
 * Every value a number the user wrote could mean, whatever its separators:
 * "1.000" may be 1000 or 1. Generous on purpose: these are the user's own
 * amounts, which an answer may repeat.
 */
export function userNumbers(text: string): number[] {
  const values = new Set<number>();
  for (const [raw] of text.matchAll(/\d+(?:[.,]\d+)*/gu)) {
    const candidates = [
      raw.replaceAll('.', '').replace(',', '.'),
      raw.replaceAll(',', ''),
      raw.replaceAll(',', '.'),
      raw,
    ];
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value)) values.add(value);
    }
  }
  return [...values];
}
