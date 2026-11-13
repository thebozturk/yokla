// Richer evidence mapping end to end (ADR-0020): the demo-shop's acceptance
// cases give the same verdicts through a profile that reads the products from
// two paths, reads stock only as available or not, and joins the product names
// to the answer text, as through the demo-shop's own profile. The seeded
// unknown-stock and duplicate-product defects are still caught, by the same
// checks on the same cases. Everything runs behind a network guard that allows
// only the demo-shops.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const DEFECTS = ['none', 'unknown-stock-claim', 'duplicate-products'] as const;
const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
const runs = new Map<string, { own: Results; richer: Results }>();

async function startShop(defect: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--defect', defect],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  return new Promise<string>((resolve, reject) => {
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

/** Replaces exactly one occurrence, so a changed demo-shop profile fails loudly. */
function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at === -1 || text.indexOf(from, at + 1) !== -1) {
    throw new Error(`the demo-shop profile no longer has exactly one "${from}"`);
  }
  return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
}

/** The demo-shop's profile, rewritten with ADR-0020's mapping options. */
function richerProfile(dir: string): string {
  let text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  text = replaceOnce(
    text,
    '    text: $.data.answer\n',
    '    text:\n      - $.data.answer\n      - $.data.products[*].name\n',
  );
  text = replaceOnce(
    text,
    '        items: $.data.products[*]\n',
    '        items:\n          - $.data.products[*]\n          - $.data.products[*]\n',
  );
  text = replaceOnce(
    text,
    '          stock: stockQuantity # null means unknown, not zero\n',
    '          inStock: available # null means unknown\n',
  );
  text = replaceOnce(text, '      stock: stock\n', '');
  const path = join(dir, 'richer.profile.yaml');
  writeFileSync(path, text);
  return path;
}

async function run(profile: string, base: string, out: string): Promise<Results> {
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const args = ['run', '--profile', profile, '--cases', join(DEMO, 'cases')];
  await main([...args, '--target-url', `${base}/v1/chat`, '--out', out], io);
  return Results.parse(JSON.parse(readFileSync(out, 'utf8')));
}

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const dir = mkdtempSync(join(tmpdir(), 'yokla-evidence-'));
  const richer = richerProfile(dir);
  await Promise.all(
    DEFECTS.map(async (defect) => {
      const base = await startShop(defect);
      // One after the other: both runs share the shop's rate limit.
      const own = await run(
        join(DEMO, 'yokla.profile.yaml'),
        base,
        join(dir, `${defect}-own.json`),
      );
      const richerRun = await run(richer, base, join(dir, `${defect}-richer.json`));
      runs.set(defect, { own, richer: richerRun });
    }),
  );
}, 180_000);

afterAll(() => {
  guard?.uninstall();
  // Stop exactly the processes these tests started, by their handles.
  for (const child of children) child.kill();
});

function pairOf(defect: string): { own: Results; richer: Results } {
  const pair = runs.get(defect);
  if (pair === undefined) throw new Error(`no runs against the ${defect} demo-shop`);
  return pair;
}

/** Per case: its status and the checks that failed on it. */
function verdicts(results: Results): Record<string, string> {
  return Object.fromEntries(
    results.cases.map((c) => {
      const failed = new Set(
        c.samples.flatMap((s) =>
          s.turns.flatMap((t) =>
            t.checks
              .filter((check) => check.findings.some((f) => f.verdict === 'fail'))
              .map((check) => check.check),
          ),
        ),
      );
      return [c.id, `${c.status} ${[...failed].toSorted().join(',')}`.trim()];
    }),
  );
}

describe('richer evidence mapping against the demo-shop (ADR-0020)', () => {
  it.each(DEFECTS)('gives the same verdicts as the demo-shop profile: %s', (defect) => {
    const pair = pairOf(defect);
    expect(verdicts(pair.richer)).toEqual(verdicts(pair.own));
  });

  it('passes every acceptance case without defects', () => {
    expect(pairOf('none').richer.summary.statuses).toEqual({ pass: 18 });
  });

  it('catches the unknown-stock claim through availability alone', () => {
    const failing = Object.entries(verdicts(pairOf('unknown-stock-claim').richer)).filter(
      ([, verdict]) => verdict.includes('stock-claim'),
    );
    expect(failing.length).toBeGreaterThan(0);
  });

  it('still catches a product listed twice, though both paths return it', () => {
    const failing = Object.values(verdicts(pairOf('duplicate-products').richer)).filter((verdict) =>
      verdict.includes('no-duplicates'),
    );
    expect(failing.length).toBeGreaterThan(0);
  });

  it('joins the product names to the answer text', () => {
    const turn = pairOf('none').richer.cases.find((c) => c.id === 'tents-tr')?.samples[0]?.turns[0];
    const first: unknown = Reflect.get(Object(turn?.response?.evidence['products']?.[0]), 'name');
    expect(typeof first).toBe('string');
    expect(turn?.response?.text).toContain(`\n\n${String(first)}`);
  });

  it('contacts nothing but the demo-shops', () => {
    expect(guard?.attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
