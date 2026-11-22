// Acceptance (design §19): yokla runs the demo-shop's acceptance cases against
// the demo-shop running as its own process, over HTTP, like any other target.
// Without defects every case passes. With each defect, exactly the expected
// check fails on exactly the expected cases, and nothing else fails. Over a
// WebSocket (ADR-0024), the defect-free run gives the same answers, and a
// seeded defect is caught the same way. The runs load the demo-shop's own
// check through its yokla.config.yaml, as a user would (ADR-0030). Behind
// bearer tokens (ADR-0031), the acceptance still passes, with tokens yokla
// fetches, refreshes and replaces, and no token or secret in what it writes.
// yokla never imports the demo-shop (layer rules).
//
// The egress test (ADR-0003, design §15): every run, gate and baseline here
// runs behind a network guard that allows only the demo-shops' own ports.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, Results, z } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;

const ALL_PRODUCT_CASES = [
  'tents-tr',
  'tents-under-1000-tr',
  'tents-under-500-tr',
  'black-women-jacket-tr',
  'women-jackets-m-en',
  'black-backpack-en',
  'water-bottle-en',
  'sleeping-pad-tr',
  'hammock-en',
  'stoves-tr',
  'headlamps-en',
  'cheaper-follow-up-en',
];

/** Defect → the checks that must catch it → the cases each must fail. */
const EXPECTED: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'fabricated-price': { 'price-grounded': ALL_PRODUCT_CASES },
  // Cases that list a product whose stock is unknown.
  'unknown-stock-claim': {
    'stock-claim': [
      'tents-tr',
      'tents-under-500-tr',
      'women-jackets-m-en',
      'sleeping-pad-tr',
      'hammock-en',
      'stoves-tr',
      'headlamps-en',
      'cheaper-follow-up-en',
    ],
  },
  'invented-return-policy': {
    'policy-claim': ['returns-tr', 'returns-en'],
    // The invented policy strays from the FAQ's wording too (ADR-0030).
    'answer-similarity': ['returns-tr'],
  },
  'filter-ignored': {
    'filter-honoured-or-disclosed': [
      'tents-under-1000-tr',
      'tents-under-500-tr',
      'black-women-jacket-tr',
      'women-jackets-m-en',
      'black-backpack-en',
      'water-bottle-en',
      'cheaper-follow-up-en',
    ],
  },
  'over-refusal': { 'over-refusal': ['stoves-tr'] },
  // The refusal dimension, majority-of-N (ADR-0039).
  'out-of-scope-answered': { 'over-refusal': ['invest-en'] },
  'duplicate-products': { 'no-duplicates': ALL_PRODUCT_CASES },
  'absence-substitution': { 'absence-correct': ['sleeping-pad-tr', 'hammock-en'] },
  // Short results with other types that satisfy the filters.
  'type-padding': {
    'type-matched-or-disclosed': ['tents-under-1000-tr', 'black-women-jacket-tr'],
  },
  // The model runs in process here; these defects show with the model over
  // HTTP, in the resilience matrix of proxy.e2e.test.ts.
  'no-model-fallback': {},
  'no-model-timeout': {},
  'unchecked-model-output': {},
  // The inspection defects need the model over HTTP too, or no prompt carries
  // personal data; they are in the inspection matrix of proxy.e2e.test.ts.
  'products-in-system': {},
  'prompt-bloat': {},
  'unmasked-pii': {},
  'no-leak-guard': {},
  // The tool-call defects need the model over HTTP too; they are in the tool
  // matrix of proxy.e2e.test.ts (ADR-0025).
  'unrequested-cart': {},
  'repeated-search': {},
  // The price defects whose origin differs need the model over HTTP too; they
  // are in the origin matrix of proxy.e2e.test.ts (ADR-0033).
  'stale-price-in-prompt': {},
  'price-rewritten': {},
  // Tool results go to a model over HTTP only, with --tool-results; the defect is
  // in tool-results.e2e.test.ts (ADR-0043).
  'unfenced-tool-results': {},
  // No written case puts two products in a cart; yokla explore finds the defect in
  // explore.e2e.test.ts (ADR-0044).
  'cart-total-off': {},
  // Every written message has a Turkish letter but the greeting, which expects nothing
  // that depends on the language; a run without diacritics finds the defect in
  // robustness.e2e.test.ts (ADR-0045).
  'language-by-letters': {},
  // Only a code-switched message shows it (ADR-0059).
  'language-by-words': {},
  // No written case asks for sleeping bags under a price; yokla explore finds the defect
  // in explore.e2e.test.ts (ADR-0046).
  'type-bound-ignored': {},
  // No written case writes an amount with a currency code; yokla explore finds the
  // defect in explore.e2e.test.ts (ADR-0052).
  'currency-code-ignored': {},
  // The generic checks (ADR-0030): the profile's everyAnswer patterns, its
  // response contract, and the check the demo-shop's team wrote.
  'unfilled-template': { 'answer-text': ['greeting-tr', 'thanks-tr', 'order-en'] },
  'missing-contract-field': {
    'json-schema': [
      ...ALL_PRODUCT_CASES,
      'returns-tr',
      'returns-en',
      'shipping-tr',
      'warranty-en',
      'invest-en',
      'greeting-tr',
      'thanks-tr',
      'handoff-en',
      'order-en',
    ].toSorted(),
  },
  'internal-ids': { 'no-internal-ids': ALL_PRODUCT_CASES },
  // A thank-you answered as a failed search with products (ADR-0075).
  'thanks-searched': { 'request-handled': ['thanks-tr'] },
  // No written case names a price for a product: generate.e2e.test.ts's attacks catch it (ADR-0080).
  'offer-accepted': {},
  // No written case attacks the red-team guards: generate.e2e.test.ts's and proxy.e2e.test.ts's
  // attacks catch them (ADR-0082).
  'premise-accepted': {},
  'unbounded-output': {},
  'system-markup-trusted': {},
  'hidden-text-obeyed': {},
  'tools-disclosed': {},
  'restriction-ignored': {},
  // generate.e2e.test.ts's attacks on another customer's data catch these (ADR-0083).
  'other-customer-order': {},
  'pretext-accepted': {},
  'shared-memory': {},
  'card-echoed': {},
  // generate.e2e.test.ts's attacks under each strategy catch these (ADR-0084).
  'decodes-and-obeys': {},
  'obfuscation-obeyed': {},
  'wrapper-obeyed': {},
  // proxy.e2e.test.ts's attacks through the tools catch the first two, generate.e2e.test.ts's
  // attack on memory the third (ADR-0085).
  'description-obeyed': {},
  'raw-arguments': {},
  'memory-poisoned': {},
  // proxy.e2e.test.ts's attacks on agency and authority catch these (ADR-0086).
  'order-action-unchecked': {},
  'eager-action': {},
  'staff-tools-offered': {},
  'quantity-ignored': {},
  // attacker.e2e.test.ts's escalation catches it; no written case asks three times (ADR-0087).
  'worn-down': {},
};

