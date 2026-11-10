// The JSONPath subset yokla evaluates (see JSON_PATH_PATTERN): `$` followed by
// `.name`, `['name']`, `[n]` and `[*]`. `[*]` selects every element of an array
// or every member value of an object. Pure; no dependencies.

import { JSON_PATH_PATTERN } from '../schema/common.ts';

export type Segment =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'wildcard' };

const SEGMENT = /\.([A-Za-z_][\w-]*)|\['([^'\\]*)'\]|\[(\d+)\]|\[\*\]/gu;

export function parseJsonPath(path: string): Segment[] {
  if (!JSON_PATH_PATTERN.test(path)) throw new Error(`invalid JSONPath "${path}"`);
  const segments: Segment[] = [];
  for (const match of path.slice(1).matchAll(SEGMENT)) {
    const [, dotted, quoted, index] = match;
    if (dotted !== undefined) segments.push({ kind: 'name', name: dotted });
    else if (quoted !== undefined) segments.push({ kind: 'name', name: quoted });
    else if (index !== undefined) segments.push({ kind: 'index', index: Number(index) });
    else segments.push({ kind: 'wildcard' });
  }
  return segments;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function step(value: unknown, segment: Segment): unknown[] {
  switch (segment.kind) {
    case 'name':
      return isObject(value) && Object.hasOwn(value, segment.name) ? [value[segment.name]] : [];
    case 'index':
      return Array.isArray(value) && segment.index < value.length ? [value[segment.index]] : [];
    case 'wildcard':
      if (Array.isArray(value)) return value;
      return isObject(value) ? Object.values(value) : [];
  }
}

/** Every value the path selects, in document order. */
export function queryJsonPath(document: unknown, path: string): unknown[] {
  let nodes: unknown[] = [document];
  for (const segment of parseJsonPath(path)) nodes = nodes.flatMap((node) => step(node, segment));
  return nodes;
}

/** The value at a dotted field path such as `price.amount`, or undefined. */
export function getFieldPath(item: unknown, path: string): unknown {
  let current: unknown = item;
  for (const name of path.split('.')) {
    if (!isObject(current) || !Object.hasOwn(current, name)) return undefined;
    current = current[name];
  }
  return current;
}
