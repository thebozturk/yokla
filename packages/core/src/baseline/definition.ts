// What decides a case's verdict, as canonical JSON (ADR-0011). The runtime
// hashes it; equal text means an unchanged definition. Title, suite, tags,
// provenance and the knownGap marker are left out: a marker documents a gap,
// it must not make a case look changed.

import type { Case } from '../schema/cases.ts';

/** JSON with object keys sorted at every level; undefined values are left out. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function caseDefinition(c: Case): string {
  return stableJson({
    language: c.language,
    turns: c.turns.map((turn) => ({ user: turn.user, request: turn.request, expect: turn.expect })),
    samples: c.samples,
    checks: c.checks,
  });
}
