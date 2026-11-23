// The import mapping (ADR-0097): where each value is in another tool's row,
// as a profile says where an answer is in a target's (P9). A value is a
// JSONPath into the row, or `{ value }` for a constant. The mapping names no
// tool: the user writes it.

import { JsonPath, queryJsonPath, z } from '@yokla/core';

export const IMPORT_MAPPING_SCHEMA_ID = 'yokla.import/v1';

/** A value: a JSONPath into the row, or a constant. */
export const MappedValue = z.union([JsonPath, z.strictObject({ value: z.json() })]);
export type MappedValue = z.output<typeof MappedValue>;

/** A verdict: where it is, and which of its values pass and which fail. */
export const MappedVerdict = z.strictObject({
  at: MappedValue,
  pass: z.array(z.json()).min(1),
  fail: z.array(z.json()).min(1),
});
export type MappedVerdict = z.output<typeof MappedVerdict>;

export const ImportMapping = z
  .strictObject({
    version: z.literal(1),
    /** In a JSON or YAML file, where the rows are; by default the document, when a list. */
    rows: JsonPath.optional(),
    /** The case's id; rows with the same id are one case. */
    case: MappedValue.optional(),
    /** What was sent. */
    message: MappedValue.optional(),
    /** What came back. */
    answer: MappedValue.optional(),
    /** How long the answer took; without it, a row's answer isn't timed. */
    latencyMs: MappedValue.optional(),
    verdict: MappedVerdict.optional(),
    score: MappedValue.optional(),
    reason: MappedValue.optional(),
    /** Each assertion the tool lists in a row. */
    findings: z
      .strictObject({
        at: JsonPath,
        check: MappedValue.optional(),
        verdict: MappedVerdict.optional(),
        reason: MappedValue.optional(),
      })
      .optional(),
    /** Which sample of its case a row is; by default, the order of its rows. */
    sample: MappedValue.optional(),
    /** Which turn of its sample a row is; by default, 0. */
    turn: MappedValue.optional(),
    suite: MappedValue.optional(),
    language: MappedValue.optional(),
    tags: MappedValue.optional(),
  })
  .meta({ title: 'yokla import mapping v1' });
export type ImportMapping = z.output<typeof ImportMapping>;

/** A value of a row: the first a path selects, or the constant; undefined when none. */
export function valueOf(row: unknown, mapped: MappedValue | undefined): unknown {
  if (mapped === undefined) return undefined;
  if (typeof mapped === 'object') return mapped.value;
  const [first] = queryJsonPath(row, mapped);
  return first;
}

/** Every value a path selects in a row. */
export function valuesOf(row: unknown, path: string): unknown[] {
  return queryJsonPath(row, path);
}

/** A value as text, for an id, a message or a reason; undefined for none or an object. */
export function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** A value as a whole number of at least 0, as a CSV's string may hold it; undefined otherwise. */
export function indexOf(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : undefined;
}

/** A verdict's value in a row: pass, fail, or why it is neither. */
export function verdictOf(
  row: unknown,
  mapped: MappedVerdict,
):
  { readonly verdict: 'pass' | 'fail'; readonly value: unknown } | { readonly unmeasured: string } {
  const value = valueOf(row, mapped.at);
  if (value === undefined) return { unmeasured: 'the mapping finds no verdict in the row' };
  const same = (listed: unknown) => JSON.stringify(listed) === JSON.stringify(value);
  if (mapped.pass.some(same)) return { verdict: 'pass', value };
  if (mapped.fail.some(same)) return { verdict: 'fail', value };
  return {
    unmeasured: `the row's verdict ${JSON.stringify(value)} is neither one that passes nor one that fails`,
  };
}
