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

/**
 * The products the model saw in the results of a mapped tool, completed from
 * the catalog, with that tool (ADR-0026). Kept apart from the returned ones.
 */
export function seenProductsOf(
  turn: TurnView,
  data: EcommerceData,
): { readonly product: Product; readonly tool: string }[] {
  return (turn.seen[PRODUCTS] ?? []).map(({ tool, item }) => ({
    product: productOf(item, data.catalog),
    tool,
  }));
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

/** The shortest start of a name, two words or more, that no other name shares (ADR-0027). */
function uniqueStart(
  own: readonly string[],
  others: readonly (readonly string[])[],
): string | undefined {
  for (let length = 2; length < own.length; length += 1) {
    const start = own.slice(0, length).join(' ');
    if (!others.some((other) => other.slice(0, length).join(' ') === start)) return start;
  }
  return undefined;
}

/**
 * Where products are named in folded text, as whole words: by their full name,
 * or by the shortest start of it, two words or more, that no other of these
 * products shares (ADR-0027). Where mentions overlap ("Kubbe Çadır" inside
 * "Kubbe Çadır 2 Kişilik"), the longest wins.
 */
export function namedProducts<T extends { readonly name: string | undefined }>(
  folded: string,
  products: readonly T[],
  fold: (text: string) => string,
): { product: T; start: number; end: number }[] {
  const names = products.map((product) =>
    product.name === undefined ? undefined : fold(product.name),
  );
  const words = names.map((name) => name?.split(/\s+/u).filter((word) => word !== '') ?? []);
  const matches = products.flatMap((product, index) => {
    const name = names[index];
    if (name === undefined) return [];
    // Another product with the same name doesn't make its start shared.
    const others = words.filter((_other, at) => names[at] !== undefined && names[at] !== name);
    const start = uniqueStart(words[index] ?? [], others);
    return findPhrases(folded, [`${name}$`, ...(start === undefined ? [] : [`${start}$`])]).map(
      (m) => ({ product, start: m.start, end: m.end }),
    );
  });
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
