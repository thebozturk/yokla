import { describe, expect, it } from 'vitest';
import type { Intents } from '../checks/types.ts';
import type { CaseTurn } from '../schema/cases.ts';
import type { Coverage } from './coverage.ts';
import {
  explore,
  exploreFaults,
  type ExploreCandidate,
  type Explored,
  type ExploreOutcome,
  type ObservedTurn,
} from './search.ts';

/** A target in a table: each message's route, the tool it asks for and the products it shows. */
const WORLD: Readonly<
  Record<string, { route: string; tool?: string; args?: string; products?: string[] }>
> = {
  tents: { route: 'search', tool: 'search', args: '{"q":1}', products: ['A', 'B'] },
  'cheap tents': { route: 'search', tool: 'search', args: '{"q":1,"max":2}', products: ['A'] },
  returns: { route: 'policy', tool: 'policy', args: '{"topic":1}' },
  çadır: { route: 'search', tool: 'search', args: '{"q":1}', products: ['A'] },
  hi: { route: 'fallback' },
  browse: { route: 'search', products: ['A'] },
  warranty: { route: 'policy', tool: 'policy', args: '{"topic":1}' },
  'add A': { route: 'cart', tool: 'cart', args: '{"id":1}' },
  'add B': { route: 'cart', tool: 'cart', args: '{"id":1}' },
};

function observe(turn: CaseTurn): ObservedTurn {
  const known = WORLD[turn.user];
  const route = turn.faults === undefined ? (known?.route ?? 'fallback') : 'fallback';
  const tools = turn.faults === undefined && known?.tool !== undefined ? [known.tool] : [];
  return {
    user: turn.user,
    route,
    evidence:
      turn.faults === undefined && known?.products !== undefined
        ? { products: known.products.map((name) => ({ name })) }
        : {},
    tools,
  };
}

const sorted = (set: ReadonlySet<string>): string[] => [...set].toSorted();

function coverageOf(turns: readonly CaseTurn[]): Coverage {
  const routes = new Set<string>();
  const tools = new Set<string>();
  const shapes = new Set<string>();
  const faultStates = new Set<string>();
  for (const turn of turns) {
    const seen = observe(turn);
    if (seen.route !== undefined) routes.add(seen.route);
    const known = WORLD[turn.user];
    if (turn.faults === undefined && known?.tool !== undefined) {
      tools.add(known.tool);
      shapes.add(`${known.tool}${known.args ?? ''}`);
    }
    for (const plan of turn.faults ?? []) faultStates.add(`${seen.route ?? ''}/${plan.fault.kind}`);
  }
  return {
    routes: sorted(routes),
    tools: sorted(tools),
    shapes: sorted(shapes),
    faultStates: sorted(faultStates),
    offered: ['cart', 'policy', 'search'],
  };
}

/**
 * A trial over the table, recording what ran; a check fails on a conversation
 * whose last message `failing` lists, or that `failingWhen` says.
 */
function world(
  options: {
    budget?: number;
    failing?: string[];
    failingWhen?: (users: readonly string[]) => boolean;
  } = {},
) {
  const ran: ExploreCandidate[] = [];
  const trial = (candidate: ExploreCandidate): Promise<ExploreOutcome | 'stopped'> => {
    if (ran.length >= (options.budget ?? Infinity)) return Promise.resolve('stopped');
    ran.push(candidate);
    const last = candidate.turns.at(-1)?.user ?? '';
    return Promise.resolve({
      coverage: coverageOf(candidate.turns),
      observed: candidate.turns.map(observe),
      failed:
        (options.failing ?? []).includes(last) ||
        (options.failingWhen?.(candidate.turns.map((turn) => turn.user)) ?? false)
          ? ['price-grounded (fabrication)']
          : [],
    });
  };
  const lines = () =>
    ran.map(
      (candidate) =>
        `${candidate.operator}: ${candidate.turns
          .map(
            (turn) =>
              turn.user +
              (turn.faults === undefined ? '' : `[${turn.faults[0]?.fault.kind ?? ''}]`),
          )
          .join(' / ')}`,
    );
  return { trial, ran, lines };
}

function seed(id: string, users: string[], language = 'en'): Explored {
  const turns: CaseTurn[] = users.map((user) => ({ user, expect: { answerable: true } }));
  return { id, suite: 'factual', language, turns, observed: turns.map(observe) };
}

