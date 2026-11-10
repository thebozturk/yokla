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

  const [textNode] = queryJsonPath(body, mapping.text);
  const text = typeof textNode === 'string' ? textNode : undefined;
  if (text === undefined) issues.push(`answer text not found at ${mapping.text}`);

  const route = scalarAt(body, mapping.route);
  if (mapping.route !== undefined && route === undefined)
    issues.push(`route not found at ${mapping.route}`);
  const id = scalarAt(body, mapping.id);
  if (mapping.id !== undefined && id === undefined)
    issues.push(`target id not found at ${mapping.id}`);

  const evidence: Record<string, EvidenceItem[]> = {};
  for (const [name, collection] of Object.entries(mapping.evidence ?? {})) {
    const nodes = queryJsonPath(body, collection.items);
    const [only] = nodes;
    if (nodes.length === 1 && Array.isArray(only) && !collection.items.endsWith('[*]')) {
      issues.push(
        `evidence "${name}": ${collection.items} selects an array; did you mean ${collection.items}[*]?`,
      );
    }
    evidence[name] = nodes.map((node, index) =>
      Object.fromEntries(
        Object.entries(collection.fields).map(([field, spec]) => [
          field,
          extractField(node, spec, issues, `evidence "${name}"[${String(index)}].${field}`),
        ]),
      ),
    );
  }

  return { text, route, id, evidence, issues };
}
