// The model proxy end to end (ADR-0012, design §20 v0.2): the demo-shop calls
// the fake provider through `yokla proxy`, and what the proxy measured must
// reconcile with the provider's own usage records, call for call and token
// for token. One run correlates serially with JSON answers, the other by
// header with event streams. Then the resilience cases run against a
// demo-shop for each resilience defect (ADR-0013). Everything runs behind the
// network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyCommand } from './commands/proxy.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'yokla-proxy-e2e-'));
const usageLog = join(dir, 'provider-usage.jsonl');
const proxyLog = join(dir, 'proxy-records.jsonl');

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
const stopProxy = new AbortController();
let proxyDone: Promise<number> | undefined;

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

interface UsageEntry {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

function usageEntries(): UsageEntry[] {
  return readFileSync(usageLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): UsageEntry => {
      const value: unknown = JSON.parse(line);
      const read = (key: string) => Number(Reflect.get(Object(value), key));
      return { promptTokens: read('promptTokens'), completionTokens: read('completionTokens') };
    });
}

const PRICES = { input: 1, output: 2 };
let proxyUrl = '';
let serialShop = '';
let headerShop = '';

/** The demo-shop profile with its data paths made absolute and a model proxy added. */
function profileFor(correlation: 'serial' | 'header', providerUrl: string): string {
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

const runs = new Map<
  string,
  { code: number; output: string; results: Results; before: number; after: number }
>();

async function run(correlation: 'serial' | 'header', shop: string, providerUrl: string) {
  const out = join(dir, `${correlation}.results.json`);
  const config = join(dir, 'yokla.config.yaml');
  writeFileSync(
    config,
    `version: 1\nprices:\n  fake:\n    demo-writer-1: { input: ${String(PRICES.input)}, output: ${String(PRICES.output)} }\n`,
  );
  const before = usageEntries().length;
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      profileFor(correlation, providerUrl),
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${shop}/v1/chat`,
      '--proxy-url',
      proxyUrl,
      '--config',
      config,
      '--out',
      out,
    ],
    io,
  );
  runs.set(correlation, {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    before,
    after: usageEntries().length,
  });
}

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
const resilience = new Map<string, Results>();

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

async function runResilience(defect: string, providerUrl: string): Promise<void> {
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    '--model-url',
    `${proxyUrl}/fake`,
    '--model-timeout-ms',
    '300',
    '--defect',
    defect,
  ]);
  const out = join(dir, `resilience-${defect}.json`);
  const quiet = { out: () => undefined, err: () => undefined };
  const code = await main(
    [
      'run',
      '--profile',
      profileFor('serial', providerUrl),
      '--cases',
      join(DEMO, 'cases-resilience'),
      '--target-url',
      `${shop}/v1/chat`,
      '--proxy-url',
      proxyUrl,
      '--out',
      out,
    ],
    quiet,
  );
  expect(code, defect).toBe(0);
  resilience.set(defect, Results.parse(JSON.parse(readFileSync(out, 'utf8'))));
}

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  writeFileSync(usageLog, '');
  const providerUrl = await start('src/provider-main.ts', ['--port', '0', '--usage-log', usageLog]);
  const proxyLines: string[] = [];
  proxyDone = proxyCommand(
    ['--profile', profileFor('serial', providerUrl), '--port', '0', '--records', proxyLog],
    { out: (line) => proxyLines.push(line), err: (line) => proxyLines.push(line) },
    stopProxy.signal,
  );
  for (let i = 0; i < 200 && proxyUrl === ''; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    proxyUrl = /http:\/\/127\.0\.0\.1:\d+/u.exec(proxyLines[0] ?? '')?.[0] ?? '';
  }
  if (proxyUrl === '') throw new Error(`yokla proxy didn't start:\n${proxyLines.join('\n')}`);
  ports.add(Number(new URL(proxyUrl).port));
  [serialShop, headerShop] = await Promise.all([
    start('src/main.ts', ['--port', '0', '--model-url', `${proxyUrl}/fake`]),
    start('src/main.ts', ['--port', '0', '--model-url', `${proxyUrl}/fake`, '--model-stream']),
  ]);
  // One recording at a time: the runs go one after the other.
  await run('serial', serialShop, providerUrl);
  await run('header', headerShop, providerUrl);
  for (const defect of Object.keys(RESILIENCE)) await runResilience(defect, providerUrl);
}, 180_000);

