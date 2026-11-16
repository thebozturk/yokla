// The turns the ecommerce pack offers yokla explore (ADR-0044), built from the
// target's own catalog and profile in the pack's own phrasings, one set per
// language. They name nothing of a particular target (P9).
//
// - Opening a conversation (ADR-0046): for each of a few types spread over
//   the catalog's type tree, a product of the type by its name, the type, the
//   type under its median price, and the type under its lowest price, where
//   nothing can match; then each policy the profile declares. A turn that
//   asks for a type or a price bound states it as its expectation, from the
//   same catalog data its words came from (ADR-0004).
// - After an answer that showed products: adding the first of them to the
//   cart (then the next, while the conversation only adds to the cart), and
//   asking for a cheaper one.

import type { EvidenceItem, ExploredTurn, Intents, IntentTurn } from '@yokla/core';
import { PRODUCTS } from './checks/common.ts';
import type { CatalogRow, EcommerceData } from './data.ts';

interface Phrasings {
  product(name: string): string;
  type(type: string): string;
  underPrice(type: string, amount: string): string;
  policy(topic: string): string;
  cart(name: string): string;
  readonly cheaper: string;
  /** The words for the policy topics the pack knows; another topic goes by its key. */
  readonly topics: Readonly<Record<string, string>>;
}

export const PHRASINGS: Readonly<Record<string, Phrasings>> = {
  tr: {
    product: (name) => `${name} var mı?`,
    type: (type) => `${type} var mı?`,
    underPrice: (type, amount) => `${amount} altında ${type} var mı?`,
    policy: (topic) => `${topic} koşullarınız neler?`,
    cart: (name) => `${name} ürününü sepete ekler misin?`,
    cheaper: 'Daha ucuz bir seçenek var mı?',
    topics: { returns: 'İade', shipping: 'Kargo', warranty: 'Garanti' },
  },
  en: {
    product: (name) => `Do you have the ${name}?`,
    type: (type) => `Do you have any ${type}?`,
    underPrice: (type, amount) => `Do you have any ${type} under ${amount}?`,
    policy: (topic) => `What are your ${topic} terms?`,
    cart: (name) => `Please add the ${name} to my cart.`,
    cheaper: 'Do you have anything cheaper?',
    topics: { returns: 'return', shipping: 'shipping', warranty: 'warranty' },
  },
};

function nameIn(row: CatalogRow, language: string): string | undefined {
  return row.names?.[language] ?? row.names?.['*'];
}

/** A type as words: its last level, with dashes and underscores as spaces. */
function typeWords(type: string, separator: string | undefined): string {
  const last = separator === undefined ? type : (type.split(separator).at(-1) ?? type);
  return last.replaceAll(/[-_]+/gu, ' ').trim();
}

/** The prices of a type's products, lowest first. */
function pricesOf(rows: readonly CatalogRow[]): number[] {
  return rows
    .flatMap((row) => (row.price === undefined ? [] : [row.price]))
    .toSorted((a, b) => a - b);
}

/** The middle price of a type's products, rounded up to a whole amount. */
function medianPrice(prices: readonly number[]): number | undefined {
  const middle = prices[Math.floor((prices.length - 1) / 2)];
  return middle === undefined ? undefined : Math.ceil(middle);
}

/**
 * The largest whole amount below a type's lowest price: a bound no product of
 * the type meets, since a bound is inclusive. Undefined below 1.
 */
function emptyBand(prices: readonly number[]): number | undefined {
  const lowest = prices[0];
  if (lowest === undefined) return undefined;
  const bound = Math.ceil(lowest) - 1;
  return bound >= 1 ? bound : undefined;
}

/** How many leading levels every type shares, leaving each at least one level of its own. */
function sharedLevels(levels: readonly (readonly string[])[]): number {
  const [head] = levels;
  if (head === undefined) return 0;
  for (let shared = 0; ; shared += 1) {
    const at = head[shared];
    if (!levels.every((level) => level.length > shared + 1 && level[shared] === at)) return shared;
  }
}

/**
 * The types opening intents ask about (ADR-0046): at most `count`, taken in
 * turn from each branch of the type tree. A branch is the first level below
 * the levels all types share; within one, types go by product count, then by
 * name, and the branches go by name. Without a separator, the types with the
 * most products. The same catalog gives the same types.
 */
export function spreadTypes(
  rows: readonly CatalogRow[],
  separator: string | undefined,
  count: number,
): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== undefined) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  }
  const ordered = [...counts.keys()].toSorted(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  if (separator === undefined) return ordered.slice(0, count);
  const levels = ordered.map((type) => type.split(separator));
  const shared = sharedLevels(levels);
  const branches = new Map<string, string[]>();
  ordered.forEach((type, index) => {
    const branch = levels[index]?.[shared] ?? '';
    branches.set(branch, [...(branches.get(branch) ?? []), type]);
  });
  const queues = [...branches.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, types]) => types);
  const chosen: string[] = [];
  for (let round = 0; chosen.length < count; round += 1) {
    const taken = queues.flatMap((types) => {
      const type = types[round];
      return type === undefined ? [] : [type];
    });
    if (taken.length === 0) break;
    chosen.push(...taken.slice(0, count - chosen.length));
  }
  return chosen;
}

