// The demo-shop's "LLM": a deterministic, rule-based stand-in behind the
// ChatModel interface. It makes two calls per turn, like a tool-using assistant:
// interpret() turns the message into a structured request, and write() turns
// the app's structured answer into text.

import type { Product } from './catalog.ts';
import type { Defect } from './defects.ts';
import { detectLanguage, fold, formatMoney, parseAmount, type Language } from './language.ts';
import {
  ABSENT_TYPES,
  CHEAPER_TERMS,
  COLORS,
  GENDERS,
  OUT_OF_SCOPE_TERMS,
  POLICY_TOPICS,
  PRODUCT_TYPES,
  longestMatch,
  type Color,
  type Gender,
  type PolicyTopic,
} from './vocabulary.ts';

export interface Filters {
  readonly priceMax?: number;
  readonly priceMin?: number;
  readonly size?: string;
  readonly color?: Color;
  readonly gender?: Gender;
}

export type Route = 'product-search' | 'policy' | 'follow-up-cheapest' | 'refusal' | 'fallback';

export type Interpretation =
  | {
      readonly route: 'product-search';
      readonly language: Language;
      readonly productType: string;
      readonly filters: Filters;
    }
  | { readonly route: 'policy'; readonly language: Language; readonly topic: PolicyTopic }
  | { readonly route: 'follow-up-cheapest' | 'refusal' | 'fallback'; readonly language: Language };

/** What a session remembers between turns. */
export interface ConversationContext {
  readonly productType?: string;
  readonly filters: Filters;
  readonly products: readonly Product[];
}

/** The structured answer the app asks the model to put into words. */
export type AnswerDraft =
  | {
      readonly kind: 'products' | 'relaxed';
      readonly language: Language;
      readonly productType: string;
      readonly filters: Filters;
      readonly products: readonly Product[];
    }
  | {
      readonly kind: 'absence';
      readonly language: Language;
      readonly absentType: string;
      readonly substituteType: string;
      readonly products: readonly Product[];
    }
  | { readonly kind: 'cheapest'; readonly language: Language; readonly product: Product }
  | {
      readonly kind: 'policy';
      readonly language: Language;
      readonly topic: PolicyTopic;
      /** The FAQ answer, if the shop has a source for this topic. */
      readonly source: string | undefined;
    }
  | { readonly kind: 'refusal' | 'fallback'; readonly language: Language };

export interface ChatModel {
  interpret(message: string, context: ConversationContext | undefined): Promise<Interpretation>;
  write(draft: AnswerDraft): Promise<string>;
}

export function hasFilters(filters: Filters): boolean {
  return Object.keys(filters).length > 0;
}

const NUMBER = String.raw`(\d[\d.,]*)`;
const CURRENCY = String.raw`(?:tl|lira|try|₺)?`;
const PRICE_MAX_PATTERNS = [
  new RegExp(String.raw`${NUMBER}\s*${CURRENCY}[a-z']*\s+(?:alti|altinda|altindaki|ucuz)`, 'u'),
  new RegExp(String.raw`en fazla\s+${NUMBER}`, 'u'),
  new RegExp(
    String.raw`(?:under|below|less than|cheaper than|up to|at most)\s+${CURRENCY}\s*${NUMBER}`,
    'u',
  ),
];
const PRICE_MIN_PATTERNS = [
  new RegExp(
    String.raw`${NUMBER}\s*${CURRENCY}[a-z']*\s+(?:ustu|uzeri|uzerinde|uzerindeki|pahali)`,
    'u',
  ),
  new RegExp(String.raw`en az\s+${NUMBER}`, 'u'),
  new RegExp(String.raw`(?:over|above|more than|at least)\s+${CURRENCY}\s*${NUMBER}`, 'u'),
];
const SIZE = String.raw`(xxl|xl|xs|s|m|l|\d{2})`;
const SIZE_PATTERNS = [
  new RegExp(String.raw`(?:beden|numara|size)\s*:?\s*${SIZE}(?![a-z0-9])`, 'u'),
  new RegExp(String.raw`(?:^|[^a-z0-9])${SIZE}\s*(?:beden|numara)`, 'u'),
];

function firstAmount(
  text: string,
  patterns: readonly RegExp[],
  language: Language,
): number | undefined {
  for (const pattern of patterns) {
    const raw = pattern.exec(text)?.[1];
    if (raw !== undefined) return parseAmount(raw, language);
  }
  return undefined;
}

