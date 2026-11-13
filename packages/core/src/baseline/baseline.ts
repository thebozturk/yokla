// Baselines (design §13, ADR-0011): reduce a run to what the gate compares,
// and describe what changed between two baselines for review.

import { BASELINE_SCHEMA_ID, type Baseline } from '../schema/baseline.ts';
import type { Results } from '../schema/results.ts';

export function baselineOf(results: Results): Baseline {
  return {
    schema: BASELINE_SCHEMA_ID,
    yokla: { version: results.yokla.version },
    run: {
      id: results.run.id,
      startedAt: results.run.startedAt,
      profile: { target: results.run.profile.target, sha256: results.run.profile.sha256 },
    },
    // A proposed case doesn't gate, so the baseline leaves it out (ADR-0004).
    cases: results.cases
      .filter((c) => c.review !== 'proposed')
      .map((c) => ({
        id: c.id,
        suite: c.suite,
        status: c.status,
        ...(c.definitionSha256 === undefined ? {} : { definitionSha256: c.definitionSha256 }),
      }))
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** What changed from `previous` to `next`, one line per change. */
export function baselineChanges(previous: Baseline | undefined, next: Baseline): string[] {
  if (previous === undefined) return [`new baseline: ${String(next.cases.length)} cases`];
  const changes: string[] = [];
  if (previous.run.profile.sha256 !== next.run.profile.sha256) changes.push('~ profile changed');
  const before = new Map(previous.cases.map((c) => [c.id, c]));
  const after = new Map(next.cases.map((c) => [c.id, c]));
  for (const c of next.cases) {
    const old = before.get(c.id);
    if (old === undefined) {
      changes.push(`+ ${c.id} (${c.status})`);
      continue;
    }
    if (old.status !== c.status) changes.push(`~ ${c.id}: ${old.status} → ${c.status}`);
    if (
      old.definitionSha256 !== undefined &&
      c.definitionSha256 !== undefined &&
      old.definitionSha256 !== c.definitionSha256
    ) {
      changes.push(`~ ${c.id}: definition changed`);
    }
  }
  for (const c of previous.cases) {
    if (!after.has(c.id)) changes.push(`- ${c.id} (was ${c.status})`);
  }
  return changes.length === 0 ? ['no changes'] : changes;
}
