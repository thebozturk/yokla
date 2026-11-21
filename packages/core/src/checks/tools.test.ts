import { describe, expect, it } from 'vitest';
import { coreExpectations } from '../schema/cases.ts';
import { checkContext, mutate, proxyCall, turnView } from '../testing.ts';
import { toolCalls, toolCallValid } from './tools.ts';
import type { CheckOutcome, ProxyCallView, TurnView } from './types.ts';

function verdicts(outcome: CheckOutcome): string[] {
  if (!outcome.applicable) return [`n/a: ${outcome.reason}`];
  return [
    ...outcome.findings.map((f) => `${f.verdict}: ${f.message}`),
    ...(outcome.unmeasured ?? []).map((u) => `unmeasured: ${u.reason}`),
  ];
}

type Asked = NonNullable<ProxyCallView['toolCalls']>[number];
const ask = (name: string, args: unknown = {}): Asked => ({
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});
const call = (offered: string[] | null, ...asked: Asked[]) =>
  proxyCall({ offered, toolCalls: asked });
const UNREAD = proxyCall({ offered: ['search_products'], toolCalls: null });
const proxied = (...calls: ProxyCallView[]): TurnView['proxy'] => ({ calls, costUsd: 0 });

const TOOLS = ['search_products', 'get_policy', 'cheapest_shown'];
const SEARCH = ask('search_products', { productType: 'tent', filters: { priceMax: 500 } });

const turn = (tools: unknown, proxy: TurnView['proxy']): TurnView =>
  turnView({ expect: tools === undefined ? {} : { tools }, proxy });
const judge = (tools: unknown, proxy: TurnView['proxy']) =>
  verdicts(toolCalls.run(checkContext(turn(tools, proxy))));
const validity = (proxy: TurnView['proxy']) =>
  verdicts(toolCallValid.run(checkContext(turn(undefined, proxy))));

const parse = (value: unknown) => coreExpectations.tools.safeParse(value).success;

describe('the tools expectation', () => {
  it('needs at least one of its keys, and well-formed values', () => {
    expect(parse({ called: ['search_products'] })).toBe(true);
    expect(parse({ maxCalls: 0 })).toBe(true);
    expect(parse({ args: { search_products: { 'filters.priceMax': 500 } } })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ order: ['search_products'] })).toBe(false);
    expect(parse({ called: [] })).toBe(false);
    expect(parse({ maxCalls: -1 })).toBe(false);
    expect(parse({ other: true })).toBe(false);
    expect(parse({ atMost: { add_to_cart: { quantity: 2 } } })).toBe(true);
    expect(parse({ atMost: { add_to_cart: { quantity: 'two' } } })).toBe(false);
  });
});

/** A cart call with these arguments (ADR-0086). */
const cartCall = (args: unknown) => ask('add_to_cart', args);

describe('tool-calls atMost (ADR-0086)', () => {
  const LIMIT = { atMost: { add_to_cart: { quantity: 2 } } };

  it('passes calls within the limit, and calls without the path, which take the tool default', () => {
    expect(
      judge(
        LIMIT,
        proxied(
          call(TOOLS, cartCall({ productId: 'P', quantity: 2 }), cartCall({ productId: 'P' })),
        ),
      ),
    ).toEqual(['pass: 2 tool calls as expected: add_to_cart, add_to_cart']);
    // Another tool's quantity is not this limit's.
    expect(judge(LIMIT, proxied(call(TOOLS, ask('order_more', { quantity: 9 }))))).toEqual([
      'pass: 1 tool call as expected: order_more',
    ]);
  });

  it('fails a number above the limit, or digits read as one, naming the tool, path and limit', () => {
    expect(
      toolCalls.run(
        checkContext(
          turn(LIMIT, proxied(call(TOOLS, cartCall({ quantity: 3 }), cartCall({ quantity: '5' })))),
        ),
      ),
    ).toEqual({
      applicable: true,
      findings: [
        {
          dimension: 'tool-use',
          verdict: 'fail',
          severity: 'high',
          message: '2 calls of add_to_cart asked for more than 2 at quantity',
          evidence: { tool: 'add_to_cart', path: 'quantity', max: 2 },
        },
      ],
    });
    expect(
      judge(
        { atMost: { add_to_cart: { 'item.count': 1 } } },
        proxied(call(TOOLS, cartCall({ item: { count: 2 } }))),
      ),
    ).toEqual(['fail: 1 call of add_to_cart asked for more than 1 at item.count']);
  });

  it("fails a value it can't read as a number, and arguments that aren't JSON", () => {
    expect(
      judge(LIMIT, proxied(call(TOOLS, cartCall({ quantity: 'many' }), cartCall('{broken')))),
    ).toEqual([
      "fail: 2 calls of add_to_cart had at quantity a value that isn't a number, so not within 2",
    ]);
    expect(
      judge(LIMIT, proxied(call(TOOLS, cartCall({ quantity: 3 }), cartCall({ quantity: null })))),
    ).toEqual([
      'fail: 1 call of add_to_cart asked for more than 2 at quantity',
      "fail: 1 call of add_to_cart had at quantity a value that isn't a number, so not within 2",
    ]);
  });

  it('reads the calls it was given: a mutated quantity moves the verdict', () => {
    const base = turn(LIMIT, proxied(call(TOOLS, cartCall({ quantity: 2 }))));
    const over = mutate(base, (view) => ({
      ...view,
      proxy: proxied(call(TOOLS, cartCall({ quantity: 3 }))),
    }));
    expect(verdicts(toolCalls.run(checkContext(base)))[0]).toMatch(/^pass/u);
    expect(verdicts(toolCalls.run(checkContext(over)))[0]).toMatch(/^fail/u);
  });
});

