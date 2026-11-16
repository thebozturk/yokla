// yokla explore's search (ADR-0044): from the written cases, it runs small
// conversations that go where no run went yet, and keeps those that reach
// something new or fail a check. KeptCandidate conversations join the pool the
// operators draw from, so the search goes on from where it got to.
//
// The search is pure: a trial runs a candidate and says what it reached. The
// operators come in a fixed order, and each goes over the pool in the order
// it grew, so the same seeds, data and answers give the same search.
//
// A conversation's state is the route of its last answer with the tools the
// model asked for in it. An operator is tried once per state: from a second
// conversation that ended the same way, it would most likely reach the same
// paths, and the budget is better spent elsewhere.

import type { ExploredTurn, Intents } from '../checks/types.ts';
import type { CaseTurn } from '../schema/cases.ts';
import type { Suite } from '../schema/common.ts';
import type { Fault } from '../schema/fault.ts';
import { type Coverage, newCoverage, unionCoverage } from './coverage.ts';

/** The fault kinds the fault operator tries, in order (ADR-0044). */
export function exploreFaults(holdMs: number): Fault[] {
  return [
    { kind: 'status', status: 503 },
    { kind: 'timeout', holdMs },
    { kind: 'empty-content' },
    { kind: 'malformed-json' },
  ];
}

/** A turn as a run showed it, with the tools the model asked for in it, by name. */
export interface ObservedTurn extends ExploredTurn {
  readonly tools: readonly string[];
}

/** A conversation of the pool: a written case, or a kept candidate. */
export interface Explored {
  readonly id: string;
  readonly suite: Suite;
  readonly language: string;
  readonly turns: readonly CaseTurn[];
  /** Each turn of its run, in order. */
  readonly observed: readonly ObservedTurn[];
}

/** A conversation to run. Its turns carry no expectation. */
export interface ExploreCandidate {
  /** The operator or intent that made it, such as `fault` or `cart`. */
  readonly operator: string;
  /** The pool conversation it goes on from; undefined for one an intent opens. */
  readonly from: string | undefined;
  readonly suite: Suite;
  readonly language: string;
  readonly turns: readonly CaseTurn[];
}

/** What a candidate's run showed. */
export interface ExploreOutcome {
  readonly coverage: Coverage;
  readonly observed: readonly ObservedTurn[];
  /** The checks that failed on its last turn, such as `price-grounded (fabrication)`. */
  readonly failed: readonly string[];
}

/** Runs a candidate; `stopped` once the budget allows no more runs. */
export type ExploreTrial = (candidate: ExploreCandidate) => Promise<ExploreOutcome | 'stopped'>;

/** A candidate the search kept, with the id it is written under. */
export interface KeptCandidate {
  readonly id: string;
  readonly candidate: ExploreCandidate;
  /** What it reached first, as labelled keys such as `route:cart`. */
  readonly reached: readonly string[];
  readonly failed: readonly string[];
}

export interface ExploreResult {
  readonly kept: readonly KeptCandidate[];
  /** What the seeds and the search reached together. */
  readonly coverage: Coverage;
  /** What the search reached beyond the seeds, as labelled keys. */
  readonly added: readonly string[];
  /** The candidates that ran. */
  readonly runs: number;
  /** true when the budget ended the search before the operators ran out. */
  readonly stopped: boolean;
}

export interface ExploreOptions {
  /** The pack's intents, when the domain pack offers them. */
  readonly intents?: Intents | undefined;
  /** The faults the fault operator tries; none without the model proxy. */
  readonly faults: readonly Fault[];
  /** The languages opening intents are asked in. */
  readonly languages: readonly string[];
  /** Ids a kept candidate must not take, such as the written cases'. */
  readonly reserved?: readonly string[];
}

/** What tells two conversations apart: their messages and what the turns arm. */
function conversationKey(turns: readonly CaseTurn[]): string {
  return JSON.stringify(
    turns.map((turn) => [
      turn.user,
      turn.request ?? null,
      turn.faults ?? null,
      turn.toolResults ?? null,
    ]),
  );
}

/** A turn without its expectations: a candidate states none (ADR-0044). */
function unexpected(turn: CaseTurn): CaseTurn {
  const { expect: _expect, ...rest } = turn;
  return rest;
}

/** A conversation's first message, as a turn of another conversation. */
function opening(turn: CaseTurn): CaseTurn {
  return { user: turn.user, ...(turn.request === undefined ? {} : { request: turn.request }) };
}

/** How a turn ended: its route, with the tools the model asked for. */
function stateOf(turn: ObservedTurn | undefined): string {
  if (turn === undefined) return '?';
  return `${turn.route ?? ''}:${[...new Set(turn.tools)].toSorted().join(',')}`;
}

/** A conversation as intents read it. */
function conversation(entry: Explored): ExploredTurn[] {
  return entry.observed.map(({ user, route, evidence }) => ({ user, route, evidence }));
}

