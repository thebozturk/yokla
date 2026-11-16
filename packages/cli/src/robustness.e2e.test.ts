// Robustness transforms, end to end (ADR-0045): the demo-shop's acceptance
// cases run as written, and then with each transform of their messages:
// without diacritics, in lower case, without punctuation, and with a typo.
// yokla compare --expect-same sets each beside the run as written.
// - The correct shop keeps every verdict under every transform.
// - A shop with language-by-letters tells Turkish by its letters alone. Every
//   written case passes, and only the run without diacritics moves verdicts:
//   it answers three Turkish cases in English.
// - Two runs with typos send the same messages.
// The model runs in process, at no cost, behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results, TRANSFORM_KINDS, type TransformKind } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'yokla-robustness-e2e-'));
const profile = join(dir, 'yokla.profile.yaml');

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;

/** Starts a demo-shop and resolves with its URL. */
function shop(...args: string[]): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--rate-limit', 'off', ...args],
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
      reject(new Error(`demo-shop exited early with ${String(code)}`));
    });
  });
}

interface Ran {
  readonly code: number;
  readonly output: string;
  readonly results: Results;
  readonly out: string;
}

interface Compared {
  readonly code: number;
  readonly output: string;
}

async function run(name: string, url: string, ...more: string[]): Promise<Ran> {
  const out = join(dir, `${name}.json`);
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      profile,
      '--config',
      join(DEMO, 'yokla.config.yaml'),
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${url}/v1/chat`,
      '--out',
      out,
      ...more,
    ],
    io,
  );
  return {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    out,
  };
}

async function compare(written: Ran, transformed: Ran): Promise<Compared> {
  const lines: string[] = [];
  const code = await main(
    ['compare', '--results', written.out, '--results', transformed.out, '--expect-same'],
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  );
  return { code, output: lines.join('\n') };
}

const runs = new Map<string, Ran>();
const comparisons = new Map<string, Compared>();

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  // The shops don't limit their rate, so neither does the profile: the runs go faster.
  writeFileSync(
    profile,
    readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8')
      .replaceAll('./data/', join(DEMO, 'data/'))
      .replace(/^ {2}limits:\n(?: {4}.*\n)+/mu, ''),
  );
  const [correct, byLetters] = await Promise.all([shop(), shop('--defect', 'language-by-letters')]);
  for (const [shopName, url] of [
    ['correct', correct],
    ['by-letters', byLetters],
  ] as const) {
    const written = await run(`${shopName}-written`, url);
    runs.set(`${shopName}-written`, written);
    for (const kind of TRANSFORM_KINDS) {
      const transformed = await run(`${shopName}-${kind}`, url, '--transform', kind);
      runs.set(`${shopName}-${kind}`, transformed);
      comparisons.set(`${shopName}-${kind}`, await compare(written, transformed));
    }
  }
  runs.set(
    'correct-typos-again',
    await run('correct-typos-again', correct, '--transform', 'typos'),
  );
}, 600_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

function ran(name: string): Ran {
  const found = runs.get(name);
  if (found === undefined) throw new Error(`no ${name} run`);
  return found;
}

function compared(name: string): Compared {
  const found = comparisons.get(name);
  if (found === undefined) throw new Error(`no ${name} comparison`);
  return found;
}

/** Every message a run sent, by case, sample and turn. */
const sent = (results: Results) =>
  results.cases.flatMap((c) =>
    c.samples.flatMap((sample) => sample.turns.map((turn) => `${c.id}: ${turn.user}`)),
  );

/** The failing checks of a run's cases that didn't pass. */
const failing = (results: Results) =>
  Object.fromEntries(
    results.cases
      .filter((c) => c.status !== 'pass')
      .map((c) => [
        c.id,
        c.samples.flatMap((sample) =>
          sample.turns.flatMap((turn) =>
            turn.checks
              .filter((check) => check.findings.some((finding) => finding.verdict === 'fail'))
              .map((check) => check.check),
          ),
        ),
      ]),
  );

describe('robustness transforms on the demo-shop (ADR-0045)', () => {
  it('as written, both shops pass every case', () => {
    for (const name of ['correct-written', 'by-letters-written']) {
      const { code, output, results } = ran(name);
      expect(code, output).toBe(0);
      expect(results.summary.statuses, name).toEqual({ pass: 18 });
      expect(results.run.transforms).toBeUndefined();
    }
  });

  it.each(TRANSFORM_KINDS)(
    'the correct shop keeps every verdict under %s, and the transform changed messages',
    (kind: TransformKind) => {
      const { code, output, results } = ran(`correct-${kind}`);
      expect(code, output).toBe(0);
      expect(results.summary.statuses).toEqual({ pass: 18 });
      const [counted] = results.run.transforms ?? [];
      expect(counted?.kind).toBe(kind);
      expect(counted?.messages).toBeGreaterThan(0);
      expect(results.run.issues).toBeUndefined();
      const comparison = compared(`correct-${kind}`);
      expect(comparison.code, comparison.output).toBe(0);
      expect(comparison.output).toContain(`transforms: ${kind}`);
      expect(comparison.output).toContain(
        '--expect-same: every case has the same status in every run',
      );
    },
  );

  it('keeps the written message beside the one sent, and the definition of each case', () => {
    const written = ran('correct-written').results;
    const transformed = ran('correct-no-diacritics').results;
    expect(transformed.cases.map((c) => c.definitionSha256)).toEqual(
      written.cases.map((c) => c.definitionSha256),
    );
    const turn = transformed.cases.find((c) => c.id === 'tents-tr')?.samples[0]?.turns[0];
    expect([turn?.user, turn?.written]).toEqual(['Cadir onerir misin?', 'Çadır önerir misin?']);
  });

  it('language-by-letters shows only without diacritics: three Turkish cases answered in English', () => {
    const { results } = ran('by-letters-no-diacritics');
    expect(failing(results)).toEqual({
      'tents-under-500-tr': ['filter-honoured-or-disclosed'],
      'sleeping-pad-tr': ['absence-correct'],
      'returns-tr': ['answer-similarity'],
    });
    const answer = results.cases.find((c) => c.id === 'sleeping-pad-tr')?.samples[0]?.turns[0]
      ?.response?.text;
    expect(answer).toMatch(/^We don't carry sleeping pads/u);
    const comparison = compared('by-letters-no-diacritics');
    expect(comparison.code, comparison.output).toBe(1);
    expect(comparison.output).toContain(
      '--expect-same: the status of 3 cases differs: tents-under-500-tr, sleeping-pad-tr, returns-tr',
    );
    for (const kind of TRANSFORM_KINDS.filter((other) => other !== 'no-diacritics')) {
      const other = compared(`by-letters-${kind}`);
      expect(other.code, `${kind}: ${other.output}`).toBe(0);
    }
  });

  it('two runs with typos send the same messages, a typo in each', () => {
    const first = ran('correct-typos').results;
    const again = ran('correct-typos-again').results;
    expect(sent(again)).toEqual(sent(first));
    const turns = first.cases.flatMap((c) => c.samples.flatMap((sample) => sample.turns));
    expect(turns.every((turn) => turn.written !== undefined && turn.written !== turn.user)).toBe(
      true,
    );
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shops (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
