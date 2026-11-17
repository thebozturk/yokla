// Generated cases (ADR-0055, ADR-0056): yokla generate writes the demo-shop's
// cases from its catalog, every kind in both languages, the same file twice,
// sending nothing. Run on the demo-shop without defects, every generated case
// passes; each data defect fails a generated case of the kind meant for it.
// No model cost, behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCases } from './load.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'yokla-generate-'));
const profile = join(work, 'yokla.profile.yaml');
const generated = join(work, 'cases', 'generated.yaml');
const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;

interface Ran {
  readonly code: number;
  readonly output: string;
}

async function cli(...args: string[]): Promise<Ran> {
  const lines: string[] = [];
  const code = await main(args, {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  return { code, output: lines.join('\n') };
}

function startShop(defect: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--rate-limit', 'off', '--defect', defect],
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

const DEFECTS = [
  'none',
  'fabricated-price',
  'unknown-stock-claim',
  'absence-substitution',
  'filter-ignored',
  'type-padding',
] as const;

let first: Ran | undefined;
let firstText = '';
let second: Ran | undefined;
const runs = new Map<string, Ran>();
const results = (defect: string) =>
  Results.parse(JSON.parse(readFileSync(join(work, `${defect}.json`), 'utf8')));

beforeAll(async () => {
  cpSync(join(DEMO, 'yokla.profile.yaml'), profile);
  cpSync(join(DEMO, 'data'), join(work, 'data'), { recursive: true });
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const absent = ['--absent', 'en:hammock', '--absent', 'tr:hamak'];
  first = await cli('generate', '--profile', profile, ...absent);
  firstText = readFileSync(generated, 'utf8');
  second = await cli('generate', '--profile', profile, ...absent, '--force');
  for (const defect of DEFECTS) {
    const base = await startShop(defect);
    runs.set(
      defect,
      await cli(
        'run',
        '--profile',
        profile,
        '--cases',
        generated,
        '--target-url',
        `${base}/v1/chat`,
        '--out',
        join(work, `${defect}.json`),
      ),
    );
  }
}, 120_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

/** The kinds of the cases a run failed. */
const failedKinds = (defect: string) =>
  new Set(
    results(defect)
      .cases.filter((c) => c.status === 'fail')
      .map((c) => c.id.replace(/-(?:tr|en)-.*$/u, '')),
  );

describe('yokla generate on the demo-shop (ADR-0055, ADR-0056)', () => {
  it('writes every kind in both languages, as proposed cases, the same file twice', () => {
    expect(first?.code, first?.output).toBe(0);
    expect(second?.code, second?.output).toBe(0);
    expect(readFileSync(generated, 'utf8')).toBe(firstText);
    const cases = loadCases([generated]);
    const kinds = (language: string) =>
      [
        ...new Set(cases.filter((c) => c.language === language).map((c) => c.tags[1] ?? '')),
      ].toSorted((a, b) => a.localeCompare(b));
    const all = [
      'absent-type',
      'attribute',
      'cheaper',
      'comparison',
      'empty-band',
      'lookup',
      'refine',
      'unknown-stock',
    ];
    expect(kinds('tr')).toEqual(all);
    expect(kinds('en')).toEqual(all);
    expect(cases.every((c) => c.provenance?.status === 'proposed')).toBe(true);
    expect(first?.output).toContain(`generated ${String(cases.length)} proposed cases`);
  });

  it('passes every generated case on the demo-shop without defects', () => {
    expect(runs.get('none')?.code, runs.get('none')?.output).toBe(0);
    const failing = results('none').cases.filter((c) => c.status !== 'pass');
    expect(failing.map((c) => [c.id, c.status])).toEqual([]);
  });

  it.each([
    ['fabricated-price', 'lookup'],
    ['unknown-stock-claim', 'unknown-stock'],
    ['absence-substitution', 'absent-type'],
    ['filter-ignored', 'attribute'],
    ['type-padding', 'attribute'],
  ])('fails a generated case of the kind meant for %s: %s', (defect, kind) => {
    expect(failedKinds(defect)).toContain(kind);
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shops (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
