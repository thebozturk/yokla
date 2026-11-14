// The simulated customer against the demo-shop (ADR-0028), as v0.3's exit
// criteria ask: the customer reaches each purchase goal, every turn passes the
// checks, and a run repeats from its seed. The fake provider plays the
// customer by simple rules, so it costs nothing. Everything runs behind a
// network guard that allows only the demo-shop and the fake provider.
// yokla never imports the demo-shop (layer rules).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const KEY_ENV = 'YOKLA_E2E_CUSTOMER_KEY';

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
const runs: { code: number; output: string; results: Results }[] = [];
let usageLog = '';

/** Starts a demo-shop process and resolves with the url it prints. */
async function start(script: string, args: string[]): Promise<string> {
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

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const dir = mkdtempSync(join(tmpdir(), 'yokla-e2e-customer-'));
  usageLog = join(dir, 'provider-usage.jsonl');
  writeFileSync(usageLog, '');
  const [shop, provider] = await Promise.all([
    start('src/main.ts', ['--port', '0']),
    start('src/provider-main.ts', ['--port', '0', '--usage-log', usageLog]),
  ]);
  // The profile next to its data, in a directory of its own: yokla-data goes there.
  const profile = join(dir, 'yokla.profile.yaml');
  writeFileSync(
    profile,
    readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
      './data/',
      join(DEMO, 'data/'),
    ),
  );
  const config = join(dir, 'yokla.config.yaml');
  writeFileSync(
    config,
    [
      'version: 1',
      'models:',
      '  customer:',
      '    kind: openai-compatible',
      `    url: ${provider}/v1`,
      '    model: demo-customer-1',
      `    apiKeyEnv: ${KEY_ENV}`,
      '    price: { input: 0.1, output: 0.5 }',
      '',
    ].join('\n'),
  );
  process.env[KEY_ENV] = 'demo-key';
  try {
    for (const name of ['first', 'second']) {
      const out = join(dir, `${name}.json`);
      const lines: string[] = [];
      const io = {
        out: (line: string) => lines.push(line),
        err: (line: string) => lines.push(line),
      };
      const code = await main(
        [
          'run',
          '--profile',
          profile,
          '--config',
          config,
          '--cases',
          join(DEMO, 'cases-customer'),
          '--target-url',
          `${shop}/v1/chat`,
          '--out',
          out,
        ],
        io,
      );
      runs.push({
        code,
        output: lines.join('\n'),
        results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
      });
    }
  } finally {
    Reflect.deleteProperty(process.env, KEY_ENV);
  }
}, 120_000);

afterAll(() => {
  guard?.uninstall();
  // Stop exactly the processes these tests started, by their handles.
  for (const child of children) child.kill();
});

/** Each case's conversation: the customer's messages, in order. */
const conversations = (results: Results | undefined) =>
  Object.fromEntries(
    (results?.cases ?? []).map((c) => [c.id, c.samples[0]?.turns.map((turn) => turn.user)]),
  );

describe('the simulated customer against the demo-shop (ADR-0028)', () => {
  it('reaches each purchase goal, and every turn passes the checks', () => {
    const [first] = runs;
    expect(first?.code, first?.output).toBe(0);
    expect(first?.results.summary.statuses).toEqual({ pass: 3 });
    for (const c of first?.results.cases ?? []) {
      const [sample] = c.samples;
      expect(sample?.customer?.ended, c.id).toBe('reached');
      const goal = sample?.turns.at(-1)?.checks.find((check) => check.check === 'goal-reached');
      expect(goal?.findings[0]?.verdict, c.id).toBe('pass');
    }
  });

  it('reacts to the answers: it puts the tent in stock in the cart, not the first one listed', () => {
    expect(conversations(runs[0]?.results)).toEqual({
      'tent-in-stock-to-cart-tr': [
        '3.000 TL altında, stokta olan bir çadırı sepete eklemek.',
        'Kubbe Çadır 2 Kişilik ürününü sepete ekler misin?',
      ],
      'women-jacket-to-cart-en': [
        "A women's jacket in size M under 1,500 TL, in my cart.",
        "Please add the Women's Fleece Jacket to my cart.",
      ],
      'headlamp-to-cart-en': [
        'Do you sell headlamps?',
        'Please add the Headlamp 200 lm to my cart.',
      ],
    });
    const tent = runs[0]?.results.cases.find((c) => c.id === 'tent-in-stock-to-cart-tr');
    const [search, cart] = tent?.samples[0]?.turns ?? [];
    expect(
      search?.response?.evidence['products']?.map((p): unknown => Reflect.get(Object(p), 'id')),
    ).toEqual(['TNT-004', 'TNT-001']);
    expect(cart?.response?.evidence['cart']).toEqual([
      { id: 'TNT-001', name: 'Kubbe Çadır 2 Kişilik' },
    ]);
  });

  it("counts the customer's calls and their cost, apart from the target's", () => {
    const results = runs[0]?.results;
    // The headlamp case opens as written: five customer calls in all.
    expect(results?.run.own).toMatchObject({ calls: 5, cached: 0 });
    expect(results?.run.own?.costUsd).toBeGreaterThan(0);
    const calls = readFileSync(usageLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(calls).toHaveLength(5);
  });

  it('repeats every conversation from the cache, at no cost', () => {
    const [first, second] = runs;
    expect(second?.code, second?.output).toBe(0);
    expect(conversations(second?.results)).toEqual(conversations(first?.results));
    expect(second?.results.run.own).toEqual({ calls: 5, cached: 5, costUsd: 0 });
    for (const c of second?.results.cases ?? []) {
      expect(c.samples[0]?.customer?.seed).toBe(`${c.id}|0`);
    }
    // The provider was asked nothing more.
    expect(
      readFileSync(usageLog, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
    ).toHaveLength(5);
  });

  it('contacts no host but the demo-shop and the fake provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