describe('tool-calls (ADR-0025)', () => {
  it('does not apply without a tools expectation', () => {
    expect(judge(undefined, proxied(call(TOOLS, SEARCH)))).toEqual([
      'n/a: the turn expects nothing of tool calls',
    ]);
  });

  it('passes a trajectory that meets every expectation, naming its calls', () => {
    const tools = {
      called: ['search_products'],
      notCalled: ['add_to_cart'],
      args: { search_products: { productType: 'tent', 'filters.priceMax': 500 } },
      order: ['search_products', 'cheapest_shown'],
      maxCalls: 2,
    };
    const proxy = proxied(call(TOOLS, SEARCH), call(TOOLS, ask('cheapest_shown')));
    expect(judge(tools, proxy)).toEqual([
      'pass: 2 tool calls as expected: search_products, cheapest_shown',
    ]);
    expect(judge({ maxCalls: 0 }, proxied(call(TOOLS)))).toEqual([
      'pass: no tool calls, as expected',
    ]);
  });

  it('fails a tool never asked for, and one the turn forbids', () => {
    expect(judge({ called: ['get_policy'] }, proxied(call(TOOLS, SEARCH)))).toEqual([
      'fail: never asked for get_policy',
    ]);
    const cart = proxied(
      call(TOOLS, SEARCH),
      call(['add_to_cart'], ask('add_to_cart', { id: 'P1' })),
    );
    expect(judge({ notCalled: ['add_to_cart'] }, cart)).toEqual([
      'fail: asked for add_to_cart, which the turn forbids (1 time)',
    ]);
  });

  it('matches arguments by dotted path and JSON value, on any call of the tool', () => {
    const cheap = ask('search_products', { productType: 'tent', filters: { priceMax: 300 } });
    const proxy = proxied(call(TOOLS, cheap, SEARCH));
    expect(judge({ args: { search_products: { 'filters.priceMax': 500 } } }, proxy)).toEqual([
      'pass: 2 tool calls as expected: search_products, search_products',
    ]);
    expect(judge({ args: { search_products: { 'filters.priceMax': 400 } } }, proxy)).toEqual([
      'fail: no call of search_products has filters.priceMax 400 (2 calls)',
    ]);
    // Every field must match on the same call.
    expect(
      judge(
        { args: { search_products: { productType: 'tent', 'filters.priceMax': 999 } } },
        proxy,
      )[0],
    ).toMatch(/^fail/u);
    // A string is not the number it spells, and a missing field matches nothing.
    expect(judge({ args: { search_products: { 'filters.priceMax': '500' } } }, proxy)).toHaveLength(
      1,
    );
    expect(judge({ args: { search_products: { 'filters.size': null } } }, proxy)[0]).toMatch(
      /^fail/u,
    );
    // Objects and arrays compare as JSON, whatever the key order.
    const nested = proxied(
      call(TOOLS, ask('search_products', { filters: { a: [1, { b: 2 }], c: 3 } })),
    );
    expect(
      judge({ args: { search_products: { filters: { c: 3, a: [1, { b: 2 }] } } } }, nested)[0],
    ).toMatch(/^pass/u);
    expect(
      judge({ args: { search_products: { filters: { a: [1, { b: 2 }] } } } }, nested)[0],
    ).toMatch(/^fail/u);
    expect(
      judge(
        { args: { search_products: { filters: { a: [1, { b: 2 }], c: 3, d: 4 } } } },
        nested,
      )[0],
    ).toMatch(/^fail/u);
    expect(judge({ args: { search_products: { 'filters.a': [{ b: 2 }, 1] } } }, nested)[0]).toMatch(
      /^fail/u,
    );
  });

  it('fails expected arguments when the tool was never asked for, or its arguments are broken', () => {
    expect(
      judge({ args: { get_policy: { topic: 'returns' } } }, proxied(call(TOOLS, SEARCH))),
    ).toEqual(['fail: never asked for get_policy, so no call has topic "returns"']);
    const broken = proxied(call(TOOLS, ask('get_policy', '{"topic": "ret')));
    expect(judge({ args: { get_policy: { topic: 'returns' } } }, broken)).toEqual([
      'fail: no call of get_policy has topic "returns" (1 call)',
    ]);
    // Empty arguments are none, and match an expectation of no fields' values only if met.
    const empty = proxied(call(TOOLS, ask('cheapest_shown', '')));
    expect(judge({ args: { cheapest_shown: { language: 'tr' } } }, empty)[0]).toMatch(/^fail/u);
  });

  it('judges order across calls, with others between allowed', () => {
    const proxy = proxied(
      call(TOOLS, SEARCH),
      call(TOOLS, ask('get_policy'), ask('cheapest_shown')),
    );
    expect(judge({ order: ['search_products', 'cheapest_shown'] }, proxy)[0]).toMatch(/^pass/u);
    expect(judge({ order: ['cheapest_shown', 'search_products'] }, proxy)).toEqual([
      "fail: didn't ask for cheapest_shown, search_products in this order",
    ]);
    expect(
      judge({ order: ['search_products', 'get_policy', 'cheapest_shown', 'get_policy'] }, proxy)[0],
    ).toMatch(/^fail/u);
  });

  it('fails more tool calls than allowed', () => {
    const twice = proxied(call(TOOLS, SEARCH), call(TOOLS, SEARCH));
    expect(judge({ maxCalls: 1 }, twice)).toEqual(['fail: 2 tool calls, more than the 1 allowed']);
    expect(judge({ maxCalls: 2 }, twice)[0]).toMatch(/^pass/u);
  });

  it('is unmeasured without proxy data, or with a call whose tool calls are unknown', () => {
    expect(judge({ called: ['search_products'] }, undefined)).toEqual([
      'unmeasured: no model proxy data for this turn',
    ]);
    expect(judge({ called: ['search_products'] }, proxied(call(TOOLS, SEARCH), UNREAD))).toEqual([
      "unmeasured: the tool calls of a model call couldn't be read",
    ]);
  });

  it('never quotes the arguments the target sent', () => {
    const secret = ask('search_products', { query: 'ayse@example.com', productType: 'tent' });
    const outcome = toolCalls.run(
      checkContext(
        turn({ args: { search_products: { productType: 'tarp' } } }, proxied(call(TOOLS, secret))),
      ),
    );
    expect(JSON.stringify(outcome)).not.toContain('ayse@example.com');
  });

  it('catches a forbidden call slipped into a passing trajectory', () => {
    const base = turn({ notCalled: ['add_to_cart'] }, proxied(call(TOOLS, SEARCH)));
    const slipped = mutate(base, (view) => ({
      ...view,
      proxy: proxied(call([...TOOLS, 'add_to_cart'], SEARCH, ask('add_to_cart'))),
    }));
    expect(verdicts(toolCalls.run(checkContext(base)))[0]).toMatch(/^pass/u);
    expect(verdicts(toolCalls.run(checkContext(slipped)))[0]).toMatch(/^fail/u);
  });
});

