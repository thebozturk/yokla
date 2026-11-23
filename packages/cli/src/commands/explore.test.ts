import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_COVERAGE, Results } from '@yokla/core';
import { startTestServer, type TestServer } from '@yokla/runtime/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCases } from '../load.ts';
import { explorationResults, exploreCommand } from './explore.ts';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/**
 * A shop over HTTP: a search shows a tent at 10 TL, a policy question gets an
 * answer, a cart request totals the cart wrong, anything else is small talk.
 */
async function shop(): Promise<string> {
  const server = await startTestServer({
    onHttp: (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const message = String(Reflect.get(Object(body), 'message'));
        const reply = message.includes('sepete')
          ? { answer: 'Sepete eklendi. Toplam: 999,00 TL', route: 'cart', products: [] }
          : /çadır|tent/iu.test(message)
            ? {
                answer: 'Kubbe Çadır: 10,00 TL',
                route: 'search',
                products: [{ id: 'T1', name: 'Kubbe Çadır', price: 10 }],
              }
            : /koşul|iade/iu.test(message)
              ? { answer: 'İade 14 gün içinde.', route: 'policy', products: [] }
              : { answer: 'Merhaba!', route: 'chat', products: [] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply));
      });
    },
  });
  servers.push(server);
  return `${server.url.replace(/^ws/u, 'http')}/chat`;
}

const CASES = `version: 1
cases:
  - id: tents
    suite: factual
    language: tr
    turns:
      - user: Çadır var mı?
  - id: hello
    suite: quality
    language: tr
    turns:
      - user: Merhaba
`;

