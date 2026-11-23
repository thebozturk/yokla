// Case rows (ADR-0096): yokla's cases as a neutral dataset, one JSON Lines row
// per case, for a tool that reads one. A row holds the case's id, its labels,
// its first message, and each turn's message with its expectations as the
// case writes them. Only approved cases with written turns become rows; the
// others are named with why they were left out.

import { reviewStatus, toJson, z, type Case, type JsonValue } from '@yokla/core';

export const CASE_ROW_SCHEMA_ID = 'yokla.case-row/v1';

export const CaseRow = z
  .object({
    schema: z.literal(CASE_ROW_SCHEMA_ID),
    id: z.string().min(1),
    suite: z.string().min(1),
    language: z.string().min(1),
    tags: z.array(z.string()),
    /** The first turn's message, for a tool that sends one message. */
    message: z.string(),
    /** Each turn's message and its expectations, as the case writes them. */
    turns: z
      .array(z.object({ message: z.string(), expect: z.record(z.string(), z.json()) }))
      .min(1),
  })
  .meta({ title: 'yokla case row v1' });
export type CaseRow = z.output<typeof CaseRow>;

/** The rows of the cases that have them, and why the others have none. */
export interface CaseRows {
  readonly rows: readonly CaseRow[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/** An object's JSON form, as a row holds it. */
function jsonObject(value: unknown): Record<string, JsonValue> {
  const json = toJson(value);
  return typeof json === 'object' && json !== null && !Array.isArray(json) ? json : {};
}

/** The cases as rows, in their order (ADR-0096). */
export function caseRows(cases: readonly Case[]): CaseRows {
  const rows: CaseRow[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const testCase of cases) {
    const status = reviewStatus(testCase);
    if (status !== 'approved') {
      skipped.push({ id: testCase.id, reason: `${status}: only approved cases are written` });
      continue;
    }
    // A case has written turns or a simulated customer, never both (caseDriverProblem).
    const [first] = testCase.turns;
    if (first === undefined) {
      skipped.push({ id: testCase.id, reason: 'a simulated customer has no written turns' });
      continue;
    }
    rows.push({
      schema: CASE_ROW_SCHEMA_ID,
      id: testCase.id,
      suite: testCase.suite,
      language: testCase.language,
      tags: [...testCase.tags],
      message: first.user,
      turns: testCase.turns.map((turn) => ({
        message: turn.user,
        expect: jsonObject(turn.expect ?? {}),
      })),
    });
  }
  return { rows, skipped };
}
