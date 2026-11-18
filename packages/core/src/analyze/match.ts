// Evidence found by the data (ADR-0047): where an answer holds known rows,
// such as a catalog's products, is found by matching the answer's values to
// the rows', never by guessing from key names. A value sent as a decimal
// string, or held by one path or another, is read the way the profile reads
// a field (ADR-0067). Knows no domain; a pack names the rows and what their
// fields mean. Pure.

import { extractField, type JsonValue } from '../extract/response.ts';
import type { FieldSpec } from '../schema/profile.ts';

export interface KnownRows {
  /** The rows, such as a catalog's products: each a flat object of field → value. */
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
  /** The field that identifies a row. */
  readonly id: string;
}

export interface MatchedCollection {
  /** A JSONPath to the array's items, such as `$.data.products[*]`. */
  readonly items: string;
  /**
   * Per row field, where its value is in every item: a dotted path, or a
   * profile field read as a number or from a fallback (ADR-0067).
   */
  readonly fields: Readonly<Record<string, FieldSpec>>;
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

const absent = (value: JsonValue | undefined): boolean => value === undefined || value === null;

/** The one answer a rule gave; none when it gave two or more, or none at all. */
function onlyOne<T>(answers: readonly T[]): T | undefined {
  return answers.length === 1 ? answers[0] : undefined;
}

const idKey = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? JSON.stringify(value) : undefined;

/**
 * The arrays of the document whose every item holds a known row's id, at the
 * same path in each item. For each row field, the item path whose value
 * equals the row's in every item, when exactly one path does. Failing any
 * such path, the one path that does when read as a number, then the one pair
 * of paths that does as a fallback (ADR-0067). A field matched only by null,
 * or one whose value another field shares in every item, gets no path.
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
    const fields: Record<string, FieldSpec> = { [known.id]: idPath };
    const firstPaths = [...(leaves[0]?.keys() ?? [])];
    const allPaths = [...new Set(leaves.flatMap((item) => [...item.keys()]))];
    for (const column of columns) {
      if (column === known.id) continue;
      if (rows.every((row) => row[column] === null || row[column] === undefined)) continue;
      // Indistinguishable from another field in every item: no path for it.
      const twin = columns.some(
        (other) => other !== column && rows.every((row) => same(row[column], row[other])),
      );
      if (twin) continue;
      const found = fieldFor(column, items, leaves, rows, firstPaths, allPaths);
      if (found !== undefined) fields[column] = found;
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

/**
 * Where a row field is in the items, by ADR-0067's rules in order: the first
 * rule with an answer decides, and two answers at it give none. Every answer
 * is read back by the profile's own field reader.
 */
function fieldFor(
  column: string,
  items: readonly { [key: string]: JsonValue }[],
  leaves: readonly Map<string, JsonValue>[],
  rows: readonly Readonly<Record<string, JsonValue>>[],
  firstPaths: readonly string[],
  allPaths: readonly string[],
): FieldSpec | undefined {
  const readsBack = (spec: FieldSpec): boolean =>
    items.every((item, index) => {
      const issues: string[] = [];
      const value = extractField(item, spec, issues, column);
      return issues.length === 0 && same(value, rows[index]?.[column]);
    });

  // 1. A path as it is.
  const asIs = firstPaths.filter((leaf) =>
    leaves.every((item, index) => same(item.get(leaf), rows[index]?.[column])),
  );
  if (asIs.length > 0) return onlyOne(asIs);

  // 2. A path read as a number: a string in at least one item.
  const asNumber = firstPaths.filter(
    (leaf) =>
      leaves.some((item) => typeof item.get(leaf) === 'string') &&
      readsBack({ from: leaf, as: 'number' }),
  );
  if (asNumber.length > 0) {
    const leaf = onlyOne(asNumber);
    return leaf === undefined ? undefined : { from: leaf, as: 'number' };
  }

  // 3. A fallback of two paths: the first absent in one item, present in
  // another; the second holding a value in an item where the first is absent.
  const fallbacks: FieldSpec[] = [];
  for (const first of allPaths) {
    if (!leaves.some((item) => !absent(item.get(first)))) continue;
    for (const second of allPaths) {
      if (second === first) continue;
      if (!leaves.some((item) => absent(item.get(first)) && !absent(item.get(second)))) continue;
      const plain: FieldSpec = { from: [first, second] };
      const numeric: FieldSpec = { from: [first, second], as: 'number' };
      if (readsBack(plain)) fallbacks.push(plain);
      else if (readsBack(numeric)) fallbacks.push(numeric);
    }
  }
  return onlyOne(fallbacks);
}
