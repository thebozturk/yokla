// Evidence found by the data (ADR-0047): where an answer holds known rows,
// such as a catalog's products, is found by matching the answer's values to
// the rows', never by guessing from key names. Knows no domain; a pack names
// the rows and what their fields mean. Pure.

import type { JsonValue } from '../extract/response.ts';

export interface KnownRows {
  /** The rows, such as a catalog's products: each a flat object of field → value. */
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
  /** The field that identifies a row. */
  readonly id: string;
}

export interface MatchedCollection {
  /** A JSONPath to the array's items, such as `$.data.products[*]`. */
  readonly items: string;
  /** Per row field, the item's dotted path whose value equals it in every item. */
  readonly fields: Readonly<Record<string, string>>;
  /** The items, each matched to a row by its id. */
  readonly matched: number;
  /** The ids of the rows the items matched, in the items' order. */
  readonly ids: readonly JsonValue[];
}

const IDENTIFIER = /^[A-Za-z_][\w-]*$/u;

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key the profile's JSONPath can name: by name, or quoted without a quote or backslash. */
const NAMEABLE = /^[^'\\]*$/u;

function memberPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}['${key}']`;
}

/** An item's scalar leaves by dotted path; keys a dotted path can't name are left out. */
function itemLeaves(item: { [key: string]: JsonValue }): Map<string, JsonValue> {
  const leaves = new Map<string, JsonValue>();
  const walk = (value: { [key: string]: JsonValue }, prefix: string): void => {
    for (const [key, child] of Object.entries(value)) {
      if (!IDENTIFIER.test(key)) continue;
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (isObject(child)) walk(child, path);
      else if (!Array.isArray(child)) leaves.set(path, child);
    }
  };
  walk(item, '');
  return leaves;
}

/** Every array of objects in the document, with its JSONPath. */
function arraysOfObjects(
  document: JsonValue,
): { path: string; items: { [key: string]: JsonValue }[] }[] {
  const found: { path: string; items: { [key: string]: JsonValue }[] }[] = [];
  const walk = (value: JsonValue, path: string): void => {
    if (Array.isArray(value)) {
      const items = value.filter(isObject);
      if (value.length > 0 && items.length === value.length) found.push({ path, items });
      for (const item of value) walk(item, `${path}[*]`);
    } else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (NAMEABLE.test(key)) walk(child, memberPath(path, key));
      }
    }
  };
  walk(document, '$');
  return found;
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined): boolean =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

const idKey = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? JSON.stringify(value) : undefined;

/**
 * The arrays of the document whose every item holds a known row's id, at the
 * same path in each item. For each row field, the item path whose value
 * equals the row's in every item, when exactly one path does. A field matched
 * only by null, or one whose value another field shares in every item, gets
 * no path.
 */
export function matchRows(document: JsonValue, known: KnownRows): MatchedCollection[] {
  const byId = new Map<string, Readonly<Record<string, JsonValue>>>();
  for (const row of known.rows) {
    const key = idKey(row[known.id]);
    if (key !== undefined) byId.set(key, row);
  }
  const collections: MatchedCollection[] = [];
  for (const { path, items } of arraysOfObjects(document)) {
    const leaves = items.map(itemLeaves);
    // The path that holds a known id in every item.
    const idPaths = [...(leaves[0]?.keys() ?? [])].filter((leaf) =>
      leaves.every((item) => {
        const key = idKey(item.get(leaf));
        return key !== undefined && byId.has(key);
      }),
    );
    const [idPath] = idPaths;
    if (idPaths.length !== 1 || idPath === undefined) continue;
    const rows = leaves.map((item) => byId.get(idKey(item.get(idPath)) ?? '') ?? {});
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const fields: Record<string, string> = { [known.id]: idPath };
    for (const column of columns) {
      if (column === known.id) continue;
      if (rows.every((row) => row[column] === null || row[column] === undefined)) continue;
      // Indistinguishable from another field in every item: no path for it.
      const twin = columns.some(
        (other) => other !== column && rows.every((row) => same(row[column], row[other])),
      );
      if (twin) continue;
      const paths = [...(leaves[0]?.keys() ?? [])].filter((leaf) =>
        leaves.every((item, index) => same(item.get(leaf), rows[index]?.[column])),
      );
      const [only] = paths;
      if (paths.length === 1 && only !== undefined) fields[column] = only;
    }
    collections.push({
      items: `${path}[*]`,
      fields,
      matched: items.length,
      ids: leaves.map((item) => item.get(idPath) ?? null),
    });
  }
  return collections;
}