/**
 * Defects tested elsewhere, never in this matrix. flaky-price fails every
 * other answer with products, so which cases fail depends on their order;
 * shrink.e2e.test.ts shows it reported as flaky (ADR-0035).
 */
const ELSEWHERE = ['flaky-price'];

const children: ChildProcess[] = [];
const shopPorts = new Set<number>();
let guard: NetworkGuard | undefined;
const runs = new Map<
  string,
  { code: number; output: string; results: Results; junit: string; html: string; out: string }
>();

async function startShop(
  defect: string,
  extra: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--defect', defect, ...extra],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    },
  );
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
      if (url !== undefined) {
        shopPorts.add(Number(new URL(url).port));
        resolve(url);
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`demo-shop (${defect}) exited early with ${String(code)}`));
    });
  });
}

/** The run of the not-a-search cases alone, against the shop that searches a thank-you (ADR-0077). */
const TAGGED = 'thanks-searched --tag not-a-search';

async function runAgainst(
  defect: string,
  name = defect,
  extra: readonly string[] = [],
): Promise<void> {
  const base = await startShop(defect);
  const dir = mkdtempSync(join(tmpdir(), `yokla-e2e-${defect}-`));
  const out = join(dir, 'results.json');
  const junit = join(dir, 'junit.xml');
  const html = join(dir, 'report.html');
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const args = [
    'run',
    '--profile',
    join(DEMO, 'yokla.profile.yaml'),
    '--config',
    join(DEMO, 'yokla.config.yaml'),
    '--cases',
    join(DEMO, 'cases'),
    ...extra,
  ];
  const code = await main(
    [...args, '--target-url', `${base}/v1/chat`, '--out', out, '--junit', junit, '--html', html],
    io,
  );
  runs.set(name, {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    junit: readFileSync(junit, 'utf8'),
    html: readFileSync(html, 'utf8'),
    out,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The demo-shop profile as a WebSocket target (ADR-0024): the same message per
 * turn, and the answer read from the events the shop sends, one message each.
 */
function websocketProfile(dir: string): string {
  const text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  const parsed = parseConfig(text, 'yokla.profile.yaml', z.record(z.string(), z.unknown()));
  if (!parsed.ok) throw new Error('the demo-shop profile does not parse');
  const target = parsed.value['target'];
  if (!isRecord(target) || !isRecord(target['response'])) {
    throw new Error('the demo-shop profile has no target');
  }
  const evidence = target['response']['evidence'];
  const products = isRecord(evidence) ? evidence['products'] : undefined;
  const fields = isRecord(products) ? products['fields'] : undefined;
  const profile = {
    ...parsed.value,
    target: {
      ...target,
      adapter: 'websocket',
      // Below the shop's own limit: a message gets no 429 to wait out, so pacing
      // at the shop's limit would now and then lose a turn to its rate-limit event.
      limits: { burstPerSecond: 2, perMinute: 120 },
      request: {
        url: 'ws://127.0.0.1:3000/v1/ws',
        body: { message: '{{message}}', sessionId: '{{session}}' },
      },
      response: {
        stream: {
          event: '$.type',
          text: { event: 'delta', from: '$.text' },
          done: 'done',
          error: { event: 'error', from: '$.detail' },
        },
        text: '$.text',
        route: '$.last.done.route',
        evidence: { products: { items: '$.last.products.products[*]', fields } },
      },
    },
  };
  const path = join(dir, 'websocket.profile.yaml');
  // JSON is YAML too.
  writeFileSync(path, JSON.stringify(profile, null, 2));
  return path;
}

const socketRuns = new Map<string, { code: number; output: string; results: Results }>();

/** The demo-shop's credentials for these runs, never written by yokla (ADR-0031). */
const SECRETS = {
  DEMO_SHOP_CLIENT_SECRET: 'e2e-client-s3cret',
  DEMO_SHOP_PASSWORD: 'e2e-passw0rd',
};

/** How each run gets its token, and how the shop limits one. */
const AUTH_RUNS = {
  // A short lifetime: yokla replaces tokens before they expire.
  oauth: {
    shop: ['--token-ttl-ms', '1500'],
    auth: {
      kind: 'oauth2-client-credentials',
      tokenUrl: '<shop>/v1/oauth/token',
      clientId: 'demo-shop-client',
      clientSecret: '{{env.DEMO_SHOP_CLIENT_SECRET}}',
      scope: 'chat',
    },
  },
  // Four uses a token: the shop refuses it, and yokla gets a new one.
  login: {
    shop: ['--token-uses', '4'],
    auth: {
      kind: 'request',
      request: {
        url: '<shop>/v1/login',
        body: { username: 'tester', password: '{{env.DEMO_SHOP_PASSWORD}}' },
      },
      token: '$.data.jwt',
      expiresIn: '$.data.ttlSeconds',
    },
  },
} as const;

const authRuns = new Map<
  string,
  { code: number; output: string; results: Results; written: string }
>();

/** The demo-shop profile behind bearer tokens: each request carries the token. */
function authProfile(dir: string, base: string, auth: unknown): string {
  const text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  const parsed = parseConfig(text, 'yokla.profile.yaml', z.record(z.string(), z.unknown()));
  if (!parsed.ok) throw new Error('the demo-shop profile does not parse');
  const target = parsed.value['target'];
  if (!isRecord(target) || !isRecord(target['request'])) {
    throw new Error('the demo-shop profile has no target');
  }
  const profile = {
    ...parsed.value,
    target: {
      ...target,
      request: {
        ...target['request'],
        headers: { 'content-type': 'application/json', authorization: 'Bearer {{auth.token}}' },
      },
      auth: JSON.parse(JSON.stringify(auth).replaceAll('<shop>', base)) as unknown,
    },
  };
  const path = join(dir, 'auth.profile.yaml');
  writeFileSync(path, JSON.stringify(profile, null, 2));
  return path;
}

async function runWithAuth(kind: keyof typeof AUTH_RUNS): Promise<void> {
  const setup = AUTH_RUNS[kind];
  const base = await startShop('none', ['--auth', ...setup.shop], SECRETS);
  const dir = mkdtempSync(join(tmpdir(), `yokla-e2e-auth-${kind}-`));
  const out = join(dir, 'results.json');
  const junit = join(dir, 'junit.xml');
  const html = join(dir, 'report.html');
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      authProfile(dir, base, setup.auth),
      '--config',
      join(DEMO, 'yokla.config.yaml'),
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${base}/v1/chat`,
      '--out',
      out,
      '--junit',
      junit,
      '--html',
      html,
    ],
    io,
  );
  const output = lines.join('\n');
  authRuns.set(kind, {
    code,
    output,
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    written: [
      readFileSync(out, 'utf8'),
      readFileSync(junit, 'utf8'),
      readFileSync(html, 'utf8'),
      output,
    ].join('\n'),
  });
}

async function runOverSocket(defect: string): Promise<void> {
  const base = await startShop(defect);
  const dir = mkdtempSync(join(tmpdir(), `yokla-e2e-ws-${defect}-`));
  const out = join(dir, 'results.json');
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      websocketProfile(dir),
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${base.replace('http:', 'ws:')}/v1/ws`,
      '--out',
      out,
    ],
    io,
  );
  socketRuns.set(defect, {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
  });
}

/** Each case's answers, texts and routes, turn by turn. */
const answers = (results: Results | undefined) =>
  Object.fromEntries(
    (results?.cases ?? []).map((c) => [
      c.id,
      c.samples[0]?.turns.map((turn) => [turn.response?.text, turn.response?.route]),
    ]),
  );

/** check → the cases where it reported a failing finding. */
function failingByCheck(results: Results | undefined): Record<string, string[]> {
  const failing: Record<string, Set<string>> = {};
  for (const c of results?.cases ?? []) {
    for (const sample of c.samples) {
      for (const turn of sample.turns) {
        for (const check of turn.checks) {
          if (check.findings.some((f) => f.verdict === 'fail')) {
            (failing[check.check] ??= new Set()).add(c.id);
          }
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(failing).map(([check, ids]) => [check, [...ids].toSorted()]),
  );
}

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && shopPorts.has(port),
  );
  // yokla reads the auth section's secrets from its own environment, as a user's run would.
  Object.assign(process.env, SECRETS);
  // Each defect gets its own demo-shop process and port, so the runs go in parallel.
  await Promise.all([
    runWithAuth('oauth'),
    runWithAuth('login'),
    ...['none', ...Object.keys(EXPECTED)].map((defect) => runAgainst(defect)),
    runAgainst('thanks-searched', TAGGED, ['--tag', 'not-a-search', '--tag', 'no-such-tag']),
    ...['none', 'fabricated-price'].map((defect) => runOverSocket(defect)),
  ]);
}, 120_000);

afterAll(() => {
  for (const name of Object.keys(SECRETS)) Reflect.deleteProperty(process.env, name);
  guard?.uninstall();
  // Stop exactly the processes these tests started, by their handles.
  for (const child of children) child.kill();
});

describe('the demo-shop acceptance', () => {
  it('has an expectation for every defect the demo-shop lists', () => {
    const listed = execFileSync(process.execPath, [join(DEMO, 'src/main.ts'), '--list-defects'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(0, line.indexOf(':')));
    expect(listed.toSorted()).toEqual([...Object.keys(EXPECTED), ...ELSEWHERE].toSorted());
  });

  it('passes every case without defects', () => {
    const run = runs.get('none');
    expect(run?.code, run?.output).toBe(0);
    // The demo-shop's own check, named in the results with its file's hash (ADR-0030).
    expect(run?.results.run.checkModules).toEqual([
      {
        id: 'no-internal-ids',
        module: 'checks/no-internal-ids.ts',
        sha256: createHash('sha256')
          .update(readFileSync(join(DEMO, 'checks/no-internal-ids.ts')))
          .digest('hex'),
      },
    ]);
    expect(run?.results.cases).toHaveLength(21);
    expect(run?.results.summary.statuses).toEqual({ pass: 21 });
    expect(run?.junit).toMatch(
      /<testsuites name="yokla" tests="21" failures="0" errors="0" skipped="0"/u,
    );
    // Every case in the HTML report, closed, since every case passed (ADR-0023).
    const cases = [
      ...(run?.html ?? '').matchAll(/<details class="case" id="case-[^"]+"( open)?>/gu),
    ];
    expect(cases).toHaveLength(21);
    expect(cases.filter((match) => match[1] !== undefined)).toEqual([]);
  });

  it('keeps the evidence and the conversation of every turn', () => {
    const results = runs.get('none')?.results;
    const relaxed = results?.cases.find((c) => c.id === 'tents-under-500-tr')?.samples[0]?.turns[0];
    expect(relaxed?.response?.text).toMatch(/^Bu kriterlere \(500,00 TL altı\)/u);
    expect(relaxed?.response?.evidence['products']?.[0]).toMatchObject({
      id: 'TNT-004',
      price: 899.5,
      stock: 0,
    });
    const followUp = results?.cases.find((c) => c.id === 'cheaper-follow-up-en')?.samples[0]?.turns;
    expect(followUp?.map((turn) => turn.response?.route)).toEqual([
      'product-search',
      'follow-up-cheapest',
    ]);
    expect(followUp?.[1]?.response?.evidence['products']).toMatchObject([{ id: 'JKT-003' }]);
  });

  it.each(Object.entries(EXPECTED))(
    'catches %s with exactly the expected check and cases',
    (defect, expected) => {
      const run = runs.get(defect);
      expect(run, `no run for ${defect}`).toBeDefined();
      const wanted = Object.fromEntries(
        Object.entries(expected).map(([check, ids]) => [check, [...ids].toSorted()]),
      );
      expect(failingByCheck(run?.results)).toEqual(wanted);
      const failed = new Set(Object.values(wanted).flat());
      for (const c of run?.results.cases ?? []) {
        expect(c.status, c.id).toBe(failed.has(c.id) ? 'fail' : 'pass');
      }
      expect(run?.junit).toContain(`failures="${String(failed.size)}"`);
    },
  );

  it('accepts the defect-free run as the baseline, and each defect breaks the gate against it', async () => {
    const baseline = join(
      mkdtempSync(join(tmpdir(), 'yokla-e2e-baseline-')),
      'yokla.baseline.json',
    );
    const quiet = { out: () => undefined, err: () => undefined };
    const none = runs.get('none')?.out ?? '';
    expect(await main(['baseline', '--results', none, '--out', baseline], quiet)).toBe(0);
    const written = readFileSync(baseline, 'utf8');
    expect(JSON.parse(written)).toMatchObject({ schema: 'yokla.baseline/v1' });
    expect(written).not.toContain('"answer"');
    expect(written).not.toContain('latencyMs');

    const gate = async (defect: string) => {
      const lines: string[] = [];
      const io = {
        out: (line: string) => lines.push(line),
        err: (line: string) => lines.push(line),
      };
      const results = runs.get(defect)?.out ?? '';
      const code = await main(['gate', '--results', results, '--baseline', baseline], io);
      return { code, output: lines.join('\n') };
    };
    expect(await gate('none')).toMatchObject({ code: 0 });
    for (const [defect, expected] of Object.entries(EXPECTED)) {
      const outcome = await gate(defect);
      // A defect that fails no case here leaves the gate passed.
      const breaks = Object.values(expected).flat().length > 0;
      expect(outcome.code, defect).toBe(breaks ? 1 : 0);
      for (const id of Object.values(expected).flat()) {
        expect(outcome.output, defect).toContain(`${id} passed in the baseline and is now fail`);
      }
    }
  });

  it('runs only the cases with a tag, and gates them alone against the full baseline (ADR-0077)', async () => {
    const run = runs.get(TAGGED);
    expect(run?.code, run?.output).toBe(0);
    expect(run?.results.cases.map((c) => [c.id, c.status, c.tags])).toEqual([
      ['thanks-tr', 'fail', ['not-a-search']],
      ['handoff-en', 'pass', ['not-a-search']],
      ['order-en', 'pass', ['not-a-search']],
    ]);
    expect(run?.results.summary.tags).toEqual([
      {
        tag: 'not-a-search',
        cases: 3,
        statuses: { fail: 1, pass: 2 },
        passRate: {
          passed: 2,
          measured: 3,
          rate: 0.6667,
          interval: { level: 0.95, lower: 0.2077, upper: 0.9385 },
        },
      },
    ]);
    // The full run's summary groups by the same tag, and only those three cases carry it.
    expect(runs.get('none')?.results.summary.tags?.map((t) => [t.tag, t.cases])).toEqual([
      ['not-a-search', 3],
    ]);

    const baseline = join(mkdtempSync(join(tmpdir(), 'yokla-e2e-tagged-')), 'yokla.baseline.json');
    const quiet = { out: () => undefined, err: () => undefined };
    expect(
      await main(['baseline', '--results', runs.get('none')?.out ?? '', '--out', baseline], quiet),
    ).toBe(0);
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const code = await main(['gate', '--results', run?.out ?? '', '--baseline', baseline], io);
    const output = lines.join('\n');
    expect(code, output).toBe(1);
    // The one regression is a case the run ran; the 18 it didn't run break nothing.
    expect(output.match(/passed in the baseline and is now/gu)).toHaveLength(1);
    expect(output).toContain('thanks-tr passed in the baseline and is now fail');
    expect(output.match(/passed in the baseline but is not in this run/gu)).toHaveLength(18);
  });

  it('refuses a run whose tags no case has', async () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const args = [
      'run',
      '--profile',
      join(DEMO, 'yokla.profile.yaml'),
      '--cases',
      join(DEMO, 'cases'),
    ];
    expect(await main([...args, '--tag', 'no-such-tag'], io)).toBe(2);
    expect(lines.join('\n')).toContain('no case has the tag "no-such-tag"');
  });

  // Last, so it sees the traffic of every test above.
  it('contacts no host but the demo-shops (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => `${attempt.kind} ${attempt.host}`))).toEqual(
      new Set(['tcp 127.0.0.1']),
    );
    // Not vacuous: the guard saw every demo-shop the runs talked to.
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(shopPorts);
    // The defects, the clean shop, and the tag-limited run's shop.
    expect(shopPorts.size).toBe(Object.keys(EXPECTED).length + 2 + socketRuns.size + authRuns.size);
  });
});

