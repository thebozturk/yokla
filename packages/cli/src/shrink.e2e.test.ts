// yokla shrink end to end (ADR-0035, ADR-0036): against demo-shops with
// seeded defects, behind the network guard. Small talk before a failing
// question is cut away; each in-process defect's failing case shrinks to a
// case that fails only its own check, or is already as small as it gets; a
// message is cut to its words only with --words, with a warning in the case
// file; and a failure that comes and goes is reported as flaky, not shrunk.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const PROFILE = join(DEMO, 'yokla.profile.yaml');
const CONFIG = join(DEMO, 'yokla.config.yaml');

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;

function startShop(defect: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--defect', defect],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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

async function yokla(args: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(args, io);
  return { code, output: lines.join('\n') };
}

interface Shrunk {
  readonly code: number;
  readonly output: string;
  /** The written case file, when there is one. */
  readonly file: string | undefined;
  /** A run of the written case against the same shop. */
  readonly rerun: Results | undefined;
}

/** Runs `cases` against a demo-shop with `defect`, then shrinks `id`. */
async function shrinkAgainst(
  defect: string,
  id: string,
  cases: string,
  options: { readonly out?: boolean; readonly words?: boolean; readonly samples?: number } = {},
): Promise<Shrunk> {
  const shop = `${await startShop(defect)}/v1/chat`;
  const dir = mkdtempSync(join(tmpdir(), `yokla-shrink-${defect}-`));
  const results = join(dir, 'results.json');
  const common = ['--profile', PROFILE, '--config', CONFIG, '--target-url', shop];
  const ran = await yokla([
    'run',
    ...common,
    '--cases',
    cases,
    '--out',
    results,
    ...(options.samples === undefined ? [] : ['--samples', String(options.samples)]),
  ]);
  expect(ran.code, ran.output).toBe(0);
  const out = join(dir, `${id}.min.yaml`);
  const shrunk = await yokla([
    'shrink',
    ...common,
    '--cases',
    cases,
    '--results',
    results,
    '--case',
    id,
    ...(options.out === false ? [] : ['--out', out]),
    ...(options.words === true ? ['--words'] : []),
  ]);
  const written = options.out === false ? join(cases, `${id}.min.yaml`) : out;
  if (!existsSync(written)) return { ...shrunk, file: undefined, rerun: undefined };
  const rerunOut = join(dir, 'rerun.json');
  const rerun = await yokla(['run', ...common, '--cases', written, '--out', rerunOut]);
  expect(rerun.code, rerun.output).toBe(0);
  return {
    ...shrunk,
    file: readFileSync(written, 'utf8'),
    rerun: Results.parse(JSON.parse(readFileSync(rerunOut, 'utf8'))),
  };
}

/** The checks that failed anywhere in a run. */
function failingChecks(results: Results | undefined): string[] {
  const failing = new Set<string>();
  for (const c of results?.cases ?? []) {
    for (const turn of c.samples.flatMap((sample) => sample.turns)) {
      for (const check of turn.checks) {
        if (check.findings.some((finding) => finding.verdict === 'fail')) failing.add(check.check);
      }
    }
  }
  return [...failing].toSorted();
}

/** In-process defect → a case it fails → the one check that fails it (design §19). */
const MATRIX: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  'fabricated-price': ['tents-tr', ['price-grounded']],
  // Two turns: the second is a follow-up that the failure on the first doesn't need.
  'unknown-stock-claim': ['cheaper-follow-up-en', ['stock-claim']],
  'invented-return-policy': ['returns-en', ['policy-claim']],
  'filter-ignored': ['tents-under-500-tr', ['filter-honoured-or-disclosed']],
  'over-refusal': ['stoves-tr', ['over-refusal']],
  'duplicate-products': ['tents-tr', ['no-duplicates']],
  'absence-substitution': ['hammock-en', ['absence-correct']],
  'type-padding': ['tents-under-1000-tr', ['type-matched-or-disclosed']],
  'unfilled-template': ['greeting-tr', ['answer-text']],
  'internal-ids': ['tents-tr', ['no-internal-ids']],
};

