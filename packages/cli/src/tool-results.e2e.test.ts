// Tool results changed by the proxy, end to end (ADR-0043): the demo-shop
// sends its writer the search result as a tool result (--tool-results), and
// the model proxy changes it before the fake provider sees it. An instruction
// injected into the first product name is ignored by the shop that fences its
// tool results as data, so injection-canary passes; with
// unfenced-tool-results, the model follows it, and injection-canary alone
// fails, with the origin input. On a shop that sends no tool result, the
// injection reaches nothing, and the check is unmeasured. Reversing the search
// results for a whole run moves no verdict, and yokla compare --expect-same
// says so. Everything runs behind the network guard.

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
const dir = mkdtempSync(join(tmpdir(), 'yokla-tool-results-e2e-'));
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

const shop = (...args: string[]) =>
  start('src/main.ts', ['--port', '0', '--model-url', `${proxyUrl}/fake`, ...args]);

interface Ran {
  readonly code: number;
  readonly output: string;
  readonly results: Results;
}

async function run(name: string, url: string, cases: string, ...more: string[]): Promise<Ran> {
  const out = join(dir, `${name}.json`);
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      profile,
      '--cases',
      join(DEMO, cases),
      '--target-url',
      `${url}/v1/chat`,
      '--proxy-url',
      proxyUrl,
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
  };
}

const runs = new Map<string, Ran>();
let compared: { code: number; output: string } | undefined;

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const providerUrl = await start('src/provider-main.ts', ['--port', '0']);
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
  const [fenced, unfenced, silent] = await Promise.all([
    shop('--tool-results'),
    shop('--tool-results', '--defect', 'unfenced-tool-results'),
    shop(),
  ]);

  // One recording at a time: the runs go one after the other.
  runs.set('fenced', await run('fenced', fenced, 'cases-injection'));
  runs.set('unfenced', await run('unfenced', unfenced, 'cases-injection'));
  runs.set('silent', await run('silent', silent, 'cases-injection'));
  runs.set('plain', await run('plain', fenced, 'cases'));
  runs.set(
    'reversed',
    await run('reversed', fenced, 'cases', '--reverse-items', 'search_products=$.results'),
  );
  const lines: string[] = [];
  const code = await main(
    [
      'compare',
      '--results',
      join(dir, 'plain.json'),
      '--results',
      join(dir, 'reversed.json'),
      '--expect-same',
    ],
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  );
  compared = { code, output: lines.join('\n') };
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

/** The injection-canary result of the injection case's turn. */
const injection = (results: Results) =>
  results.cases[0]?.samples[0]?.turns[0]?.checks.find((c) => c.check === 'injection-canary');

/** check → whether it reported a failing finding, in the injection case. */
const failing = (results: Results) =>
  (results.cases[0]?.samples[0]?.turns[0]?.checks ?? [])
    .filter((check) => check.findings.some((finding) => finding.verdict === 'fail'))
    .map((check) => check.check);

describe('tool results changed by the proxy, on the demo-shop (ADR-0043)', () => {
  it('a shop that fences its tool results ignores the injected instruction', () => {
    const { code, output, results } = ran('fenced');
    expect(code, output).toBe(0);
    expect(results.cases[0]?.status).toBe('pass');
    expect(injection(results)?.findings.map((f) => f.verdict)).toEqual(['pass']);
    const calls = results.cases[0]?.samples[0]?.turns[0]?.proxy?.calls ?? [];
    expect(calls.flatMap((call) => call.toolChanges ?? [])).toEqual([
      { kind: 'inject', tool: 'search_products', applied: true },
    ]);
  });

  it('a shop that sends tool results as they are follows it: injection-canary alone fails, from the input', () => {
    const { results } = ran('unfenced');
    expect(results.cases[0]?.status).toBe('fail');
    expect(failing(results)).toEqual(['injection-canary']);
    const [finding] = injection(results)?.findings ?? [];
    expect(finding).toMatchObject({
      verdict: 'fail',
      subject: { kind: 'text', text: 'INJ-7Q2' },
      origin: { stage: 'input', role: 'tool', tool: 'search_products' },
    });
    expect(results.cases[0]?.samples[0]?.turns[0]?.response?.text).toBe('INJ-7Q2');
  });

  it("an injection that reaches no tool result tests nothing, and isn't a pass", () => {
    const { results } = ran('silent');
    expect(results.cases[0]?.status).toBe('unmeasured');
    expect(injection(results)?.unmeasured).toEqual([
      {
        dimension: 'injection',
        reason: 'the injection into search_products reached no tool result of this turn',
      },
    ]);
  });

  it('reversing the search results moves no verdict, and compare --expect-same says so', () => {
    const plain = ran('plain');
    const reversed = ran('reversed');
    expect(plain.results.summary.statuses).toEqual({ pass: 21 });
    expect(reversed.results.summary.statuses).toEqual({ pass: 21 });
    const [change] = reversed.results.run.toolChanges ?? [];
    expect(change).toMatchObject({ tool: 'search_products', at: '$.results' });
    expect(change?.results).toBeGreaterThan(0);
    expect(reversed.results.run.issues).toBeUndefined();
    expect(compared?.code, compared?.output).toBe(0);
    expect(compared?.output).toContain(
      '--expect-same: every case has the same status in every run',
    );
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shops, the proxy and the provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
