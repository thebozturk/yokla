import { describe, expect, it } from 'vitest';
import type { Case } from '../schema/cases.ts';
import { checkContext, mutate, turnView } from '../testing.ts';
import { runChecks } from './run.ts';
import type { CheckOutcome, TurnView } from './types.ts';
import {
  customProblems,
  userCheck,
  UserCheckDefinition,
  userPolicies,
  type UserTurn,
} from './user.ts';

/** A definition by contract 1, with this run. */
function definition(
  run: (turn: UserTurn) => unknown,
  change: Record<string, unknown> = {},
): UserCheckDefinition {
  return UserCheckDefinition.parse({
    api: 1,
    id: 'no-internal-ids',
    description: 'The answer shows no internal product id.',
    dimension: 'internal-ids',
    run,
    ...change,
  });
}

/** The example check of ADR-0030: no id such as TNT-001 in the answer. */
const noInternalIds = definition((turn) => {
  const found = /\b[A-Z]{3}-\d{3}\b/u.exec(turn.answer.text);
  return {
    findings: [
      found === null
        ? { verdict: 'pass', message: 'no internal id' }
        : { verdict: 'fail', message: `shows ${found[0]}`, severity: 'high' },
    ],
  };
});

const answered = (text: string, change: Partial<TurnView> = {}): TurnView =>
  turnView({
    ...change,
    response: {
      text,
      route: 'search',
      evidence: { products: [{ id: 'T1', price: { amount: 5 } }] },
    },
  });

function messages(outcome: CheckOutcome): string[] {
  return outcome.applicable
    ? outcome.findings.map((f) => `${f.verdict} ${f.severity} ${f.dimension}: ${f.message}`)
    : [`n/a: ${outcome.reason}`];
}

describe('the user check contract, version 1 (ADR-0030)', () => {
  it('accepts a definition, with an optional policy and expect schema', () => {
    expect(noInternalIds.id).toBe('no-internal-ids');
    const full = definition(() => ({ applicable: false, reason: 'x' }), {
      policy: 'advisory',
      expect: { type: 'object', properties: { prefix: { type: 'string' } } },
    });
    expect(full.policy).toBe('advisory');
  });

  it.each([
    ['another contract version', { api: 2 }, /api must be 1/u],
    ['an id that is not kebab-case', { id: 'NoIds' }, /kebab-case id/u],
    ['a dimension that is not kebab-case', { dimension: 'Internal IDs' }, /kebab-case dimension/u],
    ['no description', { description: '' }, /too_small|>=1|at least 1/u],
    ['a policy yokla has not', { policy: 'percentile' }, /invalid/iu],
    ['a run that is not a function', { run: 'x' }, /run must be a function/u],
    ['a key the contract does not have', { tags: [] }, /unrecognized/iu],
    [
      'an expect schema yokla cannot check',
      { expect: { if: {} } },
      /the keyword \\"if\\" isn't checked/u,
    ],
  ])('refuses %s', (_name, change, message) => {
    const parsed = UserCheckDefinition.safeParse({
      api: 1,
      id: 'x',
      description: 'd',
      dimension: 'x',
      run: () => undefined,
      ...change,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(message);
  });

  it("reports the check's findings in its dimension, medium unless it says otherwise", () => {
    const check = userCheck(noInternalIds);
    expect(messages(check.run(checkContext(answered('Kubbe Çadır stokta.'))))).toEqual([
      'pass medium internal-ids: no internal id',
    ]);
    expect(messages(check.run(checkContext(answered('Kubbe Çadır (TNT-001) stokta.'))))).toEqual([
      'fail high internal-ids: shows TNT-001',
    ]);
  });

  it('keeps the evidence a finding gives, and passes not applicable on', () => {
    const check = userCheck(
      definition((turn) =>
        turn.answer.route === 'search'
          ? { applicable: true, findings: [{ verdict: 'pass', message: 'ok', evidence: { n: 1 } }] }
          : { applicable: false, reason: 'not a search' },
      ),
    );
    const outcome = check.run(checkContext(answered('x')));
    expect(outcome.applicable && outcome.findings[0]?.evidence).toEqual({ n: 1 });
    const other = answered('x');
    expect(
      check.run(checkContext({ ...other, response: { ...other.response, route: 'faq' } })),
    ).toEqual({ applicable: false, reason: 'not a search' });
  });

  it('gives run a frozen copy of the turn, made for the contract', () => {
    const seen: UserTurn[] = [];
    const check = userCheck(
      definition((turn) => {
        seen.push(turn);
        return { applicable: false, reason: 'looking' };
      }),
    );
    const earlier = answered('İlk yanıt', { user: 'ilk' });
    const turn = answered('Kubbe Çadır', {
      user: 'Çadır var mı?',
      expect: { custom: { 'no-internal-ids': { prefix: 'TNT' }, other: 1 }, route: 'search' },
    });
    const context = checkContext(turn, { history: [earlier] });
    check.run(context);
    const [view] = seen;
    expect(view).toEqual({
      case: { id: 'case', suite: 'factual', language: 'tr' },
      index: 1,
      user: 'Çadır var mı?',
      expect: { prefix: 'TNT' },
      answer: {
        status: 200,
        latencyMs: 10,
        text: 'Kubbe Çadır',
        route: 'search',
        evidence: { products: [{ id: 'T1', price: { amount: 5 } }] },
      },
      history: [{ user: 'ilk', text: 'İlk yanıt' }],
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view?.answer.evidence['products']?.[0]?.['price'])).toBe(true);
    expect(Object.isFrozen(view?.history[0])).toBe(true);
    // A copy: the turn other checks read stays as it was, and unfrozen.
    expect(view?.answer.evidence).not.toBe(turn.response.evidence);
    expect(Object.isFrozen(turn.response.evidence['products']?.[0])).toBe(false);
    // Without a value of its own and a route, expect is absent and route null.
    check.run(checkContext(turnView({ response: { text: 'x' } })));
    expect(seen[1]).not.toHaveProperty('expect');
    expect(seen[1]?.answer.route).toBeNull();
  });

  it('turns a throw, a promise or a result outside the contract into an error finding', () => {
    const results = [
      () => {
        throw new Error('boom');
      },
      () => Promise.resolve({ findings: [{ verdict: 'pass', message: 'late' }] }),
      () => ({ findings: [] }),
      () => ({}),
      () => ({ findings: [{ verdict: 'ok', message: 'x' }] }),
      () => ({
        applicable: true,
        findings: [{ verdict: 'pass', message: 'x', severity: 'severe' }],
      }),
      () => ({ applicable: false }),
      (turn: UserTurn) => {
        // The turn is frozen: changing it throws.
        Object.defineProperty(turn.answer, 'text', { value: 'changed' });
        return { findings: [{ verdict: 'pass', message: 'x' }] };
      },
    ].map(
      (run) => runChecks([userCheck(definition(run))], checkContext(answered('x')))[0]?.findings[0],
    );
    expect(results.map((finding) => finding?.verdict)).toEqual(Array(8).fill('error'));
    const contract = `check "no-internal-ids" failed: run returned what contract 1 doesn't allow`;
    expect(results.map((finding) => finding?.message)).toEqual([
      'check "no-internal-ids" failed: boom',
      'check "no-internal-ids" failed: run returned a promise: a check runs synchronously',
      `${contract}: findings: an applicable result needs at least one finding`,
      expect.stringMatching(new RegExp(`^${contract}: findings: `, 'u')),
      expect.stringMatching(new RegExp(`^${contract}: findings\\.0\\.verdict: `, 'u')),
      expect.stringMatching(new RegExp(`^${contract}: findings\\.0\\.severity: `, 'u')),
      expect.stringMatching(new RegExp(`^${contract}: reason: `, 'u')),
      expect.stringMatching(/^check "no-internal-ids" failed: Cannot redefine property: text$/u),
    ]);
  });

  it('catches an internal id added to the answer', () => {
    const base = answered('Kubbe Çadır stokta.');
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, text: 'Kubbe Çadır (TNT-001) stokta.' },
    }));
    const check = userCheck(noInternalIds);
    expect(messages(check.run(checkContext(base)))[0]).toMatch(/^pass/u);
    expect(messages(check.run(checkContext(mutated)))[0]).toMatch(/^fail/u);
  });
});

