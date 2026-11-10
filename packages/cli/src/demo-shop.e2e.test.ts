// Acceptance (design §19): yokla runs the demo-shop's acceptance cases against
// the demo-shop running as its own process, over HTTP, like any other target.
// Without defects every case passes. With each defect, exactly the expected
// check fails on exactly the expected cases, and nothing else fails.
// yokla never imports the demo-shop (layer rules).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
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
};

const children: ChildProcess[] = [];
const runs = new Map<
  string,
  { code: number; output: string; results: Results; junit: string; out: string }
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
      if (url !== undefined) resolve(url);
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
    [...args, '--target-url', `${base}/v1/chat`, '--out', out, '--junit', junit],
    io,
  );
  runs.set(defect, {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    junit: readFileSync(junit, 'utf8'),
    out,
  });
}

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
  // Each defect gets its own demo-shop process and port, so the runs go in parallel.
  await Promise.all(['none', ...Object.keys(EXPECTED)].map((defect) => runAgainst(defect)));
}, 120_000);

afterAll(() => {
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

  it('passes the gate without defects, and breaks it with each defect against that baseline', async () => {
    const baseline = runs.get('none')?.out ?? '';
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
      expect(outcome.code, defect).toBe(1);
      for (const id of Object.values(expected).flat()) {
        expect(outcome.output, defect).toContain(`${id} passed in the baseline and is now fail`);
      }
    }
  });
});