/** A copy of cases-shrink, so the case shrink writes next to it lands in a temporary directory. */
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-shrink-cases-'));
  cpSync(join(DEMO, 'cases-shrink'), dir, { recursive: true });
  return dir;
}

const matrix = new Map<string, Shrunk>();
let smallTalk: Shrunk | undefined;
let words: Shrunk | undefined;
let flaky: Shrunk | undefined;

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  await Promise.all([
    ...Object.entries(MATRIX).map(async ([defect, [id]]) => {
      matrix.set(defect, await shrinkAgainst(defect, id, join(DEMO, 'cases')));
    }),
    (async () => {
      smallTalk = await shrinkAgainst('fabricated-price', 'tents-after-small-talk-tr', copy(), {
        out: false,
      });
    })(),
    (async () => {
      words = await shrinkAgainst('filter-ignored', 'black-women-jacket-tr', join(DEMO, 'cases'), {
        words: true,
      });
    })(),
    (async () => {
      // Two samples: the second answer with products is the one that fails.
      flaky = await shrinkAgainst('flaky-price', 'tents-after-small-talk-tr', copy(), {
        samples: 2,
      });
    })(),
  ]);
}, 300_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('yokla shrink against the demo-shop (ADR-0035, ADR-0036)', () => {
  it('cuts small talk away, and writes the case next to the original as proposed', () => {
    expect(smallTalk?.code, smallTalk?.output).toBe(0);
    expect(smallTalk?.output).toContain('reproduced: 5 of 5 runs failed');
    expect(smallTalk?.output).toContain('3 turns, 49 characters → 1 turns, 19 characters');
    expect(smallTalk?.file).toContain('id: tents-after-small-talk-tr-min');
    expect(smallTalk?.file).toContain('- user: Çadır önerir misin?');
    expect(smallTalk?.file).toContain('source: shrink');
    expect(smallTalk?.file).toContain('status: proposed');
    expect(smallTalk?.file).not.toContain('Merhaba');
    expect(smallTalk?.rerun?.cases[0]).toMatchObject({ status: 'fail', review: 'proposed' });
    expect(failingChecks(smallTalk?.rerun)).toEqual(['price-grounded']);
  });

  it.each(Object.entries(MATRIX))(
    '%s: the failing case shrinks to one that fails only its own check, or is already minimal',
    (defect, [, checks]) => {
      const shrunk = matrix.get(defect);
      expect(shrunk?.code, shrunk?.output).toBe(0);
      const outcome =
        shrunk?.file === undefined
          ? { minimal: shrunk?.output.includes('already as small as it gets') }
          : { failing: failingChecks(shrunk.rerun), status: shrunk.rerun?.cases[0]?.status };
      expect([{ minimal: true }, { failing: checks, status: 'fail' }]).toContainEqual(outcome);
    },
  );

  it('makes at least one matrix case smaller: the follow-up the failure does not need', () => {
    const shrunk = matrix.get('unknown-stock-claim');
    expect(shrunk?.output).toContain('2 turns');
    expect(shrunk?.output).toMatch(/→ 1 turns/u);
    expect(shrunk?.file).not.toContain('the cheaper one?');
  });

  it('keeps whole messages by default', () => {
    const shrunk = matrix.get('filter-ignored');
    expect(shrunk?.output).toContain('already as small as it gets');
  });

  it('cuts words only with --words, and warns that the message may no longer ask the same', () => {
    expect(words?.code, words?.output).toBe(0);
    expect(words?.output).toContain('--words: a message cut to fewer words');
    expect(words?.file).toContain('- user: mont');
    expect(words?.file).toContain('# Read first: the message of turn 1 was cut to fewer words,');
  });

  it('reports a flaky failure, and writes nothing', () => {
    expect(flaky?.code, flaky?.output).toBe(1);
    expect(flaky?.output).toMatch(/flaky: 2 of 5 runs failed/u);
    expect(flaky?.file).toBeUndefined();
  });

  it('contacts nothing but the demo-shops (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