/** A workspace with a profile for `url`; `extra` is added to it, `route` maps the route. */
function workspace(url: string, options: { extra?: string; route?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-explore-'));
  writeFileSync(
    join(dir, 'catalog.jsonl'),
    `${JSON.stringify({ id: 'T1', type: 'out/tent', price: 10, name: 'Kubbe Çadır' })}\n`,
  );
  writeFileSync(
    join(dir, 'yokla.profile.yaml'),
    `version: 1
target:
  name: t
  adapter: http
  request: { url: '${url}', body: { message: '{{message}}' } }
  response:
    text: $.answer
${options.route === false ? '' : '    route: $.route\n'}    evidence:
      products: { items: '$.products[*]', fields: { id: id, name: name, price: price } }
languages: [tr]
domain: ecommerce
ecommerce:
  typeSeparator: /
  policies: { returns: { source: text, text: 'İade 14 gün içinde.' } }
  catalog:
    kind: file
    path: ./catalog.jsonl
    fields: { id: id, type: type, price: price, name: name }
${options.extra ?? ''}`,
  );
  writeFileSync(join(dir, 'cases.yaml'), CASES);
  return dir;
}

async function explore(dir: string, ...args: string[]) {
  const lines: string[] = [];
  const err: string[] = [];
  const code = await exploreCommand(
    [
      '--profile',
      join(dir, 'yokla.profile.yaml'),
      '--cases',
      join(dir, 'cases.yaml'),
      '--results',
      join(dir, 'results.json'),
      ...args,
    ],
    { out: (line) => lines.push(line), err: (line) => err.push(line) },
  );
  return { code, out: lines, err };
}

/** A run's proxy summary with these counts. */
function proxy(records: number, unattributed: number, cost: number, missing: number) {
  return {
    correlation: 'serial' as const,
    records,
    attributed: records - unattributed,
    unattributed,
    totals: { calls: records, costUsd: cost },
    missing: missing === 0 ? {} : { costUsd: missing },
    prompts: 'sizes' as const,
  };
}

/** A run's spans summary with this many spans. */
function spans(received: number, settled: boolean) {
  return {
    received,
    attributed: received,
    unattributed: 0,
    totals: { calls: received },
    missing: {},
    settled,
  };
}

describe('yokla explore (ADR-0044)', () => {
  it('searches by routes alone without a model proxy, and writes what it kept', async () => {
    const dir = workspace(await shop());
    const { code, out, err } = await explore(dir);
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out.slice(0, 2)).toEqual([
      'explore: 2 written cases once each, then up to 64 candidates: at most 66 runs',
      '  no model proxy: only routes count; no tools, argument shapes or faults',
    ]);
    expect(out).toContain('  routes: chat, search; added: cart, policy');
    const cases = loadCases([join(dir, 'explored.yaml')]);
    // The shop ignores price bounds: under its lowest price, it still shows the tent as
    // matching (ADR-0046). The cart answer's total is no price the conversation showed.
    expect(cases.map((c) => [c.id, c.provenance?.evidence])).toEqual([
      [
        'empty-band-1',
        'yokla explore, empty-band from an opening turn: failed filter-honoured-or-disclosed (filter-honesty) on turn 1; expects type "tent" (1 catalog type) at most 9, below its lowest price 10',
      ],
      [
        'cart-1',
        'yokla explore, cart from tents: failed price-grounded (fabrication) on turn 2; reached route:cart',
      ],
      // Asked again, the cart fails again.
      [
        'repeat-1',
        'yokla explore, repeat from cart-1: failed price-grounded (fabrication) on turn 3',
      ],
      ['policy-1', 'yokla explore, policy from an opening turn: reached route:policy'],
    ]);
    expect(cases.map((c) => c.provenance?.status)).toEqual([
      'proposed',
      'proposed',
      'proposed',
      'proposed',
    ]);
    // The intent's turn keeps what it asked.
    expect(cases[0]?.turns).toEqual([
      {
        user: '9 altında tent var mı?',
        expect: { productType: ['out/tent'], filters: { maxPrice: 9 } },
      },
    ]);
    expect(cases.every((c) => c.turns.every((turn) => turn.faults === undefined))).toBe(true);
    const results = Results.parse(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')));
    expect(results.run.coverage).toEqual({
      routes: ['cart', 'chat', 'policy', 'search'],
      tools: [],
      shapes: [],
      faultStates: [],
      offered: [],
      added: ['route:cart', 'route:policy'],
    });
    expect(results.cases.map((c) => [c.id, c.status])).toEqual([
      ['tents', 'pass'],
      // No check applies to small talk.
      ['hello', 'unmeasured'],
      ['empty-band-1', 'fail'],
      ['policy-1', 'pass'],
      ['cart-1', 'fail'],
      ['repeat-1', 'fail'],
    ]);
    expect(results.summary).toMatchObject({
      cases: 6,
      statuses: { pass: 2, unmeasured: 1, fail: 3 },
      // Passing over measured, the unmeasured case left out (ADR-0076).
      passRate: { passed: 2, measured: 5, rate: 0.4 },
    });
    // The trace holds every candidate that ran, kept or not (ADR-0046).
    const trace = results.run.exploration?.candidates ?? [];
    const ranLine = out.find((line) => / candidates run;/u.test(line)) ?? '';
    expect(trace).toHaveLength(Number(/\d+/u.exec(ranLine)?.[0]));
    expect(trace.slice(0, 4).map((entry) => [entry.operator, entry.messages, entry.kept])).toEqual([
      ['product', ['Kubbe Çadır var mı?'], null],
      ['type', ['tent var mı?'], null],
      ['under-price', ['10 altında tent var mı?'], null],
      ['empty-band', ['9 altında tent var mı?'], 'empty-band-1'],
    ]);
    expect(trace[0]?.routes).toEqual(['search']);
    expect(
      trace
        .filter((entry) => entry.kept !== null)
        .map((entry) => entry.kept ?? '')
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(cases.map((c) => c.id).toSorted());
    expect(out.at(-1)).toBe(`  results: ${join(dir, 'results.json')}`);
    // Never over a file it wrote.
    const again = await explore(dir);
    expect(again.code).toBe(2);
    expect(again.err).toEqual([
      `${join(dir, 'explored.yaml')} exists: explore never overwrites a file`,
    ]);
  });

  it('spreads its opening turns over --types types, 6 by default (ADR-0046)', async () => {
    const url = await shop();
    const asked = async (...args: string[]) => {
      const dir = workspace(url);
      writeFileSync(
        join(dir, 'catalog.jsonl'),
        [
          { id: 'T1', type: 'out/tent', price: 10, name: 'Kubbe Çadır' },
          { id: 'B1', type: 'out/bag', price: 20, name: 'Uyku Tulumu' },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n'),
      );
      await explore(dir, '--max-runs', '8', ...args);
      const results = Results.parse(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')));
      return (results.run.exploration?.candidates ?? []).flatMap((entry) => entry.messages);
    };
    // Branches by name: bag, then tent.
    const both = await asked();
    expect(both).toEqual(expect.arrayContaining(['bag var mı?', 'tent var mı?']));
    const one = await asked('--types', '1');
    expect(one).toContain('bag var mı?');
    expect(one).not.toContain('tent var mı?');
  });

  it('stops at --max-runs, and writes no case when nothing new was reached', async () => {
    const dir = workspace(await shop());
    const { code, out } = await explore(dir, '--max-runs', '1', '--out', join(dir, 'x.yaml'));
    expect(code).toBe(0);
    expect(out).toContain('  1 candidates run; model cost 0.000000 USD');
    expect(out).toContain('  stopped: --max-runs 1 was reached');
    // The one candidate, the opening product question, reached the search route again.
    expect(out).toContain('  nothing new reached and no check failed: no case written');
    expect(existsSync(join(dir, 'x.yaml'))).toBe(false);
  });

  it('leaves out a case with a simulated customer, and runs the others', async () => {
    const dir = workspace(await shop());
    writeFileSync(
      join(dir, 'cases.yaml'),
      `${CASES}  - id: shopper
    suite: quality
    language: tr
    customer:
      persona: Kampa gidecek.
      goal: bir çadır
      maxTurns: 2
      reached: { evidence: { cart: { includes: [T1] } } }
`,
    );
    // No customer model is configured: running the customer's case would be an error.
    const { code, out, err } = await explore(dir, '--max-runs', '1');
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out[1]).toBe('  1 cases with a simulated customer are left out');
    const results = Results.parse(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')));
    expect(results.cases.map((c) => c.id)).toEqual(['tents', 'hello']);
  });

  it('counts every run in the results: its model calls, issues and whether one stopped at a cap', async () => {
    const dir = workspace(await shop());
    await explore(dir, '--max-runs', '1');
    const ran = Results.parse(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')));
    const seeds = { ...ran, run: { ...ran.run, proxy: proxy(2, 0, 1, 0), issues: ['a'] } };
    const later = {
      ...ran,
      run: {
        ...ran.run,
        partial: true,
        finishedAt: new Date(Date.parse(ran.run.startedAt) + 5000).toISOString(),
        proxy: proxy(3, 1, 2, 1),
        issues: ['a', 'b'],
      },
    };
    const coverage = { ...EMPTY_COVERAGE, routes: ['x'] };
    const merged = explorationResults(seeds, [later], [], {
      kept: [],
      coverage,
      added: ['route:x'],
      runs: 1,
      stopped: true,
      trace: [],
    });
    expect(merged.run.partial).toBe(true);
    expect(merged.run.proxy).toEqual({ ...proxy(5, 1, 3, 1), attributed: 4 });
    expect(merged.run.issues).toEqual(['a', 'b']);
    expect(merged.run.coverage).toEqual({ ...coverage, added: ['route:x'] });
    expect(merged.run.durationMs).toBe(5000);
    expect(merged.run.finishedAt).toBe(later.run.finishedAt);
    // A run without the proxy adds nothing; the first with it starts the count.
    const plain = explorationResults(ran, [ran, later], [], {
      kept: [],
      coverage,
      added: [],
      runs: 2,
      stopped: false,
      trace: [],
    });
    expect(plain.run.proxy).toEqual(proxy(3, 1, 2, 1));
    expect(plain.run.partial).toBe(true);
    // Spans add up too, and are settled only when every run's were.
    const spanned = explorationResults(
      { ...ran, run: { ...ran.run, spans: spans(1, true) } },
      [ran, { ...ran, run: { ...ran.run, spans: spans(2, false) } }],
      [],
      { kept: [], coverage, added: [], runs: 2, stopped: false, trace: [] },
    );
    expect(spanned.run.spans).toEqual(spans(3, false));
  });

  it('refuses what it cannot search, before it sends anything', async () => {
    let requests = 0;
    const server = await startTestServer({
      onHttp: (_request, response) => {
        requests += 1;
        response.end('{}');
      },
    });
    servers.push(server);
    const url = `${server.url.replace(/^ws/u, 'http')}/chat`;
    const unrouted = workspace(url, { route: false });
    expect((await explore(unrouted)).err).toEqual([
      'yokla explore steers by the route the target answers on: map response.route in the profile (ADR-0044)',
    ]);
    const spending = workspace(url, {
      extra: `modelProxy:
  port: 1
  upstreams:
    - { id: fake, kind: openai-compatible, upstream: 'http://127.0.0.1:1' }
`,
    });
    expect((await explore(spending)).err).toEqual([
      'this exploration can spend money on model calls: run yokla explore with --max-cost <usd> (ADR-0044)',
    ]);
    const dir = workspace(url);
    expect((await explore(dir, '--max-runs', '0')).err).toEqual([
      '--max-runs must be a positive integer',
    ]);
    for (const bad of ['0', '1.5', 'x']) {
      expect((await explore(dir, '--types', bad)).err).toEqual([
        '--types must be a positive integer',
      ]);
    }
    expect((await explore(dir, '--max-cost', '0')).err).toEqual([
      '--max-cost must be a positive number of USD',
    ]);
    writeFileSync(
      join(dir, 'customer.yaml'),
      `version: 1
cases:
  - id: shopper
    suite: quality
    language: tr
    customer:
      persona: Kampa gidecek.
      goal: bir çadır
      maxTurns: 2
      reached: { evidence: { cart: { includes: [T1] } } }
`,
    );
    const customerErr: string[] = [];
    const onlyCustomers = await exploreCommand(
      ['--profile', join(dir, 'yokla.profile.yaml'), '--cases', join(dir, 'customer.yaml')],
      { out: () => undefined, err: (line) => customerErr.push(line) },
    );
    expect(onlyCustomers).toBe(2);
    expect(customerErr).toEqual(['no case with written turns to start from']);
    const unknown = await explore(dir, '--nope');
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toMatch(/nope/u);
    expect(requests).toBe(0);
    const help = await exploreCommand(['--help'], { out: () => undefined, err: () => undefined });
    expect(help).toBe(0);
  });
});
