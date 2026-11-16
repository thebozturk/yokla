// The analyzer, deterministic first, end to end (ADR-0047): yokla analyze
// reads a copy of the demo-shop's repository and probes the demo-shop in
// process, with the request of its hand-written profile. Its proposal is
// compared with that profile, which it never reads: every entry it proposes
// is the hand-written one, and what it misses is what code, docs and prompts
// must give a later step. A proposed profile doesn't run; an approved one
// loads. Two analyses write the same file. No model call, behind the network
// guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function startShop(): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--rate-limit', 'off'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
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
      reject(new Error(`demo-shop exited early with ${String(code)}`));
    });
  });
}

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

const analyze = (out: string, json: string, ...more: string[]) =>
  cli(
    'analyze',
    '--dir',
    repo,
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

let first: Ran | undefined;
let second: Ran | undefined;
let firstText = '';
const proposal = join(repo, 'yokla.profile.proposed.yaml');

beforeAll(async () => {
  // A copy of the repository, so the proposal can be written next to its data.
  cpSync(DEMO, repo, {
    recursive: true,
    filter: (path) => !/(?:node_modules|dist|tsbuildinfo)$/u.test(path),
  });
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  shopUrl = await startShop();
  first = await analyze(proposal, join(work, 'analysis.json'));
  firstText = readFileSync(proposal, 'utf8');
  second = await analyze(proposal, join(work, 'again.json'), '--force');
}, 120_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

const report = () => Analysis.parse(JSON.parse(readFileSync(join(work, 'analysis.json'), 'utf8')));
const pointers = (entries: readonly { pointer: string }[]) => entries.map((entry) => entry.pointer);

describe('yokla analyze on the demo-shop (ADR-0047)', () => {
  it('writes a proposal and an analysis report', () => {
    expect(first?.code, first?.output).toBe(0);
    expect(first?.output).toContain('probing ');
    expect(first?.output).toContain('precision 100.0%, recall 46.9%');
  });

  it("proposes only the hand-written profile's entries", () => {
    const { comparison } = report();
    expect(comparison?.different).toEqual([]);
    expect(comparison?.new).toEqual([]);
    expect(pointers(comparison?.same ?? [])).toEqual([
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
      '/target/response/schema',
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
    ]);
    expect(missed).toHaveLength(34);
    expect(report().comparison?.recall).toBeCloseTo(30 / 64, 12);
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

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shop (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
