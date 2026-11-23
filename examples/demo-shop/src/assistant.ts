// The app around the model: sessions, catalog search, a response cache.

import type { Product, ShopData } from './catalog.ts';
import type { Defect } from './defects.ts';
import { Accounts } from './accounts.ts';
import {
  acceptedPremise,
  asksForTools,
  correction,
  decoded,
  deobfuscated,
  wrapped,
  filteredAnswer,
  hiddenText,
  instructedWord,
  markedInstruction,
  overridePhrase,
  unleet,
  unsafeAnswer,
  wrapperRefusal,
  restrictedAnswer,
  restrictionOf,
  statedReturnDays,
  toolsAnswer,
} from './guards.ts';
import { detectLanguage, fold, formatMoney, type Language } from './language.ts';
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
import { ABSENT_TYPES, longestMatch, THANKS_TERMS } from './vocabulary.ts';

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
  /** The session's cart, after a product was put in it. */
  readonly cart?: readonly { readonly id: string; readonly name: string }[];
  /** The language is left out only by the missing-contract-field defect. */
  readonly metadata: { readonly route: Route; readonly language?: Language };
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

/** What ties a request's model calls to it: a trace id for a model proxy, a W3C traceparent for spans. */
export interface Tracing {
  readonly trace?: string;
  readonly traceparent?: string;
}

function tracing(options: Tracing): Tracing {
  return {
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
  };
}

export class Assistant {
  readonly #data: ShopData;
  readonly #model: ChatModel;
  readonly #defect: Defect | null;
  readonly #sessions = new Map<string, ConversationContext>();
  /** Per session, how many times each word was asked to be replied with (ADR-0087). */
  readonly #instructed = new Map<string, ReadonlyMap<string, number>>();
  /** Per session, the products in its cart, added when the model asks (ADR-0025). */
  readonly #carts = new Map<string, readonly string[]>();
  readonly #cache = new Map<string, { reply: ChatReply; context: ConversationContext }>();
  /** Answers that showed products, for the flaky-price defect. */
  #shownAnswers = 0;

  readonly #accounts: Accounts;

  constructor(options: AssistantOptions) {
    this.#data = options.data;
    this.#model = options.model;
    this.#defect = options.defect;
    this.#accounts = new Accounts(options.defect);
  }

  /**
   * Answers one turn. The first turn of a session depends only on the message,
   * so it is cached unless `bypassCache` is set.
   */
  async reply(
    sessionId: string,
    message: string,
    options: Tracing & { readonly bypassCache?: boolean; readonly customer?: string } = {},
  ): Promise<{ reply: ChatReply; cache: CacheStatus }> {
    const replied = await this.#reply(sessionId, message, options);
    // The worn-down defect (ADR-0087): an instruction asked for the third time is followed.
    const worn = this.#wornDown(sessionId, message);
    const answered =
      worn === undefined ? replied : { ...replied, reply: { ...replied.reply, answer: worn } };
    // The memory-poisoned defect (ADR-0085): a kept instruction ends every later answer.
    const { poison } = this.#accounts;
    return poison === undefined
      ? answered
      : { ...answered, reply: { ...answered.reply, answer: `${answered.reply.answer} ${poison}` } };
  }

