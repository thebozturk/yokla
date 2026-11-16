import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Results } from '@yokla/core';
import { startTestServer, type TestServer } from '@yokla/runtime/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { readResults } from '../load.ts';
import { prepareRun } from '../prepare.ts';
import { ToolError, type McpTool } from './protocol.ts';
import { canSpend, EVIDENCE_LIMIT, Session, sessionTools, spentBy, TEXT_LIMIT } from './tools.ts';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A target over HTTP whose answer `answers` gives; undefined answers 500. */
async function target(answers: {
  reply: (message: string) => string | { answer: string; products: unknown[] } | undefined;
}): Promise<string> {
  const server = await startTestServer({
    onHttp: (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const answer = answers.reply(String(Reflect.get(Object(body), 'message')));
        response.writeHead(answer === undefined ? 500 : 200, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify(
            answer === undefined
              ? { error: 'down' }
              : typeof answer === 'string'
                ? { answer }
                : answer,
          ),
        );
      });
    },
  });
  servers.push(server);
  return `${server.url.replace(/^ws/u, 'http')}/chat`;
}

const CASES = `version: 1
cases:
  - id: price
    suite: quality
    language: tr
    turns:
      - user: merhaba
      - user: fiyat nedir
        expect: { answer: { notContains: [bozuk] } }
  - id: greet
    suite: quality
    language: tr
    turns:
      - user: selam
        expect: { answer: { notEmpty: true } }
  - id: thanks
    suite: quality
    language: tr
    turns:
      - user: teşekkürler
        expect: { answer: { notEmpty: true } }
  - id: deals
    suite: factual
    language: tr
    turns:
      - user: kampanya
        expect: { answer: { notContains: [bozuk] } }
  - id: other
    suite: factual
    language: tr
    turns:
      - user: uzun
        expect: { answer: { notEmpty: true } }
  - id: draft
    suite: quality
    language: tr
    provenance: { source: template, evidence: test, status: proposed }
    turns: [{ user: selam }]
`;

/** A workspace with a profile for `url`, the cases and an out directory. */
function workspace(url: string, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-mcp-'));
  writeFileSync(
    join(dir, 'yokla.profile.yaml'),
    `version: 1
target:
  name: t
  adapter: http
  request: { url: '${url}', body: { message: '{{message}}' } }
  response:
    text: $.answer
    evidence:
      products: { items: '$.products[*]', fields: { id: id, name: name, price: price } }
languages: [tr]
domain: ecommerce
${extra}`,
  );
  writeFileSync(join(dir, 'cases.yaml'), CASES);
  return {
    dir,
    settings: {
      profile: join(dir, 'yokla.profile.yaml'),
      cases: [join(dir, 'cases.yaml')],
      out: join(dir, 'runs'),
      version: '0.0.0-test',
    },
  };
}

