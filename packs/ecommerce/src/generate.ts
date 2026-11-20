// The cases yokla generate writes from the catalog (ADR-0055, design §9):
// eight kinds, each with expectations computed from the data, never from an
// answer. Types are chosen as explore chooses its opening types (ADR-0046)
// and named by their words (ADR-0050); products in stock go in catalog order
// (ADR-0062), each by a name no other product holds (ADR-0063), at most one
// per type; amounts are written as the language writes them (ADR-0048).
// The checks that read the catalog judge the rest: price-grounded the prices
// an answer shows, stock-claim its stock claims.

import type { GenerateOptions, Generated, GeneratedCase, JsonValue } from '@yokla/core';
import { PRODUCTS } from './checks/common.ts';
import { nameIn, type CatalogRow, type EcommerceData } from './data.ts';
import { holdsAbsent } from './facts.ts';
import {
  currencyOf,
  emptyBand,
  medianPrice,
  PHRASINGS,
  pricesOf,
  spreadTypes,
  typeWordsIn,
  wordGroup,
  wordKey,
  type Phrasings,
  type WordGroup,
} from './intents.ts';

/** What generate asks besides explore's phrasings, per language. */
interface Wording {
  compare(a: string, b: string): string;
  stock(name: string): string;
  attribute(type: string, attribute: string, value: string): string;
  refine(amount: string): string;
  /** Cheaper than the product asked about first, without naming it again (ADR-0064). */
  readonly cheaper: string;
}

const WORDINGS: Readonly<Record<string, Wording>> = {
  tr: {
    compare: (a, b) => `${a} ile ${b} arasında hangisi daha iyi?`,
    stock: (name) => `${name} stokta var mı?`,
    attribute: (type, attribute, value) => `${attribute} ${value} olan ${type} var mı?`,
    refine: (amount) => `Peki ${amount} altında olan var mı?`,
    cheaper: 'İlk sorduğum üründen daha ucuz bir seçenek var mı?',
  },
  en: {
    compare: (a, b) => `Which is better, the ${a} or the ${b}?`,
    stock: (name) => `Is the ${name} in stock?`,
    attribute: (type, attribute, value) => `Do you have any ${type} with ${attribute} ${value}?`,
    refine: (amount) => `And under ${amount}?`,
    cheaper: 'Do you have anything cheaper than the one I asked about first?',
  },
};

export const GENERATED_KINDS = [
  'lookup',
  'absent-type',
  'empty-band',
  'attribute',
  'comparison',
  'refine',
  'cheaper',
  'unknown-stock',
] as const;
type Kind = (typeof GENERATED_KINDS)[number];

type Turn = GeneratedCase['turns'][number];

/** What every kind sees of one language. */
interface Scope {
  readonly language: string;
  readonly say: Phrasings;
  readonly word: Wording;
  readonly groups: readonly WordGroup[];
  readonly rows: readonly CatalogRow[];
  readonly data: EcommerceData;
  readonly absent: readonly string[];
  /** Names, as nameKey writes them, that more than one product holds (ADR-0063). */
  readonly shared: ReadonlySet<string>;
}

/** A name as names are compared: the language's lower case, runs of spaces as one. */
const nameKey = (name: string, language: string): string =>
  name.trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase(language);

