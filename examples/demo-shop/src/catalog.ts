import { readFileSync } from 'node:fs';
import type { Language } from './language.ts';
import type { Color, Gender } from './vocabulary.ts';

export interface Product {
  readonly id: string;
  readonly categoryPath: string;
  /** The last segment of the category path, e.g. "tent". */
  readonly type: string;
  readonly name: Readonly<Record<Language, string>>;
  readonly price: number;
  readonly currency: string;
  /** null means unknown, not zero. */
  readonly stock: number | null;
  readonly size?: string;
  readonly color?: Color;
  readonly gender?: Gender;
}

export interface FaqEntry {
  readonly id: string;
  readonly topic: string;
  readonly lang: Language;
  readonly question: string;
  readonly answer: string;
}

export interface ShopData {
  readonly catalog: readonly Product[];
  readonly faq: readonly FaqEntry[];
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonl(text: string, source: string): { row: Row; where: string }[] {
  return text
    .split('\n')
    .map((line, index) => ({ line, where: `${source}:${String(index + 1)}` }))
    .filter(({ line }) => line.trim() !== '')
    .map(({ line, where }) => {
      const value: unknown = JSON.parse(line);
      if (!isRow(value)) throw new Error(`${where}: expected a JSON object`);
      return { row: value, where };
    });
}

function str(row: Row, key: string, where: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value === '')
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  return value;
}

function optionalStr(row: Row, key: string, where: string): string | undefined {
  return row[key] === undefined ? undefined : str(row, key, where);
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  key: string,
  where: string,
): T | undefined {
  if (value === undefined) return undefined;
  const found = allowed.find((item) => item === value);
  if (found === undefined)
    throw new Error(`${where}: "${key}" must be one of ${allowed.join(', ')}`);
  return found;
}

const COLOR_KEYS: readonly Color[] = ['black', 'blue', 'red', 'green', 'grey', 'orange'];
const GENDER_KEYS: readonly Gender[] = ['women', 'men'];
const LANGUAGES: readonly Language[] = ['tr', 'en'];

export function parseCatalog(text: string, source = 'catalog.jsonl'): Product[] {
  const seen = new Set<string>();
  return parseJsonl(text, source).map(({ row, where }) => {
    const id = str(row, 'id', where);
    if (seen.has(id)) throw new Error(`${where}: duplicate id ${id}`);
    seen.add(id);

    const categoryPath = str(row, 'category_path', where);
    const type = categoryPath.split('/').at(-1) ?? '';
    const price = row['price'];
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      throw new Error(`${where}: "price" must be a non-negative number`);
    }
    const stock = row['stock'];
    if (stock !== null && (typeof stock !== 'number' || !Number.isInteger(stock) || stock < 0)) {
      throw new Error(`${where}: "stock" must be a non-negative integer or null`);
    }
    const size = optionalStr(row, 'size', where);
    const color = oneOf(optionalStr(row, 'color', where), COLOR_KEYS, 'color', where);
    const gender = oneOf(optionalStr(row, 'gender', where), GENDER_KEYS, 'gender', where);

    return {
      id,
      categoryPath,
      type,
      name: { tr: str(row, 'name_tr', where), en: str(row, 'name_en', where) },
      price,
      currency: str(row, 'currency', where),
      stock,
      ...(size === undefined ? {} : { size }),
      ...(color === undefined ? {} : { color }),
      ...(gender === undefined ? {} : { gender }),
    };
  });
}

export function parseFaq(text: string, source = 'faq.jsonl'): FaqEntry[] {
  return parseJsonl(text, source).map(({ row, where }) => {
    const lang = oneOf(str(row, 'lang', where), LANGUAGES, 'lang', where);
    if (lang === undefined) throw new Error(`${where}: "lang" is required`);
    return {
      id: str(row, 'id', where),
      topic: str(row, 'topic', where),
      lang,
      question: str(row, 'question', where),
      answer: str(row, 'answer', where),
    };
  });
}

/** The bundled reference data in examples/demo-shop/data. */
export const DATA_DIR = new URL('../data/', import.meta.url);

export function loadShopData(dir: URL = DATA_DIR): ShopData {
  return {
    catalog: parseCatalog(readFileSync(new URL('catalog.jsonl', dir), 'utf8')),
    faq: parseFaq(readFileSync(new URL('faq.jsonl', dir), 'utf8')),
  };
}
