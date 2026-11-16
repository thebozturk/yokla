// yokla explore end to end (ADR-0044): from the demo-shop's acceptance cases,
// with the model over HTTP behind the model proxy, at no model cost. The
// search reaches every route and every tool. On a shop that totals a cart of
// two products 10 % low (cart-total-off), the acceptance cases all pass, and a
// proposed case fails price-grounded on its second cart addition; on the shop
// without the defect, no explored case fails, and two explorations write the
// same cases. Everything runs behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { definitionSha256 } from '@yokla/runtime';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyCommand } from './commands/proxy.ts';
import { loadCases } from './load.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'yokla-explore-e2e-'));
const profile = join(dir, 'yokla.profile.yaml');
// The fake provider's calls are priced, so the cost cap can hold.
const config = join(dir, 'yokla.config.yaml');

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

// A short model timeout: the timeout fault holds a call until the shop gives up.
// No rate limit, on the shop or in the profile: a search makes many requests,
// and header correlation waits for the model calls only once a run, not after
// every turn.
const shop = (...args: string[]) =>
  start('src/main.ts', [
    '--port',
    '0',
    '--model-url',
    `${proxyUrl}/fake`,
    '--model-timeout-ms',
    '300',
    '--rate-limit',
    'off',
    ...args,
  ]);

interface Explored {
  readonly code: number;
  readonly output: string;
  readonly cases: string;
  readonly results: Results;
}

async function exploreShop(name: string, url: string): Promise<Explored> {
  const out = join(dir, `${name}.yaml`);
  const resultsFile = join(dir, `${name}.json`);
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'explore',
      '--profile',
      profile,
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${url}/v1/chat`,
      '--proxy-url',
      proxyUrl,
      '--out',
      out,
      '--results',
      resultsFile,
      '--config',
      config,
      '--max-cost',
      '1',
    ],
    io,
  );
  if (!existsSync(out))
    throw new Error(`yokla explore wrote no cases (${String(code)}):\n${lines.join('\n')}`);
  return {
    code,
    output: lines.join('\n'),
    cases: readFileSync(out, 'utf8'),
    results: Results.parse(JSON.parse(readFileSync(resultsFile, 'utf8'))),
  };
}

const explored = new Map<string, Explored>();

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  writeFileSync(
    config,
    'version: 1\nprices:\n  fake:\n    demo-writer-1: { input: 1, output: 2 }\n',
  );
  const providerUrl = await start('src/provider-main.ts', ['--port', '0']);
  writeFileSync(
    profile,
    `${readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8')
      .replaceAll('./data/', join(DEMO, 'data/'))
      .replace(
        /^ {2}limits:\n(?: {4}.*\n)+/mu,
        '',
      )}\nmodelProxy:\n  port: 1\n  correlation: header\n  upstreams:\n    - { id: fake, kind: openai-compatible, upstream: '${providerUrl}' }\n`,
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
  const [clean, defective] = await Promise.all([shop(), shop('--defect', 'cart-total-off')]);

  // One recording at a time: the explorations go one after the other.
  explored.set('clean', await exploreShop('clean', clean));
  explored.set('again', await exploreShop('again', clean));
  explored.set('defective', await exploreShop('defective', defective));
}, 600_000);

afterAll(async () => {
  stopProxy.abort();
  await proxyDone;
  guard?.uninstall();
  for (const child of children) child.kill();
});

function get(name: string): Explored {
  const found = explored.get(name);
  if (found === undefined) throw new Error(`no ${name} exploration`);
  return found;
}

const ROUTES = ['cart', 'fallback', 'follow-up-cheapest', 'policy', 'product-search', 'refusal'];
const TOOLS = ['add_to_cart', 'cheapest_shown', 'get_policy', 'search_products'];

describe('yokla explore on the demo-shop (ADR-0044)', () => {
  it('reaches every route and every tool, and no explored case fails without the defect', () => {
    const { code, output, results } = get('clean');
    expect(code, output).toBe(0);
    const coverage = results.run.coverage;
    expect(coverage?.routes).toEqual(ROUTES);
    expect(coverage?.tools).toEqual(TOOLS);
    expect(coverage?.added).toEqual(expect.arrayContaining(['route:cart', 'tool:add_to_cart']));
    expect(results.cases.filter((c) => c.status !== 'pass').map((c) => c.id)).toEqual([]);
    expect(output).not.toMatch(/failed /u);
    // The results count the model calls of every run, the candidates that were dropped too.
    const kept = results.cases.flatMap((c) =>
      c.samples.flatMap((sample) => sample.turns.flatMap((turn) => turn.proxy?.calls ?? [])),
    );
    expect(results.run.proxy?.records).toBeGreaterThan(kept.length);
    expect(results.run.proxy?.unattributed).toBe(0);
  });

  it('writes the same cases twice, which load as proposed cases with the definitions it ran', () => {
    const { cases, results } = get('clean');
    expect(get('again').cases).toBe(cases);
    const file = join(dir, 'clean.yaml');
    const loaded = loadCases([file]);
    expect(loaded.length).toBeGreaterThan(0);
    for (const testCase of loaded) {
      expect(testCase.provenance).toMatchObject({ source: 'explore', status: 'proposed' });
      const ran = results.cases.find((c) => c.id === testCase.id);
      expect(ran?.definitionSha256).toBe(definitionSha256(testCase));
    }
  });

  it('finds a wrong cart total that no written case reaches', () => {
    const { code, output, results, cases } = get('defective');
    expect(code, output).toBe(0);
    const written = loadCases([join(DEMO, 'cases')]).map((c) => c.id);
    const seeds = results.cases.filter((c) => written.includes(c.id));
    expect(seeds.map((c) => c.status)).toEqual(written.map(() => 'pass'));
    const [first] = loadCases([join(dir, 'defective.yaml')]);
    expect(first?.provenance?.evidence).toMatch(
      /^yokla explore, cart from cart-\d+: failed price-grounded \(fabrication\) on turn 3/u,
    );
    expect(first?.turns.slice(1).map((turn) => turn.user)).toEqual([
      'Plaj Çadırı ürününü sepete ekler misin?',
      'Kubbe Çadır 2 Kişilik ürününü sepete ekler misin?',
    ]);
    expect(cases).toContain('status: proposed');
    // A timeout fault holds a call as long as yokla waits for the shop: the profile's 30 s.
    expect(cases).toMatch(/kind: timeout\n\s+holdMs: 30000\n/u);
  });
});
