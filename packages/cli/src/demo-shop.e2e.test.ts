// Acceptance (design §19): yokla runs the demo-shop's acceptance cases against
// the demo-shop running as its own process, over HTTP, like any other target.
// Without defects every case passes. With each defect, exactly the expected
// check fails on exactly the expected cases, and nothing else fails. Over a
// WebSocket (ADR-0024), the defect-free run gives the same answers, and a
// seeded defect is caught the same way.
// yokla never imports the demo-shop (layer rules).
//
// The egress test (ADR-0003, design §15): every run, gate and baseline here
// runs behind a network guard that allows only the demo-shops' own ports.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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

/** Defect → the one check that must catch it → the cases it must fail. */
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
  'invented-return-policy': { 'policy-claim': ['returns-tr', 'returns-en'] },
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
};

const children: ChildProcess[] = [];
const shopPorts = new Set<number>();
let guard: NetworkGuard | undefined;
const runs = new Map<
  string,
  { code: number; output: string; results: Results; junit: string; html: string; out: string }
>();

async function startShop(defect: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--defect', defect],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
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

async function runAgainst(defect: string): Promise<void> {
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
    '--cases',
    join(DEMO, 'cases'),
  ];
  const code = await main(
    [...args, '--target-url', `${base}/v1/chat`, '--out', out, '--junit', junit, '--html', html],
    io,
  );
  runs.set(defect, {
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
  // Each defect gets its own demo-shop process and port, so the runs go in parallel.
  await Promise.all([
    ...['none', ...Object.keys(EXPECTED)].map((defect) => runAgainst(defect)),
    ...['none', 'fabricated-price'].map((defect) => runOverSocket(defect)),
  ]);
}, 120_000);

afterAll(() => {
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
    expect(listed.toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  it('passes every case without defects', () => {
    const run = runs.get('none');
    expect(run?.code, run?.output).toBe(0);
    expect(run?.results.cases).toHaveLength(18);
    expect(run?.results.summary.statuses).toEqual({ pass: 18 });
    expect(run?.junit).toMatch(
      /<testsuites name="yokla" tests="18" failures="0" errors="0" skipped="0"/u,
    );
    // Every case in the HTML report, closed, since every case passed (ADR-0023).
    const cases = [
      ...(run?.html ?? '').matchAll(/<details class="case" id="case-[^"]+"( open)?>/gu),
    ];
    expect(cases).toHaveLength(18);
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

  // Last, so it sees the traffic of every test above.
  it('contacts no host but the demo-shops (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => `${attempt.kind} ${attempt.host}`))).toEqual(
      new Set(['tcp 127.0.0.1']),
    );
    // Not vacuous: the guard saw every demo-shop the runs talked to.
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(shopPorts);
    expect(shopPorts.size).toBe(Object.keys(EXPECTED).length + 1 + socketRuns.size);
  });
});

describe('the demo-shop acceptance over a WebSocket (ADR-0024)', () => {
  it('passes every case without defects, with the same answers as over HTTP', () => {
    const run = socketRuns.get('none');
    expect(run?.code, run?.output).toBe(0);
    expect(run?.results.summary.statuses).toEqual({ pass: 18 });
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
