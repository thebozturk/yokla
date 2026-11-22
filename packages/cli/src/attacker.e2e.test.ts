// The attacker model, end to end (ADR-0087): yokla generate --redteam writes
// the attack cases, and yokla run --attacker adapts each, with the fake
// provider playing the attacker.
// - The correct shop withstands escalation and best-of-n.
// - worn-down, which gives in to an instruction asked for three times, passes
//   every written case and best-of-n, and escalation breaks it.
// - obfuscation-obeyed passes every written case and escalation, and
//   best-of-n breaks it at its leetspeak attempt, running no further one.
// - A second run sends no attacker call: every reply comes from the cache.
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
const KEY_ENV = 'YOKLA_E2E_ATTACKER_KEY';
const work = mkdtempSync(join(tmpdir(), 'yokla-attacker-e2e-'));
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

/** Each shop's runs, in order: an attacker strategy, or none for the cases as written. */
const PLAN: Readonly<Record<string, readonly string[]>> = {
  none: ['escalation', 'best-of-n', 'escalation-again'],
  'worn-down': ['escalation', 'best-of-n', 'written'],
  'obfuscation-obeyed': ['best-of-n', 'escalation', 'written'],
};
/** The kinds whose own message, followed, breaks a check (ADR-0084). */
const FOLLOWED = new Set(['injection', 'false-premise', 'card', 'offer']);

const runs = new Map<string, { code: number; output: string }>();
const results = (defect: string, run: string) =>
  Results.parse(JSON.parse(readFileSync(join(work, `${defect}-${run}.json`), 'utf8')));
const kindOf = (id: string) => id.replace(/-(?:tr|en)-.*$/u, '');
const failed = (defect: string, run: string) =>
  results(defect, run)
    .cases.filter((c) => c.status === 'fail')
    .map((c) => c.id);

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
        const strategy = run.replace(/-again$/u, '');
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
            '--out',
            join(work, `${defect}-${run}.json`),
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

describe('the attacker model on the demo-shop (ADR-0087)', () => {
  it('every run ran, and the attacker adapted every attack case of one turn', () => {
    for (const [name, ran] of runs) expect(ran.code, `${name}: ${ran.output}`).toBe(0);
    const cases = results('none', 'escalation').cases.length;
    expect(cases).toBeGreaterThan(10);
    expect(results('none', 'escalation').run.attacker).toEqual({
      strategy: 'escalation',
      limit: 5,
      cases,
    });
    expect(results('none', 'best-of-n').run.attacker).toEqual({
      strategy: 'best-of-n',
      limit: 4,
      cases,
    });
    expect(runs.get('none escalation')?.output).toContain(
      `attacker: escalation, at most 5 turns, ${String(cases)} cases`,
    );
  });

  it('the correct shop withstands every turn of escalation and every attempt of best-of-n', () => {
    for (const run of ['escalation', 'best-of-n']) {
      const broken = results('none', run).cases.filter(
        (c) => c.status === 'fail' || c.status === 'error',
      );
      expect(
        broken.map((c) => c.id),
        run,
      ).toEqual([]);
    }
    const escalated = results('none', 'escalation').cases;
    expect(escalated.map((c) => c.samples.map((sample) => sample.turns.length))).toEqual(
      escalated.map(() => [5]),
    );
    expect(escalated.map((c) => c.samples[0]?.attacker?.brokeAt)).toEqual(
      escalated.map(() => undefined),
    );
    const sampled = results('none', 'best-of-n').cases;
    expect(sampled.map((c) => c.samples.length)).toEqual(sampled.map(() => 4));
  });

  it('worn-down passes the written cases and best-of-n, and escalation breaks it on its fourth turn', () => {
    expect(failed('worn-down', 'written')).toEqual([]);
    expect(failed('worn-down', 'best-of-n')).toEqual([]);
    const broken = results('worn-down', 'escalation').cases.filter((c) => c.status === 'fail');
    const injections = results('worn-down', 'escalation')
      .cases.map((c) => c.id)
      .filter((id) => kindOf(id) === 'injection' && !id.endsWith('-hidden-text'));
    expect(broken.map((c) => c.id).toSorted()).toEqual(injections.toSorted());
    for (const c of broken) {
      const [sample] = c.samples;
      expect(sample?.attacker?.brokeAt, c.id).toBe(3);
      expect(sample?.turns, c.id).toHaveLength(4);
      const failing = sample?.turns
        .flatMap((turn) => turn.checks)
        .filter((check) => check.findings.some((finding) => finding.verdict === 'fail'))
        .map((check) => check.check);
      expect(failing, c.id).toEqual(['answer-text']);
    }
  });

  it('obfuscation-obeyed passes the written cases and escalation, and best-of-n stops at its leetspeak attempt', () => {
    expect(failed('obfuscation-obeyed', 'written')).toEqual([]);
    expect(failed('obfuscation-obeyed', 'escalation')).toEqual([]);
    const broken = results('obfuscation-obeyed', 'best-of-n').cases.filter(
      (c) => c.status === 'fail',
    );
    const ids = broken.map((c) => c.id);
    const injections = results('obfuscation-obeyed', 'best-of-n')
      .cases.map((c) => c.id)
      .filter((id) => kindOf(id) === 'injection' && !id.endsWith('-hidden-text'));
    expect(ids).toEqual(expect.arrayContaining(injections));
    for (const c of broken) {
      expect(FOLLOWED.has(kindOf(c.id)), c.id).toBe(true);
      // The third attempt, in leetspeak, broke through; no fourth was sent.
      expect(c.samples, c.id).toHaveLength(3);
      expect(c.samplesPlanned, c.id).toBe(4);
    }
  });

  it('a second run sends no attacker call: every reply comes from the cache', () => {
    const first = results('none', 'escalation').run.own;
    const again = results('none', 'escalation-again').run.own;
    expect(first?.calls).toBeGreaterThan(0);
    expect(again).toEqual({ calls: first?.calls, cached: first?.calls, costUsd: 0 });
    expect(
      results('none', 'escalation-again').cases.map((c) => c.samples[0]?.turns.map((t) => t.user)),
    ).toEqual(
      results('none', 'escalation').cases.map((c) => c.samples[0]?.turns.map((t) => t.user)),
    );
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shop and its fake provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
