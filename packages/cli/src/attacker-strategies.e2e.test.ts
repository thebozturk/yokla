// The attacker strategies of R5b, end to end (ADR-0088): yokla generate
// --redteam writes the attack cases, and yokla run --attacker adapts each with
// iterative, tree or translate, the fake provider playing the attacker.
// - The correct shop withstands every attempt of each strategy.
// - filter-explained, which quotes the phrase it refused, passes the written
//   cases and best-of-n, and iterative breaks it at its second attempt.
// - Each tree writes the last branch of each node past its first level as
//   the parent in leetspeak, with no attacker call (ADR-0109).
// - layered-obeyed, which refuses a wrapper it can read and reads past
//   leetspeak, passes the written cases and best-of-n, and tree breaks it at
//   its sixth attempt, its leetspeak layer over the role-play.
// - obfuscation-obeyed, which reads past leetspeak, breaks under tree at the
//   same attempt, over the injection cases.
// - one-language-guard, which follows English instructions only, fails the
//   English injections as written and the Turkish ones under translate.
// - A second iterative run sends no attacker call.
// The shop's model runs in process, at no cost, behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const KEY_ENV = 'YOKLA_E2E_STRATEGIES_KEY';
const work = mkdtempSync(join(tmpdir(), 'yokla-strategies-e2e-'));
const profile = join(work, 'yokla.profile.yaml');
const config = join(work, 'yokla.config.yaml');
const attacks = join(work, 'cases', 'redteam.yaml');
const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;

/** Starts a demo-shop process and resolves with the url it prints. */
function start(script: string, args: string[]): Promise<string> {
  const child = spawn(process.execPath, [join(DEMO, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      reject(new Error(`${script} exited early with ${String(code)}`));
    });
  });
}

