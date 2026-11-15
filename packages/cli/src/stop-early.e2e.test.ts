// --stop-early end to end (ADR-0038): the demo-shop's acceptance cases run
// with three samples, with and without it, for the defect-free shop and for
// in-process defects, behind the network guard. Each case gets the same
// status and failing dimensions both ways; a failing worst-of-N case stops
// after one sample, a majority-of-N one, such as out-of-scope-answered's
// refusal, after two (ADR-0039), and a passing case runs all three.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const DEFECTS = [
  'none',
  'fabricated-price',
  'unknown-stock-claim',
  'filter-ignored',
  'over-refusal',
  'out-of-scope-answered',
  'absence-substitution',
  'invented-return-policy',
] as const;

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;

function startShop(defect: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--defect', defect],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
      if (url !== undefined) {
        ports.add(Number(new URL(url).port));
        resolve(url);
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`demo-shop (${defect}) exited early with ${String(code)}`));
    });
  });
}

const runs = new Map<string, { full: Results; early: Results; output: string }>();

async function run(shop: string, early: boolean): Promise<{ results: Results; output: string }> {
  const out = join(mkdtempSync(join(tmpdir(), 'yokla-stop-early-')), 'results.json');
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      join(DEMO, 'yokla.profile.yaml'),
      '--config',
      join(DEMO, 'yokla.config.yaml'),
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${shop}/v1/chat`,
      '--samples',
      '3',
      '--out',
      out,
      ...(early ? ['--stop-early'] : []),
    ],
    io,
  );
  expect(code, lines.join('\n')).toBe(0);
  return {
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    output: lines.join('\n'),
  };
}

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  await Promise.all(
    DEFECTS.map(async (defect) => {
      const shop = await startShop(defect);
      const full = await run(shop, false);
      const early = await run(shop, true);
      runs.set(defect, { full: full.results, early: early.results, output: early.output });
    }),
  );
}, 300_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

/** Per case: its status and its failing dimensions. */
function verdicts(results: Results | undefined) {
  return (results?.cases ?? []).map((c) => ({
    id: c.id,
    status: c.status,
    failing: c.dimensions.filter((d) => d.verdict === 'fail').map((d) => d.dimension),
  }));
}

describe('--stop-early against the demo-shop (ADR-0038)', () => {
  it.each(DEFECTS)('%s: every case gets the verdict three samples give', (defect) => {
    const done = runs.get(defect);
    expect(verdicts(done?.early)).toEqual(verdicts(done?.full));
    expect(done?.early.run.sampling).toEqual({ stopEarly: true });
  });

  it.each(DEFECTS)(
    '%s: failing cases stop as soon as settled, passing ones run all three',
    (defect) => {
      for (const c of runs.get(defect)?.early.cases ?? []) {
        const majority = c.dimensions.some(
          (d) => d.verdict === 'fail' && d.policy === 'majority-of-n',
        );
        const worst = c.dimensions.some((d) => d.verdict === 'fail' && d.policy === 'worst-of-n');
        const expected = c.status === 'pass' ? 3 : worst ? 1 : majority ? 2 : 3;
        expect([c.id, c.samples.length]).toEqual([c.id, expected]);
        expect(c.samplesPlanned).toBe(expected === 3 ? undefined : 3);
      }
    },
  );

  it('a majority-of-N failure stops after two samples, a worst-of-N one after one (ADR-0039)', () => {
    const invest = runs.get('out-of-scope-answered')?.early.cases.find((c) => c.id === 'invest-en');
    expect(invest?.dimensions.find((d) => d.dimension === 'refusal')).toMatchObject({
      policy: 'majority-of-n',
      verdict: 'fail',
    });
    expect(invest?.samples).toHaveLength(2);
    const stoves = runs.get('over-refusal')?.early.cases.find((c) => c.id === 'stoves-tr');
    expect(stoves?.dimensions.find((d) => d.dimension === 'over-refusal')?.policy).toBe(
      'worst-of-n',
    );
    expect(stoves?.samples).toHaveLength(1);
  });

  it('ran fewer samples than planned where something failed, and says so', () => {
    const done = runs.get('fabricated-price');
    expect(done?.output).toMatch(/--stop-early: \d+ samples ran of 54 planned/u);
    const ran = (done?.early.cases ?? []).reduce((n, c) => n + c.samples.length, 0);
    expect(ran).toBeLessThan(54);
    const none = runs.get('none');
    expect((none?.early.cases ?? []).every((c) => c.samples.length === 3)).toBe(true);
  });

  it('contacts nothing but the demo-shops (ADR-0003)', () => {
    expect((guard?.attempts ?? []).filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
