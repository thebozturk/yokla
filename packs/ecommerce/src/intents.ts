// The turns the ecommerce pack offers yokla explore (ADR-0044), built from the
// target's own catalog and profile in the pack's own phrasings, one set per
// language. They name nothing of a particular target (P9).
//
// - Opening a conversation (ADR-0046): for each of a few types spread over
//   the catalog's type tree, a product of the type by its name, the type, the
//   type under its median price, and the type under its lowest price, where
//   nothing can match; then each policy the profile declares. A turn that
//   asks for a type or a price bound states it as its expectation, from the
//   same catalog data its words came from (ADR-0004). A type is asked by its
//   words, so the expectation and the prices cover every type with the same
//   words; amounts are written in the language's usual unit, and one turn
//   per language writes the currency code, at the type's lower quartile
//   price (ADR-0048, ADR-0052). A type's words are its
//   catalog label where the profile maps one, else its last level (ADR-0050).
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
  /** An amount as shoppers in the language write it, by currency code (ADR-0048). */
  money(amount: string, currency: string | undefined): string;
  policy(topic: string): string;
  cart(name: string): string;
  readonly cheaper: string;
  /** The words for the policy topics the pack knows; another topic goes by its key. */
  readonly topics: Readonly<Record<string, string>>;
}

/** The words Turkish shoppers write after an amount, by currency code (ADR-0048). */
const TR_UNITS: Readonly<Record<string, string>> = {
  TRY: 'TL',
  USD: 'dolar',
  EUR: 'euro',
  GBP: 'sterlin',
};

/** The signs English shoppers write before an amount; the lira has none, so its code stays. */
const EN_SIGNS: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£' };

