// Turns a target's response body into what checks read: the answer text, the
// route, the target's own id and the evidence collections, as the profile maps
// them. Problems are reported, never hidden: a missing field is a measurement
// problem, not a pass (design P5).

import type { FieldSpec, ProfileTarget } from '../schema/profile.ts';
import { getFieldPath, queryJsonPath } from './jsonpath.ts';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type EvidenceItem = Readonly<Record<string, JsonValue>>;

export interface ExtractedResponse {
  readonly text: string | undefined;
  readonly route: string | undefined;
  readonly id: string | undefined;
  readonly evidence: Readonly<Record<string, readonly EvidenceItem[]>>;
  /** Mapping problems, such as a missing answer text or a value that can't be converted. */
  readonly issues: readonly string[];
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/u;

export function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toJson(inner)]));
  }
  return null;
}

type Conversion = 'string' | 'number' | 'boolean';

function convert(value: JsonValue, as: Conversion): JsonValue | undefined {
  switch (as) {
    case 'number':
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && DECIMAL.test(value.trim())) return Number(value.trim());
      return undefined;
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return undefined;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return undefined;
  }
}

/**
 * Reads one field. Paths are tried in order; the first value that is present
 * and not null wins. An unconvertible value is reported and read as null.
 */
export function extractField(
  item: unknown,
  spec: FieldSpec,
  issues: string[],
  where: string,
): JsonValue {
  const paths =
    typeof spec === 'string' ? [spec] : typeof spec.from === 'string' ? [spec.from] : spec.from;
  const as = typeof spec === 'string' ? undefined : spec.as;
  for (const path of paths) {
    const raw = getFieldPath(item, path);
    if (raw === undefined || raw === null) continue;
    const value = toJson(raw);
    if (as === undefined) return value;
    const converted = convert(value, as);
    if (converted !== undefined) return converted;
    issues.push(`${where}: value at "${path}" can't be read as ${as}: ${JSON.stringify(value)}`);
    return null;
  }
  return null;
}

function scalarAt(body: unknown, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const [first] = queryJsonPath(body, path);
  return typeof first === 'string' || typeof first === 'number' ? String(first) : undefined;
}

export function extractResponse(
  body: unknown,
  mapping: ProfileTarget['response'],
): ExtractedResponse {
  const issues: string[] = [];

  let text: string | undefined;
  if (typeof mapping.text === 'string') {
    const [textNode] = queryJsonPath(body, mapping.text);
    text = typeof textNode === 'string' ? textNode : undefined;
  } else {
    // Several paths (ADR-0020): every string at each, in order, a blank line between.
    // An empty string still means the answer has text, just none to show.
    const pieces = mapping.text.flatMap((path) =>
      queryJsonPath(body, path).filter((node): node is string => typeof node === 'string'),
    );
    text = pieces.length === 0 ? undefined : pieces.filter((piece) => piece !== '').join('\n\n');
  }
  if (text === undefined) {
    const where = typeof mapping.text === 'string' ? mapping.text : mapping.text.join(', ');
    issues.push(`answer text not found at ${where}`);
  }

  const route = scalarAt(body, mapping.route);
  if (mapping.route !== undefined && route === undefined)
    issues.push(`route not found at ${mapping.route}`);
  const id = scalarAt(body, mapping.id);
  if (mapping.id !== undefined && id === undefined)
    issues.push(`target id not found at ${mapping.id}`);

  const evidence: Record<string, EvidenceItem[]> = {};
  for (const [name, collection] of Object.entries(mapping.evidence ?? {})) {
    const paths = typeof collection.items === 'string' ? [collection.items] : collection.items;
    const items: EvidenceItem[] = [];
    // Several paths (ADR-0020): an id an earlier path returned is the same item, shown
    // twice; within one path a repeated item stays, for no-duplicates to see.
    const earlier = new Set<string>();
    for (const path of paths) {
      const nodes = queryJsonPath(body, path);
      const [only] = nodes;
      if (nodes.length === 1 && Array.isArray(only) && !path.endsWith('[*]')) {
        issues.push(`evidence "${name}": ${path} selects an array; did you mean ${path}[*]?`);
      }
      const ids = new Set<string>();
      for (const node of nodes) {
        const item = Object.fromEntries(
          Object.entries(collection.fields).map(([field, spec]) => [
            field,
            extractField(
              node,
              spec,
              issues,
              `evidence "${name}"[${String(items.length)}].${field}`,
            ),
          ]),
        );
        const itemId = item['id'];
        const key =
          typeof itemId === 'string' || typeof itemId === 'number' ? String(itemId) : undefined;
        if (key !== undefined && earlier.has(key)) continue;
        if (key !== undefined) ids.add(key);
        items.push(item);
      }
      for (const seen of ids) earlier.add(seen);
    }
    evidence[name] = items;
  }

  return { text, route, id, evidence, issues };
}