/** The name of a product an answer showed: its own, or the catalog's by its id. */
function shownName(item: EvidenceItem, data: EcommerceData, language: string): string | undefined {
  const own = item['name'];
  if (typeof own === 'string' && own.trim() !== '') return own;
  const id = item['id'];
  const row =
    typeof id === 'string' || typeof id === 'number' ? data.catalog?.get(String(id)) : undefined;
  return row === undefined ? undefined : nameIn(row, language);
}

/** The first product with a name in the language, one in stock before one that isn't. */
function namedProduct(rows: readonly CatalogRow[], language: string): string | undefined {
  const named = rows.filter((row) => nameIn(row, language) !== undefined);
  const stocked = named.find((row) => (row.stock ?? 0) > 0 || row.inStock === true);
  const row = stocked ?? named[0];
  return row === undefined ? undefined : nameIn(row, language);
}

/** The opening turns about one type: by a product's name, the type, and the type under two bounds. */
function aboutType(
  rows: readonly CatalogRow[],
  type: string,
  data: EcommerceData,
  language: string,
  say: Phrasings,
): IntentTurn[] {
  const turns: IntentTurn[] = [];
  const name = namedProduct(rows, language);
  if (name !== undefined) turns.push({ intent: 'product', user: say.product(name) });
  const words = typeWords(type, data.config.typeSeparator);
  turns.push({
    intent: 'type',
    user: say.type(words),
    expect: { productType: [type] },
    basis: `type ${type} from the catalog`,
  });
  const prices = pricesOf(rows);
  const currency = rows.find((row) => row.currency !== undefined)?.currency;
  const money = (amount: number) =>
    currency === undefined ? String(amount) : `${String(amount)} ${currency}`;
  const bounded = (intent: string, amount: number, why: string): IntentTurn => ({
    intent,
    user: say.underPrice(words, money(amount)),
    expect: { productType: [type], filters: { maxPrice: amount } },
    basis: `type ${type} at most ${String(amount)}, ${why}`,
  });
  const median = medianPrice(prices);
  if (median !== undefined) turns.push(bounded('under-price', median, 'its median price'));
  const empty = emptyBand(prices);
  if (empty !== undefined) {
    const lowest = String(prices[0]);
    turns.push(bounded('empty-band', empty, `below its lowest price ${lowest}`));
  }
  return turns;
}

function opening(data: EcommerceData, language: string, count: number): IntentTurn[] {
  const say = PHRASINGS[language];
  if (say === undefined) return [];
  const rows = [...(data.catalog?.values() ?? [])];
  const types = spreadTypes(rows, data.config.typeSeparator, count);
  const turns = types.flatMap((type) =>
    aboutType(
      rows.filter((row) => row.type === type),
      type,
      data,
      language,
      say,
    ),
  );
  // A catalog without types: a product by its name, as before.
  if (types.length === 0) {
    const name = namedProduct(rows, language);
    if (name !== undefined) turns.push({ intent: 'product', user: say.product(name) });
  }
  for (const topic of data.policies.keys()) {
    turns.push({ intent: 'policy', user: say.policy(say.topics[topic] ?? topic) });
  }
  return turns;
}

function following(
  data: EcommerceData,
  language: string,
  conversation: readonly ExploredTurn[],
): IntentTurn[] {
  const say = PHRASINGS[language];
  if (say === undefined) return [];
  const names = (turn: ExploredTurn) =>
    (turn.evidence[PRODUCTS] ?? []).flatMap((item) => {
      const name = shownName(item, data, language);
      return name === undefined ? [] : [name];
    });
  const at = conversation.findLastIndex((turn) => names(turn).length > 0);
  const answer = conversation[at];
  if (answer === undefined) return [];
  const shown = names(answer);
  // Since that answer, the conversation may only have added its products to the cart.
  const since = conversation.slice(at + 1);
  if (!since.every((turn) => shown.some((name) => say.cart(name) === turn.user))) return [];
  const asked = new Set(conversation.map((turn) => turn.user));
  const turns: IntentTurn[] = [];
  const next = shown.find((name) => !asked.has(say.cart(name)));
  if (next !== undefined) turns.push({ intent: 'cart', user: say.cart(next) });
  if (since.length === 0) turns.push({ intent: 'cheaper', user: say.cheaper });
  return turns;
}

/** The pack's intents over the target's data. */
export function ecommerceIntents(data: EcommerceData): Intents {
  return {
    opening: (language, types) => opening(data, language, types),
    following: (language, conversation) => following(data, language, conversation),
  };
}
