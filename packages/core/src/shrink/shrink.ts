// The smallest failing conversation (ADR-0035). This holds the search and
// the rule that decides whether a candidate still fails; it runs nothing.
// The caller runs each candidate and answers with a trial: it fails, it
// passes, or the budget stopped the search.
//
// A candidate keeps some of the case's turns, and some words of each kept
// message, by their positions in the original. Turns after the target turn
// are dropped without a run; earlier turns, then each kept message's words,
// are cut by delta debugging. The search is deterministic.

import { Document } from 'yaml';
import { wilson } from '../checks/aggregate.ts';
import type { Results } from '../schema/results.ts';

type CaseResult = Results['cases'][number];
type SampleResult = CaseResult['samples'][number];
type OriginStage = NonNullable<
  CaseResult['samples'][number]['turns'][number]['checks'][number]['findings'][number]['origin']
>['stage'];

/** The failure a shrink keeps: its turn, check, dimension and origin stage (ADR-0035). */
export interface ShrinkTarget {
  /** The target turn's position in the original case, from 0. */
  readonly turn: number;
  readonly check: string;
  readonly dimension: string;
  /** The stage of the finding's origin, when it had one (ADR-0033). */
  readonly stage?: OriginStage;
  /** Every check that failed on the target turn in the original, in any sample. */
  readonly failing: readonly string[];
}

function failingFindings(sample: SampleResult, turn: number) {
  return (sample.turns[turn]?.checks ?? []).flatMap((check) =>
    check.findings
      .filter((finding) => finding.verdict === 'fail')
      .map((finding) => ({ check: check.check, finding })),
  );
}

/**
 * The failure to keep: the first failing finding of `check`, or by default
 * of a deciding dimension, in turn order and then check order. A string says
 * why there is none.
 */
export function pickTarget(result: CaseResult, check?: string): ShrinkTarget | string {
  if (result.status !== 'fail') return `case "${result.id}" is ${result.status}, not fail`;
  const deciding = new Set(
    result.dimensions
      .filter((d) => d.verdict === 'fail' && d.policy !== 'advisory')
      .map((d) => d.dimension),
  );
  const turns = Math.max(0, ...result.samples.map((sample) => sample.turns.length));
  for (let turn = 0; turn < turns; turn += 1) {
    for (const sample of result.samples) {
      const found = failingFindings(sample, turn).find((entry) =>
        check === undefined ? deciding.has(entry.finding.dimension) : entry.check === check,
      );
      if (found === undefined) continue;
      const failing = new Set(
        result.samples.flatMap((s) => failingFindings(s, turn).map((entry) => entry.check)),
      );
      const stage = found.finding.origin?.stage;
      return {
        turn,
        check: found.check,
        dimension: found.finding.dimension,
        ...(stage === undefined ? {} : { stage }),
        failing: [...failing].toSorted(),
      };
    }
  }
  return check === undefined
    ? `case "${result.id}" has no failing finding in a deciding dimension`
    : `check "${check}" didn't fail in case "${result.id}"`;
}

/**
 * Whether one sample still shows the target failure at `turn`: the target
 * check fails in the target dimension, with the same origin stage, and no
 * check fails there that didn't in the original (ADR-0035).
 */
export function sampleFails(sample: SampleResult, target: ShrinkTarget, turn: number): boolean {
  const at = sample.turns[turn];
  if (at === undefined || at.error !== undefined) return false;
  const failing = failingFindings(sample, turn);
  const kept = failing.some(
    ({ check, finding }) =>
      check === target.check &&
      finding.dimension === target.dimension &&
      (target.stage === undefined || finding.origin?.stage === target.stage),
  );
  return kept && failing.every(({ check }) => target.failing.includes(check));
}

/** Whether every sample of a candidate's result still fails, with the target turn at `turn`. */
export function stillFails(result: CaseResult, target: ShrinkTarget, turn: number): boolean {
  return (
    result.samples.length > 0 && result.samples.every((sample) => sampleFails(sample, target, turn))
  );
}

export interface Reproduction {
  readonly kind: 'reproducible' | 'flaky' | 'not-reproduced';
  readonly failed: number;
  readonly samples: number;
  /** The failure rate's Wilson 95 % interval. */
  readonly interval: { readonly lower: number; readonly upper: number };
}

/** How the original's reproduction runs went: every sample failed, some, or none. */
export function reproduction(result: CaseResult, target: ShrinkTarget): Reproduction {
  const samples = result.samples.length;
  const failed = result.samples.filter((sample) => sampleFails(sample, target, target.turn)).length;
  const { lower, upper } = wilson(failed, samples);
  const kind =
    samples > 0 && failed === samples ? 'reproducible' : failed > 0 ? 'flaky' : 'not-reproduced';
  return { kind, failed, samples, interval: { lower, upper } };
}

/** The words of a message, split on whitespace. */
export function wordsOf(message: string): string[] {
  return message.split(/\s+/u).filter((word) => word !== '');
}

/** Which turns, and which words of each, a candidate keeps, by position in the original. */
export interface ShrinkCandidate {
  readonly turns: readonly number[];
  /** Per kept turn, the positions of the words kept; a turn not listed keeps every word. */
  readonly words: ReadonlyMap<number, readonly number[]>;
}

