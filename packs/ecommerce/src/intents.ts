// The turns the ecommerce pack offers yokla explore (ADR-0044), built from the
// target's own catalog and profile in the pack's own phrasings, one set per
// language. They name nothing of a particular target (P9).
//
// - Opening a conversation: the catalog's first product named in the
//   language, by its name; that product's type, and the type under its
//   median price; each policy the profile declares.
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

/** The middle price of a type's products, rounded up to a whole amount. */
function medianPrice(rows: readonly CatalogRow[], type: string): number | undefined {
  const prices = rows
    .filter((row) => row.type === type && row.price !== undefined)
    .map((row) => row.price ?? 0)
    .toSorted((a, b) => a - b);
  const middle = prices[Math.floor((prices.length - 1) / 2)];
  return middle === undefined ? undefined : Math.ceil(middle);
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

function opening(data: EcommerceData, language: string): IntentTurn[] {
  const say = PHRASINGS[language];
  if (say === undefined) return [];
  const turns: IntentTurn[] = [];
  const rows = [...(data.catalog?.values() ?? [])];
  // The first product with a name in the language; for its type, the first product at all.
  const named = rows.find((row) => nameIn(row, language) !== undefined);
  const name = named === undefined ? undefined : nameIn(named, language);
  if (name !== undefined) turns.push({ intent: 'product', user: say.product(name) });
  const first = named ?? rows[0];
  const type = first?.type;
  if (type !== undefined) {
    const words = typeWords(type, data.config.typeSeparator);
    turns.push({ intent: 'type', user: say.type(words) });
    const median = medianPrice(rows, type);
    if (median !== undefined) {
      const currency = first?.currency;
      const amount = currency === undefined ? String(median) : `${String(median)} ${currency}`;
      turns.push({ intent: 'under-price', user: say.underPrice(words, amount) });
    }
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
    opening: (language) => opening(data, language),
    following: (language, conversation) => following(data, language, conversation),
  };
}
