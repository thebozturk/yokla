// Comparing models through the proxy, end to end (ADR-0042): the demo-shop
// asks for demo-writer-1 through `yokla proxy`, and the acceptance cases run
// three times: as the app asks, with the writer swapped to demo-writer-mini,
// and swapped to demo-writer-nano, which invents a price. The fake provider's
// usage log shows which model answered each call. yokla compare then names
// demo-writer-mini as the cheapest run that passes the gate, and shows
// demo-writer-nano's product cases failing price-grounded with the origin
// model. A swap of a model the app never asks for is a run issue. Everything
// runs behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Comparison, Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyCommand } from './commands/proxy.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'yokla-compare-e2e-'));
const usageLog = join(dir, 'provider-usage.jsonl');
const config = join(dir, 'yokla.config.yaml');
const profile = join(dir, 'yokla.profile.yaml');

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
const stopProxy = new AbortController();
let proxyDone: Promise<number> | undefined;
let proxyUrl = '';

/** Starts a demo-shop script and resolves with the first URL it prints. */
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

/** The models the fake provider answered, in order. */
function answered(): string[] {
  return readFileSync(usageLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => String(Reflect.get(Object(JSON.parse(line)), 'model')));
}

interface Ran {
  readonly code: number;
  readonly output: string;
  readonly results: Results;
  readonly path: string;
  /** The models the provider answered during the run. */
  readonly models: readonly string[];
}

let shop = '';
async function run(name: string, ...swaps: string[]): Promise<Ran> {
  const before = answered().length;
  const path = join(dir, `${name}.json`);
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      profile,
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${shop}/v1/chat`,
      '--proxy-url',
      proxyUrl,
      '--config',
      config,
      '--out',
      path,
      ...swaps.flatMap((swap) => ['--swap-model', swap]),
    ],
    io,
  );
  return {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(path, 'utf8'))),
    path,
    models: answered().slice(before),
  };
}

const runs = new Map<string, Ran>();
let compared: { code: number; output: string; comparison: Comparison } | undefined;

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  writeFileSync(usageLog, '');
  // Prices fall from the app's own writer to the one that invents prices.
  writeFileSync(
    config,
    [
      'version: 1',
      'prices:',
      '  fake:',
      '    demo-writer-1: { input: 3, output: 6 }',
      '    demo-writer-mini: { input: 1, output: 2 }',
      '    demo-writer-nano: { input: 0.25, output: 0.5 }',
      '',
    ].join('\n'),
  );
  const providerUrl = await start('src/provider-main.ts', ['--port', '0', '--usage-log', usageLog]);
  writeFileSync(
    profile,
    `${readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll('./data/', join(DEMO, 'data/'))}\nmodelProxy:\n  port: 1\n  correlation: serial\n  upstreams:\n    - { id: fake, kind: openai-compatible, upstream: '${providerUrl}' }\n`,
  );
  const proxyLines: string[] = [];
  proxyDone = proxyCommand(
    ['--profile', profile, '--port', '0'],
    { out: (line) => proxyLines.push(line), err: (line) => proxyLines.push(line) },
    stopProxy.signal,
  );
  for (let i = 0; i < 200 && proxyUrl === ''; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    proxyUrl = /http:\/\/127\.0\.0\.1:\d+/u.exec(proxyLines[0] ?? '')?.[0] ?? '';
  }
  if (proxyUrl === '') throw new Error(`yokla proxy didn't start:\n${proxyLines.join('\n')}`);
  ports.add(Number(new URL(proxyUrl).port));
  shop = await start('src/main.ts', ['--port', '0', '--model-url', `${proxyUrl}/fake`]);

  // One recording at a time: the runs go one after the other.
  runs.set('as-is', await run('as-is'));
  runs.set('mini', await run('mini', 'fake:demo-writer-1=demo-writer-mini'));
  runs.set('nano', await run('nano', 'fake:demo-writer-1=demo-writer-nano'));
  runs.set('unused', await run('unused', 'fake:demo-writer-9=demo-writer-mini'));

  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const out = join(dir, 'comparison.json');
  const code = await main(
    [
      'compare',
      ...['as-is', 'mini', 'nano'].flatMap((name) => ['--results', join(dir, `${name}.json`)]),
      '--config',
      config,
      '--json',
      out,
    ],
    io,
  );
  compared = {
    code,
    output: lines.join('\n'),
    comparison: Comparison.parse(JSON.parse(readFileSync(out, 'utf8'))),
  };
}, 600_000);

