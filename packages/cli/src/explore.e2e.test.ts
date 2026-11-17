// yokla explore end to end (ADR-0044): from the demo-shop's acceptance cases,
// with the model over HTTP behind the model proxy, at no model cost. The
// search reaches every route and every tool. On a shop that totals a cart of
// two products 10 % low (cart-total-off), the acceptance cases all pass, and a
// proposed case fails price-grounded on its second cart addition; on the shop
// without the defect, no explored case fails, and two explorations write the
// same cases. Its opening turns spread over the catalog's types and state the
// type and price bound they ask (ADR-0046): on a shop that drops the price
// bound for sleeping bags, a type no written case asks about, a proposed case
// fails filter-honoured-or-disclosed. Every candidate that ran is in the trace.
// A type is asked by its catalog label where the profile maps one (ADR-0050):
// with it, a sleeping bag filed under a size level is asked as a sleeping
// bag; without it, by the size.
// Everything runs behind the network guard.

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
// The same profile without the catalog's type labels.
const unlabelledProfile = join(dir, 'unlabelled.profile.yaml');
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

function exploreShop(name: string, url: string, ...extra: string[]): Promise<Explored> {
  return exploreWith(profile, name, url, ...extra);
}

async function exploreWith(
  profileFile: string,
  name: string,
  url: string,
  ...extra: string[]
): Promise<Explored> {
  const out = join(dir, `${name}.yaml`);
  const resultsFile = join(dir, `${name}.json`);
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'explore',
      '--profile',
      profileFile,
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
      ...extra,
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
  const labelLine = /^ {6}typeLabel: .*\n/mu;
  const labelled = readFileSync(profile, 'utf8');
  if (!labelLine.test(labelled)) throw new Error('the demo-shop profile maps no type label');
  writeFileSync(unlabelledProfile, labelled.replace(labelLine, ''));
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
  const [clean, defective, bound, coded] = await Promise.all([
    shop(),
    shop('--defect', 'cart-total-off'),
    shop('--defect', 'type-bound-ignored'),
    shop('--defect', 'currency-code-ignored'),
  ]);

  // One recording at a time: the explorations go one after the other.
  explored.set('clean', await exploreShop('clean', clean));
  explored.set('again', await exploreShop('again', clean));
  explored.set('defective', await exploreShop('defective', defective));
  // Round-robin over the branches, sleeping bags are the camping branch's second type: the
  // seventh (ADR-0046).
  explored.set('bound', await exploreShop('bound', bound, '--types', '7'));
  // The kids' sleeping bags are the camping branch's fourth type: the tenth (ADR-0050).
  const reach = ['--types', '10', '--max-runs', '50'];
  explored.set('labelled', await exploreShop('labelled', clean, ...reach));
  explored.set('unlabelled', await exploreWith(unlabelledProfile, 'unlabelled', clean, ...reach));
  explored.set('coded', await exploreShop('coded', coded));
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
  it('finds a price bound dropped for a type no written case asks about (ADR-0046)', () => {
    const { code, output, results } = get('bound');
    expect(code, output).toBe(0);
    const written = loadCases([join(DEMO, 'cases')]);
    expect(
      written.some((c) => c.turns.some((turn) => /uyku tulum|sleeping bag/iu.test(turn.user))),
    ).toBe(false);
    const seeds = results.cases.filter((c) => written.some((w) => w.id === c.id));
    expect(seeds.map((c) => c.status)).toEqual(written.map(() => 'pass'));
    const failing = loadCases([join(dir, 'bound.yaml')]).filter((c) =>
      /failed /u.test(c.provenance?.evidence ?? ''),
    );
    expect(failing.map((c) => [c.id, c.turns.map((turn) => turn.user)])).toEqual([
      ['under-price-1', ['1849 TL altında uyku tulumu var mı?']],
      ['empty-band-1', ['749 TL altında uyku tulumu var mı?']],
      ['under-price-2', ['Do you have any sleeping bag under 1849 TRY?']],
      ['empty-band-2', ['Do you have any sleeping bag under 749 TRY?']],
    ]);
    expect(failing[0]?.provenance?.evidence).toBe(
      'yokla explore, under-price from an opening turn: failed filter-honoured-or-disclosed (filter-honesty) on turn 1; expects type "uyku tulumu" (2 catalog types) at most 1849, its median price',
    );
    expect(failing[0]?.turns[0]?.expect).toEqual({
      productType: ['outdoor/camping/sleeping-bag', 'outdoor/camping/sleeping-bag/junior'],
      filters: { maxPrice: 1849 },
    });
    // At the default six types, the search doesn't ask about sleeping bags.
    const clean = get('clean').results.run.exploration?.candidates ?? [];
    expect(
      clean.some((entry) => entry.messages.some((m) => /uyku tulumu|sleeping bag/u.test(m))),
    ).toBe(false);
  });

  it('asks for a type by its catalog label, and by its last level without one (ADR-0050)', () => {
    const asked = (name: string) =>
      (get(name).results.run.exploration?.candidates ?? [])
        .filter((entry) => entry.from === null && entry.operator === 'type')
        .map((entry) => entry.messages[0]);
    // With the label, the kids' bags are sleeping bags: asked with the others, never by size.
    // Fifty runs reach the Turkish openings of all ten types.
    expect(asked('labelled')).toContain('uyku tulumu var mı?');
    expect(asked('labelled').filter((m) => m?.includes('junior') === true)).toEqual([]);
    const labelled = loadCases([join(dir, 'labelled.yaml')]);
    expect(labelled.filter((c) => /failed /u.test(c.provenance?.evidence ?? ''))).toEqual([]);
    const bagTurns = (get('labelled').results.run.exploration?.candidates ?? []).filter((entry) =>
      /uyku tulumu|sleeping bag/u.test(entry.messages[0] ?? ''),
    );
    expect(bagTurns.length).toBeGreaterThan(0);
    expect(bagTurns.flatMap((entry) => entry.failed)).toEqual([]);
    // Without it, the size is the words asked.
    expect(asked('unlabelled')).toContain('junior var mı?');
    expect(asked('unlabelled')).toContain('sleeping bag var mı?');
  });

  it('asks for trekking poles as a shopper would, which two branches of the catalog hold (ADR-0048)', () => {
    const trace = get('clean').results.run.exploration?.candidates ?? [];
    const poles = trace.filter((entry) => entry.messages[0]?.includes('trekking pole') === true);
    // Both types are one type to a shopper: asked once per language and intent, and passed.
    expect(poles.map((entry) => [entry.operator, entry.messages[0], entry.failed])).toEqual([
      ['type', 'trekking pole var mı?', []],
      ['under-price', '1000 TL altında trekking pole var mı?', []],
      ['empty-band', '649 TL altında trekking pole var mı?', []],
      ['type', 'Do you have any trekking pole?', []],
      ['under-price', 'Do you have any trekking pole under 1000 TRY?', []],
      ['empty-band', 'Do you have any trekking pole under 649 TRY?', []],
    ]);
    // One Turkish turn writes the currency code; English has no other word for the lira.
    expect(
      trace.filter((entry) => entry.operator === 'currency-code').map((entry) => entry.messages),
    ).toEqual([['900 TRY altında backpack var mı?']]);
  });

  it('finds a bound dropped when written with the currency code, at the lower quartile (ADR-0052)', () => {
    const { code, output } = get('coded');
    expect(code, output).toBe(0);
    const failing = loadCases([join(dir, 'coded.yaml')]).filter((c) =>
      /failed /u.test(c.provenance?.evidence ?? ''),
    );
    const messages = failing.map((c) => c.turns[0]?.user ?? '');
    // The Turkish code turn fails; at the median it would pass, the shop's three
    // cheapest backpacks costing less.
    expect(messages).toContain('900 TRY altında backpack var mı?');
    expect(failing.find((c) => c.id.startsWith('currency-code'))?.provenance?.evidence).toMatch(
      /failed filter-honoured-or-disclosed .* at most 900, its lower quartile price, with the currency code TRY$/u,
    );
    // English has no other word for the lira: its bounds are written with the code too.
    // Every failure is a bound written with the code.
    expect(messages.filter((m) => !m.includes(' TRY'))).toEqual([]);
  });

  it('traces every candidate it ran, the same way twice', () => {
    const { output, results } = get('clean');
    const trace = results.run.exploration?.candidates ?? [];
    const ran = Number(/(\d+) candidates run/u.exec(output)?.[1]);
    expect(trace).toHaveLength(ran);
    expect(get('again').results.run.exploration).toEqual(results.run.exploration);
    // Openings first: six types in two languages, each by the type and under two bounds.
    const openings = trace.filter((entry) => entry.from === null);
    expect(
      openings.filter((entry) => ['type', 'under-price', 'empty-band'].includes(entry.operator)),
    ).toHaveLength(36);
    const kept = new Set(results.cases.map((c) => c.id));
    const keptIds = trace.flatMap((entry) => (entry.kept === null ? [] : [entry.kept]));
    expect(keptIds.filter((id) => !kept.has(id))).toEqual([]);
    expect(trace.filter((entry) => entry.routes.length !== entry.messages.length)).toEqual([]);
  });
});