/** The turns a candidate keeps, each message cut to its kept words, joined with one space. */
export function applyCandidate<T extends { readonly user: string }>(
  turns: readonly T[],
  candidate: ShrinkCandidate,
): T[] {
  return candidate.turns.flatMap((index) => {
    const turn = turns[index];
    if (turn === undefined) return [];
    const kept = candidate.words.get(index);
    if (kept === undefined) return [turn];
    const words = wordsOf(turn.user);
    return [{ ...turn, user: kept.map((position) => words[position] ?? '').join(' ') }];
  });
}

export type Trial = 'fails' | 'passes' | 'stopped';

/** n chunks of near-equal size, in order. */
function split(items: readonly number[], n: number): number[][] {
  const chunks: number[][] = [];
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const end = start + Math.floor((items.length - start) / (n - i));
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

interface Search {
  stopped: boolean;
}

/**
 * Delta debugging: the smallest subset of `items`, of at least one item, that
 * still fails, given that `items` does. Removing any one item of the result
 * makes it pass, unless the search was stopped.
 */
async function ddmin(
  items: readonly number[],
  test: (subset: readonly number[]) => Promise<Trial>,
  search: Search,
): Promise<number[]> {
  let current = [...items];
  let n = 2;
  while (current.length >= 2 && !search.stopped) {
    const chunks = split(current, n);
    let reduced = false;
    for (const chunk of chunks) {
      const trial = await test(chunk);
      if (trial === 'stopped') {
        search.stopped = true;
        return current;
      }
      if (trial === 'fails') {
        current = chunk;
        n = 2;
        reduced = true;
        break;
      }
    }
    // With two chunks, each complement is the other chunk, already tried.
    if (!reduced && chunks.length > 2) {
      for (const chunk of chunks) {
        const complement = current.filter((item) => !chunk.includes(item));
        const trial = await test(complement);
        if (trial === 'stopped') {
          search.stopped = true;
          return current;
        }
        if (trial === 'fails') {
          current = complement;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }
  return current;
}

export interface Shrunk {
  readonly candidate: ShrinkCandidate;
  /** true when the budget stopped the search before it was minimal. */
  readonly stopped: boolean;
}

/**
 * Shrinks a case whose turn `target` fails, given `trial`, which runs a
 * candidate. Equal candidates are tried once. Messages are cut to their
 * words only with `words`: a cut message can stop asking what its turn's
 * expectations describe (ADR-0036).
 */
export async function shrink(
  turns: readonly { readonly user: string }[],
  target: number,
  trial: (candidate: ShrinkCandidate) => Promise<Trial>,
  options: { readonly words?: boolean } = {},
): Promise<Shrunk> {
  const tried = new Map<string, Trial>();
  const run = async (candidate: ShrinkCandidate): Promise<Trial> => {
    const key = JSON.stringify([
      candidate.turns,
      [...candidate.words.entries()].toSorted(([a], [b]) => a - b),
    ]);
    const known = tried.get(key);
    if (known !== undefined) return known;
    const result = await trial(candidate);
    if (result !== 'stopped') tried.set(key, result);
    return result;
  };
  const search: Search = { stopped: false };
  // Turns after the target can't change it: dropped without a run.
  let candidate: ShrinkCandidate = {
    turns: Array.from({ length: target + 1 }, (_value, index) => index),
    words: new Map(),
  };

  const earlier = candidate.turns.filter((index) => index !== target);
  if (earlier.length > 0) {
    const withTurns = (kept: readonly number[]): ShrinkCandidate => ({
      ...candidate,
      turns: [...kept, target],
    });
    const none = await run(withTurns([]));
    if (none === 'stopped') search.stopped = true;
    else if (none === 'fails') candidate = withTurns([]);
    else candidate = withTurns(await ddmin(earlier, (kept) => run(withTurns(kept)), search));
  }

  // Earlier messages first, the target turn's last.
  for (const index of options.words === true ? candidate.turns : []) {
    if (search.stopped) break;
    const words = wordsOf(turns[index]?.user ?? '');
    if (words.length < 2) continue;
    const base = candidate;
    const withWords = (kept: readonly number[]): ShrinkCandidate => ({
      ...base,
      words: new Map([...base.words, [index, [...kept]]]),
    });
    const all = words.map((_word, position) => position);
    const kept = await ddmin(all, (subset) => run(withWords(subset)), search);
    if (kept.length < all.length) candidate = withWords(kept);
  }
  return { candidate, stopped: search.stopped };
}

/** The case file a shrink writes: one proposed case, with a comment on where it came from. */
export function shrunkCaseYaml(
  testCase: Readonly<Record<string, unknown>>,
  from: string,
  cut: readonly number[] = [],
): string {
  const doc = new Document({ version: 1, cases: [testCase] }, { aliasDuplicateObjects: false });
  doc.commentBefore = [
    ` Written by yokla shrink (ADR-0035): ${from}.`,
    ' It runs, but gates only once a person reads it and sets its status to approved',
    ' (ADR-0004). See docs/guide/cli.md.',
    // A cut message can stop asking what its expectations describe (ADR-0036).
    ...(cut.length === 0
      ? []
      : [
          ` Read first: the message of turn ${cut.map((index) => String(index + 1)).join(', ')} was cut to fewer words,`,
          ' and may no longer ask what the expectations of its turn describe.',
        ]),
  ].join('\n');
  return doc.toString({ lineWidth: 100 });
}