afterAll(async () => {
  stopProxy.abort();
  await proxyDone;
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('the model proxy against the demo-shop', () => {
  it.each(['serial', 'header'])(
    '%s: the acceptance still passes with the model over HTTP',
    (name) => {
      const result = runs.get(name);
      expect(result?.code, result?.output).toBe(0);
      expect(result?.results.summary.statuses).toEqual({ pass: 18 });
      expect(result?.results.run.correlation).toBe(name);
    },
  );

  it.each(['serial', 'header'])(
    "%s: the proxy's measurement reconciles with the provider's records",
    (name) => {
      const result = runs.get(name);
      const before = result?.before ?? 0;
      const after = result?.after ?? 0;
      const provider = usageEntries().slice(before, after);
      const input = provider.reduce((total, entry) => total + entry.promptTokens, 0);
      const output = provider.reduce((total, entry) => total + entry.completionTokens, 0);
      expect(provider.length).toBeGreaterThan(0);
      expect(result?.results.run.proxy).toEqual({
        correlation: name,
        records: provider.length,
        attributed: provider.length,
        unattributed: 0,
        totals: {
          calls: provider.length,
          inputTokens: input,
          outputTokens: output,
          costUsd: expect.closeTo(
            (input * PRICES.input + output * PRICES.output) / 1e6,
            12,
          ) as unknown,
        },
        missing: {
          cachedInputTokens: provider.length,
          cacheWriteTokens: provider.length,
          reasoningTokens: provider.length,
        },
      });
    },
  );

  it.each(['serial', 'header'])('%s: every answered turn has its two model calls', (name) => {
    const turns =
      runs.get(name)?.results.cases.flatMap((c) => c.samples.flatMap((s) => s.turns)) ?? [];
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      expect(turn.proxy?.calls, turn.user).toHaveLength(2);
      expect(turn.proxy?.calls.every((call) => call.stream === (name === 'header'))).toBe(true);
      // Header correlation names each turn's trace; serial correlation has none.
      expect(turn.proxy?.trace === undefined).toBe(name === 'serial');
    }
  });

  it('wrote every recorded call to the --records file', () => {
    const lines = readFileSync(proxyLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    const recorded = [
      ...[...runs.values()].map((done) => done.results),
      ...resilience.values(),
    ].reduce((total, results) => total + (results.run.proxy?.records ?? 0), 0);
    expect(lines).toHaveLength(recorded);
    expect(lines.join('\n')).not.toMatch(/authorization|demo-key/iu);
  });

  it.each(Object.entries(RESILIENCE))(
    'resilience, %s: exactly the expected check fails, on exactly the expected cases',
    (defect, expected) => {
      const results = resilience.get(defect);
      expect(results?.cases).toHaveLength(6);
      const wanted = Object.fromEntries(
        Object.entries(expected).map(([check, ids]) => [check, [...ids].toSorted()]),
      );
      expect(failingByCheck(results)).toEqual(wanted);
      const failed = new Set(Object.values(wanted).flat());
      for (const c of results?.cases ?? [])
        expect(c.status, `${defect} ${c.id}`).toBe(failed.has(c.id) ? 'fail' : 'pass');
    },
  );

  it('resilience: the faults reached the provider only when they had to', () => {
    const calls = (resilience.get('none')?.cases ?? []).map((c) => ({
      id: c.id,
      calls: c.samples[0]?.turns[0]?.proxy?.calls.map((call) => call.fault?.kind ?? 'none'),
    }));
    expect(calls).toEqual([
      { id: 'provider-503-once', calls: ['status', 'none', 'none'] },
      { id: 'provider-down', calls: ['status'] },
      { id: 'provider-stalls', calls: ['timeout'] },
      { id: 'empty-model-output', calls: ['none', 'empty-content'] },
      { id: 'malformed-interpretation', calls: ['malformed-json'] },
      { id: 'slow-provider', calls: ['latency', 'latency'] },
    ]);
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shops, the proxy and the provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
