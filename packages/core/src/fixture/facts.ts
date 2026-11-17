// The facts a case's expectations state about the data, checked before it
// runs (ADR-0053). A domain pack says which facts its data no longer holds;
// core gathers them over a case's expectations and never reads their keys
// (P7).

import type { UnmetFacts } from '../checks/types.ts';
import type { Case } from '../schema/cases.ts';

/**
 * The facts a case rests on that the data no longer holds: one line each,
 * over every turn's expectation and the simulated customer's, each once.
 * Empty when the pack states no fact, or every one holds.
 */
export function caseUnmetFacts(testCase: Case, unmetFacts: UnmetFacts | undefined): string[] {
  if (unmetFacts === undefined) return [];
  const expectations = [
    ...testCase.turns.flatMap((turn) => (turn.expect === undefined ? [] : [turn.expect])),
    ...(testCase.customer?.expect === undefined ? [] : [testCase.customer.expect]),
  ];
  return [...new Set(expectations.flatMap((expect) => unmetFacts(expect)))];
}