/** The names more than one product holds in a language. */
function sharedNames(rows: readonly CatalogRow[], language: string): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = nameIn(row, language);
    if (name !== undefined) {
      const key = nameKey(name, language);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

/** One kind's cases in a language, or why it wrote none. */
type Made = {
  readonly cases: readonly Omit<GeneratedCase, 'kind' | 'language'>[];
  readonly none: string;
};

const includes = (...ids: string[]): Readonly<Record<string, JsonValue>> => ({
  evidence: { [PRODUCTS]: { includes: ids } },
});

const priced = (row: CatalogRow): string =>
  row.price === undefined
    ? ''
    : `, ${String(row.price)}${row.currency === undefined ? '' : ` ${row.currency}`}`;

/**
 * In stock, as far as the catalog says (ADR-0062): the quantity decides, as in
 * stock-claim (ADR-0020); a catalog that maps neither stock nor inStock can't
 * tell, so its products count.
 */
function stocked(row: CatalogRow): boolean {
  if (typeof row.stock === 'number') return row.stock > 0;
  if (row.inStock !== undefined) return row.inStock === true;
  return row.stock === undefined;
}

/** The stock a product was named by, for the case's basis (ADR-0062). */
function stockNote(row: CatalogRow): string | undefined {
  if (typeof row.stock === 'number') return `stock ${String(row.stock)}`;
  return row.inStock === true ? 'in stock' : undefined;
}

const noted = (row: CatalogRow): string => {
  const note = stockNote(row);
  return note === undefined ? '' : `, ${note}`;
};

/**
 * The first product of a group with a name in the language that no other
 * product holds (ADR-0063), and that name.
 */
function named(
  scope: Scope,
  group: WordGroup,
  also: (row: CatalogRow) => boolean = () => true,
): { readonly row: CatalogRow; readonly name: string } | undefined {
  for (const row of group.rows) {
    const name = nameIn(row, scope.language);
    if (name !== undefined && !scope.shared.has(nameKey(name, scope.language)) && also(row))
      return { row, name };
  }
  return undefined;
}

/** A product in stock of the same catalog type, cheaper than this one (ADR-0063). */
function cheaperThan(group: WordGroup, row: CatalogRow): CatalogRow | undefined {
  const { price } = row;
  if (price === undefined) return undefined;
  // A strict price comparison leaves the product itself out.
  return group.rows.find(
    (other) =>
      other.type === row.type && other.price !== undefined && other.price < price && stocked(other),
  );
}

const money = (scope: Scope, group: WordGroup, bound: number): string =>
  scope.say.money(String(bound), currencyOf(group));

const types = (group: WordGroup): JsonValue[] => [...group.types];

const KINDS: Readonly<Record<Kind, (scope: Scope) => Made>> = {
  lookup: (scope) => ({
    cases: scope.groups.flatMap((group) => {
      const found = named(scope, group, stocked);
      if (found === undefined) return [];
      const { row, name } = found;
      const turn: Turn = {
        user: scope.say.product(name),
        expect: { ...includes(row.id), answerable: true },
      };
      const basis = `catalog ${row.id}: "${name}"${priced(row)}${noted(row)}`;
      return [{ key: row.id, turns: [turn], basis }];
    }),
    none: 'no product in stock has a name in the language that no other product holds',
  }),

  'absent-type': (scope) => ({
    cases: scope.absent.flatMap((absent) => {
      if (present(scope, absent) !== undefined) return [];
      const turn: Turn = {
        user: scope.say.type(absent),
        expect: { absentType: absent, answerable: true },
      };
      const basis = `"${absent}" is no catalog type, level or ${scope.language} type label`;
      return [{ key: absent, turns: [turn], basis }];
    }),
    none:
      scope.absent.length === 0
        ? 'no --absent word was given'
        : 'every --absent word is in the catalog',
  }),

  'empty-band': (scope) => ({
    cases: scope.groups.flatMap((group) => {
      const prices = pricesOf(group.rows);
      const bound = emptyBand(prices);
      if (bound === undefined) return [];
      const turn: Turn = {
        user: scope.say.underPrice(group.words, money(scope, group, bound)),
        expect: { productType: types(group), filters: { maxPrice: bound } },
      };
      const basis = `${group.label} at most ${String(bound)}, below its lowest price ${String(prices[0])}`;
      return [{ key: group.words, turns: [turn], basis }];
    }),
    none: 'no type has a lowest price above 1',
  }),

  attribute: (scope) => {
    const mapped = Object.keys(scope.data.config.catalog?.fields.attributes ?? {});
    return {
      cases: scope.groups.flatMap((group) => {
        for (const attribute of mapped) {
          const row = group.rows.find(
            (candidate) => candidate.attributes?.[attribute] !== undefined && stocked(candidate),
          );
          const value = row?.attributes?.[attribute];
          if (row === undefined || value === undefined) continue;
          const turn: Turn = {
            user: scope.word.attribute(group.words, attribute, value),
            expect: { productType: types(group), filters: { attributes: { [attribute]: value } } },
          };
          const basis = `catalog ${row.id}: ${attribute} ${value}${noted(row)}, ${group.label}`;
          return [{ key: `${group.words} ${attribute} ${value}`, turns: [turn], basis }];
        }
        return [];
      }),
      none:
        mapped.length === 0
          ? 'no attribute is mapped (ecommerce.catalog.fields.attributes)'
          : 'no product in stock of the chosen types has a mapped attribute',
    };
  },

  comparison: (scope) => ({
    cases: scope.groups.flatMap((group) => {
      const first = named(scope, group, stocked);
      const second =
        first === undefined
          ? undefined
          : named(scope, group, (row) => row !== first.row && stocked(row));
      if (first === undefined || second === undefined) return [];
      const turn: Turn = {
        user: scope.word.compare(first.name, second.name),
        expect: { ...includes(first.row.id, second.row.id), answerable: true },
      };
      const notes = [first.row, second.row].map((row) => stockNote(row));
      const stock = notes.every((note) => note !== undefined) ? `; ${notes.join(' and ')}` : '';
      const basis = `catalog ${first.row.id} and ${second.row.id}, both ${group.label}${stock}`;
      return [{ key: `${first.row.id} ${second.row.id}`, turns: [turn], basis }];
    }),
    none: 'no type has two products in stock with names in the language that no other product holds',
  }),

  refine: (scope) => ({
    cases: scope.groups.flatMap((group) => {
      const median = medianPrice(pricesOf(group.rows));
      if (median === undefined) return [];
      const turns: Turn[] = [
        { user: scope.say.type(group.words), expect: { productType: types(group) } },
        {
          user: scope.word.refine(money(scope, group, median)),
          expect: { productType: types(group), filters: { maxPrice: median } },
        },
      ];
      const basis = `${group.label}, then at most ${String(median)}, its median price`;
      return [{ key: group.words, turns, basis }];
    }),
    none: 'no type has a price',
  }),

  cheaper: (scope) => ({
    cases: scope.groups.flatMap((group) => {
      const found = named(
        scope,
        group,
        (row) => stocked(row) && cheaperThan(group, row) !== undefined,
      );
      const price = found?.row.price;
      const cheaper = found === undefined ? undefined : cheaperThan(group, found.row);
      if (found === undefined || price === undefined || cheaper === undefined) return [];
      const turns: Turn[] = [
        { user: scope.say.product(found.name), expect: includes(found.row.id) },
        {
          user: scope.word.cheaper,
          // The catalog holds a cheaper product in stock, so one must be shown (ADR-0063).
          expect: {
            productType: types(group),
            filters: { maxPrice: price },
            evidence: { [PRODUCTS]: { min: 1 } },
          },
        },
      ];
      const basis = `catalog ${found.row.id}${priced(found.row)}${noted(found.row)}, then ${group.label} at most its price; ${cheaper.id} is cheaper and in stock`;
      return [{ key: found.row.id, turns, basis }];
    }),
    none: 'no product in stock with a name of its own has a cheaper one in stock of its type',
  }),

  'unknown-stock': (scope) => ({
    cases: scope.groups.flatMap((group) => {
      const found = named(
        scope,
        group,
        (row) => row.stock === null || (row.stock === undefined && row.inStock === null),
      );
      if (found === undefined) return [];
      const turn: Turn = {
        user: scope.word.stock(found.name),
        expect: { ...includes(found.row.id), answerable: true },
      };
      return [
        { key: found.row.id, turns: [turn], basis: `catalog ${found.row.id}: stock unknown` },
      ];
    }),
    none: 'no product with a name of its own in the language has an unknown stock',
  }),
};

/** A product that holds a word the person expects absent: by a type's level, or its label. */
function present(scope: Scope, absent: string): CatalogRow | undefined {
  const separator = scope.data.config.typeSeparator;
  const key = wordKey(absent, scope.language);
  return scope.rows.find((row) => {
    const label = row.typeLabels?.[scope.language] ?? row.typeLabels?.['*'];
    return (
      (row.type !== undefined && holdsAbsent(row.type, absent, separator)) ||
      (label !== undefined && wordKey(label, scope.language) === key)
    );
  });
}

/**
 * The products lookup asks about in a language, in its order: in stock, by a
 * name no other product holds, one per type. Offers name them too (ADR-0080).
 */
export function lookupProducts(
  data: EcommerceData,
  language: string,
): { readonly row: CatalogRow; readonly name: string; readonly group: WordGroup }[] {
  const { catalog } = data;
  const say = PHRASINGS[language];
  const word = WORDINGS[language];
  if (catalog === undefined || say === undefined || word === undefined) return [];
  const rows = [...catalog.values()];
  const separator = data.config.typeSeparator;
  const wordsOf = typeWordsIn(rows, separator, language);
  const keyOf = (type: string) => wordKey(wordsOf(type), language);
  const groups = spreadTypes(rows, separator, Number.POSITIVE_INFINITY, keyOf).map((type) =>
    wordGroup(type, rows, wordsOf, language),
  );
  const shared = sharedNames(rows, language);
  const scope: Scope = { language, say, word, groups, rows, data, absent: [], shared };
  return groups.flatMap((group) => {
    const found = named(scope, group, stocked);
    return found === undefined ? [] : [{ ...found, group }];
  });
}

/** The cases of every kind from the catalog, in each language there are phrasings for. */
export function ecommerceGenerate(
  data: EcommerceData,
): ((options: GenerateOptions) => Generated) | undefined {
  const { catalog } = data;
  if (catalog === undefined) return undefined;
  const rows = [...catalog.values()];
  const separator = data.config.typeSeparator;
  return (options) => {
    const cases: GeneratedCase[] = [];
    const notes: string[] = [];
    for (const language of options.languages) {
      const say = PHRASINGS[language];
      const word = WORDINGS[language];
      if (say === undefined || word === undefined) {
        notes.push(`${language}: the pack has no phrasings for it`);
        continue;
      }
      const wordsOf = typeWordsIn(rows, separator, language);
      const keyOf = (type: string) => wordKey(wordsOf(type), language);
      const groups = spreadTypes(rows, separator, Number.POSITIVE_INFINITY, keyOf).map((type) =>
        wordGroup(type, rows, wordsOf, language),
      );
      const absent = options.absent[language] ?? [];
      const shared = sharedNames(rows, language);
      const scope: Scope = { language, say, word, groups, rows, data, absent, shared };
      for (const absentWord of absent) {
        const holder = present(scope, absentWord);
        if (holder !== undefined) {
          notes.push(
            `absent-type (${language}): "${absentWord}" is in the catalog, as ${holder.id}`,
          );
        }
      }
      for (const kind of GENERATED_KINDS) {
        const made = KINDS[kind](scope);
        if (made.cases.length === 0) notes.push(`${kind} (${language}): ${made.none}`);
        cases.push(...made.cases.slice(0, options.perKind).map((c) => ({ kind, language, ...c })));
      }
    }
    return { cases, notes };
  };
}