describe('the demo-shop acceptance behind bearer tokens (ADR-0031)', () => {
  it.each(Object.keys(AUTH_RUNS))('%s: every case passes, with the tokens yokla gets', (kind) => {
    const run = authRuns.get(kind);
    expect(run?.code, run?.output).toBe(0);
    expect(run?.results.summary.statuses).toEqual({ pass: 21 });
    // The answers are those of the run without tokens.
    expect(answers(run?.results)).toEqual(answers(runs.get('none')?.results));
  });

  it('oauth: replaces tokens before they expire', () => {
    const auth = authRuns.get('oauth')?.results.run.auth;
    expect(auth?.kind).toBe('oauth2-client-credentials');
    // Tokens fetched without a refusal were replaced ahead of time. A request can still
    // carry a token that expires while it waits, for the rate limit or a 429's
    // Retry-After; the shop then refuses it, and the 401 path gets a new one.
    const ahead = (auth?.tokens ?? 0) - 1 - (auth?.retried ?? 0);
    expect(ahead).toBeGreaterThanOrEqual(2);
  });

  it('login: gets a new token each time the shop refuses one, and sends the request again', () => {
    const auth = authRuns.get('login')?.results.run.auth;
    expect(auth?.kind).toBe('request');
    // Four uses a token, about twenty requests: four refusals at least.
    expect(auth?.retried).toBeGreaterThanOrEqual(4);
    expect(auth?.tokens).toBe((auth?.retried ?? 0) + 1);
  });

  it('writes no token and no secret: not in the results, the reports or the output', () => {
    for (const [kind, run] of authRuns) {
      expect(run.written.length, kind).toBeGreaterThan(1000);
      // Every token the shop issues starts with dst_.
      expect(run.written, kind).not.toContain('dst_');
      for (const secret of Object.values(SECRETS)) expect(run.written, kind).not.toContain(secret);
    }
  });
});