function tool(tools: McpTool[], name: string): McpTool {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const field = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((at, key) => Reflect.get(Object(at), key), value);

/** The shop: answers "bozuk" to the price and deals questions while broken. */
function shop() {
  const state = { broken: true, emptyGreeting: false, down: false, flaky: false, asked: 0 };
  const reply = (message: string): string | { answer: string; products: unknown[] } | undefined => {
    if (state.down) return undefined;
    switch (message) {
      case 'fiyat nedir':
        return state.broken && (!state.flaky || (state.asked += 1) % 2 === 0)
          ? 'bozuk fiyat: 1.169,10 TL'
          : 'fiyat 899,50 TL';
      case 'kampanya':
        return state.broken ? 'bozuk kampanya' : 'kampanya yok';
      case 'uzun':
        return {
          answer: 'ç'.repeat(TEXT_LIMIT + 10),
          products: Array.from({ length: EVIDENCE_LIMIT + 5 }, (_v, i) => ({
            id: `P${String(i)}`,
            name: `Ürün ${String(i)}`,
            price: 10 + i,
          })),
        };
      case 'selam':
      case 'çok teşekkürler':
        return state.emptyGreeting ? '' : 'Merhaba!';
      default:
        return 'Merhaba!';
    }
  };
  return { state, reply };
}

describe('the MCP tools (ADR-0041)', () => {
  it('lists the cases with their turns and review status', async () => {
    const { settings } = workspace(await target(shop()));
    const tools = sessionTools(new Session(settings));
    const listed = await tool(tools, 'list_cases').call({});
    expect(field(listed, 'cases')).toEqual([
      { id: 'price', suite: 'quality', language: 'tr', turns: 2, review: 'approved' },
      { id: 'greet', suite: 'quality', language: 'tr', turns: 1, review: 'approved' },
      { id: 'thanks', suite: 'quality', language: 'tr', turns: 1, review: 'approved' },
      { id: 'deals', suite: 'factual', language: 'tr', turns: 1, review: 'approved' },
      { id: 'other', suite: 'factual', language: 'tr', turns: 1, review: 'approved' },
      { id: 'draft', suite: 'quality', language: 'tr', turns: 1, review: 'proposed' },
    ]);
  });

  it('runs cases, writes their results, and returns each failing finding', async () => {
    const { settings } = workspace(await target(shop()));
    const tools = sessionTools(new Session(settings));
    const ran = await tool(tools, 'run_cases').call({ cases: ['price', 'greet'] });
    const run = String(field(ran, 'run'));
    expect(existsSync(join(settings.out, `${run}.json`))).toBe(true);
    expect(field(ran, 'results')).toBe(join(settings.out, `${run}.json`));
    expect(field(ran, 'statuses')).toEqual({ fail: 1, pass: 1 });
    expect(field(ran, 'notPassed')).toEqual([
      {
        id: 'price',
        status: 'fail',
        failing: [
          expect.objectContaining({
            sample: 0,
            turn: 1,
            check: 'answer-text',
            subject: { kind: 'text', text: 'bozuk' },
            origin: expect.objectContaining({ stage: 'unknown' }) as unknown,
          }) as unknown,
        ],
      },
    ]);
    // Without a model proxy, the target's cost can't be counted.
    expect(field(ran, 'cost')).toEqual({
      spentUsd: 0,
      sessionSpentUsd: 0,
      note: "without a model proxy, the target's cost is unknown and isn't counted",
    });
    await expect(tool(tools, 'run_cases').call({ cases: ['nope'] })).rejects.toThrow(
      new ToolError('no case "nope": list_cases lists them'),
    );
  });

  it('explains a case turn by turn, with long answers cut and only the failing findings', async () => {
    const { settings } = workspace(await target(shop()));
    const tools = sessionTools(new Session(settings));
    const all = await tool(tools, 'run_cases').call({});
    const run = String(field(all, 'run'));
    // A proposed case is counted, and also apart.
    expect(field(all, 'proposed')).toEqual({ unmeasured: 1 });
    const notPassed = field(all, 'notPassed');
    expect(
      Array.isArray(notPassed)
        ? notPassed.map((c: unknown) => [field(c, 'id'), field(c, 'proposed')])
        : [],
    ).toEqual([
      ['price', undefined],
      ['deals', undefined],
      ['draft', true],
    ]);
    const explained = await tool(tools, 'explain_finding').call({ run, case: 'price' });
    expect(explained).toMatchObject({
      run,
      case: 'price',
      status: 'fail',
      failingDimensions: ['answer-content'],
      sample: 0,
      samples: 1,
      turns: [
        { turn: 0, user: 'merhaba', answer: { status: 200, text: 'Merhaba!' }, failing: [] },
        {
          turn: 1,
          user: 'fiyat nedir',
          answer: { text: 'bozuk fiyat: 1.169,10 TL' },
          failing: [{ check: 'answer-text' }],
          calls: [],
        },
      ],
    });
    const long = await tool(tools, 'explain_finding').call({ run, case: 'other' });
    expect(field(long, 'turns', 0, 'answer', 'text')).toHaveLength(TEXT_LIMIT);
    expect(field(long, 'turns', 0, 'answer', 'cut')).toBe(true);
    // The evidence a check compares with, each collection cut at its first items.
    expect(field(long, 'turns', 0, 'answer', 'evidence', 'products', 'length')).toBe(
      EVIDENCE_LIMIT,
    );
    expect(field(long, 'turns', 0, 'answer', 'evidence', 'products', 0)).toEqual({
      id: 'P0',
      name: 'Ürün 0',
      price: 10,
    });
    expect(field(long, 'turns', 0, 'answer', 'evidenceCut')).toEqual(['products']);
    // A turn that returned no product says so; nothing was cut.
    expect(field(explained, 'turns', 1, 'answer', 'evidence')).toEqual({ products: [] });
    expect(field(explained, 'turns', 1, 'answer', 'evidenceCut')).toBeUndefined();
    await expect(
      tool(tools, 'explain_finding').call({ run, case: 'price', sample: 3 }),
    ).rejects.toThrow(/ran 1 sample\(s\)/u);
    await expect(
      tool(tools, 'explain_finding').call({ run: 'nope', case: 'price' }),
    ).rejects.toThrow('no run "nope": run_cases returns run ids');
    // A run id is a name, never a path.
    expect(tool(tools, 'explain_finding').input.safeParse({ run: '../x', case: 'a' }).success).toBe(
      false,
    );
  });

  it('explains the first sample that failed, by default', async () => {
    const answers = shop();
    answers.state.flaky = true;
    const { settings } = workspace(await target(answers));
    const tools = sessionTools(new Session(settings));
    const ran = await tool(tools, 'run_cases').call({ cases: ['price'], samples: 2 });
    const run = String(field(ran, 'run'));
    // The first sample passed, the second failed.
    expect(field(ran, 'notPassed', 0, 'failing', 0, 'sample')).toBe(1);
    const explained = await tool(tools, 'explain_finding').call({ run, case: 'price' });
    expect(explained).toMatchObject({ sample: 1, samples: 2 });
    expect(field(explained, 'turns', 1, 'failing', 0, 'check')).toBe('answer-text');
    const first = await tool(tools, 'explain_finding').call({ run, case: 'price', sample: 0 });
    expect(field(first, 'turns', 1, 'failing')).toEqual([]);
  });

  it('shrinks a failing case into a proposed case next to it', async () => {
    const { settings, dir } = workspace(await target(shop()));
    const tools = sessionTools(new Session(settings));
    const run = String(field(await tool(tools, 'run_cases').call({ cases: ['price'] }), 'run'));
    const shrunk = await tool(tools, 'shrink_case').call({
      run,
      case: 'price',
      reproduce: 2,
      samples: 1,
    });
    expect(shrunk).toMatchObject({
      outcome: 'written',
      target: { check: 'answer-text', turn: 1, stage: 'unknown' },
      case: 'price-min',
      file: join(dir, 'price.min.yaml'),
      turns: ['fiyat nedir'],
      before: { turns: 2 },
      after: { turns: 1 },
      failureRate: { failed: 2, samples: 2 },
      cost: { spentUsd: 0 },
    });
    expect(field(shrunk, 'candidates')).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'price.min.yaml'), 'utf8')).toContain('id: price-min');
    // It never overwrites, and a passing case has nothing to shrink.
    await expect(tool(tools, 'shrink_case').call({ run, case: 'price' })).rejects.toThrow(
      /price\.min\.yaml exists/u,
    );
    await expect(tool(tools, 'shrink_case').call({ run, case: 'greet' })).rejects.toThrow(
      /no case "greet" in run/u,
    );
  });

  it('verifies a fix against the case, its shrunk case and its suite, and names regressions', async () => {
    const answers = shop();
    const { settings, dir } = workspace(await target(answers));
    const tools = sessionTools(new Session(settings));
    const run = String(field(await tool(tools, 'run_cases').call({}), 'run'));
    await tool(tools, 'shrink_case').call({ run, case: 'price', reproduce: 1, samples: 1 });
    const notYet = await tool(tools, 'verify_fix').call({ run, case: 'price' });
    expect(notYet).toMatchObject({
      fixed: false,
      target: { check: 'answer-text', dimension: 'answer-content' },
      checked: [
        { id: 'price', status: 'fail', failsTarget: true },
        { id: 'price-min', status: 'fail', failsTarget: true },
      ],
      regressions: [],
    });
    answers.state.broken = false;
    const fixed = await tool(tools, 'verify_fix').call({ run, case: 'price' });
    expect(fixed).toMatchObject({
      fixed: true,
      checked: [
        { id: 'price', status: 'pass', failsTarget: false },
        { id: 'price-min', status: 'pass', failsTarget: false },
      ],
      ran: [
        { id: 'price', before: 'fail', now: 'pass' },
        { id: 'greet', before: 'pass', now: 'pass' },
        { id: 'thanks', before: 'pass', now: 'pass' },
        { id: 'draft', before: 'unmeasured', now: 'unmeasured' },
        { id: 'price-min', now: 'pass' },
      ],
      regressions: [],
      changed: [],
      // Another suite's failure isn't run, and fixed says nothing of it.
      otherNotPassing: [{ id: 'deals', suite: 'factual', status: 'fail' }],
    });
    // Only the case's suite runs: quality, not factual.
    const verified = readResults(String(field(fixed, 'results')));
    expect(verified.cases.map((c) => c.id)).toEqual([
      'price',
      'greet',
      'thanks',
      'draft',
      'price-min',
    ]);
    // A neighbour that passed and doesn't now is a regression; one whose definition changed
    // isn't compared, though it fails too.
    answers.state.emptyGreeting = true;
    writeFileSync(
      join(dir, 'cases.yaml'),
      CASES.replace('- user: teşekkürler', '- user: çok teşekkürler'),
    );
    const broken = await tool(tools, 'verify_fix').call({ run, case: 'price' });
    expect(broken).toMatchObject({
      fixed: true,
      partial: false,
      regressions: [{ id: 'greet', status: 'fail' }],
      changed: ['thanks'],
    });
    // A case that errors isn't fixed, though it no longer fails the check.
    answers.state.down = true;
    const down = await tool(tools, 'verify_fix').call({ run, case: 'price' });
    expect(down).toMatchObject({
      fixed: false,
      checked: [
        { id: 'price', status: 'error', failsTarget: false },
        { id: 'price-min', status: 'error', failsTarget: false },
      ],
    });
  });

  it('refuses a shrink on a cassette, whose recorded turns a candidate no longer has', async () => {
    const { settings } = workspace(await target(shop()));
    const tools = sessionTools(new Session({ ...settings, replay: join(settings.out, 'x.json') }));
    await expect(tool(tools, 'shrink_case').call({ run: 'r', case: 'price' })).rejects.toThrow(
      /a shrink can't run on a cassette/u,
    );
  });
});

