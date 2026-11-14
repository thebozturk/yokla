import { describe, expect, it } from 'vitest';
import type { Results } from '../schema/results.ts';
import { mutate } from '../testing.ts';
import {
  applyCandidate,
  pickTarget,
  reproduction,
  sampleFails,
  shrink,
  shrunkCaseYaml,
  stillFails,
  wordsOf,
  type ShrinkCandidate,
  type ShrinkTarget,
  type Trial,
} from './shrink.ts';

type CaseResult = Results['cases'][number];
type TurnResult = CaseResult['samples'][number]['turns'][number];
type Finding = TurnResult['checks'][number]['findings'][number];

const fail = (dimension: string, origin?: Finding['origin']): Finding => ({
  dimension,
  verdict: 'fail',
  severity: 'high',
  message: 'm',
  ...(origin === undefined ? {} : { origin }),
});
const pass = (dimension: string): Finding => ({
  dimension,
  verdict: 'pass',
  severity: 'high',
  message: 'm',
});

function turn(checks: Record<string, Finding[]>, error?: string): TurnResult {
  return {
    user: 'u',
    checks: Object.entries(checks).map(([check, findings]) => ({
      check,
      applicable: true,
      findings,
    })),
    ...(error === undefined ? {} : { error }),
  };
}

function kase(samples: TurnResult[][], status: CaseResult['status'] = 'fail'): CaseResult {
  return {
    id: 'c',
    suite: 'factual',
    language: 'tr',
    status,
    unstable: false,
    dimensions: [
      { dimension: 'fabrication', policy: 'worst-of-n', verdict: 'fail', samples: 1, failed: 1 },
      { dimension: 'deflection', policy: 'advisory', verdict: 'fail', samples: 1, failed: 1 },
      { dimension: 'refusal', policy: 'majority-of-n', verdict: 'pass', samples: 1, failed: 0 },
    ],
    samples: samples.map((turns, index) => ({ index, cache: 'cold', turns })),
  };
}

const priced = (stage: NonNullable<Finding['origin']>['stage'] = 'model') =>
  turn({ 'price-grounded': [fail('fabrication', { stage })], 'over-refusal': [pass('refusal')] });

describe('pickTarget (ADR-0035)', () => {
  it('takes the first failing finding of a deciding dimension, in turn then check order', () => {
    const result = kase([
      [
        turn({ deflection: [fail('deflection')] }),
        priced(),
        turn({ 'stock-claim': [fail('fabrication')] }),
      ],
    ]);
    expect(pickTarget(result)).toEqual({
      turn: 1,
      check: 'price-grounded',
      dimension: 'fabrication',
      stage: 'model',
      failing: ['price-grounded'],
    });
  });

  it('takes the named check, advisory or not, and gathers every failing check of its turn', () => {
    const result = kase([
      [turn({ deflection: [fail('deflection')] })],
      [turn({ deflection: [fail('deflection')], 'answer-text': [fail('answer-content')] })],
    ]);
    expect(pickTarget(result, 'deflection')).toEqual({
      turn: 0,
      check: 'deflection',
      dimension: 'deflection',
      failing: ['answer-text', 'deflection'],
    });
  });

  it('says why there is no target', () => {
    expect(pickTarget(kase([[priced()]], 'pass'))).toBe('case "c" is pass, not fail');
    expect(pickTarget(kase([[turn({ deflection: [fail('deflection')] })]]))).toBe(
      'case "c" has no failing finding in a deciding dimension',
    );
    expect(pickTarget(kase([[priced()]]), 'stock-claim')).toBe(
      `check "stock-claim" didn't fail in case "c"`,
    );
  });
});

const TARGET: ShrinkTarget = {
  turn: 1,
  check: 'price-grounded',
  dimension: 'fabrication',
  stage: 'model',
  failing: ['price-grounded'],
};

function sample(turns: TurnResult[]) {
  return kase([turns]).samples[0] ?? { index: 0, cache: 'cold' as const, turns };
}