afterAll(async () => {
  stopProxy.abort();
  await proxyDone;
  guard?.uninstall();
  for (const child of children) child.kill();
});

function ran(name: string): Ran {
  const found = runs.get(name);
  if (found === undefined) throw new Error(`no ${name} run`);
  return found;
}

const calls = (results: Results) =>
  results.cases.flatMap((c) =>
    c.samples.flatMap((sample) => sample.turns.flatMap((turn) => turn.proxy?.calls ?? [])),
  );

describe('comparing models through the proxy, on the demo-shop (ADR-0042)', () => {
  it('as the app asks: every call goes to demo-writer-1, and every case passes', () => {
    const { code, output, results, models } = ran('as-is');
    expect(code, output).toBe(0);
    expect(results.summary.statuses).toEqual({ pass: 21 });
    expect(new Set(models)).toEqual(new Set(['demo-writer-1']));
    expect(results.run.swaps).toBeUndefined();
    expect(calls(results).every((call) => call.asked === undefined)).toBe(true);
  });

  it('swapped: the provider answers with the other model, and each call keeps the one asked for', () => {
    const { code, output, results, models } = ran('mini');
    expect(code, output).toBe(0);
    expect(results.summary.statuses).toEqual({ pass: 21 });
    expect(new Set(models)).toEqual(new Set(['demo-writer-mini']));
    const swapped = calls(results);
    expect(swapped.length).toBe(models.length);
    for (const call of swapped) {
      expect([call.asked, call.model]).toEqual(['demo-writer-1', 'demo-writer-mini']);
    }
    expect(results.run.swaps).toEqual([
      { upstream: 'fake', asked: 'demo-writer-1', model: 'demo-writer-mini', calls: models.length },
    ]);
    expect(results.run.issues).toBeUndefined();
  });

  it('swapped to the model that invents a price: the product cases fail price-grounded, from the model', () => {
    const { results, models } = ran('nano');
    expect(new Set(models)).toEqual(new Set(['demo-writer-nano']));
    const failing = results.cases.filter((c) => c.status === 'fail');
    expect(failing).toHaveLength(12);
    const findings = failing
      .flatMap((c) => c.samples.flatMap((sample) => sample.turns))
      .flatMap((turn) => turn.checks)
      .filter((check) => check.findings.some((finding) => finding.verdict === 'fail'));
    expect(new Set(findings.map((check) => check.check))).toEqual(new Set(['price-grounded']));
    expect(
      new Set(
        findings
          .flatMap((check) => check.findings)
          .flatMap((f) => (f.verdict === 'fail' ? [f.origin?.stage] : [])),
      ),
    ).toEqual(new Set(['model']));
  });

  it('a swap of a model the app never asks for changes nothing, and says so', () => {
    const { results, models } = ran('unused');
    expect(new Set(models)).toEqual(new Set(['demo-writer-1']));
    expect(results.run.swaps).toEqual([
      { upstream: 'fake', asked: 'demo-writer-9', model: 'demo-writer-mini', calls: 0 },
    ]);
    expect(results.run.issues).toEqual([
      'the swap of fake:demo-writer-9 changed no call: the app may ask for another model',
    ]);
  });

  it('compare names demo-writer-mini the cheapest run that passes the gate', () => {
    expect(compared?.code, compared?.output).toBe(0);
    const comparison = compared?.comparison;
    expect(comparison?.runs.map((r) => [r.label, r.gate.verdict])).toEqual([
      ['as the app asks', 'pass'],
      ['fake: demo-writer-1 → demo-writer-mini', 'pass'],
      ['fake: demo-writer-1 → demo-writer-nano', 'broken'],
    ]);
    const [asIs, mini, nano] = comparison?.runs ?? [];
    expect(comparison?.cheapest).toEqual({ runs: [mini?.id], costUsd: mini?.costUsd });
    // The prices fall from one model to the next, and so does what each run cost.
    expect(asIs?.costUsd ?? 0).toBeGreaterThan(mini?.costUsd ?? Infinity);
    expect(mini?.costUsd ?? 0).toBeGreaterThan(nano?.costUsd ?? Infinity);
    // The cases nano failed come first, and only they differ.
    const differing = comparison?.cases.filter((c) => c.differs) ?? [];
    expect(differing).toHaveLength(12);
    for (const c of differing) expect(c.statuses).toEqual(['pass', 'pass', 'fail']);
    expect(comparison?.cases.slice(0, 12)).toEqual(differing);
    expect(compared?.output).toContain(
      'cheapest passing run: B (fake: demo-writer-1 → demo-writer-mini)',
    );
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shop, the proxy and the provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