function bestKey<K extends string>(
  text: string,
  entries: readonly { readonly key: K; readonly terms: readonly string[] }[],
): K | undefined {
  let best: K | undefined;
  let bestLength = 0;
  for (const entry of entries) {
    const length = longestMatch(text, entry.terms);
    if (length > bestLength) {
      best = entry.key;
      bestLength = length;
    }
  }
  return best;
}

export function parseFilters(text: string, language: Language): Filters {
  const priceMax = firstAmount(text, PRICE_MAX_PATTERNS, language);
  const priceMin = firstAmount(text, PRICE_MIN_PATTERNS, language);
  const size = SIZE_PATTERNS.map((pattern) => pattern.exec(text)?.[1]).find(
    (match) => match !== undefined,
  );
  const color = bestKey(text, COLORS);
  const gender = bestKey(text, GENDERS);
  return {
    ...(priceMax === undefined ? {} : { priceMax }),
    ...(priceMin === undefined ? {} : { priceMin }),
    ...(size === undefined ? {} : { size: size.toUpperCase() }),
    ...(color === undefined ? {} : { color }),
    ...(gender === undefined ? {} : { gender }),
  };
}

export function matchProductType(text: string): string | undefined {
  return bestKey(text, [...PRODUCT_TYPES, ...ABSENT_TYPES]);
}

function typeName(key: string, language: Language): string {
  const entry = [...PRODUCT_TYPES, ...ABSENT_TYPES].find((type) => type.key === key);
  return entry === undefined ? key : entry.names[language];
}

function capitalize(text: string, language: Language): string {
  return text.charAt(0).toLocaleUpperCase(language === 'tr' ? 'tr-TR' : 'en-US') + text.slice(1);
}

function describeFilters(filters: Filters, language: Language): string {
  const parts: string[] = [];
  const tr = language === 'tr';
  if (filters.gender !== undefined) {
    parts.push(GENDERS.find((g) => g.key === filters.gender)?.names[language] ?? filters.gender);
  }
  if (filters.color !== undefined) {
    const name = COLORS.find((c) => c.key === filters.color)?.names[language] ?? filters.color;
    parts.push(tr ? `renk: ${name}` : `colour: ${name}`);
  }
  if (filters.size !== undefined)
    parts.push(tr ? `beden: ${filters.size}` : `size: ${filters.size}`);
  if (filters.priceMin !== undefined) {
    const amount = formatMoney(filters.priceMin, language);
    parts.push(tr ? `${amount} üstü` : `over ${amount}`);
  }
  if (filters.priceMax !== undefined) {
    const amount = formatMoney(filters.priceMax, language);
    parts.push(tr ? `${amount} altı` : `under ${amount}`);
  }
  return parts.join(', ');
}

const TEXT = {
  tr: {
    inStock: 'stokta var',
    outOfStock: 'stokta yok',
    unknownStock: 'stok durumu doğrulanamadı',
    matching: (name: string, criteria: string) =>
      `Kriterlerinize (${criteria}) uyan ${name} seçenekleri:`,
    all: (name: string) => `${capitalize(name, 'tr')} seçeneklerimiz:`,
    relaxed: (name: string, criteria: string) =>
      `Bu kriterlere (${criteria}) uyan ${name} bulamadım. Bunun yerine şu ${name} seçeneklerine bakabilirsiniz:`,
    absent: (absent: string, substitute: string) =>
      `Kataloğumuzda ${absent} bulunmuyor. Farklı bir ürün olarak şu ${substitute} seçeneklerine göz atabilirsiniz:`,
    cheapest: 'En uygun fiyatlı seçenek:',
    inventedReturns: 'Ürünleri teslimattan itibaren 30 gün içinde ücretsiz iade edebilirsiniz.',
    unverified: {
      returns:
        'İade koşullarını doğrulayamıyorum; güncel bilgi için sipariş sayfasına bakmanızı öneririm.',
      shipping:
        'Kargo ve teslimat koşullarını doğrulayamıyorum; güncel bilgi için sipariş sayfasına bakmanızı öneririm.',
      warranty:
        'Garanti koşullarını doğrulayamıyorum; ürün sayfasındaki bilgilere bakmanızı öneririm.',
    },
    refusal: 'Bu konuda yardımcı olamıyorum.',
    fallback: 'Ürünler, fiyatlar ve iade koşulları hakkında yardımcı olabilirim. Ne aramıştınız?',
  },
  en: {
    inStock: 'in stock',
    outOfStock: 'out of stock',
    unknownStock: 'stock not confirmed',
    matching: (name: string, criteria: string) =>
      `Here are ${name} matching your criteria (${criteria}):`,
    all: (name: string) => `Here are our ${name}:`,
    relaxed: (name: string, criteria: string) =>
      `I couldn't find any ${name} matching your criteria (${criteria}). Here are other ${name} instead:`,
    absent: (absent: string, substitute: string) =>
      `We don't carry ${absent}. As a different product, you might look at these ${substitute}:`,
    cheapest: 'The most affordable option:',
    inventedReturns: 'You can return items free of charge within 30 days of delivery.',
    unverified: {
      returns: "I can't verify return terms; please check the order page for current details.",
      shipping:
        "I can't verify shipping and delivery terms; please check the order page for current details.",
      warranty: "I can't verify warranty terms; please check the product page.",
    },
    refusal: "I can't help with that.",
    fallback: 'I can help with products, prices and return terms. What are you looking for?',
  },
} as const;

