// The data the ecommerce checks read: the catalog snapshot and the policy
// sources, loaded once per run through the reader the runtime injects.
// Evidence products come from the response; the catalog adds what the
// response doesn't carry (stock, type), joined by id.

import {
  getFieldPath,
  queryJsonPath,
  toJson,
  type EvidenceItem,
  type PackIo,
  type Profile,
} from '@yokla/core';
import { ecommerceProfile, type EcommerceProfile } from './schema.ts';

export interface CatalogRow {
  readonly id: string;
  readonly type: string | undefined;
  readonly price: number | undefined;
  readonly currency: string | undefined;
  /** null means unknown, undefined means the snapshot has no stock field. */
  readonly stock: number | null | undefined;
  /** Available or not (ADR-0020); null means unknown, undefined not mapped. */
  readonly inStock: boolean | null | undefined;
}

export interface PolicySource {
  readonly topic: string;
  /** Answers per language; `none` policies have no entry. */
  readonly answers: Readonly<Record<string, string>>;
}

export interface EcommerceData {
  readonly config: EcommerceProfile;
  readonly catalog: ReadonlyMap<string, CatalogRow> | undefined;
  readonly policies: ReadonlyMap<string, PolicySource>;
  /** Amounts read from the price source files (ADR-0020), with the file they came from. */
  readonly sourceAmounts: readonly { readonly amount: number; readonly file: string }[];
}

function jsonLines(text: string, path: string): unknown[] {
  return text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line !== '')
    .map(({ line, index }) => {
      try {
        return toJson(JSON.parse(line));
      } catch {
        throw new Error(`${path}:${String(index + 1)}: not valid JSON`);
      }
    });
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value);
  return undefined;
}

export function loadData(profile: Profile, io: PackIo): EcommerceData {
  const config = ecommerceProfile.parse(profile['ecommerce'] ?? {});

  let catalog: Map<string, CatalogRow> | undefined;
  if (config.catalog !== undefined) {
    const { fields, path } = config.catalog;
    catalog = new Map();
    for (const row of jsonLines(io.readText(path), path)) {
      const id = getFieldPath(row, fields.id);
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      const type = getFieldPath(row, fields.type);
      const currency =
        fields.currency === undefined ? undefined : getFieldPath(row, fields.currency);
      const stockValue = fields.stock === undefined ? undefined : getFieldPath(row, fields.stock);
      const inStockValue =
        fields.inStock === undefined ? undefined : getFieldPath(row, fields.inStock);
      catalog.set(String(id), {
        id: String(id),
        type: typeof type === 'string' ? type : undefined,
        price: asNumber(getFieldPath(row, fields.price)),
        currency: typeof currency === 'string' ? currency : undefined,
        stock: fields.stock === undefined ? undefined : (asNumber(stockValue) ?? null),
        inStock: fields.inStock === undefined ? undefined : (asBoolean(inStockValue) ?? null),
      });
    }
  }

  const policies = new Map<string, PolicySource>();
  for (const [topic, policy] of Object.entries(config.policies)) {
    if (policy.source === 'none') {
      policies.set(topic, { topic, answers: {} });
    } else if (policy.source === 'text') {
      policies.set(topic, { topic, answers: { '*': policy.text } });
    } else {
      const wanted = policy.topic ?? topic;
      const answers: Record<string, string> = {};
      for (const entry of jsonLines(io.readText(policy.path), policy.path)) {
        const entryTopic = getFieldPath(entry, 'topic');
        const lang = getFieldPath(entry, 'lang');
        const answer = getFieldPath(entry, 'answer');
        if (entryTopic === wanted && typeof lang === 'string' && typeof answer === 'string') {
          answers[lang] = answer;
        }
      }
      policies.set(topic, { topic, answers });
    }
  }
  const sourceAmounts: { amount: number; file: string }[] = [];
  for (const source of config.priceSources) {
    if (!('file' in source)) continue;
    const text = io.readText(source.file);
    let document: unknown;
    if (/\.(?:jsonl|ndjson)$/iu.test(source.file)) {
      document = jsonLines(text, source.file);
    } else {
      try {
        document = toJson(JSON.parse(text));
      } catch {
        throw new Error(`${source.file}: not valid JSON`);
      }
    }
    for (const path of source.paths) {
      for (const value of queryJsonPath(document, path)) {
        const amount = asNumber(value);
        if (amount !== undefined) sourceAmounts.push({ amount, file: source.file });
      }
    }
  }
  return { config, catalog, policies, sourceAmounts };
}

/** A product as the checks see it: the evidence item, completed from the catalog. */
export interface Product {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly price: number | undefined;
  readonly currency: string | undefined;
  /** null: unknown; undefined: neither the response nor the catalog says. */
  readonly stock: number | null | undefined;
  /** Available or not (ADR-0020); null: unknown; undefined: neither says. */
  readonly inStock: boolean | null | undefined;
  readonly type: string | undefined;
}

export function productOf(item: EvidenceItem, catalog: EcommerceData['catalog']): Product {
  const id =
    typeof item['id'] === 'string' || typeof item['id'] === 'number'
      ? String(item['id'])
      : undefined;
  const row = id === undefined ? undefined : catalog?.get(id);
  const stock = 'stock' in item ? (asNumber(item['stock']) ?? null) : row?.stock;
  const inStock = 'inStock' in item ? (asBoolean(item['inStock']) ?? null) : row?.inStock;
  const type = typeof item['category'] === 'string' ? item['category'] : row?.type;
  return {
    id,
    name: typeof item['name'] === 'string' ? item['name'] : undefined,
    price: asNumber(item['price']) ?? row?.price,
    currency: typeof item['currency'] === 'string' ? item['currency'] : row?.currency,
    stock,
    inStock,
    type,
  };
}
