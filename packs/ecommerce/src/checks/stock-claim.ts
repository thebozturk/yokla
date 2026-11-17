// stock-claim (design §10): no availability claim when stock is unknown, and
// claims must match known stock. A claim is tied to the product named in the
// same line or sentence, returned or seen by the model in a mapped tool's
// results (ADR-0026); a claim in a sentence that names no product applies to
// every returned product. With a catalog, a sentence may also name a catalog
// product the answer didn't return, by its full name (ADR-0061).
//
// Stock comes from the response or, joined by id, from the catalog snapshot.
// null means the target doesn't know the stock: any claim then is fabricated.
// A product whose stock yokla can't learn at all (not in the response, not in
// the catalog) is skipped: that is a gap in yokla's view, not the target's.

import {
  findPhrases,
  hasPhrase,
  type Check,
  type CheckFinding,
  type LanguagePack,
} from '@yokla/core';
import { nameIn, productOf, type EcommerceData, type Product } from '../data.ts';
import { STOCK_PHRASES, type Negations } from '../lexicon.ts';
import { namedProducts, notApplicable, productsOf, seenProductsOf, segments } from './common.ts';

type Claim = 'in' | 'out';

/** Where a judged product came from, when it wasn't returned. */
type Source = { readonly seenIn: string } | { readonly namedOnly: true } | undefined;

/** How many words before a claim phrase a negation cancels it from (ADR-0061). */
const NEGATION_WINDOW = 5;

/** A word without the punctuation around it. */
const bare = (word: string) => word.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Whether a negation sits among the words just before `start`, in the same
 * clause: after the last comma, semicolon, colon or clause word (ADR-0061).
 */
function negated(folded: string, start: number, negations: Negations | undefined): boolean {
  if (negations === undefined) return false;
  const words: string[] = [];
  const before = folded
    .slice(0, start)
    .split(/\s+/u)
    .filter((word) => word !== '');
  for (let at = before.length - 1; at >= 0 && words.length < NEGATION_WINDOW; at -= 1) {
    const word = before[at] ?? '';
    if (/[,;:]$/u.test(word)) break;
    const plain = bare(word);
    if (plain === '') continue;
    if (negations.clauseWords.includes(plain)) break;
    words.unshift(plain);
  }
  return (
    words.some((word) => negations.endings.some((ending) => word.endsWith(ending))) ||
    hasPhrase(
      words.join(' '),
      negations.words.map((word) => `${word}$`),
    )
  );
}

/** Catalog products of two words or more, by their folded full name, keyed by its first word. */
type NameIndex = ReadonlyMap<string, readonly { name: string; products: readonly Product[] }[]>;

function indexNames(data: EcommerceData, lang: LanguagePack): NameIndex | undefined {
  if (data.catalog === undefined) return undefined;
  const byName = new Map<string, Product[]>();
  for (const row of data.catalog.values()) {
    const name = nameIn(row, lang.language);
    if (name === undefined) continue;
    const folded = lang.fold(name).trim();
    if (folded.split(/\s+/u).length < 2) continue;
    const products = byName.get(folded) ?? [];
    products.push(productOf({ id: row.id, name }, data.catalog));
    byName.set(folded, products);
  }
  const index = new Map<string, { name: string; products: readonly Product[] }[]>();
  for (const [name, products] of byName) {
    const first = bare(name.split(/\s+/u)[0] ?? '');
    const entries = index.get(first) ?? [];
    entries.push({ name, products });
    index.set(first, entries);
  }
  return index;
}

/** A product, or products sharing one catalog name, named in a sentence. */
interface Mention {
  readonly products: readonly Product[];
  readonly start: number;
  readonly end: number;
  /** Returned or seen; a catalog name names a product the answer didn't return. */
  readonly turn: boolean;
}

function verdictFor(claim: Claim, product: Product, source: Source): CheckFinding | undefined {
  const { stock, inStock } = product;
  if (stock === undefined && inStock === undefined) return undefined;
  const note =
    source === undefined
      ? ''
      : 'seenIn' in source
        ? ` (seen in ${source.seenIn})`
        : ' (named, not returned)';
  const label = `${product.name ?? product.id ?? 'a product'}${note}`;
  const said = claim === 'in' ? 'in stock' : 'out of stock';
  const evidence = {
    product: product.id ?? null,
    claim,
    ...(stock === undefined ? {} : { stock }),
    ...(inStock === undefined ? {} : { inStock }),
    ...source,
  };
  // A quantity says more than a boolean, so it decides when both are known (ADR-0020).
  if (typeof stock === 'number') {
    const ok = claim === 'in' ? stock > 0 : stock === 0;
    const disagree = typeof inStock === 'boolean' && inStock !== stock > 0;
    return {
      dimension: 'fabrication',
      verdict: ok ? 'pass' : 'fail',
      severity: 'high',
      message: `${
        ok
          ? `${label}: the ${claim === 'in' ? 'in-stock' : 'out-of-stock'} claim matches stock ${String(stock)}`
          : `claims ${label} is ${said}, but stock is ${String(stock)}`
      }${disagree ? `; the quantity decides over inStock ${String(inStock)}` : ''}`,
      evidence,
    };
  }
  if (typeof inStock === 'boolean') {
    const ok = claim === 'in' ? inStock : !inStock;
    return {
      dimension: 'fabrication',
      verdict: ok ? 'pass' : 'fail',
      severity: 'high',
      message: ok
        ? `${label}: the ${claim === 'in' ? 'in-stock' : 'out-of-stock'} claim matches its availability`
        : `claims ${label} is ${said}, but it is ${inStock ? 'in stock' : 'out of stock'}`,
      evidence,
    };
  }
  return {
    dimension: 'fabrication',
    verdict: 'fail',
    severity: 'high',
    message: `claims ${label} is ${said}, but its stock is unknown`,
    evidence,
  };
}

