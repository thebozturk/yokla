// The calibrated judge, end to end (ADR-0090): yokla generate --redteam
// writes the unsafe-advice cases, and yokla run asks models.judge about each
// answer, the fake provider playing the judge.
// - The correct shop passes unsafe-advice.
// - The unsafe-advice defect is found, and doesn't fail a case by default:
//   the dimension is advisory. With judge.gate, the cases fail and the gate
//   breaks.
// - demo-judge-lax misjudges the calibration: every verdict is unmeasured,
//   and a run issue names the items.
// - A second run sends no judge call.
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

/** A configuration with the fake provider as judge, under a model name, and these judge settings. */
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

/** Each run: the shop's defect, and the configuration it runs with. */
const RUNS = {
  correct: ['none', 'advisory'],
  again: ['none', 'advisory'],
  advisory: ['unsafe-advice', 'advisory'],
  gated: ['unsafe-advice', 'gated'],
  lax: ['unsafe-advice', 'lax'],
} as const;

const runs = new Map<string, { code: number; output: string }>();
const results = (run: string) =>
  Results.parse(JSON.parse(readFileSync(join(work, `${run}.json`), 'utf8')));
/** The judge's findings of a run, per case. */
const verdicts = (run: string) =>
  results(run).cases.map((c) =>
    c.samples
      .flatMap((sample) => sample.turns)
      .flatMap((turn) => turn.checks)
      .filter((check) => check.check === 'judge'),
  );

beforeAll(async () => {
  writeFileSync(
    profile,
    readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
      './data/',
      join(DEMO, 'data/'),
    ),
  );
  cpSync(join(DEMO, 'data'), join(work, 'data'), { recursive: true });
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const provider = await start('src/provider-main.ts', ['--port', '0']);
  const configs = {
    advisory: writeConfig('advisory', provider, 'demo-judge-1'),
    gated: writeConfig('gated', provider, 'demo-judge-1', ['judge:', '  gate: [unsafe-advice]']),
    lax: writeConfig('lax', provider, 'demo-judge-lax'),
  };
  process.env[KEY_ENV] = 'demo-key';
  const generated = await cli('generate', '--redteam', '--profile', profile, '--per-kind', '2');
  if (generated.code !== 0) throw new Error(generated.output);
  const shops = {
    none: await start('src/main.ts', ['--port', '0', '--rate-limit', 'off']),
    'unsafe-advice': await start('src/main.ts', [
      '--port',
      '0',
      '--rate-limit',
      'off',
      '--defect',
      'unsafe-advice',
    ]),
  };
  // One after the other: the second run of the correct shop reads the first's cache.
  for (const [run, [defect, config]] of Object.entries(RUNS)) {
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
        '--tag',
        'unsafe-advice',
        '--target-url',
        `${shops[defect]}/v1/chat`,
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

describe('the calibrated judge on the demo-shop (ADR-0090)', () => {
  it('judges every unsafe-advice case after its calibration in both languages', () => {
    // yokla run judges; yokla gate decides, below.
    for (const [run, ran] of runs) expect(ran.code, `${run}: ${ran.output}`).toBe(0);
    const correct = results('correct');
    expect(correct.cases.map((c) => c.id.replace(/-(?:tr|en)-.*$/u, ''))).toEqual(
      correct.cases.map(() => 'unsafe-advice'),
    );
    expect(correct.cases.length).toBe(4);
    expect(correct.run.judge).toEqual({
      model: 'demo-judge-1',
      dimensions: ['unsafe-advice'],
      gated: [],
      calibration: { items: 4, misjudged: [] },
    });
    expect(runs.get('correct')?.output).toContain(
      'judge: demo-judge-1, unsafe-advice (advisory); 4 of 4 calibration items judged right',
    );
  });

  it('the correct shop passes unsafe-advice', () => {
    expect(results('correct').cases.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    for (const checks of verdicts('correct')) {
      expect(checks.flatMap((check) => check.findings.map((finding) => finding.verdict))).toEqual([
        'pass',
      ]);
    }
  });

  it('finds the defect, and fails no case by default: the dimension is advisory', () => {
    for (const checks of verdicts('advisory')) {
      expect(checks.flatMap((check) => check.findings.map((finding) => finding.verdict))).toEqual([
        'fail',
      ]);
    }
    expect(results('advisory').cases.map((c) => c.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
    expect(
      results('advisory').cases.map(
        (c) => c.dimensions.find((d) => d.dimension === 'unsafe-advice')?.policy,
      ),
    ).toEqual(['advisory', 'advisory', 'advisory', 'advisory']);
  });

  it('with judge.gate, fails every case and breaks the gate', async () => {
    expect(results('gated').cases.map((c) => c.status)).toEqual(['fail', 'fail', 'fail', 'fail']);
    const approved = join(work, 'gated-approved.json');
    const ran = results('gated');
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
    expect(lax.run.judge?.unmeasured).toBe(
      'the judge misjudged 2 of 4 calibration items, so its verdicts of the run are discarded',
    );
    expect(lax.run.judge?.calibration.misjudged.map((item) => [item.language, item.got])).toEqual([
      ['en', 'pass'],
      ['tr', 'pass'],
    ]);
    for (const checks of verdicts('lax')) {
      expect(checks.flatMap((check) => check.findings)).toEqual([]);
      expect(checks.flatMap((check) => check.unmeasured ?? []).map((u) => u.dimension)).toEqual([
        'unsafe-advice',
      ]);
    }
    expect(lax.run.issues?.join('\n')).toContain('fail expected, pass given');
  });

  it('a second run sends no judge call: every verdict comes from the cache', () => {
    const first = results('correct').run.own;
    expect(first?.calls).toBeGreaterThan(4);
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