describe('the demo-shop acceptance over a WebSocket (ADR-0024)', () => {
  it('passes every case without defects, with the same answers as over HTTP', () => {
    const run = socketRuns.get('none');
    expect(run?.code, run?.output).toBe(0);
    expect(run?.results.summary.statuses).toEqual({ pass: 21 });
    const turns = run?.results.cases.flatMap((c) => c.samples.flatMap((s) => s.turns)) ?? [];
    expect(new Set(turns.map((turn) => turn.response?.status))).toEqual(new Set([101]));
    expect(answers(run?.results)).toEqual(answers(runs.get('none')?.results));
    const relaxed = run?.results.cases.find((c) => c.id === 'tents-under-500-tr');
    expect(relaxed?.samples[0]?.turns[0]?.response?.evidence['products']?.[0]).toMatchObject({
      id: 'TNT-004',
      price: 899.5,
      stock: 0,
    });
  });

  it('says the origin of a wrong price is unknown without the model proxy (ADR-0033)', () => {
    const failing = (runs.get('fabricated-price')?.results.cases ?? [])
      .flatMap((c) => c.samples.flatMap((sample) => sample.turns))
      .flatMap((turn) => turn.checks)
      .flatMap((check) => check.findings)
      .filter((finding) => finding.verdict === 'fail');
    expect(failing.length).toBeGreaterThan(0);
    for (const finding of failing) {
      expect(finding.origin).toEqual({
        stage: 'unknown',
        reason: 'no model proxy data for this turn',
      });
    }
  });

  it('catches a fabricated price with exactly the check and cases it is caught by over HTTP', () => {
    const run = socketRuns.get('fabricated-price');
    expect(failingByCheck(run?.results)).toEqual(
      failingByCheck(runs.get('fabricated-price')?.results),
    );
    expect(failingByCheck(run?.results)).toEqual({
      'price-grounded': [...ALL_PRODUCT_CASES].toSorted(),
    });
  });
});
