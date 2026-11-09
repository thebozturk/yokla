// The app around the model: sessions, catalog search, a response cache.

import type { Product, ShopData } from './catalog.ts';
import type { Defect } from './defects.ts';
import type { Language } from './language.ts';
import {
  hasFilters,
  type AnswerDraft,
  type ChatModel,
  type ConversationContext,
  type Filters,
  type Interpretation,
  type Route,
} from './model.ts';
import { ABSENT_TYPES } from './vocabulary.ts';

export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly price: { readonly amount: number; readonly currency: string };
  /** null means unknown, not zero. */
  readonly stockQuantity: number | null;
  readonly attributes: Readonly<Partial<Record<'size' | 'color' | 'gender', string>>>;
}

export interface ChatReply {
  readonly answer: string;
  readonly products: readonly ProductView[];
  readonly metadata: { readonly route: Route; readonly language: Language };
}

export type CacheStatus = 'hit' | 'miss' | 'bypass';

export interface AssistantOptions {
  readonly data: ShopData;
  readonly model: ChatModel;
  readonly defect: Defect | null;
}

const RESULT_LIMIT = 3;
const MAX_SESSIONS = 10_000;
const MAX_CACHE_ENTRIES = 1_000;
const EMPTY_CONTEXT: ConversationContext = { filters: {}, products: [] };

function byPriceThenId(a: Product, b: Product): number {
  return a.price - b.price || a.id.localeCompare(b.id);
}

export function satisfies(product: Product, filters: Filters): boolean {
  return (
    (filters.priceMax === undefined || product.price <= filters.priceMax) &&
    (filters.priceMin === undefined || product.price >= filters.priceMin) &&
    (filters.size === undefined || product.size === filters.size) &&
    (filters.color === undefined || product.color === filters.color) &&
    (filters.gender === undefined || product.gender === filters.gender)
  );
}

function view(product: Product, language: Language): ProductView {
  return {
    id: product.id,
    name: product.name[language],
    category: product.categoryPath,
    price: { amount: product.price, currency: product.currency },
    stockQuantity: product.stock,
    attributes: {
      ...(product.size === undefined ? {} : { size: product.size }),
      ...(product.color === undefined ? {} : { color: product.color }),
      ...(product.gender === undefined ? {} : { gender: product.gender }),
    },
  };
}

/** Inserts or refreshes a key, evicting the oldest entry beyond `max`. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const [oldest] = map.keys();
    if (oldest !== undefined) map.delete(oldest);
  }
}

export class Assistant {
  readonly #data: ShopData;
  readonly #model: ChatModel;
  readonly #defect: Defect | null;
  readonly #sessions = new Map<string, ConversationContext>();
  readonly #cache = new Map<string, { reply: ChatReply; context: ConversationContext }>();

  constructor(options: AssistantOptions) {
    this.#data = options.data;
    this.#model = options.model;
    this.#defect = options.defect;
  }

  /**
   * Answers one turn. The first turn of a session depends only on the message,
   * so it is cached unless `bypassCache` is set.
   */
  async reply(
    sessionId: string,
    message: string,
    options: { readonly bypassCache?: boolean } = {},
  ): Promise<{ reply: ChatReply; cache: CacheStatus }> {
    const bypass = options.bypassCache === true;
    const context = this.#sessions.get(sessionId);
    const cacheable = context === undefined;

    if (cacheable && !bypass) {
      const hit = this.#cache.get(message);
      if (hit !== undefined) {
        remember(this.#sessions, sessionId, hit.context, MAX_SESSIONS);
        return { reply: hit.reply, cache: 'hit' };
      }
    }

    const interpretation = await this.#model.interpret(message, context);
    const { draft, next } = this.#plan(interpretation, context);
    const answer = await this.#model.write(draft);
    const shown =
      draft.kind === 'cheapest' ? [draft.product] : 'products' in draft ? draft.products : [];
    const reply: ChatReply = {
      answer,
      products: shown.map((product) => view(product, interpretation.language)),
      metadata: { route: interpretation.route, language: interpretation.language },
    };

    remember(this.#sessions, sessionId, next, MAX_SESSIONS);
    if (cacheable) remember(this.#cache, message, { reply, context: next }, MAX_CACHE_ENTRIES);
    return { reply, cache: bypass ? 'bypass' : 'miss' };
  }

  #plan(
    interpretation: Interpretation,
    context: ConversationContext | undefined,
  ): { draft: AnswerDraft; next: ConversationContext } {
    const { language } = interpretation;
    switch (interpretation.route) {
      case 'product-search':
        return this.#search(interpretation.productType, interpretation.filters, language);
      case 'policy': {
        const source =
          interpretation.topic === 'returns'
            ? this.#data.faq.find((entry) => entry.topic === 'returns' && entry.lang === language)
                ?.answer
            : undefined;
        return {
          draft: { kind: 'policy', language, topic: interpretation.topic, source },
          next: context ?? EMPTY_CONTEXT,
        };
      }
      case 'follow-up-cheapest': {
        const [cheapest] = (context?.products ?? []).toSorted(byPriceThenId);
        if (cheapest === undefined)
          return { draft: { kind: 'fallback', language }, next: context ?? EMPTY_CONTEXT };
        return {
          draft: { kind: 'cheapest', language, product: cheapest },
          next: { ...(context ?? EMPTY_CONTEXT), products: [cheapest] },
        };
      }
      case 'refusal':
      case 'fallback':
        return { draft: { kind: interpretation.route, language }, next: context ?? EMPTY_CONTEXT };
    }
  }

  #search(
    productType: string,
    filters: Filters,
    language: Language,
  ): { draft: AnswerDraft; next: ConversationContext } {
    const ofType = (type: string): Product[] =>
      this.#data.catalog.filter((product) => product.type === type).toSorted(byPriceThenId);

    const absent = ABSENT_TYPES.find((type) => type.key === productType);
    if (absent !== undefined) {
      const products = this.#duplicate(ofType(absent.substitute).slice(0, RESULT_LIMIT));
      return {
        draft: {
          kind: 'absence',
          language,
          absentType: absent.key,
          substituteType: absent.substitute,
          products,
        },
        next: { productType, filters, products },
      };
    }

    const all = ofType(productType);
    const matching =
      this.#defect === 'filter-ignored'
        ? all
        : all.filter((product) => satisfies(product, filters));
    const relaxed = matching.length === 0 && hasFilters(filters);
    const products = this.#duplicate((relaxed ? all : matching).slice(0, RESULT_LIMIT));
    return {
      draft: { kind: relaxed ? 'relaxed' : 'products', language, productType, filters, products },
      next: { productType, filters, products },
    };
  }

  #duplicate(products: Product[]): Product[] {
    const [first] = products;
    return this.#defect === 'duplicate-products' && first !== undefined
      ? [...products, first]
      : products;
  }
}
