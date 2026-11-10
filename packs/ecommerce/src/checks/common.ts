// Helpers shared by the ecommerce checks.

import { findPhrases, type TurnView } from '@yokla/core';
import { STOCK_PHRASES } from '../lexicon.ts';
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

/**
 * Blanks out stock wording ("stokta yok", "out of stock"), so that its words
 * don't read as an absence statement or an alternative. Positions stay the same.
 */
export function withoutStockWording(folded: string, language: string): string {
  const phrases = STOCK_PHRASES[language];
  if (phrases === undefined) return folded;
  let result = folded;
  for (const match of findPhrases(folded, [...phrases.inStock, ...phrases.outOfStock])) {
    result = `${result.slice(0, match.start)}${' '.repeat(match.end - match.start)}${result.slice(match.end)}`;
  }
  return result;
}

/**
 * Where product names occur in folded text, as whole words. Where names
 * overlap ("Kubbe Çadır" inside "Kubbe Çadır 2 Kişilik"), the longest wins.
 */
export function namedProducts<T extends { readonly name: string | undefined }>(
  folded: string,
  products: readonly T[],
  fold: (text: string) => string,
): { product: T; start: number; end: number }[] {
  const matches = products.flatMap((product) =>
    product.name === undefined
      ? []
      : findPhrases(folded, [`${fold(product.name)}$`]).map((m) => ({
          product,
          start: m.start,
          end: m.end,
        })),
  );
  return matches.filter(
    (match) =>
      !matches.some(
        (other) =>
          other !== match &&
          other.start <= match.start &&
          other.end >= match.end &&
          other.end - other.start > match.end - match.start,
      ),
  );
}