export const PHRASINGS: Readonly<Record<string, Phrasings>> = {
  tr: {
    product: (name) => `${name} var mı?`,
    type: (type) => `${type} var mı?`,
    underPrice: (type, amount) => `${amount} altında ${type} var mı?`,
    money: (amount, currency) =>
      currency === undefined ? amount : `${amount} ${TR_UNITS[currency] ?? currency}`,
    policy: (topic) => `${topic} koşullarınız neler?`,
    cart: (name) => `${name} ürününü sepete ekler misin?`,
    cheaper: 'Daha ucuz bir seçenek var mı?',
    topics: { returns: 'İade', shipping: 'Kargo', warranty: 'Garanti' },
  },
  en: {
    product: (name) => `Do you have the ${name}?`,
    type: (type) => `Do you have any ${type}?`,
    underPrice: (type, amount) => `Do you have any ${type} under ${amount}?`,
    money: (amount, currency) => {
      if (currency === undefined) return amount;
      const sign = EN_SIGNS[currency];
      return sign === undefined ? `${amount} ${currency}` : `${sign}${amount}`;
    },
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

/** How a type is asked for: words by type, the same for every type with the same words. */
export type WordsOf = (type: string) => string;

/** Words compared as one: the same in lower case, with runs of spaces as one. */
function wordKey(words: string, language: string): string {
  return words.toLocaleLowerCase(language).replaceAll(/\s+/gu, ' ').trim();
}

/**
 * The words of each type in a language (ADR-0050): the label its rows carry
 * most often, ties to the first by name, or its last level's words where no
 * row has a label in the language.
 */
export function typeWordsIn(
  rows: readonly CatalogRow[],
  separator: string | undefined,
  language: string,
): WordsOf {
  const labels = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const label = row.typeLabels?.[language] ?? row.typeLabels?.['*'];
    if (row.type === undefined || label === undefined) continue;
    const counts = labels.get(row.type) ?? new Map<string, number>();
    counts.set(label.trim(), (counts.get(label.trim()) ?? 0) + 1);
    labels.set(row.type, counts);
  }
  const chosen = new Map<string, string>();
  for (const [type, counts] of labels) {
    const [label] = [...counts.entries()].toSorted(
      ([a, m], [b, n]) => n - m || (a < b ? -1 : a > b ? 1 : 0),
    );
    if (label !== undefined) chosen.set(type, label[0]);
  }
  return (type) => chosen.get(type) ?? typeWords(type, separator);
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
 * The price a quarter of the way up a type's products' prices, the lower one
 * between two, rounded up to a whole amount (ADR-0052): about three quarters
 * of its products cost more, and at least one doesn't.
 */
function lowerQuartile(prices: readonly number[]): number | undefined {
  const quarter = prices[Math.floor((prices.length - 1) / 4)];
  return quarter === undefined ? undefined : Math.ceil(quarter);
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
 * most products. The same catalog gives the same types. Types with the same
 * `keyOf`, the words they are asked by, count once (ADR-0048, ADR-0050).
 */
export function spreadTypes(
  rows: readonly CatalogRow[],
  separator: string | undefined,
  count: number,
  keyOf: (type: string) => string = (type) => typeWords(type, separator),
): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== undefined) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  }
  const ordered = [...counts.keys()].toSorted(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  // Types asked by the same words are one type to a shopper: the first taken stands for them.
  const asked = new Set<string>();
  const fresh = (type: string): boolean => {
    const words = keyOf(type);
    if (asked.has(words)) return false;
    asked.add(words);
    return true;
  };
  if (separator === undefined) return ordered.filter(fresh).slice(0, count);
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
    chosen.push(...taken.filter(fresh).slice(0, count - chosen.length));
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

/** The types a shopper's words for a type name: every catalog type with the same words. */
interface WordGroup {
  readonly words: string;
  /** The types, in the order the catalog first lists them. */
  readonly types: readonly string[];
  readonly rows: readonly CatalogRow[];
  /** How the turn's basis names the group, such as `type "tent" (1 catalog type)`. */
  readonly label: string;
}

function wordGroup(type: string, rows: readonly CatalogRow[], wordsOf: WordsOf, language: string) {
  const words = wordsOf(type);
  const key = wordKey(words, language);
  const members = rows.filter(
    (row) => row.type !== undefined && wordKey(wordsOf(row.type), language) === key,
  );
  const types = [...new Set(members.map((row) => row.type ?? ''))];
  const label = `type "${words}" (${String(types.length)} catalog type${types.length === 1 ? '' : 's'})`;
  return { words, types, rows: members, label } satisfies WordGroup;
}

/** The turn that asks for a group under an amount, written as `amount` says. */
function underTurn(
  group: WordGroup,
  intent: string,
  bound: number,
  amount: string,
  why: string,
  say: Phrasings,
): IntentTurn {
  return {
    intent,
    user: say.underPrice(group.words, amount),
    expect: { productType: [...group.types], filters: { maxPrice: bound } },
    basis: `${group.label} at most ${String(bound)}, ${why}`,
  };
}

/** The currency of a group's first product that has one. */
function currencyOf(group: WordGroup): string | undefined {
  return group.rows.find((row) => row.currency !== undefined)?.currency;
}

/** The opening turns about a group: by a product's name, the group, and the group under two bounds. */
function aboutGroup(group: WordGroup, language: string, say: Phrasings): IntentTurn[] {
  const turns: IntentTurn[] = [];
  const name = namedProduct(group.rows, language);
  if (name !== undefined) turns.push({ intent: 'product', user: say.product(name) });
  turns.push({
    intent: 'type',
    user: say.type(group.words),
    expect: { productType: [...group.types] },
    basis: `${group.label} from the catalog`,
  });
  const prices = pricesOf(group.rows);
  const currency = currencyOf(group);
  const money = (bound: number) => say.money(String(bound), currency);
  const median = medianPrice(prices);
  if (median !== undefined) {
    turns.push(underTurn(group, 'under-price', median, money(median), 'its median price', say));
  }
  const empty = emptyBand(prices);
  if (empty !== undefined) {
    const lowest = String(prices[0]);
    const why = `below its lowest price ${lowest}`;
    turns.push(underTurn(group, 'empty-band', empty, money(empty), why, say));
  }
  return turns;
}

/**
 * The turn that writes the first group's lower quartile with the currency
 * code, where shoppers of the language write it otherwise (ADR-0048); at the
 * lower quartile, a target that drops the bound shows a product over it
 * (ADR-0052). Undefined if not.
 */
function codeTurn(group: WordGroup | undefined, say: Phrasings): IntentTurn | undefined {
  if (group === undefined) return undefined;
  const currency = currencyOf(group);
  const bound = lowerQuartile(pricesOf(group.rows));
  if (currency === undefined || bound === undefined) return undefined;
  const coded = `${String(bound)} ${currency}`;
  if (say.money(String(bound), currency) === coded) return undefined;
  const why = `its lower quartile price, with the currency code ${currency}`;
  return underTurn(group, 'currency-code', bound, coded, why, say);
}

function opening(data: EcommerceData, language: string, count: number): IntentTurn[] {
  const say = PHRASINGS[language];
  if (say === undefined) return [];
  const rows = [...(data.catalog?.values() ?? [])];
  const separator = data.config.typeSeparator;
  const wordsOf = typeWordsIn(rows, separator, language);
  const keyOf = (type: string) => wordKey(wordsOf(type), language);
  const groups = spreadTypes(rows, separator, count, keyOf).map((type) =>
    wordGroup(type, rows, wordsOf, language),
  );
  const turns = groups.flatMap((group) => aboutGroup(group, language, say));
  // A catalog without types: a product by its name, as before.
  if (groups.length === 0) {
    const name = namedProduct(rows, language);
    if (name !== undefined) turns.push({ intent: 'product', user: say.product(name) });
  }
  for (const topic of data.policies.keys()) {
    turns.push({ intent: 'policy', user: say.policy(say.topics[topic] ?? topic) });
  }
  const code = codeTurn(groups[0], say);
  if (code !== undefined) turns.push(code);
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
