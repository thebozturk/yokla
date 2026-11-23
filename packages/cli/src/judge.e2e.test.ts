// The calibrated judge, end to end (ADR-0090, ADR-0091): yokla generate
// --redteam writes the attack cases of every judge dimension, and yokla run
// asks models.judge about each answer, the fake provider playing the judge.
// - The correct shop passes every dimension.
// - Each judged defect is found on its own kind's cases and nothing else,
//   and fails no case by default: the dimensions are advisory. With every
//   dimension in judge.gate, its cases fail, and the gate breaks.
// - demo-judge-lax misjudges the calibration: every verdict is unmeasured,
//   and a run issue names the items.
// - A second run sends no judge call.
// The shop's model runs in process, at no cost, behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JUDGE_DIMENSIONS, Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const KEY_ENV = 'YOKLA_E2E_JUDGE_KEY';
const work = mkdtempSync(join(tmpdir(), 'yokla-judge-e2e-'));
const profile = join(work, 'yokla.profile.yaml');
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

/** A configuration with the fake provider as judge, under a model name, and these judge lines. */
function writeConfig(name: string, provider: string, model: string, judge: string[] = []): string {
  const file = join(work, `${name}.config.yaml`);
  writeFileSync(
    file,
    [
      'version: 1',
      'models:',
      '  judge:',
      '    kind: openai-compatible',
      `    url: ${provider}/v1`,
      `    model: ${model}`,
      `    apiKeyEnv: ${KEY_ENV}`,
      '    price: { input: 0, output: 0 }',
      ...judge,
      '',
    ].join('\n'),
  );
  return file;
}

type Config = 'advisory' | 'gated' | 'lax';
/** Each run: the shop's defect, or none, and the configuration it runs with. */
const RUNS: readonly (readonly [string, string, Config])[] = [
  ['correct', 'none', 'advisory'],
  ['again', 'none', 'advisory'],
  ...JUDGE_DIMENSIONS.flatMap((defect) => [
    [defect, defect, 'advisory'] as const,
    [`${defect}-gated`, defect, 'gated'] as const,
  ]),
  ['lax', 'unsafe-advice', 'lax'],
];

const runs = new Map<string, { code: number; output: string }>();
const results = (run: string) =>
  Results.parse(JSON.parse(readFileSync(join(work, `${run}.json`), 'utf8')));
const kindOf = (id: string) => id.replace(/-(?:tr|en)-.*$/u, '');
/** Each case of a run, by its kind, with the judge's verdicts on it. */
const verdicts = (run: string) =>
  results(run).cases.map((c) => ({
    kind: kindOf(c.id),
    status: c.status,
    verdicts: c.samples
      .flatMap((sample) => sample.turns)
      .flatMap((turn) => turn.checks)
      .filter((check) => check.check === 'judge')
      .flatMap((check) => check.findings.map((finding) => finding.verdict)),
  }));

/** The profile's request limits, which pace a run; the shops here run without theirs. */
const LIMITS = '  limits:\n    burstPerSecond: 3\n    perMinute: 120\n';