describe('userPolicies (ADR-0030)', () => {
  const builtIn = new Set(['answer-content']);

  it("takes the policy of a dimension of the check's own", () => {
    expect(
      userPolicies(
        [
          definition(() => undefined, { policy: 'advisory' }),
          definition(() => undefined, { id: 'b', dimension: 'tone' }),
          definition(() => undefined, { id: 'c', policy: 'advisory' }),
        ],
        builtIn,
      ),
    ).toEqual({ policies: { 'internal-ids': 'advisory' }, problems: [] });
  });

  it('refuses a policy for a built-in dimension, or a second policy for one dimension', () => {
    expect(
      userPolicies(
        [
          definition(() => undefined, { dimension: 'answer-content', policy: 'advisory' }),
          definition(() => undefined, { id: 'b', policy: 'advisory' }),
          definition(() => undefined, { id: 'c', policy: 'majority-of-n' }),
        ],
        builtIn,
      ).problems,
    ).toEqual([
      `check "no-internal-ids" sets a policy for "answer-content", a dimension of yokla's own checks, which keeps its own`,
      'check "c" sets another policy for "internal-ids"',
    ]);
  });
});

const caseWith = (custom: unknown, customer = false): Case => ({
  id: 'k',
  suite: 'quality',
  language: 'tr',
  tags: [],
  turns: customer ? [] : [{ user: 'a' }, { user: 'b', expect: { custom } }],
  ...(customer
    ? {
        customer: {
          persona: 'p',
          goal: 'g',
          maxTurns: 2,
          reached: { route: 'cart' },
          expect: { custom },
        },
      }
    : {}),
});

describe('customProblems (ADR-0030)', () => {
  const withSchema = definition(() => undefined, {
    expect: { type: 'object', required: ['prefix'], properties: { prefix: { type: 'string' } } },
  });

  it("accepts values the check's schema accepts", () => {
    expect(
      customProblems([caseWith({ 'no-internal-ids': { prefix: 'TNT' } })], [withSchema]),
    ).toEqual([]);
    expect(customProblems([caseWith(undefined)], [])).toEqual([]);
  });

  it('refuses a value for no loaded check, for one that takes none, or one its schema refuses', () => {
    expect(customProblems([caseWith({ missing: 1 })], [withSchema])).toEqual([
      'case "k" turn 2: expect.custom.missing: no loaded check has this id',
    ]);
    expect(customProblems([caseWith({ 'no-internal-ids': 1 })], [noInternalIds])).toEqual([
      'case "k" turn 2: expect.custom.no-internal-ids: the check takes no value; it declares no expect schema',
    ]);
    expect(customProblems([caseWith({ 'no-internal-ids': { prefix: 3 } })], [withSchema])).toEqual([
      'case "k" turn 2: expect.custom.no-internal-ids: $.prefix: type, expected string, got integer',
    ]);
    expect(customProblems([caseWith({ 'no-internal-ids': {} }, true)], [withSchema])).toEqual([
      'case "k" customer: expect.custom.no-internal-ids: $: required, "prefix" is missing',
    ]);
  });
});
