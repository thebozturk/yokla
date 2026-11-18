// The analyzer, deterministic first, end to end (ADR-0047): yokla analyze
// reads a copy of the demo-shop's repository and probes the demo-shop in
// process, with the request of its hand-written profile. Its proposal is
// compared with that profile, which it never reads: every entry it proposes
// is the hand-written one, and what it misses is what code, docs and prompts
// must give a later step. A proposed profile doesn't run; an approved one
// loads. Two analyses write the same file. Behind the network guard.
//
// With models.analyzer on the fake provider (ADR-0049), a model also reads the
// docs and code: it adds the rate limits, the cache bypass and the canonical
// refusals, each checked against the line it quotes, and the limit it invents
// is dropped. A second analysis answers from the cache. At no model cost.

import { spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Analysis, toJson, unapprovedEntries } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProfile } from './load.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'yokla-analyze-e2e-'));
const repo = join(work, 'demo-shop');

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
let shopUrl = '';

const KEY_ENV = 'YOKLA_ANALYZE_E2E_KEY';
const usageLog = join(work, 'provider-usage.jsonl');
const config = join(work, 'yokla.config.yaml');
// A maxTokens too small for a reply that holds entries (ADR-0051).
const smallConfig = join(work, 'yokla.config.small.yaml');

/** Starts a demo-shop script and resolves with the first URL it prints, without /v1. */
function start(script: string, args: string[]): Promise<string> {
  const child = spawn(process.execPath, [join(DEMO, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
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

const startShop = () => start('src/main.ts', ['--port', '0', '--rate-limit', 'off']);

/** The model calls the fake provider answered. */
const providerCalls = () =>
  readFileSync(usageLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;

interface Ran {
  readonly code: number;
  readonly output: string;
}

async function cli(...args: string[]): Promise<Ran> {
  const lines: string[] = [];
  const code = await main(args, {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  return { code, output: lines.join('\n') };
}

// A copy whose contract requires a field the answers lack (ADR-0057).
const staleRepo = join(work, 'stale-shop');
let stale: Ran | undefined;

// A copy without its data, which is given from beside it (ADR-0065).
const outside = join(work, 'outside');
const outsideRepo = join(outside, 'demo-shop');
const outsideProposal = join(outside, 'yokla.profile.proposed.yaml');
let fromOutside: Ran | undefined;

const analyzeIn = (dir: string, out: string, json: string, ...more: string[]) =>
  cli(
    'analyze',
    '--dir',
    dir,
    '--url',
    `${shopUrl}/v1/chat`,
    '--body',
    '{"message": "{{message}}", "sessionId": "{{session}}"}',
    '--header',
    'content-type: application/json',
    '--out',
    out,
    '--json',
    json,
    ...more,
  );

const analyze = (out: string, json: string, ...more: string[]) =>
  analyzeIn(repo, out, json, ...more);

let first: Ran | undefined;
let second: Ran | undefined;
let firstText = '';
const proposal = join(repo, 'yokla.profile.proposed.yaml');
// The model step's runs (ADR-0049).
const withModel = join(repo, 'yokla.profile.model.yaml');
let estimated: Ran | undefined;
let uncapped: Ran | undefined;
let modelled: Ran | undefined;
let callsAfterFirst = 0;
let cachedRun: Ran | undefined;
let modelText = '';
// The run whose maxTokens cuts the replies that hold entries (ADR-0051).
const cutOut = join(repo, 'yokla.profile.cut.yaml');
let cutRun: Ran | undefined;
let callsAfterCut = 0;
let cachedAfterCut = 0;

beforeAll(async () => {
  // A copy of the repository, so the proposal can be written next to its data.
  cpSync(DEMO, repo, {
    recursive: true,
    filter: (path) => !/(?:node_modules|dist|tsbuildinfo)$/u.test(path),
  });
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  writeFileSync(usageLog, '');
  const [shop, provider] = await Promise.all([
    startShop(),
    start('src/provider-main.ts', ['--port', '0', '--usage-log', usageLog]),
  ]);
  shopUrl = shop;
  first = await analyze(proposal, join(work, 'analysis.json'));
  firstText = readFileSync(proposal, 'utf8');
  second = await analyze(proposal, join(work, 'again.json'), '--force');
  cpSync(repo, staleRepo, { recursive: true });
  const contractPath = join(staleRepo, 'openapi.json');
  writeFileSync(
    contractPath,
    readFileSync(contractPath, 'utf8').replace(
      '"required": ["answer", "products", "metadata"]',
      '"required": ["answer", "products", "metadata", "currencyCode"]',
    ),
  );
  stale = await analyzeIn(
    staleRepo,
    join(staleRepo, 'yokla.profile.proposed.yaml'),
    join(work, 'stale.json'),
    '--force',
  );
  const repoData = join(repo, 'data');
  cpSync(repo, outsideRepo, {
    recursive: true,
    filter: (path) => path !== repoData && !path.startsWith(`${repoData}${sep}`),
  });
  mkdirSync(join(outside, 'data'));
  for (const file of ['catalog.jsonl', 'faq.jsonl']) {
    cpSync(join(repoData, file), join(outside, 'data', file));
  }
  fromOutside = await analyzeIn(
    outsideRepo,
    outsideProposal,
    join(work, 'outside.json'),
    '--data',
    join(outside, 'data', 'catalog.jsonl'),
    '--data',
    join(outside, 'data', 'faq.jsonl'),
  );

  const configText = (maxTokens: number) =>
    [
      'version: 1',
      'models:',
      '  analyzer:',
      '    kind: openai-compatible',
      `    url: ${provider}/v1`,
      '    model: demo-analyzer-1',
      `    apiKeyEnv: ${KEY_ENV}`,
      `    maxTokens: ${String(maxTokens)}`,
      '    price: { input: 0.1, output: 0.5 }',
      '',
    ].join('\n');
  writeFileSync(config, configText(2000));
  writeFileSync(smallConfig, configText(20));
  process.env[KEY_ENV] = 'demo-key';
  estimated = await analyze(
    withModel,
    join(work, 'estimate.json'),
    '--config',
    config,
    '--estimate',
  );
  uncapped = await analyze(withModel, join(work, 'uncapped.json'), '--config', config);
  cutRun = await analyze(
    cutOut,
    join(work, 'cut.json'),
    '--config',
    smallConfig,
    '--max-cost',
    '1',
  );
  callsAfterCut = providerCalls();
  cachedAfterCut = readdirSync(join(repo, 'yokla-data', 'analyzer')).length;
  modelled = await analyze(
    withModel,
    join(work, 'model.json'),
    '--config',
    config,
    '--max-cost',
    '1',
  );
  callsAfterFirst = providerCalls();
  modelText = readFileSync(withModel, 'utf8');
  cachedRun = await analyze(
    withModel,
    join(work, 'cached.json'),
    '--config',
    config,
    '--max-cost',
    '1',
    '--force',
  );
}, 120_000);

afterAll(() => {
  Reflect.deleteProperty(process.env, KEY_ENV);
  guard?.uninstall();
  for (const child of children) child.kill();
});

const report = () => Analysis.parse(JSON.parse(readFileSync(join(work, 'analysis.json'), 'utf8')));
const pointers = (entries: readonly { pointer: string }[]) => entries.map((entry) => entry.pointer);

describe('yokla analyze on the demo-shop (ADR-0047)', () => {
  it('writes a proposal and an analysis report', () => {
    expect(first?.code, first?.output).toBe(0);
    expect(first?.output).toContain('probing ');
    expect(first?.output).toContain('precision 100.0%, recall 71.0%');
  });

  it("proposes only the hand-written profile's entries", () => {
    const { comparison } = report();
    expect(comparison?.different).toEqual([]);
    expect(comparison?.new).toEqual([]);
    const same = pointers(comparison?.same ?? []);
    // The contract, from openapi.json and kept by every answer (ADR-0057, ADR-0058).
    const contract = same.filter((pointer) => pointer.startsWith('/target/response/schema/'));
    expect(contract).toHaveLength(19);
    expect(contract).toContain('/target/response/schema/at');
    expect(same.filter((pointer) => !contract.includes(pointer))).toEqual([
      '/target/response/text',
      '/target/response/route',
      '/target/response/evidence/products/items',
      '/target/response/evidence/products/fields/id',
      '/target/response/evidence/products/fields/category',
      '/target/response/evidence/products/fields/name',
      '/target/response/evidence/products/fields/price',
      '/target/response/evidence/products/fields/currency',
      '/target/response/evidence/products/fields/stock',
      '/target/response/evidence/products/fields/color',
      '/target/response/evidence/cart/items',
      '/target/response/evidence/cart/fields/id',
      '/target/response/evidence/cart/fields/name',
      '/target/session/mode',
      '/languages',
      '/domain',
      '/ecommerce/catalog/kind',
      '/ecommerce/catalog/path',
      '/ecommerce/catalog/fields/id',
      '/ecommerce/catalog/fields/type',
      '/ecommerce/catalog/fields/price',
      '/ecommerce/catalog/fields/currency',
      '/ecommerce/catalog/fields/stock',
      '/ecommerce/catalog/fields/name/tr',
      '/ecommerce/catalog/fields/name/en',
      '/ecommerce/typeSeparator',
      '/ecommerce/policies/returns/source',
      '/ecommerce/policies/returns/path',
      '/ecommerce/policies/shipping/source',
      '/ecommerce/policies/warranty/source',
    ]);
    expect(comparison?.precision).toBe(1);
  });

  it('misses what code, docs and prompts must give, and the sizes the probed type lacks', () => {
    const missed = pointers(report().comparison?.missed ?? []);
    const groups = [
      ...new Set(
        missed.map((pointer) =>
          pointer.startsWith('/target/response/schema/') ? '/target/response/schema' : pointer,
        ),
      ),
    ];
    expect(groups).toEqual([
      '/target/response/evidence/products/fields/size',
      '/target/response/evidence/products/fields/gender',
      '/target/limits/burstPerSecond',
      '/target/limits/perMinute',
      '/target/cacheBypass/kind',
      '/target/cacheBypass/name',
      '/target/cacheBypass/value',
      '/everyAnswer/notMatches',
      '/capabilities/0/id',
      '/capabilities/0/description',
      '/capabilities/1/id',
      '/capabilities/1/description',
      '/refusal/canonical/tr',
      '/refusal/canonical/en',
      '/ecommerce/neverFabricate',
      // No step proposes a catalog's type labels yet (ADR-0050).
      '/ecommerce/catalog/fields/typeLabel/tr',
      '/ecommerce/catalog/fields/typeLabel/en',
      // Nor the catalog's attributes, which yokla generate asks by (ADR-0055).
      '/ecommerce/catalog/fields/attributes/size',
      '/ecommerce/catalog/fields/attributes/color',
      '/ecommerce/catalog/fields/attributes/gender',
    ]);
    expect(missed).toHaveLength(20);
    expect(report().comparison?.recall).toBeCloseTo(49 / 69, 12);
  });

  it("never lists the profile it is measured against, the cases or yokla's configuration", () => {
    const { inventory } = report();
    expect(
      inventory.files.map((file) => file.path).filter((path) => /yokla\.|cases/u.test(path)),
    ).toEqual([]);
    expect(inventory.skipped).toBeGreaterThanOrEqual(10);
    expect(inventory.files.find((file) => file.path === 'data/catalog.jsonl')?.kind).toBe('data');
    expect(report().probes.map((probe) => probe.status)).toEqual([200, 200, 200]);
  });

  it("doesn't run the proposal until a person approves it", async () => {
    const refused = await cli(
      'run',
      '--profile',
      proposal,
      '--target-url',
      `${shopUrl}/v1/chat`,
      '--out',
      join(work, 'refused.json'),
    );
    expect(refused.code).toBe(2);
    expect(refused.output).toContain('entries are not approved');
    const approved = join(repo, 'approved.profile.yaml');
    writeFileSync(
      approved,
      readFileSync(proposal, 'utf8').replaceAll('status: proposed', 'status: approved'),
    );
    const loaded = loadProfile(approved);
    expect(unapprovedEntries(toJson(loaded.profile))).toEqual([]);
  });

  it('writes the same proposal twice', () => {
    expect(second?.code, second?.output).toBe(0);
    expect(readFileSync(proposal, 'utf8')).toBe(firstText);
  });
});

const cutReport = () => Analysis.parse(JSON.parse(readFileSync(join(work, 'cut.json'), 'utf8')));

const modelReport = () =>
  Analysis.parse(JSON.parse(readFileSync(join(work, 'model.json'), 'utf8')));

describe('data from outside the repository, and the comparison without the contract (ADR-0065)', () => {
  it('reads the data given from outside the repository as its own', () => {
    expect(fromOutside?.code, fromOutside?.output).toBe(0);
    expect(existsSync(join(outsideRepo, 'data'))).toBe(false);
    expect(fromOutside?.output).toMatch(/^data given: .*catalog\.jsonl, .*faq\.jsonl$/mu);
    expect(readFileSync(outsideProposal, 'utf8')).toBe(firstText);
    expect(fromOutside?.output).toContain('precision 100.0%, recall 71.0%');
  });

  it('gives the precision and the recall without the 19 entries of the contract too', () => {
    expect(first?.output).toContain(
      '  without target.response.schema: precision 100.0%, recall 60.0%',
    );
    expect(report().comparison?.withoutSchema).toEqual({
      same: 30,
      different: 0,
      new: 0,
      missed: 20,
      precision: 1,
      recall: 0.6,
    });
  });
});

describe('the response contract from a contract file (ADR-0057, ADR-0058)', () => {
  it('reads openapi.json at the answer, verified by every probe answer', () => {
    expect(report().contracts).toEqual([
      {
        file: 'openapi.json',
        read: 'POST /v1/chat 200 application/json',
        at: '$.data',
        outcome: 'proposed',
        details: [],
      },
    ]);
    const entry = report().entries.find((found) => found.pointer === '/target/response/schema');
    expect(entry?.provenance).toEqual({
      source: 'contract',
      evidence: 'openapi.json: POST /v1/chat 200 application/json',
      status: 'proposed',
    });
    expect(first?.output).toContain(
      'contract: openapi.json POST /v1/chat 200 application/json at $.data: proposed',
    );
  });

  it("proposes no contract the answers don't keep, and names the violation by its path", () => {
    expect(stale?.code, stale?.output).toBe(0);
    const analysis = Analysis.parse(JSON.parse(readFileSync(join(work, 'stale.json'), 'utf8')));
    expect(analysis.contracts?.[0]).toMatchObject({ file: 'openapi.json', outcome: 'violated' });
    expect(analysis.contracts?.[0]?.details.join('\n')).toMatch(/^\$\.data required: /mu);
    expect(pointers(analysis.entries)).not.toContain('/target/response/schema');
  });
});

describe('yokla analyze with a model on the demo-shop (ADR-0049)', () => {
  it('prints the files and the estimate with --estimate, and sends nothing', () => {
    expect(estimated?.code, estimated?.output).toBe(0);
    expect(estimated?.output).toMatch(/model step: \d+ file\(s\) to demo-analyzer-1 at http/u);
    expect(estimated?.output).toMatch(/estimated cost \$\d+\.\d{4}, at most \$\d+\.\d{4}/u);
    expect(estimated?.output).toContain('--estimate: nothing was sent');
    expect(estimated?.output).not.toContain('probing');
    expect(existsSync(join(work, 'estimate.json'))).toBe(false);
  });

  it('refuses to spend without --max-cost', () => {
    expect(uncapped?.code).toBe(2);
    expect(uncapped?.output).toContain('--max-cost <usd> caps it, and is required');
  });

  it("adds the limits, the cache bypass and the refusals, every one the hand-written profile's", () => {
    expect(modelled?.code, modelled?.output).toBe(0);
    const { comparison, entries } = modelReport();
    // The model's fields are none the data or the probes give: they come first by construction.
    expect(new Set(pointers(entries)).size).toBe(entries.length);
    expect(comparison?.different).toEqual([]);
    expect(comparison?.new).toEqual([]);
    const added = pointers(comparison?.same ?? []).filter(
      (pointer) => !pointers(report().comparison?.same ?? []).includes(pointer),
    );
    // In the order they were read: the README before the code.
    expect(added).toEqual([
      '/target/cacheBypass/kind',
      '/target/cacheBypass/name',
      '/target/cacheBypass/value',
      '/target/limits/burstPerSecond',
      '/target/limits/perMinute',
      '/refusal/canonical/tr',
      '/refusal/canonical/en',
    ]);
    expect(comparison?.same).toHaveLength(56);
    expect(comparison?.recall).toBeCloseTo(56 / 69, 12);
    expect(modelled?.output).toContain('precision 100.0%, recall 81.2%');
    const cache = entries.find((entry) => entry.pointer === '/target/cacheBypass');
    expect(cache?.provenance).toMatchObject({ source: 'doc', status: 'proposed' });
    expect(cache?.provenance.evidence).toMatch(/^README\.md:\d+: ".*x-cache-bypass: 1/u);
    const limit = entries.find((entry) => entry.pointer === '/target/limits/perMinute');
    expect(limit?.provenance).toMatchObject({ source: 'code' });
    expect(limit?.provenance.evidence).toMatch(
      /^src\/server\.ts:\d+: "export const DEFAULT_RATE_LIMIT/u,
    );
  });

  it('drops the limit the model invented, and never proposes it', () => {
    const { unverified, entries } = modelReport();
    expect(unverified).toEqual([
      expect.objectContaining({
        field: 'limits.perHour',
        file: 'src/server.ts',
        reason: 'the value is not in the quote',
      }),
    ]);
    expect(pointers(entries)).not.toContain('/target/limits/perHour');
    expect(modelled?.output).toContain('unverified: limits.perHour at src/server.ts:');
  });

  it('reads docs and code, never data, environment or test files', () => {
    const sent = modelReport().model?.sent ?? [];
    expect(sent[0]).toBe('README.md');
    expect(sent).toContain('src/server.ts');
    expect(sent.filter((path) => /\.test\.|^data\/|\.env/u.test(path))).toEqual([]);
    expect(modelReport().model).toMatchObject({
      model: 'demo-analyzer-1',
      partial: false,
      unread: [],
    });
  });

  it('names the chunks a too small maxTokens cut, proposes none of their values, and caches none (ADR-0051)', () => {
    expect(cutRun?.code, cutRun?.output).toBe(0);
    const { model, entries, unverified } = cutReport();
    const unread = model?.unread ?? [];
    expect(unread.length).toBeGreaterThan(0);
    expect(new Set(unread.map((chunk) => chunk.reason))).toEqual(
      new Set(['the reply stopped at maxTokens']),
    );
    expect(unread.flatMap((chunk) => chunk.files)).toEqual(
      expect.arrayContaining(['README.md', 'src/server.ts', 'src/model.ts']),
    );
    expect(
      pointers(entries).filter((pointer) =>
        /^\/target\/(?:limits|cacheBypass)|^\/refusal\/canonical/u.test(pointer),
      ),
    ).toEqual([]);
    expect(unverified).toEqual([]);
    expect(cutRun?.output).toContain(
      'the reply stopped at maxTokens; raise models.analyzer.maxTokens, now 20',
    );
    // Every chunk was asked, and only the replies read were cached.
    expect(model?.calls).toBe(callsAfterCut);
    expect(cachedAfterCut).toBe(callsAfterCut - unread.length);
  });

  it('asks anew only the cut chunks once maxTokens is raised; the rest come from the cache (ADR-0051)', () => {
    const unread = cutReport().model?.unread.length ?? 0;
    expect(modelReport().model).toMatchObject({ calls: unread, cached: callsAfterCut - unread });
    expect(callsAfterFirst).toBe(callsAfterCut + unread);
  });

  it('answers a second analysis from the cache: no model call, the same file', () => {
    expect(cachedRun?.code, cachedRun?.output).toBe(0);
    expect(providerCalls()).toBe(callsAfterFirst);
    expect(readFileSync(withModel, 'utf8')).toBe(modelText);
    const again = Analysis.parse(JSON.parse(readFileSync(join(work, 'cached.json'), 'utf8')));
    // Every chunk, now: the cut run asked each one.
    expect(again.model).toMatchObject({ calls: 0, cached: callsAfterCut, costUsd: 0 });
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shop and the fake provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