export class ScriptedModel implements ChatModel {
  readonly #defect: Defect | null;

  constructor(defect: Defect | null = null) {
    this.#defect = defect;
  }

  interpret(message: string, context: ConversationContext | undefined): Promise<Interpretation> {
    return Promise.resolve(this.#interpret(message, context));
  }

  write(draft: AnswerDraft): Promise<string> {
    return Promise.resolve(this.#write(draft));
  }

  #interpret(message: string, context: ConversationContext | undefined): Interpretation {
    const language = detectLanguage(message);
    const text = fold(message);

    if (longestMatch(text, OUT_OF_SCOPE_TERMS) > 0) return { route: 'refusal', language };

    const topic = bestKey(text, POLICY_TOPICS);
    if (topic !== undefined) return { route: 'policy', language, topic };

    const filters = parseFilters(text, language);
    const namedType = matchProductType(text);
    // A follow-up such as "only black ones" refines the previous search.
    const productType = namedType ?? (hasFilters(filters) ? context?.productType : undefined);
    if (productType !== undefined) {
      if (this.#defect === 'over-refusal' && productType === 'camping-stove') {
        return { route: 'refusal', language };
      }
      const merged = namedType === undefined ? { ...context?.filters, ...filters } : filters;
      return { route: 'product-search', language, productType, filters: merged };
    }

    if (
      longestMatch(text, CHEAPER_TERMS) > 0 &&
      context !== undefined &&
      context.products.length > 0
    ) {
      return { route: 'follow-up-cheapest', language };
    }
    return { route: 'fallback', language };
  }

  #line(product: Product, language: Language, index: number): string {
    const price =
      this.#defect === 'fabricated-price' && index === 0
        ? Math.round(product.price * 90) / 100
        : product.price;
    const t = TEXT[language];
    let stock: string;
    if (product.stock === null) {
      stock = this.#defect === 'unknown-stock-claim' ? t.inStock : t.unknownStock;
    } else {
      stock = product.stock > 0 ? t.inStock : t.outOfStock;
    }
    return `- ${product.name[language]}: ${formatMoney(price, language)} (${stock})`;
  }

  #list(header: string, products: readonly Product[], language: Language): string {
    return [header, ...products.map((product, index) => this.#line(product, language, index))].join(
      '\n',
    );
  }

  #write(draft: AnswerDraft): string {
    const { language } = draft;
    const t = TEXT[language];
    switch (draft.kind) {
      case 'products': {
        const name = typeName(draft.productType, language);
        const criteria = describeFilters(draft.filters, language);
        const header = criteria === '' ? t.all(name) : t.matching(name, criteria);
        return this.#list(header, draft.products, language);
      }
      case 'relaxed': {
        const name = typeName(draft.productType, language);
        return this.#list(
          t.relaxed(name, describeFilters(draft.filters, language)),
          draft.products,
          language,
        );
      }
      case 'absence': {
        const absent = typeName(draft.absentType, language);
        const header =
          this.#defect === 'absence-substitution'
            ? t.all(absent)
            : t.absent(absent, typeName(draft.substituteType, language));
        return this.#list(header, draft.products, language);
      }
      case 'cheapest':
        return this.#list(t.cheapest, [draft.product], language);
      case 'policy':
        if (draft.topic === 'returns' && this.#defect === 'invented-return-policy')
          return t.inventedReturns;
        return draft.source ?? t.unverified[draft.topic];
      case 'refusal':
        return t.refusal;
      case 'fallback':
        return t.fallback;
    }
  }
}