describe('the session cap (ADR-0041)', () => {
  it('lets runs spend what is left, and refuses once it is spent or can no longer hold', async () => {
    const { settings } = workspace('http://127.0.0.1:1/chat');
    const capped = new Session({ ...settings, maxCostUsd: 1 });
    expect(capped.allowance()).toBe(1);
    expect(capped.account(0.6, false)).toEqual({
      spentUsd: 0.6,
      sessionSpentUsd: 0.6,
      remainingUsd: expect.closeTo(0.4, 10) as unknown,
    });
    expect(capped.allowance()).toBeCloseTo(0.4, 10);
    capped.account(0.4, false);
    // Spent to the cent is spent.
    expect(() => capped.allowance()).toThrow(
      "the session's cost cap of 1 USD is spent; start yokla mcp again with a higher --max-cost",
    );
    const unknown = new Session({ ...settings, maxCostUsd: 1 });
    unknown.account(null, false);
    expect(() => unknown.allowance()).toThrow(
      "the session's cost cap can no longer hold: a model call had no cost",
    );
    const uncapped = new Session(settings);
    expect(uncapped.allowance()).toBeUndefined();
    expect(uncapped.account(0.2, false)).toEqual({ spentUsd: 0.2, sessionSpentUsd: 0.2 });
  });

  it("counts a run's spend from the proxy or the spans, with yokla's own, and never a replayed call", async () => {
    const { settings } = workspace(await target(shop()));
    const tools = sessionTools(new Session(settings));
    const results: Results = readResults(
      String(field(await tool(tools, 'run_cases').call({ cases: ['greet'] }), 'results')),
    );
    expect(spentBy(results)).toEqual({ usd: 0, targetUnknown: true });
    const proxy = {
      correlation: 'serial' as const,
      records: 2,
      attributed: 2,
      unattributed: 0,
      totals: { costUsd: 0.25 },
      missing: {},
    };
    const own = { calls: 1, cached: 0, costUsd: 0.5 };
    const run = (change: Partial<Results['run']>): Results => ({
      ...results,
      run: { ...results.run, ...change },
    });
    expect(spentBy(run({ proxy, own }))).toEqual({ usd: 0.75, targetUnknown: false });
    expect(spentBy(run({ proxy: { ...proxy, missing: { costUsd: 1 } } }))).toEqual({
      usd: null,
      targetUnknown: false,
    });
    expect(spentBy(run({ proxy, own: { ...own, costUsd: null } })).usd).toBeNull();
    const replay = { cassetteSha256: 'a'.repeat(64), loose: false, diverged: 0 };
    expect(spentBy(run({ proxy, own, replay }))).toEqual({ usd: 0.5, targetUnknown: false });
    const spans = {
      received: 1,
      attributed: 1,
      unattributed: 0,
      totals: { costUsd: 0.1 },
      missing: {},
      settled: true,
    };
    expect(spentBy(run({ spans }))).toEqual({ usd: 0.1, targetUnknown: false });
  });

  it('knows when a session can spend: a proxy that forwards, spans, or a customer model', async () => {
    const proxied = workspace(
      'http://127.0.0.1:1/chat',
      "modelProxy:\n  upstreams: [{ id: fake, kind: openai-compatible, upstream: 'http://127.0.0.1:2/v1' }]\n",
    );
    const prepared = await prepareRun(proxied.settings, '0');
    expect(canSpend(prepared, false)).toBe(true);
    expect(canSpend(prepared, true)).toBe(false);
    const plain = await prepareRun(workspace('http://127.0.0.1:1/chat').settings, '0');
    expect(canSpend(plain, false)).toBe(false);
    const spansOnly = workspace(
      'http://127.0.0.1:1/chat',
      'modelProxy:\n  upstreams: []\n  spans: {}\n',
    );
    expect(canSpend(await prepareRun(spansOnly.settings, '0'), false)).toBe(true);
    const config = join(plain.profileDir, 'customer.yaml');
    writeFileSync(
      config,
      "version: 1\nmodels:\n  customer: { kind: openai-compatible, url: 'http://127.0.0.1:3/v1', model: m }\n",
    );
    const withCustomer = await prepareRun(
      { ...workspace('http://127.0.0.1:1/chat').settings, config },
      '0',
    );
    expect(canSpend(withCustomer, true)).toBe(true);
  });
});