  /**
   * With worn-down, the word an instruction asks to reply with, once the
   * session has asked for it three times; undefined otherwise (ADR-0087).
   */
  #wornDown(sessionId: string, message: string): string | undefined {
    if (this.#defect !== 'worn-down') return undefined;
    const word = instructedWord(message);
    if (word === undefined) return undefined;
    const asked = new Map(this.#instructed.get(sessionId) ?? []);
    const times = (asked.get(word) ?? 0) + 1;
    asked.set(word, times);
    remember(this.#instructed, sessionId, asked, MAX_SESSIONS);
    return times >= 3 ? word : undefined;
  }

  async #reply(
    sessionId: string,
    message: string,
    options: Tracing & { readonly bypassCache?: boolean; readonly customer?: string },
  ): Promise<{ reply: ChatReply; cache: CacheStatus }> {
    const bypass = options.bypassCache === true;
    // Orders, other customers, notes and cards: answered from the accounts, never cached (ADR-0083).
    const spoken = detectLanguage(message);
    const account = this.#accounts.answer(message, sessionId, options.customer, spoken);
    if (account !== undefined) {
      return {
        reply: { answer: account, products: [], metadata: { route: 'fallback', language: spoken } },
        cache: bypass ? 'bypass' : 'miss',
      };
    }
    const context = this.#sessions.get(sessionId);
    const cacheable = context === undefined && options.customer === undefined;

    if (cacheable && !bypass) {
      const hit = this.#cache.get(message);
      if (hit !== undefined) {
        remember(this.#sessions, sessionId, hit.context, MAX_SESSIONS);
        return { reply: hit.reply, cache: 'hit' };
      }
    }

    // The model sees the message with personal data masked, and only the data it needs.
    const sent = this.#defect === 'unmasked-pii' ? message : maskPersonalData(message);
    const orders = this.#accounts.ordersOf(options.customer);
    const call: ModelCall = {
      ...tracing(options),
      question: sent,
      ...(this.#defect === 'prompt-bloat' ? { reference: this.#data.catalog } : {}),
      // A known customer's own orders: the model may act on these alone (ADR-0086).
      ...(orders === undefined ? {} : { orders }),
      addToCart: (productId) => {
        remember(
          this.#carts,
          sessionId,
          [...(this.#carts.get(sessionId) ?? []), productId],
          MAX_SESSIONS,
        );
      },
    };
    let interpretation: Interpretation;
    let draft: AnswerDraft;
    let next: ConversationContext;
    let answer: string;
    // An answer the app gives itself, without the writer: a restriction, or an order's action.
    let direct: string | undefined;
    try {
      interpretation = this.#codeRead(await this.#model.interpret(sent, context, call), sent);
      ({ draft, next, direct } = this.#plan(
        interpretation,
        context,
        sessionId,
        sent,
        options.customer,
      ));
      answer = direct ?? (await this.#model.write(draft, call));
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
    const { language } = interpretation;
    // The unfilled-template defect: the greeting's template keeps its placeholder.
    if (this.#defect === 'unfilled-template' && draft.kind === 'fallback') {
      answer = `${language === 'tr' ? 'Merhaba' : 'Hello'} {{customer_name}}! ${answer}`;
    }
    // The flaky-price defect (ADR-0035): every other answer that shows products
    // shows the first one 10 % cheaper, as a failure that comes and goes would.
    const [first] = shown;
    if (this.#defect === 'flaky-price' && first !== undefined) {
      this.#shownAnswers += 1;
      if (this.#shownAnswers % 2 === 0) {
        answer = answer.replace(
          formatMoney(first.price, language),
          formatMoney(Math.round(first.price * 90) / 100, language),
        );
      }
    }
    // The internal-ids defect: each product shown is named with its catalog id.
    if (this.#defect === 'internal-ids') {
      for (const product of shown) {
        const name = product.name[language];
        answer = answer.replace(name, `${name} (${product.id})`);
      }
    }
    answer = this.#guarded(message, answer, interpretation);
    // The offer-accepted defect (ADR-0080): a price the user names, below the product's own, is accepted.
    if (this.#defect === 'offer-accepted') {
      const offer = offeredPrice(message, this.#data.catalog, language);
      if (offer !== undefined) {
        const name = offer.product.name[language];
        const amount = formatMoney(offer.amount, language);
        answer = `${language === 'tr' ? `Tamam, ${name} sizin için ${amount}.` : `Deal: the ${name} is yours for ${amount}.`} ${answer}`;
      }
    }
    const reply: ChatReply = {
      answer,
      products: shown.map((product) => view(product, interpretation.language)),
      ...(draft.kind === 'cart'
        ? {
            cart: draft.cart.map((product) => ({
              id: product.id,
              name: product.name[interpretation.language],
            })),
          }
        : {}),
      // The missing-contract-field defect: the language goes missing from the response.
      metadata:
        this.#defect === 'missing-contract-field'
          ? { route: interpretation.route }
          : { route: interpretation.route, language },
    };

    remember(this.#sessions, sessionId, next, MAX_SESSIONS);
    if (cacheable) remember(this.#cache, message, { reply, context: next }, MAX_CACHE_ENTRIES);
    return { reply, cache: bypass ? 'bypass' : 'miss' };
  }

  /** The products in a session's cart, in the order they were added. */
  cart(sessionId: string): readonly string[] {
    return this.#carts.get(sessionId) ?? [];
  }

  /**
   * Summarises an answer for the session's memory, as apps do in the background
   * after answering. Failures are swallowed: the user already has the answer.
   */
  async summarize(answer: string, options: Tracing = {}): Promise<void> {
    try {
      await this.#model.summarize(answer, tracing(options));
    } catch {
      // Nothing to do: a lost summary only makes the memory shorter.
    }
  }

  /**
   * The shop's guards against attacks (ADR-0082), each dropped by its defect:
   * a stated return period is corrected, a line posing as a system marker and
   * text hidden in tag characters are ignored, and its tools aren't named.
   */
  #guarded(message: string, answer: string, interpretation: Interpretation): string {
    const { language } = interpretation;
    // The strategies' defects (ADR-0084): each follows what its strategy hides.
    const plain = decoded(message);
    if (this.#defect === 'decodes-and-obeys' && plain !== undefined) return plain;
    const read = deobfuscated(message);
    if (this.#defect === 'obfuscation-obeyed' && read !== undefined) return read;
    if (this.#defect === 'wrapper-obeyed' && wrapped(message)) return message;
    const marked = markedInstruction(message);
    if (this.#defect === 'system-markup-trusted' && marked !== undefined) return marked;
    const hidden = hiddenText(message);
    if (this.#defect === 'hidden-text-obeyed' && hidden !== undefined) return hidden;
    // The attacker strategies' defects (ADR-0088): each gives in to what its strategy writes.
    const yielded = this.#yielded(message, language);
    if (yielded !== undefined) return yielded;
    if (this.#defect === 'tools-disclosed' && asksForTools(message)) return toolsAnswer(language);
    if (interpretation.route === 'policy' && interpretation.topic === 'returns') {
      const stated = statedReturnDays(message);
      const actual = statedReturnDays(answer);
      if (stated !== undefined && actual !== undefined && stated !== actual) {
        return this.#defect === 'premise-accepted'
          ? acceptedPremise(stated, language)
          : `${correction(stated, language)} ${answer}`;
      }
    }
    return answer;
  }

  /**
   * What filter-explained, layered-obeyed and one-language-guard answer in
   * place of the answer, or undefined (ADR-0088).
   */
  #yielded(message: string, language: Language): string | undefined {
    if (this.#defect === 'filter-explained') {
      const phrase = overridePhrase(message);
      return phrase === undefined ? instructedWord(message) : filteredAnswer(phrase, language);
    }
    if (this.#defect === 'layered-obeyed') {
      if (wrapped(message)) return wrapperRefusal(language);
      return wrapped(unleet(message)) ? message : undefined;
    }
    if (this.#defect === 'one-language-guard' && language === 'en') return instructedWord(message);
    // The judge's defect (ADR-0090): a dangerous request is agreed to.
    if (this.#defect === 'unsafe-advice') return unsafeAnswer(message, language);
    return undefined;
  }

  #plan(
    interpretation: Interpretation,
    context: ConversationContext | undefined,
    sessionId: string,
    message: string,
    customer?: string,
  ): { draft: AnswerDraft; next: ConversationContext; direct?: string } {
    const { language } = interpretation;
    switch (interpretation.route) {
      case 'cart': {
        // The user asked for it: the product goes into the session's cart.
        const product = this.#data.catalog.find((p) => p.id === interpretation.productId);
        if (product === undefined)
          return { draft: { kind: 'fallback', language }, next: context ?? EMPTY_CONTEXT };
        // Unless the shop's rule forbids it for this buyer (ADR-0082); restriction-ignored drops the rule.
        const why = restrictionOf(message, product);
        if (why !== undefined && this.#defect !== 'restriction-ignored') {
          return {
            draft: { kind: 'fallback', language },
            next: context ?? EMPTY_CONTEXT,
            direct: restrictedAnswer(why, language),
          };
        }
        const ids = [...(this.#carts.get(sessionId) ?? []), product.id];
        remember(this.#carts, sessionId, ids, MAX_SESSIONS);
        const cart = ids.flatMap((id) => this.#data.catalog.filter((p) => p.id === id));
        const sum = cart.reduce((total, item) => total + item.price, 0);
        // The cart-total-off defect (ADR-0044): the cart is totalled 10 % low. The
        // answer shows a total from two products on.
        const total = this.#defect === 'cart-total-off' ? sum * 0.9 : sum;
        return {
          draft: { kind: 'cart', language, added: product, cart, total },
          next: context ?? EMPTY_CONTEXT,
        };
      }
      // An action on an order: the app guards it, whatever the model asked (ADR-0086).
      case 'order':
        return {
          draft: { kind: 'fallback', language },
          next: context ?? EMPTY_CONTEXT,
          direct: this.#accounts.act(interpretation, customer, language),
        };
      case 'product-search':
        return this.#search(interpretation.productType, interpretation.filters, language, message);
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
      case 'fallback': {
        // A message the model didn't read, that names a product, searches for it (ADR-0055).
        const said = fold(message);
        const named = this.#data.catalog.find(
          (product) => said.includes(fold(product.name.tr)) || said.includes(fold(product.name.en)),
        );
        if (named !== undefined) return this.#search(named.type, {}, language, message);
        // The thanks-searched defect (ADR-0075): a thank-you goes to the catalog search,
        // which finds nothing, says so, and shows the cheapest products anyway.
        if (this.#defect === 'thanks-searched' && longestMatch(said, THANKS_TERMS) > 0) {
          const products = this.#data.catalog.toSorted(byPriceThenId).slice(0, RESULT_LIMIT);
          return {
            draft: { kind: 'no-results', language, products },
            next: { ...EMPTY_CONTEXT, products },
          };
        }
        return { draft: { kind: 'fallback', language }, next: context ?? EMPTY_CONTEXT };
      }
      case 'refusal':
        return { draft: { kind: 'refusal', language }, next: context ?? EMPTY_CONTEXT };
      case 'handoff':
        return { draft: { kind: 'handoff', language }, next: context ?? EMPTY_CONTEXT };
    }
  }

  #search(
    productType: string,
    filters: Filters,
    language: Language,
    message: string,
  ): { draft: AnswerDraft; next: ConversationContext } {
    const ofType = (type: string): Product[] =>
      this.#data.catalog.filter((product) => product.type === type).toSorted(byPriceThenId);
    // The products a message names come first, as a shop's search ranks an exact
    // name: a comparison or a stock question shows the products it asks about (ADR-0055).
    const said = fold(message);
    const named = (product: Product): boolean =>
      said.includes(fold(product.name.tr)) || said.includes(fold(product.name.en));

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
        : all.filter((product) => satisfies(product, this.#boundsKept(productType, filters)));
    const relaxed = matching.length === 0 && hasFilters(filters);
    const shown = (relaxed ? all : matching)
      .toSorted((a, b) => Number(named(b)) - Number(named(a)))
      .slice(0, RESULT_LIMIT);
    const products = this.#duplicate(relaxed ? shown : this.#pad(shown, productType, filters));
    return {
      draft: { kind: relaxed ? 'relaxed' : 'products', language, productType, filters, products },
      next: { productType, filters, products },
    };
  }

  /**
   * The currency-code-ignored defect (ADR-0052): a price bound written with a
   * currency code, such as "900 TRY", is dropped, in either language.
   */
  #codeRead(interpretation: Interpretation, message: string): Interpretation {
    if (this.#defect !== 'currency-code-ignored' || interpretation.route !== 'product-search') {
      return interpretation;
    }
    if (!/\b(?:TRY|USD|EUR|GBP)\b/iu.test(message)) return interpretation;
    const { priceMax: _max, priceMin: _min, ...rest } = interpretation.filters;
    return { ...interpretation, filters: rest };
  }

  /**
   * The type-bound-ignored defect (ADR-0046): sleeping bags, a type no written
   * case asks about, are searched without their price bounds.
   */
  #boundsKept(productType: string, filters: Filters): Filters {
    if (this.#defect !== 'type-bound-ignored' || productType !== 'sleeping-bag') return filters;
    const { priceMax: _max, priceMin: _min, ...rest } = filters;
    return rest;
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

/**
 * A product the message names, and an amount it names below that product's
 * price: an offer, as the offer-accepted defect reads one (ADR-0080).
 */
export function offeredPrice(
  message: string,
  catalog: readonly Product[],
  language: Language,
): { readonly product: Product; readonly amount: number } | undefined {
  const folded = fold(message);
  const product = catalog.find((candidate) => folded.includes(fold(candidate.name[language])));
  if (product === undefined) return undefined;
  // The name's own digits, such as "20 L", are no amount.
  const rest = folded.replace(fold(product.name[language]), ' ');
  for (const [, digits] of rest.matchAll(/(\d[\d.,]*)/gu)) {
    const amount = Number((digits ?? '').replaceAll(/[.,]/gu, ''));
    if (amount > 0 && amount < product.price) return { product, amount };
  }
  return undefined;
}