describe('tool-call-valid (ADR-0025)', () => {
  it('applies only when a call offered tools', () => {
    expect(validity(undefined)).toEqual(['n/a: no model call of the turn offered tools']);
    expect(validity(proxied(call([]), call(null, SEARCH)))).toEqual([
      'n/a: no model call of the turn offered tools',
    ]);
  });

  it('passes calls that asked only for offered tools, with valid JSON, including none', () => {
    expect(validity(proxied(call(TOOLS, SEARCH, ask('get_policy', ''))))).toEqual([
      'pass: 2 tool calls, each offered and with valid JSON arguments',
    ]);
    expect(validity(proxied(call(TOOLS)))).toEqual(['pass: no tool calls']);
  });

  it('fails a tool the same call did not offer, and arguments that are not JSON', () => {
    // The search was offered by the first call, not by the second that asked for it.
    const proxy = proxied(
      call(TOOLS),
      call(['get_policy'], SEARCH, ask('get_policy', '{"topic":')),
    );
    expect(validity(proxy)).toEqual([
      "fail: model call 2 of those that offered tools asked for search_products, which it didn't offer",
      "fail: model call 2 of those that offered tools asked for get_policy with arguments that aren't valid JSON",
    ]);
  });

  it('is unmeasured when an offering call has unknown tool calls, keeping any failure', () => {
    expect(validity(proxied(UNREAD))).toEqual([
      "unmeasured: the tool calls of a model call couldn't be read",
    ]);
    expect(validity(proxied(call(TOOLS, ask('add_to_cart')), UNREAD))).toEqual([
      "fail: model call 1 of those that offered tools asked for add_to_cart, which it didn't offer",
      "unmeasured: the tool calls of a model call couldn't be read",
    ]);
  });
});