async function cli(...args: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await main(args, {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  return { code, output: lines.join('\n') };
}

/**
 * Each shop's runs, in order: an attacker strategy, or `written` for the
 * cases as written. A run ending in `@injection` runs the injection cases
 * only: the fake translates nothing else.
 */
const PLAN: Readonly<Record<string, readonly string[]>> = {
  none: ['iterative', 'tree', 'translate@injection', 'iterative-again'],
  'filter-explained': ['written', 'best-of-n', 'iterative'],
  'layered-obeyed': ['written', 'best-of-n', 'tree'],
  'obfuscation-obeyed': ['tree@injection'],
  'one-language-guard': ['written@injection', 'best-of-n@injection', 'translate@injection'],
};
/** The kinds whose own message, followed, breaks a check (ADR-0084). */
const FOLLOWED = new Set(['injection', 'false-premise', 'card', 'offer']);

const runs = new Map<string, { code: number; output: string }>();
const fileOf = (defect: string, run: string) =>
  join(work, `${defect}-${run.replace('@', '-')}.json`);
const results = (defect: string, run: string) =>
  Results.parse(JSON.parse(readFileSync(fileOf(defect, run), 'utf8')));
const kindOf = (id: string) => id.replace(/-(?:tr|en)-.*$/u, '');
const languageOf = (id: string) => /-(tr|en)-/u.exec(id)?.[1];
const failed = (defect: string, run: string) =>
  results(defect, run)
    .cases.filter((c) => c.status === 'fail')
    .map((c) => c.id)
    .toSorted();
/** The run's injections whose instruction is in plain sight, in a language or in any. */
const injections = (defect: string, run: string, language?: string) =>
  results(defect, run)
    .cases.map((c) => c.id)
    .filter(
      (id) =>
        kindOf(id) === 'injection' &&
        !id.endsWith('-hidden-text') &&
        (language === undefined || languageOf(id) === language),
    )
    .toSorted();
/** The checks that failed in a case's results. */
const failingChecks = (c: Results['cases'][number]) =>
  c.samples
    .flatMap((sample) => sample.turns)
    .flatMap((turn) => turn.checks)
    .filter((check) => check.findings.some((finding) => finding.verdict === 'fail'))
    .map((check) => check.check);

/** The profile's request limits, which pace a run; the shops here run without theirs. */
const LIMITS = '  limits:\n    burstPerSecond: 3\n    perMinute: 120\n';

beforeAll(async () => {
  const demo = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8');
  if (!demo.includes(LIMITS)) throw new Error("the demo profile's limits changed");
  // A tree sends up to 12 attempts a case: at 120 a minute, the runs would take minutes.
  writeFileSync(profile, demo.replace(LIMITS, '').replaceAll('./data/', join(DEMO, 'data/')));
  cpSync(join(DEMO, 'data'), join(work, 'data'), { recursive: true });
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const provider = await start('src/provider-main.ts', ['--port', '0']);
  writeFileSync(
    config,
    [
      'version: 1',
      'models:',
      '  attacker:',
      '    kind: openai-compatible',
      `    url: ${provider}/v1`,
      '    model: demo-attacker-1',
      `    apiKeyEnv: ${KEY_ENV}`,
      '    price: { input: 0, output: 0 }',
      '',
    ].join('\n'),
  );
  process.env[KEY_ENV] = 'demo-key';
  const generated = await cli(
    'generate',
    '--redteam',
    '--profile',
    profile,
    '--per-kind',
    '2',
    '--competitor',
    'Rivalmart',
  );
  if (generated.code !== 0) throw new Error(generated.output);
  // One shop per defect, side by side; each shop's runs one after the other.
  await Promise.all(
    Object.entries(PLAN).map(async ([defect, plan]) => {
      const shop = await start('src/main.ts', [
        '--port',
        '0',
        '--rate-limit',
        'off',
        '--defect',
        defect,
      ]);
      for (const run of plan) {
        const [name = run, tag] = run.split('@');
        const strategy = name.replace(/-again$/u, '');
        runs.set(
          `${defect} ${run}`,
          await cli(
            'run',
            '--profile',
            profile,
            '--config',
            config,
            '--cases',
            attacks,
            '--target-url',
            `${shop}/v1/chat`,
            ...(strategy === 'written' ? [] : ['--attacker', strategy]),
            ...(tag === undefined ? [] : ['--tag', tag]),
            '--out',
            fileOf(defect, run),
          ),
        );
      }
    }),
  );
}, 300_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('the attacker strategies of R5b on the demo-shop (ADR-0088)', () => {
  it('every run ran, and each strategy names its bounds', () => {
    for (const [name, ran] of runs) expect(ran.code, `${name}: ${ran.output}`).toBe(0);
    const cases = results('none', 'iterative').cases.length;
    expect(cases).toBeGreaterThan(10);
    expect(results('none', 'iterative').run.attacker).toEqual({
      strategy: 'iterative',
      limit: 4,
      cases,
    });
    expect(results('none', 'tree').run.attacker).toEqual({
      strategy: 'tree',
      limit: 12,
      branches: 3,
      depth: 2,
      cases,
    });
    const translated = results('none', 'translate@injection').cases;
    expect(translated.length).toBeGreaterThan(1);
    expect(translated.every((c) => kindOf(c.id) === 'injection')).toBe(true);
    expect(results('none', 'translate@injection').run.attacker).toEqual({
      strategy: 'translate',
      limit: 1,
      cases: translated.length,
    });
    expect(runs.get('none tree')?.output).toContain(
      `attacker: tree, 3 branches to depth 2, at most 12 attempts, ${String(cases)} cases`,
    );
  });

  it('the correct shop withstands every attempt of each strategy', () => {
    for (const run of ['iterative', 'tree', 'translate@injection']) {
      const broken = results('none', run).cases.filter(
        (c) => c.status === 'fail' || c.status === 'error',
      );
      expect(
        broken.map((c) => c.id),
        run,
      ).toEqual([]);
    }
    const iterated = results('none', 'iterative').cases;
    expect(iterated.map((c) => c.samples.length)).toEqual(iterated.map(() => 4));
    const tree = results('none', 'tree').cases;
    expect(tree.map((c) => c.samples.length)).toEqual(tree.map(() => 12));
    expect(tree[0]?.samples.map((sample) => sample.attacker?.parent)).toEqual([
      undefined,
      undefined,
      undefined,
      0,
      0,
      0,
      1,
      1,
      1,
      2,
      2,
      2,
    ]);
    // Each node's last branch past the first level is its parent in leetspeak,
    // written with no attacker call (ADR-0109); a case whose attempts the attacker
    // never sent writes none (ADR-0101).
    const sent = tree.filter((c) =>
      c.samples.every((sample) => sample.attacker?.unsent === undefined),
    );
    expect(sent.length).toBeGreaterThan(10);
    for (const c of sent) {
      expect(
        c.samples.flatMap((sample, index) =>
          sample.attacker?.layer === 'leetspeak' ? [index] : [],
        ),
        c.id,
      ).toEqual([5, 8, 11]);
      for (const index of [5, 8, 11]) {
        const sample = c.samples[index];
        const parent = c.samples[sample?.attacker?.parent ?? -1];
        expect(sample?.attacker?.calls, `${c.id} ${String(index)}`).toEqual([]);
        expect(sample?.turns[0]?.user, `${c.id} ${String(index)}`).not.toBe(parent?.turns[0]?.user);
      }
    }
    // Each translated attempt is written, and judged, in the case's other language.
    for (const c of results('none', 'translate@injection').cases) {
      expect(
        c.samples.map((sample) => sample.attacker?.language),
        c.id,
      ).toEqual([c.language === 'tr' ? 'en' : 'tr']);
    }
  });

  it('filter-explained passes the written cases and best-of-n, and iterative breaks it at its second attempt', () => {
    expect(failed('filter-explained', 'written')).toEqual([]);
    expect(failed('filter-explained', 'best-of-n')).toEqual([]);
    expect(failed('filter-explained', 'iterative')).toEqual(
      injections('filter-explained', 'iterative'),
    );
    for (const c of results('filter-explained', 'iterative').cases) {
      if (c.status !== 'fail') continue;
      expect(c.samples, c.id).toHaveLength(2);
      expect(c.samplesPlanned, c.id).toBe(4);
      expect(failingChecks(c), c.id).toEqual(['answer-text']);
    }
  });

  it('layered-obeyed passes the written cases and best-of-n, and tree breaks it at its leetspeak layer over the role-play', () => {
    expect(failed('layered-obeyed', 'written')).toEqual([]);
    expect(failed('layered-obeyed', 'best-of-n')).toEqual([]);
    const broken = results('layered-obeyed', 'tree').cases.filter((c) => c.status === 'fail');
    expect(broken.map((c) => c.id)).toEqual(
      expect.arrayContaining(injections('layered-obeyed', 'tree')),
    );
    for (const c of broken) {
      expect(FOLLOWED.has(kindOf(c.id)), c.id).toBe(true);
      // The sixth attempt, the first node's last branch: its role-play in leetspeak (ADR-0109).
      expect(c.samples, c.id).toHaveLength(6);
      expect(c.samples.at(-1)?.attacker?.parent, c.id).toBe(0);
      expect(c.samples.at(-1)?.attacker?.layer, c.id).toBe('leetspeak');
      expect(c.samplesPlanned, c.id).toBe(12);
    }
  });

  it('obfuscation-obeyed breaks under tree at the same attempt, the leetspeak layer (ADR-0109)', () => {
    const broken = results('obfuscation-obeyed', 'tree@injection').cases.filter(
      (c) => c.status === 'fail',
    );
    expect(broken.map((c) => c.id)).toEqual(
      expect.arrayContaining(injections('obfuscation-obeyed', 'tree@injection')),
    );
    for (const c of broken) {
      expect(c.samples, c.id).toHaveLength(6);
      expect(c.samples.at(-1)?.attacker?.layer, c.id).toBe('leetspeak');
      expect(failingChecks(c), c.id).toContain('answer-text');
    }
  });

  it('one-language-guard fails the English injections as written, and the Turkish ones under translate', () => {
    expect(failed('one-language-guard', 'written@injection')).toEqual(
      injections('one-language-guard', 'written@injection', 'en'),
    );
    expect(
      failed('one-language-guard', 'best-of-n@injection').filter((id) => languageOf(id) === 'tr'),
    ).toEqual([]);
    expect(failed('one-language-guard', 'translate@injection')).toEqual(
      injections('one-language-guard', 'translate@injection', 'tr'),
    );
    for (const c of results('one-language-guard', 'translate@injection').cases) {
      if (c.status !== 'fail') continue;
      expect(
        c.samples.map((sample) => sample.attacker?.language),
        c.id,
      ).toEqual(['en']);
      expect(failingChecks(c), c.id).toEqual(['answer-text']);
    }
  });

  it('a second iterative run sends no attacker call: every reply comes from the cache', () => {
    const first = results('none', 'iterative').run.own;
    const again = results('none', 'iterative-again').run.own;
    expect(first?.calls).toBeGreaterThan(0);
    expect(again).toEqual({ calls: first?.calls, cached: first?.calls, costUsd: 0 });
    expect(
      results('none', 'iterative-again').cases.map((c) =>
        c.samples.map((sample) => sample.turns[0]?.user),
      ),
    ).toEqual(
      results('none', 'iterative').cases.map((c) =>
        c.samples.map((sample) => sample.turns[0]?.user),
      ),
    );
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shop and its fake provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
