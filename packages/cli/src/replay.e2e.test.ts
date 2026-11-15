// Recorded model calls, replayed, end to end (ADR-0040): the demo-shop calls
// the fake provider through `yokla proxy`. A run with --record writes a
// cassette, and the same run with --replay answers every model call from it:
// the results are the same, case for case and finding for finding, and the
// provider's usage log gains no entry. This holds for JSON answers correlated
// serially and for streams correlated by header. The resilience cases run on
// a cassette recorded without a defect and catch each resilience defect as
// they do live. A case whose model answer is replaced with a price no product
// has fails price-grounded with the origin `model`. A cassette replayed
// against a shop whose prompt changed (prompt-bloat) makes its cases error;
// with --replay-loose they run, and the issues count the diverged calls.
// Everything runs behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cassette, Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyCommand } from './commands/proxy.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'yokla-replay-e2e-'));
const usageLog = join(dir, 'provider-usage.jsonl');
const proxyLog = join(dir, 'proxy-records.jsonl');
const config = join(dir, 'yokla.config.yaml');

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
const stopProxy = new AbortController();
let proxyDone: Promise<number> | undefined;
let proxyUrl = '';
let providerUrl = '';

/** Starts a script and resolves with the first URL it prints. */
function start(script: string, args: string[]): Promise<string> {
  const child = spawn(process.execPath, [join(DEMO, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+(?:\/v1)?/u.exec(output)?.[0];
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

/** A demo-shop with its model over HTTP, through the proxy. */
function shop(...args: string[]): Promise<string> {
  return start('src/main.ts', ['--port', '0', '--model-url', `${proxyUrl}/fake`, ...args]);
}

/** How many calls the fake provider has answered. */
function providerCalls(): number {
  return readFileSync(usageLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;
}

/** The demo-shop profile with its data paths made absolute and a model proxy added. */
function profileFor(correlation: 'serial' | 'header'): string {
  const text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  const path = join(dir, `${correlation}.profile.yaml`);
  writeFileSync(
    path,
    `${text}\nmodelProxy:\n  port: 1\n  correlation: ${correlation}\n  upstreams:\n    - { id: fake, kind: openai-compatible, upstream: '${providerUrl}' }\n`,
  );
  return path;
}

interface Ran {
  readonly code: number;
  readonly output: string;
  readonly results: Results;
  /** The calls the fake provider answered during the run. */
  readonly provider: number;
}

async function yokla(name: string, args: string[]): Promise<Ran> {
  const out = join(dir, `${name}.results.json`);
  const before = providerCalls();
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    ['run', ...args, '--proxy-url', proxyUrl, '--config', config, '--out', out],
    io,
  );
  return {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    provider: providerCalls() - before,
  };
}

const ACCEPTANCE = ['--cases', join(DEMO, 'cases'), '--cases', join(DEMO, 'cases-replay')];
const RESILIENCE_CASES = ['--cases', join(DEMO, 'cases-resilience')];
const cassetteOf = (name: string) => join(dir, `${name}.cassette.json`);

/** Resilience defect → the one check that must catch it → the cases it must fail. */
const RESILIENCE: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  none: {},
  'no-model-fallback': {
    'graceful-under-fault': [
      'empty-model-output',
      'malformed-interpretation',
      'provider-down',
      'provider-stalls',
    ],
  },
  'no-model-timeout': { 'answered-within-deadline': ['provider-stalls'] },
  'unchecked-model-output': { 'route-expected': ['empty-model-output'] },
};

const runs = new Map<string, { recorded: Ran; replayed: Ran }>();

/** The recorded run and its replay, of one correlation. */
function both(name: string): { recorded: Ran; replayed: Ran } {
  const run = runs.get(name);
  if (run === undefined) throw new Error(`no ${name} run`);
  return run;
}
let resilienceRecorded: Ran | undefined;
const resilience = new Map<string, Ran>();
let strict: Ran | undefined;
let loose: Ran | undefined;

/** What a run decided, case for case and finding for finding: no ids, times or replay marks. */
function decided(results: Results) {
  return results.cases.map((c) => ({
    id: c.id,
    status: c.status,
    dimensions: c.dimensions,
    samples: c.samples.map((sample) =>
      sample.turns.map((turn) => ({
        user: turn.user,
        status: turn.response?.status,
        text: turn.response?.text,
        route: turn.response?.route,
        evidence: turn.response?.evidence,
        error: turn.error,
        issues: turn.issues,
        checks: turn.checks,
        calls: turn.proxy?.calls.map((call) => ({
          model: call.model,
          status: call.status,
          stream: call.stream,
          usage: call.usage,
          costUsd: call.costUsd,
          fault: call.fault,
          prompt: call.prompt,
          tools: call.tools,
          toolCalls: call.toolCalls,
          output: call.output,
        })),
      })),
    ),
  }));
}

/** check → the cases where it reported a failing finding. */
function failingByCheck(results: Results | undefined): Record<string, string[]> {
  const failing: Record<string, Set<string>> = {};
  for (const c of results?.cases ?? []) {
    for (const turn of c.samples.flatMap((sample) => sample.turns)) {
      for (const check of turn.checks) {
        if (check.findings.some((f) => f.verdict === 'fail'))
          (failing[check.check] ??= new Set()).add(c.id);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(failing).map(([check, ids]) => [check, [...ids].toSorted()]),
  );
}

const calls = (results: Results | undefined) =>
  (results?.cases ?? []).flatMap((c) =>
    c.samples.flatMap((sample) => sample.turns.flatMap((turn) => turn.proxy?.calls ?? [])),
  );

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  writeFileSync(usageLog, '');
  writeFileSync(
    config,
    'version: 1\nprices:\n  fake:\n    demo-writer-1: { input: 1, output: 2 }\n',
  );
  providerUrl = await start('src/provider-main.ts', ['--port', '0', '--usage-log', usageLog]);
  const proxyLines: string[] = [];
  proxyDone = proxyCommand(
    ['--profile', profileFor('serial'), '--port', '0', '--records', proxyLog],
    { out: (line) => proxyLines.push(line), err: (line) => proxyLines.push(line) },
    stopProxy.signal,
  );
  for (let i = 0; i < 200 && proxyUrl === ''; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    proxyUrl = /http:\/\/127\.0\.0\.1:\d+/u.exec(proxyLines[0] ?? '')?.[0] ?? '';
  }
  if (proxyUrl === '') throw new Error(`yokla proxy didn't start:\n${proxyLines.join('\n')}`);
  ports.add(Number(new URL(proxyUrl).port));

  // One recording at a time: the runs go one after the other.
  for (const correlation of ['serial', 'header'] as const) {
    const url = await shop(...(correlation === 'header' ? ['--model-stream'] : []));
    const target = ['--profile', profileFor(correlation), ...ACCEPTANCE];
    target.push('--target-url', `${url}/v1/chat`);
    const recorded = await yokla(`${correlation}-recorded`, [
      ...target,
      '--record',
      cassetteOf(correlation),
    ]);
    const replayed = await yokla(`${correlation}-replayed`, [
      ...target,
      '--replay',
      cassetteOf(correlation),
    ]);
    runs.set(correlation, { recorded, replayed });
  }

  // The resilience cases, recorded once without a defect, replayed against each defect.
  const timeout = ['--model-timeout-ms', '300'];
  const healthy = await shop(...timeout);
  const resilienceArgs = (url: string) => [
    '--profile',
    profileFor('serial'),
    ...RESILIENCE_CASES,
    '--target-url',
    `${url}/v1/chat`,
  ];
  resilienceRecorded = await yokla('resilience-recorded', [
    ...resilienceArgs(healthy),
    '--record',
    cassetteOf('resilience'),
  ]);
  for (const defect of Object.keys(RESILIENCE)) {
    const url = defect === 'none' ? healthy : await shop(...timeout, '--defect', defect);
    resilience.set(
      defect,
      await yokla(`resilience-${defect}`, [
        ...resilienceArgs(url),
        '--replay',
        cassetteOf('resilience'),
      ]),
    );
  }

  // A shop whose writer prompt changed since the serial cassette was recorded.
  const bloated = await shop('--defect', 'prompt-bloat');
  const bloatedArgs = [
    '--profile',
    profileFor('serial'),
    ...ACCEPTANCE,
    '--target-url',
    `${bloated}/v1/chat`,
    '--replay',
    cassetteOf('serial'),
  ];
  strict = await yokla('prompt-bloat-strict', bloatedArgs);
  loose = await yokla('prompt-bloat-loose', [...bloatedArgs, '--replay-loose']);
}, 600_000);

afterAll(async () => {
  stopProxy.abort();
  await proxyDone;
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('recorded model calls, replayed, against the demo-shop (ADR-0040)', () => {
  it.each(['serial', 'header'])(
    '%s: a recorded run replays with the same results, and the provider gets no call',
    (name) => {
      const { recorded, replayed } = both(name);
      expect(recorded.code, recorded.output).toBe(0);
      expect(replayed.code, replayed.output).toBe(0);
      expect(recorded.results.summary.statuses).toEqual({ pass: 18, 'known-gap': 1 });
      expect(decided(replayed.results)).toEqual(decided(recorded.results));
      expect(recorded.provider).toBeGreaterThan(0);
      expect(replayed.provider).toBe(0);
      // Every call the provider answered went into the cassette, and every one answered again.
      expect(recorded.results.run.record).toEqual({ calls: recorded.provider });
      expect(recorded.output).toContain(
        `cassette: ${cassetteOf(name)} (${String(recorded.provider)} model calls; it holds their answers in full)`,
      );
      const sha256 = createHash('sha256')
        .update(readFileSync(cassetteOf(name)))
        .digest('hex');
      expect(replayed.results.run.replay).toEqual({
        cassetteSha256: sha256,
        loose: false,
        diverged: 0,
      });
      expect(replayed.results.run.issues).toBeUndefined();
      const replayedCalls = calls(replayed.results);
      expect(replayedCalls).toHaveLength(recorded.provider);
      expect(replayedCalls.every((call) => call.replay?.diverged === false)).toBe(true);
      expect(calls(recorded.results).every((call) => call.replay === undefined)).toBe(true);
    },
  );

  it('the cassette holds the answers the provider gave, and no request text', () => {
    const cassette = Cassette.parse(JSON.parse(readFileSync(cassetteOf('serial'), 'utf8')));
    expect(cassette.profileSha256).toBe(both('serial').recorded.results.run.profile.sha256);
    expect(cassette.calls.length).toBeGreaterThan(0);
    const text = JSON.stringify(cassette);
    // The demo-shop's system prompt and the user's messages stay out.
    expect(text).not.toContain('demo-shop:');
    expect(text).not.toContain('önerir misin');
    // The changed answer is what the app got; the cassette keeps the provider's own.
    expect(text).not.toContain('1.169,10');
    // The proxy's records file never holds a cassette's answers.
    expect(readFileSync(proxyLog, 'utf8')).not.toContain('"capture"');
  });

  it('a changed answer fails price-grounded with the origin model, live and on the cassette', () => {
    const { recorded, replayed } = both('serial');
    for (const ran of [recorded, replayed]) {
      const c = ran.results.cases.find((item) => item.id === 'tents-wrong-model-price-tr');
      expect(c?.status).toBe('known-gap');
      const turn = c?.samples[0]?.turns[0];
      expect(turn?.proxy?.calls.map((call) => call.fault)).toEqual([
        undefined,
        { kind: 'answer', applied: true },
      ]);
      const failing = turn?.checks.filter((check) =>
        check.findings.some((finding) => finding.verdict === 'fail'),
      );
      expect(failing?.map((check) => check.check)).toEqual(['price-grounded']);
      expect(failing?.[0]?.findings.find((f) => f.verdict === 'fail')).toMatchObject({
        subject: { kind: 'money', amount: 1169.1 },
        origin: { stage: 'model', call: 1 },
      });
    }
  });

  it('resilience: the cases recorded without a defect pass, and the cassette serves no fault twice', () => {
    expect(resilienceRecorded?.code, resilienceRecorded?.output).toBe(0);
    expect(resilienceRecorded?.results.summary.statuses).toEqual({ pass: 6 });
    // Faults the proxy answers itself never reach the provider, so they aren't in the cassette.
    const kept = Cassette.parse(JSON.parse(readFileSync(cassetteOf('resilience'), 'utf8')));
    expect(kept.calls).toHaveLength(resilienceRecorded?.provider ?? -1);
  });

  it.each(Object.entries(RESILIENCE))(
    'resilience on the cassette, %s: exactly the expected check fails, on exactly the expected cases',
    (defect, expected) => {
      const ran = resilience.get(defect);
      expect(ran?.code, ran?.output).toBe(0);
      expect(ran?.provider).toBe(0);
      expect(ran?.results.run.replay?.diverged).toBe(0);
      expect(ran?.results.cases).toHaveLength(6);
      const wanted = Object.fromEntries(
        Object.entries(expected).map(([check, ids]) => [check, [...ids].toSorted()]),
      );
      expect(failingByCheck(ran?.results)).toEqual(wanted);
      const failed = new Set(Object.values(wanted).flat());
      for (const c of ran?.results.cases ?? [])
        expect(c.status, `${defect} ${c.id}`).toBe(failed.has(c.id) ? 'fail' : 'pass');
    },
  );

  it('a changed prompt diverges: strict replay makes its cases error, and says how many calls', () => {
    expect(strict?.provider).toBe(0);
    const diverged = strict?.results.run.replay?.diverged ?? 0;
    expect(diverged).toBeGreaterThan(0);
    expect(strict?.results.run.issues).toEqual([
      `${String(diverged)} model call(s) had no match in the cassette`,
    ]);
    const affected = (strict?.results.cases ?? []).filter((c) =>
      c.samples.some((sample) =>
        sample.turns.some((turn) => turn.proxy?.calls.some((call) => call.replay?.diverged)),
      ),
    );
    expect(affected.length).toBeGreaterThan(0);
    const recorded = both('serial').recorded.results.cases;
    for (const c of strict?.results.cases ?? []) {
      const before = recorded.find((item) => item.id === c.id)?.status;
      expect(c.status, c.id).toBe(affected.includes(c) ? 'error' : before);
    }
    // A run with a case that couldn't be judged exits with 2.
    expect(strict?.code).toBe(2);
  });

  it('--replay-loose answers a diverged call by position: the cases run as recorded, and the issues count them', () => {
    expect(loose?.code, loose?.output).toBe(0);
    expect(loose?.provider).toBe(0);
    const diverged = loose?.results.run.replay?.diverged ?? 0;
    expect(diverged).toBeGreaterThan(0);
    expect(loose?.results.run.replay?.loose).toBe(true);
    expect(loose?.results.run.issues).toEqual([
      `${String(diverged)} model call(s) had no match in the cassette and were answered by position`,
    ]);
    expect(loose?.results.cases.map((c) => [c.id, c.status])).toEqual(
      both('serial').recorded.results.cases.map((c) => [c.id, c.status]),
    );
  });

  it("the gate doesn't judge a replayed run's latency", async () => {
    const thresholds = join(dir, 'latency.config.yaml');
    writeFileSync(thresholds, 'version: 1\ngate:\n  latencyP95Ms: 60000\n');
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const judge = (name: string) =>
      main(['gate', '--results', join(dir, `${name}.results.json`), '--config', thresholds], io);
    expect(await judge('serial-recorded')).toBe(0);
    expect(await judge('serial-replayed')).toBe(1);
    expect(lines.join('\n')).toContain(
      "latencyP95Ms is set but can't be measured: the run replayed a cassette, so its model answers took no time",
    );
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shops, the proxy and the provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