/** A candidate that goes on from a conversation of the pool, with one more turn. */
function goOn(entry: Explored, operator: string, turn?: CaseTurn): ExploreCandidate {
  return {
    operator,
    from: entry.id,
    suite: entry.suite,
    language: entry.language,
    turns: [...entry.turns.map(unexpected), ...(turn === undefined ? [] : [turn])],
  };
}

/**
 * Searches from the seeds: opening intents, then for each conversation of the
 * pool its following intents, a fault on its last turn, its last turn again,
 * and the first turn of another conversation in its language. Passes repeat
 * while a pass kept something; the trial's budget ends it sooner.
 */
export async function explore(
  seeds: readonly Explored[],
  seedCoverage: Coverage,
  options: ExploreOptions,
  trial: ExploreTrial,
): Promise<ExploreResult> {
  const pool: Explored[] = [...seeds];
  const tried = new Set(seeds.map((seed) => conversationKey(seed.turns.map(unexpected))));
  const states = new Set<string>();
  const counts = new Map<string, number>();
  const taken = new Set([...(options.reserved ?? []), ...seeds.map((seed) => seed.id)]);
  const kept: KeptCandidate[] = [];
  let coverage = seedCoverage;
  let runs = 0;
  let stopped = false;

  /** The next free `<operator>-<n>`. */
  const nextId = (operator: string): string => {
    let n = counts.get(operator) ?? 0;
    let id: string;
    do {
      n += 1;
      id = `${operator}-${String(n)}`;
    } while (taken.has(id));
    counts.set(operator, n);
    taken.add(id);
    return id;
  };

  /** Runs a candidate unless the search stopped, it ran before, or its state was tried. */
  const attempt = async (candidate: ExploreCandidate, state?: string): Promise<void> => {
    if (stopped || (state !== undefined && states.has(state))) return;
    const key = conversationKey(candidate.turns);
    if (tried.has(key)) return;
    const outcome = await trial(candidate);
    if (outcome === 'stopped') {
      stopped = true;
      return;
    }
    runs += 1;
    tried.add(key);
    if (state !== undefined) states.add(state);
    const reached = newCoverage(coverage, outcome.coverage);
    coverage = unionCoverage(coverage, outcome.coverage);
    if (reached.length === 0 && outcome.failed.length === 0) return;
    const id = nextId(candidate.operator);
    kept.push({ id, candidate, reached, failed: outcome.failed });
    pool.push({
      id,
      suite: candidate.suite,
      language: candidate.language,
      turns: candidate.turns,
      observed: outcome.observed,
    });
  };

  /** Each operator over one conversation of the pool, in order. */
  const operators: ((entry: Explored) => Promise<void>)[] = [
    // Following intents: the pack's turns after this conversation's answers.
    async (entry) => {
      const state = stateOf(entry.observed.at(-1));
      const intents = options.intents?.following(entry.language, conversation(entry)) ?? [];
      for (const intent of intents) {
        await attempt(
          goOn(entry, intent.intent, { user: intent.user }),
          `${intent.intent}|${state}`,
        );
      }
    },
    // A fault on the last turn, one kind at a time.
    async (entry) => {
      const last = entry.turns.at(-1);
      if (last === undefined || last.faults !== undefined) return;
      const state = stateOf(entry.observed.at(-1));
      for (const fault of options.faults) {
        const turns = entry.turns.map(unexpected);
        turns[turns.length - 1] = { ...unexpected(last), faults: [{ fault }] };
        const candidate = { ...goOn(entry, 'fault'), suite: 'resilience' as const, turns };
        await attempt(candidate, `fault:${fault.kind}|${state}`);
      }
    },
    // The last turn asked again.
    async (entry) => {
      const last = entry.turns.at(-1);
      if (last === undefined) return;
      await attempt(
        goOn(entry, 'repeat', opening(last)),
        `repeat|${stateOf(entry.observed.at(-1))}`,
      );
    },
    // The first turn of another conversation in the same language.
    async (entry) => {
      const state = stateOf(entry.observed.at(-1));
      for (const other of pool) {
        const first = other.turns[0];
        if (other === entry || other.language !== entry.language || first === undefined) continue;
        await attempt(
          goOn(entry, 'follow-up', opening(first)),
          `follow-up|${state}|${stateOf(other.observed[0])}`,
        );
      }
    },
  ];

  // Opening intents, once: they don't depend on the pool.
  for (const language of options.languages) {
    for (const intent of options.intents?.opening(language) ?? []) {
      await attempt({
        operator: intent.intent,
        from: undefined,
        suite: 'factual',
        language,
        turns: [{ user: intent.user }],
      });
    }
  }
  // Once stopped, a pass runs nothing, and the pool no longer grows.
  let grew = true;
  while (grew) {
    const before = pool.length;
    for (const operator of operators) {
      // The pool grows while the pass goes over it: new conversations get their turn too.
      for (let index = 0; index < pool.length; index += 1) {
        const entry = pool[index];
        if (entry !== undefined) await operator(entry);
      }
    }
    grew = pool.length > before;
  }
  return { kept, coverage, added: newCoverage(seedCoverage, coverage), runs, stopped };
}
