// What the e-commerce pack proposes from the target's own data (ADR-0047):
// the catalog and its fields, its type separator, the languages of its names,
// the policies' sources, and the messages that make the target show products.
// Key names say which column is which only for the data itself; where the
// products are in an answer is found by their values (core's matchRows).

import type {
  DataAnalysis,
  DataAnalyzer,
  DataEntry,
  DataFile,
  DataRow,
  JsonValue,
  LanguagePack,
  ProbedRows,
} from '@yokla/core';
import { PHRASINGS } from './intents.ts';
import { POLICY_TOPIC_PHRASES } from './lexicon.ts';

/** Key names of a catalog's columns, compared in lower case, in Turkish and English. */
export const CATALOG_KEYS = {
  id: ['id', 'sku', 'product_id', 'productid', 'item_id', 'urun_id', 'urun_kodu', 'stok_kodu'],
  price: ['price', 'fiyat', 'unit_price', 'sale_price', 'satis_fiyati'],
  currency: ['currency', 'para_birimi', 'doviz'],
  stock: ['stock', 'stok', 'quantity', 'qty', 'stock_quantity', 'stok_adedi'],
  type: ['category_path', 'category', 'product_type', 'type', 'kategori', 'urun_tipi'],
  name: ['name', 'title', 'product_name', 'urun_adi', 'baslik'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** The evidence field each catalog column is in an answer (data.ts productOf). */
const EVIDENCE_FIELD = {
  id: 'id',
  price: 'price',
  currency: 'currency',
  stock: 'stock',
  type: 'category',
  name: 'name',
} as const;

const SEPARATORS = ['/', '>'] as const;

type Column = keyof typeof CATALOG_KEYS;

/** Columns, by key, that hold the same kind of value in every row. */
const VALID: Readonly<Record<Column, (value: JsonValue | undefined) => boolean>> = {
  id: (value) => (typeof value === 'string' && value.trim() !== '') || typeof value === 'number',
  price: (value) => typeof value === 'number' && value > 0,
  currency: (value) => typeof value === 'string' && /^[A-Z]{3}$/u.test(value),
  stock: (value) => value === null || (Number.isInteger(value) && Number(value) >= 0),
  type: (value) => typeof value === 'string' && value.trim() !== '',
  name: (value) => typeof value === 'string' && value.trim() !== '',
};

const isJsonLines = (file: DataFile): boolean => file.path.toLowerCase().endsWith('.jsonl');

/** The first key of `names` every row holds, with a value `valid` takes in every row. */
function columnOf(
  rows: readonly DataRow[],
  names: readonly string[],
  valid: (value: JsonValue | undefined) => boolean,
): string | undefined {
  const keys = Object.keys(rows[0] ?? {});
  for (const name of names) {
    const key = keys.find((candidate) => candidate.toLowerCase() === name);
    if (key !== undefined && rows.every((row) => valid(row[key]))) return key;
  }
  return undefined;
}

/** Per-language name columns, such as name_tr and name_en, in the order of the first row. */
function namesByLanguage(
  rows: readonly DataRow[],
  languages: readonly LanguagePack[],
): Record<string, string> {
  const codes = new Set(languages.map((pack) => pack.language));
  const found: Record<string, string> = {};
  for (const key of Object.keys(rows[0] ?? {})) {
    const match = /^(.+)[_-]([a-z]{2})$/u.exec(key.toLowerCase());
    const [, base, code] = match ?? [];
    if (base === undefined || code === undefined || !codes.has(code)) continue;
    if (!(CATALOG_KEYS.name as readonly string[]).includes(base)) continue;
    if (code in found || !rows.every((row) => VALID.name(row[key]))) continue;
    found[code] = key;
  }
  return found;
}

interface Catalog {
  readonly file: DataFile;
  readonly columns: Partial<Record<Column, string>>;
  readonly names: Record<string, string>;
}

/** A JSON Lines file with a unique id-like column and a positive price-like one. */
function catalogOf(file: DataFile, languages: readonly LanguagePack[]): Catalog | undefined {
  const { rows } = file;
  if (rows.length === 0 || !isJsonLines(file)) return undefined;
  const id = columnOf(rows, CATALOG_KEYS.id, VALID.id);
  const price = columnOf(rows, CATALOG_KEYS.price, VALID.price);
  if (id === undefined || price === undefined) return undefined;
  if (new Set(rows.map((row) => JSON.stringify(row[id]))).size !== rows.length) return undefined;
  const columns: Partial<Record<Column, string>> = { id, price };
  for (const column of ['currency', 'stock', 'type', 'name'] as const) {
    const key = columnOf(rows, CATALOG_KEYS[column], VALID[column]);
    if (key !== undefined) columns[column] = key;
  }
  return { file, columns, names: namesByLanguage(rows, languages) };
}

const rowsText = (count: number) => `${String(count)} of ${String(count)} rows`;

function catalogEntries(catalog: Catalog): DataEntry[] {
  const { file, columns, names } = catalog;
  const fields: Record<string, JsonValue> = {};
  for (const column of ['id', 'type', 'price', 'currency', 'stock'] as const) {
    const key = columns[column];
    if (key !== undefined) fields[column] = key;
  }
  const nameKeys = Object.keys(names).length > 0 ? Object.values(names) : [];
  if (nameKeys.length > 0) fields['name'] = { ...names };
  else if (columns.name !== undefined) fields['name'] = columns.name;
  const said = Object.entries(columns)
    .map(([column, key]) => `${column} as ${key}`)
    .join(', ');
  const entries: DataEntry[] = [
    { pointer: '/ecommerce/catalog/kind', value: 'file', evidence: `${file.path}: JSON Lines` },
    {
      pointer: '/ecommerce/catalog/path',
      value: file.path,
      evidence: `${file.path}: ${rowsText(file.rows.length)}, with ${said}`,
    },
    ...Object.entries(fields).map(([field, value]) => ({
      pointer: `/ecommerce/catalog/fields/${field}`,
      value,
      evidence: `${file.path}: ${typeof value === 'string' ? value : nameKeys.join(' and ')} in ${rowsText(file.rows.length)}`,
    })),
  ];
  const type = columns.type;
  if (type !== undefined) {
    const separator = SEPARATORS.find((mark) =>
      file.rows.every((row) => {
        const value = row[type];
        return typeof value === 'string' && value.includes(mark);
      }),
    );
    if (separator !== undefined) {
      entries.push({
        pointer: '/ecommerce/typeSeparator',
        value: separator,
        evidence: `${file.path}: every ${type} holds "${separator}"`,
      });
    }
  }
  return entries;
}

/** The policy topics the pack's lexicon knows, in its order. */
function knownTopics(): string[] {
  return [
    ...new Set(Object.values(POLICY_TOPIC_PHRASES).flatMap((byTopic) => Object.keys(byTopic))),
  ];
}

/** JSON Lines files whose rows carry a topic and an answer, the shape the pack reads a FAQ in. */
function policyEntries(files: readonly DataFile[]): DataEntry[] {
  const faqs = files.filter(
    (file) =>
      isJsonLines(file) &&
      file.rows.length > 0 &&
      file.rows.every(
        (row) => typeof row['topic'] === 'string' && typeof row['answer'] === 'string',
      ),
  );
  return knownTopics().map((topic): DataEntry => {
    const faq = faqs.find((file) => file.rows.some((row) => row['topic'] === topic));
    if (faq === undefined) {
      return {
        pointer: `/ecommerce/policies/${topic}`,
        value: { source: 'none' },
        evidence: 'no data file speaks of it; say so only if the target has no source for it',
      };
    }
    const count = faq.rows.filter((row) => row['topic'] === topic).length;
    return {
      pointer: `/ecommerce/policies/${topic}`,
      value: { source: 'faq', path: faq.path },
      evidence: `${faq.path}: ${String(count)} row(s) with topic ${topic}`,
    };
  });
}

/** A type as words: its last level, with dashes and underscores as spaces. */
function typeWords(type: string, separator: string | undefined): string {
  const last = separator === undefined ? type : (type.split(separator).at(-1) ?? type);
  return last.replaceAll(/[-_]+/gu, ' ').trim();
}

/** The rows to find in the answers, and the type question and cart request that show them. */
function probedRows(
  catalog: Catalog,
  language: string,
  separator: string | undefined,
): ProbedRows | undefined {
  const say = PHRASINGS[language];
  const { columns, names, file } = catalog;
  const nameColumn = names[language] ?? columns.name;
  const typeColumn = columns.type;
  const idColumn = columns.id;
  if (say === undefined || typeColumn === undefined || idColumn === undefined) return undefined;
  const first = file.rows.find(
    (row) => nameColumn === undefined || typeof row[nameColumn] === 'string',
  );
  const type = first?.[typeColumn];
  if (typeof type !== 'string') return undefined;
  const evidenceFields: Record<string, string> = {};
  for (const column of ['id', 'price', 'currency', 'stock', 'type'] as const) {
    const key = columns[column];
    if (key !== undefined) evidenceFields[key] = EVIDENCE_FIELD[column];
  }
  for (const key of [
    ...Object.values(names),
    ...(columns.name === undefined ? [] : [columns.name]),
  ]) {
    evidenceFields[key] = 'name';
  }
  // Every other column holds an attribute, such as a colour, under its own name.
  for (const key of new Set(file.rows.flatMap((row) => Object.keys(row)))) {
    if (!(key in evidenceFields) && /^[A-Za-z_][\w-]*$/u.test(key)) evidenceFields[key] = key;
  }
  return {
    rows: file.rows,
    id: idColumn,
    evidenceFields,
    probe: { message: say.type(typeWords(type, separator)), collection: 'products' },
    next: (shown) => {
      const name = nameColumn === undefined ? undefined : shown[0]?.[nameColumn];
      return typeof name === 'string' ? { message: say.cart(name), collection: 'cart' } : undefined;
    },
  };
}

export const ecommerceAnalyzer: DataAnalyzer = {
  analyze(files, { languages, given }): DataAnalysis {
    const catalog = files
      .map((file) => catalogOf(file, languages))
      .filter((found): found is Catalog => found !== undefined)
      .toSorted((a, b) => b.file.rows.length - a.file.rows.length)[0];
    const entries: DataEntry[] = [];
    let probed: ProbedRows | undefined;
    if (catalog !== undefined) {
      const languageCodes = Object.keys(catalog.names);
      if (given.length === 0 && languageCodes.length > 0) {
        entries.push({
          pointer: '/languages',
          value: languageCodes,
          evidence: `${catalog.file.path}: names in ${languageCodes.join(' and ')}`,
        });
      }
      entries.push({
        pointer: '/domain',
        value: 'ecommerce',
        evidence: `${catalog.file.path}: a catalog`,
      });
      const fromCatalog = catalogEntries(catalog);
      entries.push(...fromCatalog);
      const separator = fromCatalog.find(
        (entry) => entry.pointer === '/ecommerce/typeSeparator',
      )?.value;
      const language = given[0] ?? languageCodes[0];
      if (language !== undefined) {
        probed = probedRows(
          catalog,
          language,
          typeof separator === 'string' ? separator : undefined,
        );
      }
    }
    entries.push(...(catalog === undefined ? [] : policyEntries(files)));
    return probed === undefined ? { entries } : { entries, probed };
  },
};