const seedCoverage = (seeds: readonly Explored[]) => coverageOf(seeds.flatMap((s) => s.turns));

/** Adds the products an answer showed to the cart, one at a time; asks for cheaper after a search. */
const INTENTS: Intents = {
  opening: (language) => (language === 'en' ? [{ intent: 'policy', user: 'warranty' }] : []),
  following: (_language, conversation) => {
    const last = conversation.at(-1);
    const shown = (last?.evidence['products'] ?? []).map((item) =>
      JSON.stringify(item['name']).slice(1, -1),
    );
    const asked = new Set(conversation.map((turn) => turn.user));
    const next = shown.find((name) => !asked.has(`add ${name}`));
    return next === undefined ? [] : [{ intent: 'cart', user: `add ${next}` }];
  },
};

const FAULTS = exploreFaults(1000);

describe('explore (ADR-0044)', () => {
  it('opens with intents, then goes over the pool operator by operator, keeping what is new', async () => {
    const seeds = [seed('tents-en', ['tents']), seed('returns-en', ['returns'])];
    const { trial, lines: ran } = world();
    const result = await explore(
      seeds,
      seedCoverage(seeds),
      { intents: INTENTS, faults: FAULTS.slice(0, 2), languages: ['en'] },
      trial,
    );
    expect(ran()).toEqual([
      // Opening intents: the warranty question reaches nothing new.
      'policy: warranty',
      // Following intents: the cart is new; from the cart, nothing more is shown.
      'cart: tents / add A',
      // Faults: per state, each kind once.
      'fault: tents[status]',
      'fault: tents[timeout]',
      'fault: returns[status]',
      'fault: returns[timeout]',
      'fault: tents / add A[status]',
      'fault: tents / add A[timeout]',
      // The last turn again.
      'repeat: tents / tents',
      'repeat: returns / returns',
      'repeat: tents / add A / add A',
      // A kept fault ends on the fallback, a new state: its last turn is asked again
      // without the fault. The other kept fault ends the same way: not again.
      'repeat: tents[status] / tents',
      // The first turn of another conversation in the same language.
      'follow-up: tents / returns',
      'follow-up: returns / tents',
      'follow-up: tents / add A / tents',
      'follow-up: tents / add A / returns',
      // From the fallback, tents ran already as the repeat: the state stays untried
      // until the next conversation that ends on the fallback.
      'follow-up: tents[status] / returns',
      'follow-up: tents[timeout] / tents',
    ]);
    expect(result.kept.map((kept) => [kept.id, kept.reached, kept.failed])).toEqual([
      ['cart-1', ['route:cart', 'tool:cart', 'shape:cart{"id":1}'], []],
      ['fault-1', ['route:fallback', 'fault:fallback/status'], []],
      ['fault-2', ['fault:fallback/timeout'], []],
    ]);
    expect(result.added).toEqual([
      'route:cart',
      'route:fallback',
      'tool:cart',
      'shape:cart{"id":1}',
      'fault:fallback/status',
      'fault:fallback/timeout',
    ]);
    expect(result.coverage.routes).toEqual(['cart', 'fallback', 'policy', 'search']);
    expect(result.runs).toBe(18);
    expect(result.stopped).toBe(false);
  });

  it('keeps a candidate a check fails on, and goes on from it', async () => {
    const seeds = [seed('tents-en', ['tents'])];
    const { trial, lines: ran } = world({ failing: ['add A'] });
    const result = await explore(
      seeds,
      seedCoverage(seeds),
      { intents: INTENTS, faults: [], languages: [] },
      trial,
    );
    const kept = result.kept.map((k) => [k.id, k.candidate.from, k.reached.length, k.failed]);
    // The repeat reaches nothing new, but a check fails on it.
    expect(kept).toEqual([
      ['cart-1', 'tents-en', 3, ['price-grounded (fabrication)']],
      ['repeat-1', 'cart-1', 0, ['price-grounded (fabrication)']],
    ]);
    expect(ran()).toEqual([
      'cart: tents / add A',
      'repeat: tents / tents',
      'repeat: tents / add A / add A',
      // repeat-1 ends as cart-1 does: its operators were tried.
      'follow-up: tents / add A / tents',
    ]);
    // The cart answer shows no products, so no second addition follows it here.
    const shows = world({ failing: ['add B'] });
    const both: Intents = {
      opening: () => [],
      following: (_language, conversation) => {
        const asked = new Set(conversation.map((turn) => turn.user));
        return ['add A', 'add B']
          .filter((user) => !asked.has(user))
          .slice(0, 1)
          .map((user) => ({ intent: 'cart', user }));
      },
    };
    const deeper = await explore(
      seeds,
      seedCoverage(seeds),
      { intents: both, faults: [], languages: [] },
      shows.trial,
    );
    expect(deeper.kept.map((k) => [k.id, k.candidate.turns.map((t) => t.user), k.failed])).toEqual([
      ['cart-1', ['tents', 'add A'], []],
      ['cart-2', ['tents', 'add A', 'add B'], ['price-grounded (fabrication)']],
    ]);
  });

  it('tries an operator once per state a conversation ends in', async () => {
    const seeds = [
      seed('a', ['tents']),
      seed('b', ['cheap tents']),
      seed('c', ['hi']),
      seed('d', ['browse']),
    ];
    const { trial, lines: ran } = world();
    await explore(seeds, seedCoverage(seeds), { faults: [], languages: [] }, trial);
    // tents and cheap tents end the same way (search, asking search): one repeat for both.
    // browse ends on the search route too, but asks for no tool: another state.
    expect(ran().filter((line) => line.startsWith('repeat'))).toEqual([
      'repeat: tents / tents',
      'repeat: hi / hi',
      'repeat: browse / browse',
    ]);
    // A follow-up pairs states: a search, then a search, is tried once.
    expect(ran().filter((line) => line.startsWith('follow-up'))).toEqual([
      'follow-up: tents / cheap tents',
      'follow-up: tents / hi',
      'follow-up: tents / browse',
      'follow-up: hi / tents',
      'follow-up: hi / browse',
      'follow-up: browse / tents',
      'follow-up: browse / hi',
    ]);
    // Each intent is its own operator: two intents from one conversation both run.
    const two: Intents = {
      opening: () => [],
      following: (_language, conversation) =>
        conversation.length === 1
          ? [
              { intent: 'cart', user: 'add A' },
              { intent: 'cheaper', user: 'cheap tents' },
            ]
          : [],
    };
    const both = world();
    const first = seeds.slice(0, 1);
    await explore(
      first,
      seedCoverage(first),
      { intents: two, faults: [], languages: [] },
      both.trial,
    );
    expect(both.lines().slice(0, 2)).toEqual([
      'cart: tents / add A',
      'cheaper: tents / cheap tents',
    ]);
  });

  it('goes over the pool again while a pass kept something, never a conversation with itself', async () => {
    // A two-turn conversation offers an intent; the follow-up that makes one is kept in the last operator.
    const longer: Intents = {
      opening: () => [],
      following: (_language, conversation) =>
        conversation.length === 2 ? [{ intent: 'more', user: 'tents' }] : [],
    };
    const seeds = [seed('a', ['hi']), seed('b', ['returns'])];
    const { trial, lines: ran } = world({
      failingWhen: (users) => users.join(' / ') === 'hi / returns',
    });
    const result = await explore(
      seeds,
      seedCoverage(seeds),
      { intents: longer, faults: [], languages: [] },
      trial,
    );
    expect(result.kept.map((kept) => kept.id)).toEqual(['follow-up-1', 'more-1']);
    expect(ran()).toContain('more: hi / returns / tents');
    const two = [seed('two', ['tents', 'returns'])];
    const alone = world();
    await explore(two, seedCoverage(two), { faults: [], languages: [] }, alone.trial);
    expect(alone.lines()).toEqual(['repeat: tents / returns / returns']);
  });

  it('follows up only in the same language, and leaves faults to a proxy', async () => {
    const seeds = [seed('en', ['tents']), seed('tr', ['çadır'], 'tr'), seed('en2', ['hi'])];
    const { trial, ran } = world();
    await explore(seeds, seedCoverage(seeds), { faults: [], languages: ['en', 'tr'] }, trial);
    expect(ran.some((candidate) => candidate.operator === 'fault')).toBe(false);
    for (const candidate of ran.filter((c) => c.operator === 'follow-up')) {
      const users = candidate.turns.map((turn) => turn.user);
      expect(users.includes('çadır') ? users.every((u) => u === 'çadır') : true).toBe(true);
      expect(candidate.language).toBe(users.includes('çadır') ? 'tr' : 'en');
    }
  });

  it('writes candidates without expectations, a fault on the last turn only, as resilience', async () => {
    const seeds = [
      {
        ...seed('two', ['tents', 'returns']),
        turns: [
          { user: 'tents', request: { headers: { x: '1' } }, expect: { a: 1 } },
          { user: 'returns', expect: { b: 2 } },
        ],
      },
      {
        ...seed('faulted', ['hi']),
        turns: [{ user: 'hi', faults: [{ fault: { kind: 'empty-content' as const } }] }],
      },
    ];
    const { trial, ran } = world();
    await explore(seeds, seedCoverage(seeds), { faults: FAULTS.slice(0, 1), languages: [] }, trial);
    const fault = ran.find((candidate) => candidate.operator === 'fault');
    expect(fault?.suite).toBe('resilience');
    expect(fault?.turns).toEqual([
      { user: 'tents', request: { headers: { x: '1' } } },
      { user: 'returns', faults: [{ fault: { kind: 'status', status: 503 } }] },
    ]);
    // A seed whose last turn arms faults already gets no other.
    expect(ran.filter((c) => c.operator === 'fault').map((c) => c.from)).toEqual(['two']);
    const followUp = ran.find((c) => c.operator === 'follow-up' && c.from === 'faulted');
    expect(followUp?.turns).toEqual([
      { user: 'hi', faults: [{ fault: { kind: 'empty-content' } }] },
      { user: 'tents', request: { headers: { x: '1' } } },
    ]);
    expect(ran.every((c) => c.turns.every((turn) => turn.expect === undefined))).toBe(true);
  });

  it('runs no conversation twice, nor one a seed already is', async () => {
    const seeds = [seed('a', ['tents']), seed('b', ['tents', 'tents'])];
    const { trial, lines: ran } = world();
    await explore(seeds, seedCoverage(seeds), { faults: [], languages: [] }, trial);
    expect(ran()).not.toContain('repeat: tents / tents');
    const opening: Intents = {
      opening: () => [{ intent: 'x', user: 'tents' }],
      following: () => [],
    };
    const again = world();
    await explore(
      seeds,
      seedCoverage(seeds),
      { intents: opening, faults: [], languages: ['en', 'tr'] },
      again.trial,
    );
    expect(again.ran.filter((c) => c.operator === 'x')).toEqual([]);
    // A seed that sends the same message with its own request is another conversation.
    const sent = [
      { ...seed('r', ['tents']), turns: [{ user: 'tents', request: { headers: { x: '1' } } }] },
    ];
    const third = world();
    await explore(
      sent,
      seedCoverage(sent),
      { intents: opening, faults: [], languages: ['en'] },
      third.trial,
    );
    expect(third.ran.filter((c) => c.operator === 'x')).toEqual([
      {
        operator: 'x',
        from: undefined,
        suite: 'factual',
        language: 'en',
        turns: [{ user: 'tents' }],
      },
    ]);
  });

  it('stops when the trial says so, and names kept cases clear of other ids', async () => {
    const seeds = [seed('tents-en', ['tents'])];
    const { trial, ran } = world({ budget: 2 });
    const result = await explore(
      seeds,
      seedCoverage(seeds),
      { intents: INTENTS, faults: FAULTS, languages: ['en'], reserved: ['cart-1', 'cart-3'] },
      trial,
    );
    expect(ran).toHaveLength(2);
    expect(result.runs).toBe(2);
    expect(result.stopped).toBe(true);
    // The warranty question reaches the policy route, which the seed didn't.
    expect(result.kept.map((kept) => kept.id)).toEqual(['policy-1', 'cart-2']);
    const seededIds = [seed('fault-1', ['hi'])];
    const named = await explore(
      seededIds,
      seedCoverage(seededIds),
      { faults: FAULTS.slice(0, 2), languages: [] },
      world().trial,
    );
    expect(named.kept.map((kept) => kept.id)).toEqual(['fault-2', 'fault-3']);
  });
});
