// The app around the model: sessions, catalog search, a response cache.

import type { Product, ShopData } from './catalog.ts';
import type { Defect } from './defects.ts';
import { detectLanguage, type Language } from './language.ts';
import {
  hasFilters,
  type AnswerDraft,
  type ChatModel,
  type ConversationContext,
  type Filters,
  type Interpretation,
  type ModelCall,
  type Route,
  unavailableAnswer,
} from './model.ts';
import { ABSENT_TYPES } from './vocabulary.ts';

export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly price: { readonly amount: number; readonly currency: string };
  /** null means unknown, not zero. */
  readonly stockQuantity: number | null;
  /** Available or not, as shops without quantities say it; null means unknown. */
  readonly available: boolean | null;
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
    available: product.stock === null ? null : product.stock > 0,
    attributes: {
      ...(product.size === undefined ? {} : { size: product.size }),
      ...(product.color === undefined ? {} : { color: product.color }),
      ...(product.gender === undefined ? {} : { gender: product.gender }),
    },
  };
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const PHONE = /(?<![\d+])(?:(?:\+90|0)[\s-]*)?5\d{2}[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu;

/** The message with e-mail addresses and Turkish mobile numbers masked, for the model. */
export function maskPersonalData(message: string): string {
  return message.replaceAll(EMAIL, '[email]').replaceAll(PHONE, '[phone]');
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
    options: { readonly bypassCache?: boolean; readonly trace?: string } = {},
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

    // The model sees the message with personal data masked, and only the data it needs.
    const sent = this.#defect === 'unmasked-pii' ? message : maskPersonalData(message);
    const call: ModelCall = {
      ...(options.trace === undefined ? {} : { trace: options.trace }),
      question: sent,
      ...(this.#defect === 'prompt-bloat' ? { reference: this.#data.catalog } : {}),
    };
    let interpretation: Interpretation;
    let draft: AnswerDraft;
    let next: ConversationContext;
    let answer: string;
    try {
      interpretation = await this.#model.interpret(sent, context, call);
      ({ draft, next } = this.#plan(interpretation, context));
      answer = await this.#model.write(draft, call);
    } catch (error) {
      if (this.#defect === 'no-model-fallback') throw error;
      // The model failed: answer from a template on the fallback route. The
      // failure is passing, so the session stays as it was and nothing is cached.
      const language = detectLanguage(message);
      if (context !== undefined) remember(this.#sessions, sessionId, context, MAX_SESSIONS);
      return {
        reply: {
          answer: unavailableAnswer(language),
          products: [],
          metadata: { route: 'fallback', language },
        },
        cache: bypass ? 'bypass' : 'miss',
      };
    }
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

  /**
   * Summarises an answer for the session's memory, as apps do in the background
   * after answering. Failures are swallowed: the user already has the answer.
   */
  async summarize(answer: string, options: { readonly trace?: string } = {}): Promise<void> {
    try {
      await this.#model.summarize(
        answer,
        options.trace === undefined ? {} : { trace: options.trace },
      );
    } catch {
      // Nothing to do: a lost summary only makes the memory shorter.
    }
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
    const shown = (relaxed ? all : matching).slice(0, RESULT_LIMIT);
    const products = this.#duplicate(relaxed ? shown : this.#pad(shown, productType, filters));
    return {
      draft: { kind: relaxed ? 'relaxed' : 'products', language, productType, filters, products },
      next: { productType, filters, products },
    };
  }

  /** The type-padding defect: fills a short result with other types that satisfy the filters. */
  #pad(products: Product[], productType: string, filters: Filters): Product[] {
    if (this.#defect !== 'type-padding' || products.length >= RESULT_LIMIT) return products;
    const others = this.#data.catalog
      .filter((product) => product.type !== productType && satisfies(product, filters))
      .toSorted(byPriceThenId);
    return [...products, ...others.slice(0, RESULT_LIMIT - products.length)];
  }

  #duplicate(products: Product[]): Product[] {
    const [first] = products;
    return this.#defect === 'duplicate-products' && first !== undefined
      ? [...products, first]
      : products;
  }
}