describe('sampleFails and stillFails (ADR-0035)', () => {
  it('holds when the target check fails in its dimension with its origin stage', () => {
    expect(sampleFails(sample([turn({}), priced()]), TARGET, 1)).toBe(true);
    // The target turn is where the candidate puts it.
    expect(sampleFails(sample([priced()]), TARGET, 0)).toBe(true);
  });

  it('fails each condition when it is taken away (mutations)', () => {
    const base = [turn({}), priced()];
    expect(sampleFails(sample(base), TARGET, 1)).toBe(true);
    const otherStage = mutate(base, (turns) => [turns[0] ?? turn({}), priced('app')]);
    expect(sampleFails(sample(otherStage), TARGET, 1)).toBe(false);
    const otherDimension = mutate(base, (turns) => [
      turns[0] ?? turn({}),
      turn({ 'price-grounded': [fail('leakage', { stage: 'model' })] }),
    ]);
    expect(sampleFails(sample(otherDimension), TARGET, 1)).toBe(false);
    const passing = mutate(base, (turns) => [
      turns[0] ?? turn({}),
      turn({ 'price-grounded': [pass('fabrication')] }),
    ]);
    expect(sampleFails(sample(passing), TARGET, 1)).toBe(false);
    const newFailure = mutate(base, (turns) => [
      turns[0] ?? turn({}),
      turn({
        'price-grounded': [fail('fabrication', { stage: 'model' })],
        'over-refusal': [fail('refusal')],
      }),
    ]);
    expect(sampleFails(sample(newFailure), TARGET, 1)).toBe(false);
    const errored = mutate(base, (turns) => [
      turns[0] ?? turn({}),
      turn({ 'price-grounded': [fail('fabrication', { stage: 'model' })] }, 'HTTP 500'),
    ]);
    expect(sampleFails(sample(errored), TARGET, 1)).toBe(false);
    expect(sampleFails(sample(base), TARGET, 2)).toBe(false);
  });

  it('ignores the stage when the target had none, and failures on earlier turns', () => {
    const { stage: _stage, ...noStage } = TARGET;
    expect(sampleFails(sample([turn({ x: [fail('y')] }), priced('app')]), noStage, 1)).toBe(true);
  });

  it('needs every sample to fail, and at least one sample', () => {
    expect(
      stillFails(
        kase([
          [turn({}), priced()],
          [turn({}), priced()],
        ]),
        TARGET,
        1,
      ),
    ).toBe(true);
    expect(
      stillFails(
        kase([
          [turn({}), priced()],
          [turn({}), turn({})],
        ]),
        TARGET,
        1,
      ),
    ).toBe(false);
    expect(stillFails(kase([]), TARGET, 1)).toBe(false);
  });
});

describe('reproduction (ADR-0035)', () => {
  const target = { ...TARGET, turn: 0 };
  it('is reproducible, flaky or not reproduced, with the failure rate interval', () => {
    expect(reproduction(kase([[priced()], [priced()], [priced()]]), target)).toEqual({
      kind: 'reproducible',
      failed: 3,
      samples: 3,
      interval: { lower: 0.4385, upper: 1 },
    });
    expect(reproduction(kase([[priced()], [turn({})], [priced()]]), target)).toMatchObject({
      kind: 'flaky',
      failed: 2,
      samples: 3,
    });
    expect(reproduction(kase([[turn({})], [turn({})]]), target)).toMatchObject({
      kind: 'not-reproduced',
      failed: 0,
    });
  });
});

describe('applyCandidate and wordsOf', () => {
  const turns = [{ user: 'merhaba  dünya' }, { user: 'çadır var mı', expect: { a: 1 } }];

  it('keeps the chosen turns, with their other fields, and the chosen words joined by one space', () => {
    expect(wordsOf(' a  b\nc ')).toEqual(['a', 'b', 'c']);
    expect(applyCandidate(turns, { turns: [1], words: new Map([[1, [0, 2]]]) })).toEqual([
      { user: 'çadır mı', expect: { a: 1 } },
    ]);
    expect(applyCandidate(turns, { turns: [0, 1], words: new Map() })).toEqual(turns);
  });
});

/**
 * A target that fails when turn 1 ("context") is kept and the target turn,
 * 3, still says "price" and "tent". Turn 0 and turn 4 don't matter.
 */
const CASE = [
  { user: 'hello there' },
  { user: 'I want camping gear' },
  { user: 'something unrelated' },
  { user: 'what is the price of the cheapest tent please' },
  { user: 'thanks' },
];

function oracle(candidate: ShrinkCandidate): boolean {
  const turns = applyCandidate(CASE, candidate);
  const last = turns.at(-1)?.user ?? '';
  return (
    candidate.turns.includes(1) &&
    candidate.turns.at(-1) === 3 &&
    last.includes('price') &&
    last.includes('tent')
  );
}

