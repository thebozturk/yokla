import { describe, expect, it } from 'vitest';
import type { Case } from '../schema/cases.ts';
import { caseUnmetFacts } from './facts.ts';

const testCase: Case = {
  id: 'c',
  suite: 'factual',
  language: 'en',
  turns: [
    { user: 'one', expect: { fact: 'a' } },
    { user: 'two' },
    { user: 'three', expect: { fact: 'a' } },
  ],
  customer: {
    persona: 'p',
    goal: 'g',
    maxTurns: 2,
    reached: { route: 'cart' },
    expect: { fact: 'b' },
  },
  tags: [],
};

/** A pack that finds every fact unmet, by the expectation's own words. */
const named = (expectation: Readonly<Record<string, unknown>>): readonly string[] =>
  typeof expectation['fact'] === 'string' ? [`no ${expectation['fact']}`] : [];

describe('caseUnmetFacts (ADR-0053)', () => {
  it("gathers the turns' and the customer's unmet facts, each once", () => {
    expect(caseUnmetFacts(testCase, named)).toEqual(['no a', 'no b']);
  });

  it('finds none without a pack that states facts', () => {
    expect(caseUnmetFacts(testCase, undefined)).toEqual([]);
    expect(caseUnmetFacts(testCase, () => [])).toEqual([]);
  });
});