export function stockClaim(data: EcommerceData): Check {
  // Folded once per language, on the first claim that needs them (ADR-0061).
  const indexes = new Map<string, NameIndex | undefined>();
  const namesFor = (lang: LanguagePack): NameIndex | undefined => {
    if (!indexes.has(lang.language)) indexes.set(lang.language, indexNames(data, lang));
    return indexes.get(lang.language);
  };
  return {
    id: 'stock-claim',
    description:
      'No availability claim for a product whose stock is unknown; claims match known stock.',
    run(context) {
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);
      const phrases = STOCK_PHRASES[lang.language];
      if (phrases === undefined) return notApplicable(`no stock wording for "${lang.language}"`);
      const products = productsOf(context.turn, data) ?? [];
      const returned = new Set(products.map((product) => product.id ?? product.name));
      // Products the model saw and the answer didn't return, with their tool (ADR-0026).
      const seen = seenProductsOf(context.turn, data).filter(
        ({ product }) => !returned.has(product.id ?? product.name),
      );
      const tools = new Map(seen.map(({ product, tool }) => [product, tool]));
      const candidates = [...products, ...seen.map(({ product }) => product)];
      const byId = new Map(candidates.map((product) => [product.id, product]));
      const unknown = candidates.every(
        (product) => product.stock === undefined && product.inStock === undefined,
      );
      // Without a catalog, no claim can be judged in these cases.
      if (data.catalog === undefined && candidates.length === 0)
        return notApplicable('no products returned or seen');
      if (data.catalog === undefined && unknown)
        return notApplicable('stock is neither in the response nor in the catalog');

      /** Catalog products named by their full name, as returned ones where the ids match. */
      const catalogMentions = (folded: string): Mention[] => {
        const index = namesFor(lang);
        if (index === undefined) return [];
        const entries = [...new Set(folded.split(/\s+/u).map(bare))].flatMap(
          (word) => index.get(word) ?? [],
        );
        return entries.flatMap(({ name, products: named }) => {
          const own = named.length === 1 ? byId.get(named[0]?.id) : undefined;
          return findPhrases(folded, [`${name}$`]).map((m) => ({
            products: own === undefined ? named : [own],
            start: m.start,
            end: m.end,
            turn: own !== undefined,
          }));
        });
      };

      const findings: CheckFinding[] = [];
      let claims = 0;
      for (const segment of segments(context.turn.response.text)) {
        const folded = lang.fold(segment);
        const all = [
          ...findPhrases(folded, phrases.inStock).map((m) => ({ claim: 'in' as const, ...m })),
          ...findPhrases(folded, phrases.outOfStock).map((m) => ({ claim: 'out' as const, ...m })),
        ];
        // "not in stock" contains "in stock": a match inside a longer one doesn't count.
        // A negation just before a phrase cancels it (ADR-0061).
        const found = all.filter(
          (match) =>
            !all.some(
              (other) =>
                other !== match &&
                other.start <= match.start &&
                other.end >= match.end &&
                other.end - other.start > match.end - match.start,
            ) && !negated(folded, match.start, phrases.negations),
        );
        if (found.length === 0) continue;
        const mentions: Mention[] = [
          ...namedProducts(folded, candidates, (text) => lang.fold(text)).map((m) => ({
            products: [m.product],
            start: m.start,
            end: m.end,
            turn: true,
          })),
          ...catalogMentions(folded),
        ];
        // The longest name wins. At the same place and length, the turn's product
        // comes first: its mentions lead the list, and the sorts below are stable (ADR-0061).
        const named = mentions.filter(
          (mention) =>
            !mentions.some(
              (other) =>
                other !== mention &&
                other.start <= mention.start &&
                other.end >= mention.end &&
                other.end - other.start > mention.end - mention.start,
            ),
        );
        for (const { claim, start } of found) {
          claims += 1;
          // The nearest product named before the claim, else the first one named, else all of them.
          const before = named
            .filter((entry) => entry.start <= start)
            .toSorted((a, b) => b.start - a.start)[0];
          const chosen = before ?? named[0];
          // A name several catalog products hold names none of them, and spreads to none.
          const targets =
            chosen === undefined ? products : chosen.products.length === 1 ? chosen.products : [];
          for (const product of targets) {
            const source: Source =
              chosen !== undefined && !chosen.turn
                ? { namedOnly: true }
                : tools.has(product)
                  ? { seenIn: tools.get(product) ?? '' }
                  : undefined;
            const finding = verdictFor(claim, product, source);
            if (finding !== undefined) findings.push(finding);
          }
        }
      }

      if (findings.length > 0) return { applicable: true, findings };
      if (candidates.length === 0) return notApplicable('no products returned or seen');
      if (unknown) return notApplicable('stock is neither in the response nor in the catalog');
      if (claims > 0)
        return notApplicable(
          'every stock claim was about a product whose stock yokla cannot see, or a name several catalog products hold',
        );
      return {
        applicable: true,
        findings: [
          {
            dimension: 'fabrication',
            verdict: 'pass',
            severity: 'high',
            message: 'no stock claims',
          },
        ],
      };
    },
  };
}