function recorder(budget = Infinity) {
  const calls: ShrinkCandidate[] = [];
  const trial = (candidate: ShrinkCandidate): Promise<Trial> => {
    if (calls.length >= budget) return Promise.resolve('stopped');
    calls.push(candidate);
    return Promise.resolve(oracle(candidate) ? 'fails' : 'passes');
  };
  return { calls, trial };
}

describe('shrink (ADR-0035)', () => {
  it('drops later turns, removes unneeded earlier ones, and cuts each message to what fails', async () => {
    const { calls, trial } = recorder();
    const { candidate, stopped } = await shrink(CASE, 3, trial, { words: true });
    expect(stopped).toBe(false);
    expect(applyCandidate(CASE, candidate)).toEqual([{ user: 'I' }, { user: 'price tent' }]);
    // No candidate keeps a turn after the target.
    expect(calls.every((call) => call.turns.every((index) => index <= 3))).toBe(true);
  });

  it('is minimal: removing any one turn or word makes it pass', async () => {
    const { candidate } = await shrink(CASE, 3, recorder().trial, { words: true });
    for (const index of candidate.turns.filter((t) => t !== 3)) {
      expect(oracle({ ...candidate, turns: candidate.turns.filter((t) => t !== index) })).toBe(
        false,
      );
    }
    for (const [index, kept] of candidate.words) {
      if (kept.length < 2) continue;
      for (const word of kept) {
        const words = new Map(candidate.words).set(
          index,
          kept.filter((w) => w !== word),
        );
        expect(oracle({ ...candidate, words })).toBe(false);
      }
    }
  });

  it('removes every earlier turn in one trial when none is needed', async () => {
    const calls: ShrinkCandidate[] = [];
    await shrink(CASE, 3, (candidate) => {
      calls.push(candidate);
      return Promise.resolve(candidate.turns.at(-1) === 3 ? 'fails' : 'passes');
    });
    expect(calls[0]).toEqual({ turns: [3], words: new Map() });
  });

  it('is deterministic, and tries each candidate once', async () => {
    const first = recorder();
    const second = recorder();
    await shrink(CASE, 3, first.trial, { words: true });
    await shrink(CASE, 3, second.trial, { words: true });
    expect(second.calls).toEqual(first.calls);
    const keys = first.calls.map((call) => JSON.stringify([call.turns, [...call.words]]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stops at the budget with the smallest failing candidate so far', async () => {
    const { calls, trial } = recorder(3);
    const { candidate, stopped } = await shrink(CASE, 3, trial, { words: true });
    expect(stopped).toBe(true);
    expect(calls).toHaveLength(3);
    // Whatever it returns still fails.
    expect(oracle(candidate)).toBe(true);
  });

  it('keeps whole messages unless asked for words (ADR-0036)', async () => {
    const { calls, trial } = recorder();
    const { candidate } = await shrink(CASE, 3, trial);
    expect(applyCandidate(CASE, candidate)).toEqual([CASE[1], CASE[3]]);
    expect(calls.every((call) => call.words.size === 0)).toBe(true);
    const many = await shrink([{ user: 'a b c' }], 0, recorder().trial);
    expect(many.candidate).toEqual({ turns: [0], words: new Map() });
  });

  it('runs nothing for a one-turn, one-word case', async () => {
    const { calls, trial } = recorder();
    const { candidate } = await shrink([{ user: 'tent' }], 0, trial, { words: true });
    expect(calls).toEqual([]);
    expect(candidate).toEqual({ turns: [0], words: new Map() });
  });
});

describe('shrunkCaseYaml', () => {
  it('writes one proposed case, and warns of each cut message (ADR-0036)', () => {
    const plain = shrunkCaseYaml({ id: 'c-min', turns: [{ user: 'a' }] }, 'shrunk from c');
    expect(plain).toContain('# Written by yokla shrink (ADR-0035): shrunk from c.');
    expect(plain).toContain('version: 1\ncases:\n  - id: c-min');
    expect(plain).not.toContain('Read first');
    const cut = shrunkCaseYaml({ id: 'c-min', turns: [] }, 'shrunk from c', [0, 2]);
    expect(cut).toContain('# Read first: the message of turn 1, 3 was cut to fewer words,');
  });
});
