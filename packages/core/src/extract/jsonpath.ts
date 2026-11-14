// The JSONPath subset yokla evaluates (see JSON_PATH_PATTERN): `$` followed by
// `.name`, `['name']`, `[n]` and `[*]`. `[*]` selects every element of an array
// or every member value of an object. Pure; no dependencies.

import { JSON_PATH_PATTERN } from '../schema/common.ts';
import { childPath } from './member.ts';

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

/** Every value the path selects, in document order, with where it is (ADR-0030). */
export function selectJsonPath(
  document: unknown,
  path: string,
): { readonly path: string; readonly value: unknown }[] {
  let nodes: { path: string; value: unknown }[] = [{ path: '$', value: document }];
  for (const segment of parseJsonPath(path)) {
    nodes = nodes.flatMap((node) => {
      const { value } = node;
      if (segment.kind === 'name') {
        return isObject(value) && Object.hasOwn(value, segment.name)
          ? [{ path: childPath(node.path, segment.name), value: value[segment.name] }]
          : [];
      }
      if (segment.kind === 'index') {
        const items: readonly unknown[] = Array.isArray(value) ? value : [];
        return segment.index < items.length
          ? [{ path: `${node.path}[${String(segment.index)}]`, value: items[segment.index] }]
          : [];
      }
      if (Array.isArray(value)) {
        const items: readonly unknown[] = value;
        return items.map((item, index) => ({
          path: `${node.path}[${String(index)}]`,
          value: item,
        }));
      }
      return isObject(value)
        ? Object.entries(value).map(([name, item]) => ({
            path: childPath(node.path, name),
            value: item,
          }))
        : [];
    });
  }
  return nodes;
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
