// Model transforms, end to end (ADR-0059): the demo-shop's acceptance cases
// run as written, then paraphrased and code-switched by the fake provider
// playing models.transform. yokla compare --expect-same sets each beside the
// run as written.
// - The correct shop keeps every verdict under both, and each changed
//   messages. The rewrite that lost an amount is sent as written, and said.
// - A shop with language-by-words answers a Turkish message that holds an
//   English product word in English: only code-switching moves verdicts, and
//   only of Turkish cases whose message gained one.
// - Without --max-cost, or without models.transform, the run refuses to
//   start; a second run answers from the cache.
// No model cost, behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'yokla-model-transforms-e2e-'));
const profile = join(dir, 'yokla.profile.yaml');
const config = join(dir, 'yokla.config.yaml');
const usageLog = join(dir, 'provider-usage.jsonl');
const KEY_ENV = 'YOKLA_TRANSFORM_E2E_KEY';

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;

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

const shop = (...args: string[]) =>
  start('src/main.ts', ['--port', '0', '--rate-limit', 'off', ...args]);

/** The model calls the fake provider answered. */
const providerCalls = () =>
  readFileSync(usageLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;

interface Ran {
  readonly code: number;
  readonly output: string;
  readonly out: string;
}

async function cli(args: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await main(args, {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  return { code, output: lines.join('\n') };
}

async function run(name: string, url: string, ...more: string[]): Promise<Ran> {
  const out = join(dir, `${name}.json`);
  const ran = await cli([
    'run',
    '--profile',
    profile,
    '--config',
    config,
    '--cases',
    join(DEMO, 'cases'),
    '--target-url',
    `${url}/v1/chat`,
    '--out',
    out,
    ...more,
  ]);
  return { ...ran, out };
}

const results = (ran: Ran | undefined) =>
  Results.parse(JSON.parse(readFileSync(ran?.out ?? '', 'utf8')));

const runs = new Map<string, Ran>();
const comparisons = new Map<string, { code: number; output: string }>();
let uncapped: { code: number; output: string } | undefined;
let unconfigured: { code: number; output: string } | undefined;
let callsBefore = 0;

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  writeFileSync(usageLog, '');
  writeFileSync(
    profile,
    readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8')
      .replaceAll('./data/', join(DEMO, 'data/'))
      .replace(/^ {2}limits:\n(?: {4}.*\n)+/mu, ''),
  );
  const [correct, byWords, provider] = await Promise.all([
    shop(),
    shop('--defect', 'language-by-words'),
    start('src/provider-main.ts', ['--port', '0', '--usage-log', usageLog]),
  ]);
  writeFileSync(
    config,
    [
      'version: 1',
      `checks: [${join(DEMO, 'checks', 'no-internal-ids.ts')}]`,
      'models:',
      '  transform:',
      '    kind: openai-compatible',
      `    url: ${provider}/v1`,
      '    model: demo-transform-1',
      `    apiKeyEnv: ${KEY_ENV}`,
      '    maxTokens: 400',
      '    price: { input: 0.1, output: 0.5 }',
      '',
    ].join('\n'),
  );
  process.env[KEY_ENV] = 'demo-key';
  unconfigured = await cli([
    'run',
    '--profile',
    profile,
    '--config',
    join(DEMO, 'yokla.config.yaml'),
    '--cases',
    join(DEMO, 'cases'),
    '--target-url',
    `${correct}/v1/chat`,
    '--out',
    join(dir, 'unconfigured.json'),
    '--transform',
    'paraphrase',
  ]);
  uncapped = await run('uncapped', correct, '--transform', 'paraphrase');
  for (const [name, url] of [
    ['correct', correct],
    ['by-words', byWords],
  ] as const) {
    runs.set(`${name}-written`, await run(`${name}-written`, url));
    for (const kind of ['paraphrase', 'code-switch']) {
      const transformed = await run(`${name}-${kind}`, url, '--transform', kind, '--max-cost', '1');
      runs.set(`${name}-${kind}`, transformed);
      const compared = await cli([
        'compare',
        '--results',
        runs.get(`${name}-written`)?.out ?? '',
        '--results',
        transformed.out,
        '--expect-same',
      ]);
      comparisons.set(`${name}-${kind}`, compared);
    }
  }
  callsBefore = providerCalls();
  runs.set(
    'correct-paraphrase-again',
    await run('correct-paraphrase-again', correct, '--transform', 'paraphrase'),
  );
}, 600_000);

afterAll(() => {
  Reflect.deleteProperty(process.env, KEY_ENV);
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('model transforms on the demo-shop (ADR-0059)', () => {
  it('refuses to start without models.transform, or without --max-cost while a rewrite costs', () => {
    expect(unconfigured?.code).toBe(2);
    expect(unconfigured?.output).toContain(
      '--transform paraphrase needs models.transform in the configuration (ADR-0059)',
    );
    expect(uncapped?.code).toBe(2);
    expect(uncapped?.output).toContain('--max-cost <usd> caps it, and is required');
    expect(uncapped?.output).toMatch(
      /transform: \d+ message\(s\) to rewrite with demo-transform-1 at http/u,
    );
  });

  it.each(['paraphrase', 'code-switch'])(
    'the correct shop keeps every verdict under %s, and the transform changed messages',
    (kind) => {
      const ran = runs.get(`correct-${kind}`);
      expect(ran?.code, ran?.output).toBe(0);
      const { run: summary, summary: counts } = results(ran);
      expect(counts.statuses).toEqual({ pass: 21 });
      expect(summary.transforms?.[0]?.kind).toBe(kind);
      expect(summary.transforms?.[0]?.messages).toBeGreaterThan(0);
      expect(summary.own?.calls).toBeGreaterThan(0);
      const comparison = comparisons.get(`correct-${kind}`);
      expect(comparison?.code, comparison?.output).toBe(0);
    },
  );

  it('sends a rewrite that lost an amount as written, and says why', () => {
    const paraphrased = results(runs.get('correct-paraphrase'));
    expect(paraphrased.run.issues).toContain(
      '--transform paraphrase left 1 message as written: "500 TL" was lost',
    );
    const turn = paraphrased.cases.find((c) => c.id === 'tents-under-500-tr')?.samples[0]?.turns[0];
    expect([turn?.user, turn?.written]).toEqual(['500 TL altı çadır', undefined]);
    const tents = paraphrased.cases.find((c) => c.id === 'tents-tr')?.samples[0]?.turns[0];
    expect([tents?.user, tents?.written]).toEqual([
      'Merhaba, çadır önerir misin?',
      'Çadır önerir misin?',
    ]);
  });

  it('language-by-words shows only under code-switching, in Turkish cases that gained an English word', () => {
    const written = results(runs.get('by-words-written'));
    expect(written.summary.statuses).toEqual({ pass: 21 });
    expect(comparisons.get('by-words-paraphrase')?.code).toBe(0);
    const switched = results(runs.get('by-words-code-switch'));
    const gained = new Set(
      switched.cases
        .filter(
          (c) =>
            c.language === 'tr' &&
            c.samples.some((sample) => sample.turns.some((turn) => turn.written !== undefined)),
        )
        .map((c) => c.id),
    );
    const moved = switched.cases
      .filter((c) => c.status !== written.cases.find((w) => w.id === c.id)?.status)
      .map((c) => c.id);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.filter((id) => !gained.has(id))).toEqual([]);
    expect(comparisons.get('by-words-code-switch')?.code).toBe(1);
  });

  it('answers a second run from the cache, and sends the same messages', () => {
    const again = runs.get('correct-paraphrase-again');
    expect(again?.code, again?.output).toBe(0);
    expect(providerCalls()).toBe(callsBefore);
    const sent = (ran: Ran | undefined) =>
      results(ran).cases.flatMap((c) => c.samples.flatMap((s) => s.turns.map((t) => t.user)));
    expect(sent(again)).toEqual(sent(runs.get('correct-paraphrase')));
    expect(results(again).run.own).toMatchObject({ costUsd: 0 });
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the shops and the fake provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