beforeAll(async () => {
  const demo = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8');
  if (!demo.includes(LIMITS)) throw new Error("the demo profile's limits changed");
  // Nineteen runs of every judged case: at 120 a minute, they would take minutes.
  writeFileSync(profile, demo.replace(LIMITS, '').replaceAll('./data/', join(DEMO, 'data/')));
  cpSync(join(DEMO, 'data'), join(work, 'data'), { recursive: true });
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const provider = await start('src/provider-main.ts', ['--port', '0']);
  const configs: Readonly<Record<Config, string>> = {
    advisory: writeConfig('advisory', provider, 'demo-judge-1'),
    gated: writeConfig('gated', provider, 'demo-judge-1', [
      'judge:',
      `  gate: [${JUDGE_DIMENSIONS.join(', ')}]`,
    ]),
    lax: writeConfig('lax', provider, 'demo-judge-lax'),
  };
  process.env[KEY_ENV] = 'demo-key';
  const generated = await cli('generate', '--redteam', '--profile', profile, '--per-kind', '2');
  if (generated.code !== 0) throw new Error(generated.output);
  const shops = new Map<string, string>();
  for (const defect of ['none', ...JUDGE_DIMENSIONS]) {
    shops.set(
      defect,
      await start('src/main.ts', ['--port', '0', '--rate-limit', 'off', '--defect', defect]),
    );
  }
  const tags = JUDGE_DIMENSIONS.flatMap((dimension) => ['--tag', dimension]);
  // One after the other: a later run reads the earlier ones' cache.
  for (const [run, defect, config] of RUNS) {
    runs.set(
      run,
      await cli(
        'run',
        '--profile',
        profile,
        '--config',
        configs[config],
        '--cases',
        attacks,
        ...tags,
        '--target-url',
        `${shops.get(defect) ?? ''}/v1/chat`,
        '--out',
        join(work, `${run}.json`),
      ),
    );
  }
}, 300_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('the calibrated judge on the demo-shop (ADR-0090, ADR-0091)', () => {
  it('judges the attack cases of every dimension, after its calibration in both languages', () => {
    // yokla run judges; yokla gate decides, below.
    for (const [run, ran] of runs) expect(ran.code, `${run}: ${ran.output}`).toBe(0);
    const correct = results('correct');
    expect(new Set(correct.cases.map((c) => kindOf(c.id)))).toEqual(new Set(JUDGE_DIMENSIONS));
    expect(correct.run.judge).toEqual({
      model: 'demo-judge-1',
      dimensions: [...JUDGE_DIMENSIONS],
      gated: [],
      calibration: { items: JUDGE_DIMENSIONS.length * 4, misjudged: [] },
    });
    expect(runs.get('correct')?.output).toContain(
      `${String(JUDGE_DIMENSIONS.length * 4)} of ${String(JUDGE_DIMENSIONS.length * 4)} calibration items judged right`,
    );
  });

  it('the correct shop passes every dimension', () => {
    for (const c of verdicts('correct')) {
      expect(c.status, c.kind).toBe('pass');
      expect(c.verdicts, c.kind).toEqual(['pass']);
    }
  });

  it("finds each defect on its own kind's cases and nothing else, and fails no case by default", () => {
    for (const defect of JUDGE_DIMENSIONS) {
      const cases = verdicts(defect);
      expect(
        cases.some((c) => c.kind === defect),
        defect,
      ).toBe(true);
      for (const c of cases) {
        expect(c.verdicts, `${defect}: ${c.kind}`).toEqual([c.kind === defect ? 'fail' : 'pass']);
        expect(c.status, `${defect}: ${c.kind}`).toBe('pass');
      }
    }
  });

  it("with every dimension in judge.gate, fails each defect's cases, and the gate breaks", async () => {
    for (const defect of JUDGE_DIMENSIONS) {
      for (const c of verdicts(`${defect}-gated`)) {
        expect(c.status, `${defect}: ${c.kind}`).toBe(c.kind === defect ? 'fail' : 'pass');
      }
    }
    const approved = join(work, 'gated-approved.json');
    const ran = results('unsafe-advice-gated');
    writeFileSync(
      approved,
      JSON.stringify({ ...ran, cases: ran.cases.map(({ review: _review, ...c }) => c) }),
    );
    const gate = await cli('gate', '--results', approved);
    expect(gate.code, gate.output).toBe(1);
    expect(gate.output).toContain('redteam: 4 failing cases');
  });

  it('a judge that misjudges the calibration leaves every verdict unmeasured, naming the items', () => {
    const lax = results('lax');
    const failing = JUDGE_DIMENSIONS.length * 2;
    expect(lax.run.judge?.unmeasured).toBe(
      `the judge misjudged ${String(failing)} of ${String(failing * 2)} calibration items, so its verdicts of the run are discarded`,
    );
    expect(lax.run.judge?.calibration.misjudged.every((item) => item.got === 'pass')).toBe(true);
    for (const c of verdicts('lax')) expect(c.verdicts, c.kind).toEqual([]);
    expect(lax.run.issues?.join('\n')).toContain('fail expected, pass given');
  });

  it('a second run sends no judge call: every verdict comes from the cache', () => {
    const first = results('correct').run.own;
    expect(first?.calls).toBeGreaterThan(JUDGE_DIMENSIONS.length * 4);
    expect(results('again').run.own).toEqual({
      calls: first?.calls,
      cached: first?.calls,
      costUsd: 0,
    });
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shop and its fake provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
