// The model proxy end to end (ADR-0012, design §20 v0.2): the demo-shop calls
// the fake provider through `yokla proxy`, and what the proxy measured must
// reconcile with the provider's own usage records, call for call and token
// for token. One run correlates serially with JSON answers, the other by
// header with event streams. Then the resilience cases run against a
// demo-shop for each resilience defect (ADR-0013), and the inspection cases
// for each inspection defect (ADR-0015). With spans on, the demo-shop exports
// a span for each model call, once per protocol, and the calls read from them
// must match the proxy's records, turn by turn; a demo-shop whose calls bypass
// the proxy is measured from its spans alone (ADR-0029). The acceptance, tool
// and resilience cases run once more with the model in Gemini's native
// protocol (ADR-0032). Everything runs behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseConfig, Results, z } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planCommand } from './commands/plan.ts';
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
  readonly thoughtsTokens: number;
}

function usageEntries(): UsageEntry[] {
  return readFileSync(usageLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): UsageEntry => {
      const value: unknown = JSON.parse(line);
      const read = (key: string) => Number(Reflect.get(Object(value), key));
      return {
        promptTokens: read('promptTokens'),
        completionTokens: read('completionTokens'),
        thoughtsTokens: Number(Reflect.get(Object(value), 'thoughtsTokens') ?? 0),
      };
    });
}

const PRICES = { input: 1, output: 2 };
let proxyUrl = '';
/** A second fake provider, whose model writes the fabricated-price defect (ADR-0033). */
let fabricatingUrl = '';
let serialShop = '';
let headerShop = '';

/** The demo-shop profile with its data paths made absolute and a model proxy added. */
/** How the demo-shop's model client speaks to the provider: chat completions, or Gemini's API. */
type Protocol = 'chat' | 'gemini';

/** The proxy's upstream for a protocol: the fake provider either way (ADR-0032). */
function upstreamFor(protocol: Protocol, providerUrl: string): string {
  return protocol === 'gemini'
    ? `    - { id: gemini, kind: gemini, upstream: '${providerUrl.replace(/\/v1$/u, '')}' }\n`
    : `    - { id: fake, kind: openai-compatible, upstream: '${providerUrl}' }\n`;
}

/** The demo-shop's model options for a protocol, through the proxy. */
function shopModel(protocol: Protocol): string[] {
  return protocol === 'gemini'
    ? ['--model-url', `${proxyUrl}/gemini/v1beta`, '--model-protocol', 'gemini']
    : ['--model-url', `${proxyUrl}/fake`];
}

function profileFor(
  correlation: 'serial' | 'header',
  providerUrl: string,
  name: string = correlation,
  more = '',
  upstreams: string = upstreamFor('chat', providerUrl),
): string {
  const text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  const path = join(dir, `${name}.profile.yaml`);
  writeFileSync(
    path,
    `${text}\nmodelProxy:\n  port: 1\n  correlation: ${correlation}\n  upstreams:\n${upstreams}${
      fabricatingUrl === ''
        ? ''
        : `    - { id: fake-fabricating, kind: openai-compatible, upstream: '${fabricatingUrl}' }\n`
    }${more}`,
  );
  return path;
}

const CANARY = 'DEMO-CANARY-7F3A';
/** What the inspection checks look for: the canary in the demo-shop's system prompt, and product names. */
const INSPECT = `  inspect:\n    canary: ${CANARY}\n    untrusted: { products: [name] }\n`;

const runs = new Map<
  string,
  { code: number; output: string; results: Results; before: number; after: number }
>();

async function run(correlation: 'serial' | 'header', shop: string, providerUrl: string) {
  const out = join(dir, `${correlation}.results.json`);
  const config = join(dir, 'yokla.config.yaml');
  writeFileSync(
    config,
    `version: 1\nprices:\n  fake:\n    demo-writer-1: { input: ${String(PRICES.input)}, output: ${String(PRICES.output)} }\n  gemini:\n    gemini-demo-1: { input: ${String(PRICES.input)}, output: ${String(PRICES.output)} }\n`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The demo-shop profile turned into a streaming target (ADR-0016): a session the
 * shop issues, sent back in a header, and answers as server-sent events.
 */
function streamingProfile(providerUrl: string): string {
  const text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  const parsed = parseConfig(text, 'yokla.profile.yaml', z.record(z.string(), z.unknown()));
  if (!parsed.ok) throw new Error('the demo-shop profile does not parse');
  const profile = parsed.value;
  const target = profile['target'];
  if (!isRecord(target) || !isRecord(target['request']) || !isRecord(target['response'])) {
    throw new Error('the demo-shop profile has no target');
  }
  const evidence = target['response']['evidence'];
  const products = isRecord(evidence) ? evidence['products'] : undefined;
  const fields = isRecord(products) ? products['fields'] : undefined;
  const streaming = {
    ...profile,
    target: {
      ...target,
      request: {
        ...target['request'],
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-session-id': '{{carry.sessionId}}',
        },
        body: { message: '{{message}}' },
      },
      session: {
        mode: 'none',
        open: {
          request: { url: '/v1/sessions', body: {} },
          carry: [{ name: 'sessionId', from: '$.data.sessionId' }],
        },
      },
      response: {
        stream: { format: 'sse', text: { event: 'delta', from: '$.text' }, done: 'done' },
        text: '$.text',
        route: '$.last.done.route',
        evidence: { products: { items: '$.last.products.products[*]', fields } },
      },
    },
    modelProxy: {
      port: 1,
      correlation: 'serial',
      upstreams: [{ id: 'fake', kind: 'openai-compatible', upstream: providerUrl }],
      settle: { quietMs: 100, maxWaitMs: 5_000 },
    },
  };
  const path = join(dir, 'streaming.profile.yaml');
  // JSON is YAML too.
  writeFileSync(path, JSON.stringify(streaming, null, 2));
  return path;
}

/** Each case's answers and routes, turn by turn. */
const answers = (results: Results | undefined) =>
  Object.fromEntries(
    (results?.cases ?? []).map((c) => [
      c.id,
      c.samples[0]?.turns.map((turn) => [turn.response?.text, turn.response?.route]),
    ]),
  );

let streamed:
  { code: number; output: string; results: Results; before: number; after: number } | undefined;

async function runStreaming(providerUrl: string): Promise<void> {
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    '--model-url',
    `${proxyUrl}/fake`,
    '--model-summary',
  ]);
  const out = join(dir, 'streaming.results.json');
  const before = usageEntries().length;
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      streamingProfile(providerUrl),
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${shop}/v1/chat`,
      '--proxy-url',
      proxyUrl,
      '--config',
      join(dir, 'yokla.config.yaml'),
      '--out',
      out,
    ],
    io,
  );
  // The last summary call reaches the provider after the run settled on it.
  streamed = {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    before,
    after: usageEntries().length,
  };
}

const PRODUCT_CASES = [
  'personal-data-masked-tr',
  'products-stay-out-of-system-en',
  'products-stay-out-of-system-tr',
  'prompt-size-tr',
];
/** Inspection defect → the one check that must catch it → the cases it must fail. */
const INSPECTION: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  none: {},
  'products-in-system': { 'untrusted-in-system': PRODUCT_CASES },
  'prompt-bloat': { 'prompt-budget': ['prompt-size-tr'] },
  'unmasked-pii': { 'pii-in-prompt': ['personal-data-masked-tr'] },
  'no-leak-guard': {
    'prompt-leak': ['system-prompt-extraction-en', 'system-prompt-extraction-tr'],
  },
};
const inspection = new Map<string, Results>();
/** The attacks yokla generate --redteam wrote, run on the correct shop and on no-leak-guard (ADR-0080). */
const attacks = new Map<string, Results>();
const ATTACK_DEFECTS = ['none', 'no-leak-guard', 'unbounded-output'];

async function runInspection(
  defect: string,
  providerUrl: string,
  cases = join(DEMO, 'cases-inspection'),
  into = inspection,
): Promise<void> {
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    '--model-url',
    `${proxyUrl}/fake`,
    '--model-canary',
    CANARY,
    '--defect',
    defect,
  ]);
  const out = join(dir, `${into === inspection ? 'inspection' : 'attacks'}-${defect}.json`);
  const quiet = { out: () => undefined, err: () => undefined };
  const code = await main(
    [
      'run',
      '--profile',
      profileFor('serial', providerUrl, 'inspection', INSPECT),
      '--cases',
      cases,
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
  into.set(defect, Results.parse(JSON.parse(readFileSync(out, 'utf8'))));
}

/** yokla generate --redteam on the profile with a canary: every kind, extraction too (ADR-0080). */
async function generateAttacks(providerUrl: string): Promise<string> {
  const out = join(dir, 'attacks', 'redteam.yaml');
  const lines: string[] = [];
  const code = await main(
    [
      'generate',
      '--redteam',
      '--profile',
      profileFor('serial', providerUrl, 'inspection', INSPECT),
      '--competitor',
      'Rivalmart',
      '--out',
      out,
    ],
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  );
  expect(code, lines.join('\n')).toBe(0);
  return dirname(out);
}

/** Tool-call defect → the one check that must catch it → the cases it must fail (ADR-0025). */
const TOOLS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  none: {},
  'unrequested-cart': { 'tool-calls': ['jacket-follow-up-tools-en', 'tent-search-tools-tr'] },
  'repeated-search': { 'tool-calls': ['tent-search-tools-tr'] },
};
const toolRuns = new Map<string, Results>();

async function runTools(
  defect: string,
  providerUrl: string,
  protocol: Protocol = 'chat',
): Promise<void> {
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    ...shopModel(protocol),
    '--defect',
    defect,
  ]);
  const out = join(dir, `tools-${protocol}-${defect}.json`);
  const quiet = { out: () => undefined, err: () => undefined };
  const code = await main(
    [
      'run',
      '--profile',
      profileFor(
        'serial',
        providerUrl,
        `tools-${protocol}`,
        '',
        upstreamFor(protocol, providerUrl),
      ),
      '--cases',
      join(DEMO, 'cases-tools'),
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
  (protocol === 'gemini' ? geminiToolRuns : toolRuns).set(
    defect,
    Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
  );
}

/** The tool calls the proxy read, per case: name and size. */
const askedTools = (results: Results | undefined) =>
  (results?.cases ?? []).flatMap((c) =>
    c.samples.flatMap((sample) =>
      sample.turns.flatMap((turn) =>
        (turn.proxy?.calls ?? []).flatMap((call) =>
          (call.toolCalls ?? []).map((tool) => [c.id, tool.name, tool.chars]),
        ),
      ),
    ),
  );

/** The tools each model call offered. */
const offeredTools = (results: Results | undefined) =>
  (results?.cases ?? []).flatMap((c) =>
    c.samples.flatMap((sample) =>
      sample.turns.flatMap((turn) => (turn.proxy?.calls ?? []).map((call) => call.tools)),
    ),
  );

/** The faults each case's first turn met, per call. */
const faultsMet = (results: Results | undefined) =>
  (results?.cases ?? []).map((c) => ({
    id: c.id,
    calls: c.samples[0]?.turns[0]?.proxy?.calls.map((call) => call.fault?.kind ?? 'none'),
  }));

/**
 * Price defect → where its wrong price comes from (ADR-0033). Each fails only
 * price-grounded, on every product case; fabricated-price is the model's, so
 * it runs against the provider that writes it.
 */
const ORIGINS: Readonly<Record<string, 'input' | 'model' | 'app'>> = {
  'fabricated-price': 'model',
  'stale-price-in-prompt': 'input',
  'price-rewritten': 'app',
};
const ORIGIN_CASES = [
  'tents-tr',
  'tents-under-1000-tr',
  'tents-under-500-tr',
  'black-women-jacket-tr',
  'women-jackets-m-en',
  'black-backpack-en',
  'water-bottle-en',
  'sleeping-pad-tr',
  'hammock-en',
  'stoves-tr',
  'headlamps-en',
  'cheaper-follow-up-en',
];
const originRuns = new Map<string, Results>();

async function runOrigin(defect: string, providerUrl: string): Promise<void> {
  const model = defect === 'fabricated-price' ? 'fake-fabricating' : 'fake';
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    '--model-url',
    `${proxyUrl}/${model}`,
    ...(defect === 'fabricated-price' ? [] : ['--defect', defect]),
  ]);
  const out = join(dir, `origin-${defect}.json`);
  const quiet = { out: () => undefined, err: () => undefined };
  const code = await main(
    [
      'run',
      '--profile',
      profileFor('serial', providerUrl, `origin-${defect}`),
      '--cases',
      join(DEMO, 'cases'),
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
  originRuns.set(defect, Results.parse(JSON.parse(readFileSync(out, 'utf8'))));
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

async function runResilience(
  defect: string,
  providerUrl: string,
  protocol: Protocol = 'chat',
): Promise<void> {
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    ...shopModel(protocol),
    '--model-timeout-ms',
    '300',
    '--defect',
    defect,
  ]);
  const out = join(dir, `resilience-${protocol}-${defect}.json`);
  const quiet = { out: () => undefined, err: () => undefined };
  const code = await main(
    [
      'run',
      '--profile',
      profileFor(
        'serial',
        providerUrl,
        `resilience-${protocol}`,
        '',
        upstreamFor(protocol, providerUrl),
      ),
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
  (protocol === 'gemini' ? geminiResilience : resilience).set(
    defect,
    Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
  );
}

/** The acceptance in Gemini's protocol: JSON answers correlated serially, streams by header. */
const GEMINI_RUNS = { json: 'serial', stream: 'header' } as const;
const geminiRuns = new Map<
  string,
  { code: number; output: string; results: Results; before: number; after: number }
>();
const geminiToolRuns = new Map<string, Results>();
const geminiResilience = new Map<string, Results>();

async function runGemini(mode: keyof typeof GEMINI_RUNS, providerUrl: string): Promise<void> {
  const correlation = GEMINI_RUNS[mode];
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    ...shopModel('gemini'),
    ...(mode === 'stream' ? ['--model-stream'] : []),
  ]);
  const out = join(dir, `gemini-${mode}.results.json`);
  const before = usageEntries().length;
  const lines: string[] = [];
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
  const code = await main(
    [
      'run',
      '--profile',
      profileFor(
        correlation,
        providerUrl,
        `gemini-${mode}`,
        '',
        upstreamFor('gemini', providerUrl),
      ),
      '--cases',
      join(DEMO, 'cases'),
      '--target-url',
      `${shop}/v1/chat`,
      '--proxy-url',
      proxyUrl,
      '--config',
      join(dir, 'yokla.config.yaml'),
      '--out',
      out,
    ],
    io,
  );
  geminiRuns.set(mode, {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    before,
    after: usageEntries().length,
  });
}

/** Each protocol the demo-shop exports spans in, with the correlation the proxy keeps (ADR-0029). */
const SPAN_RUNS = { json: 'serial', protobuf: 'header' } as const;
const SPANS = '  spans: { quietMs: 500, maxWaitMs: 10000 }\n';
const spanRuns = new Map<
  string,
  { code: number; output: string; results: Results; before: number; after: number }
>();

/** Prices for the provider as the proxy names it, and as the spans name it. */
function spansConfig(): string {
  const path = join(dir, 'spans.config.yaml');
  const price = `{ input: ${String(PRICES.input)}, output: ${String(PRICES.output)} }`;
  writeFileSync(
    path,
    `version: 1\nprices:\n  fake:\n    demo-writer-1: ${price}\n  openai:\n    demo-writer-1: ${price}\n`,
  );
  return path;
}

/** Runs the acceptance cases against a demo-shop that exports its spans to the proxy. */
async function runSpans(name: string, shopArgs: string[], profile: string): Promise<void> {
  const shop = await start('src/main.ts', [
    '--port',
    '0',
    ...shopArgs,
    '--otel-url',
    `${proxyUrl}/_yokla/otlp/v1/traces`,
    '--otel-delay-ms',
    '100',
  ]);
  const out = join(dir, `spans-${name}.json`);
  const before = usageEntries().length;
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
      spansConfig(),
      '--out',
      out,
    ],
    io,
  );
  spanRuns.set(name, {
    code,
    output: lines.join('\n'),
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
    before,
    after: usageEntries().length,
  });
}

/** A profile whose model calls only spans show: the proxy forwards none of them. */
function spansOnlyProfile(): string {
  const text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  const path = join(dir, 'spans-only.profile.yaml');
  writeFileSync(path, `${text}\nmodelProxy:\n  port: 1\n  upstreams: []\n${SPANS}`);
  return path;
}

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  writeFileSync(usageLog, '');
  const providerUrl = await start('src/provider-main.ts', ['--port', '0', '--usage-log', usageLog]);
  fabricatingUrl = await start('src/provider-main.ts', [
    '--port',
    '0',
    '--defect',
    'fabricated-price',
  ]);
  const proxyLines: string[] = [];
  proxyDone = proxyCommand(
    [
      '--profile',
      profileFor(
        'serial',
        providerUrl,
        'proxy',
        '',
        upstreamFor('chat', providerUrl) + upstreamFor('gemini', providerUrl),
      ),
      '--port',
      '0',
      '--records',
      proxyLog,
    ],
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
  for (const defect of Object.keys(INSPECTION)) await runInspection(defect, providerUrl);
  const attackCases = await generateAttacks(providerUrl);
  for (const defect of ATTACK_DEFECTS)
    await runInspection(defect, providerUrl, attackCases, attacks);
  for (const defect of Object.keys(TOOLS)) await runTools(defect, providerUrl);
  for (const defect of Object.keys(ORIGINS)) await runOrigin(defect, providerUrl);
  await runStreaming(providerUrl);
  for (const [protocol, correlation] of Object.entries(SPAN_RUNS)) {
    await runSpans(
      protocol,
      [
        '--model-url',
        `${proxyUrl}/fake`,
        '--otel-protocol',
        protocol,
        ...(correlation === 'header' ? ['--model-stream'] : []),
      ],
      profileFor(correlation, providerUrl, `spans-${protocol}`, SPANS),
    );
  }
  // The model calls go straight to the provider: only their spans show them.
  await runSpans('only', ['--model-url', providerUrl], spansOnlyProfile());
  // Gemini's native protocol (ADR-0032).
  for (const mode of ['json', 'stream'] as const) await runGemini(mode, providerUrl);
  for (const defect of Object.keys(TOOLS)) await runTools(defect, providerUrl, 'gemini');
  for (const defect of Object.keys(RESILIENCE)) await runResilience(defect, providerUrl, 'gemini');
}, 600_000);

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
      expect(result?.results.summary.statuses).toEqual({ pass: 21 });
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
        prompts: 'sizes',
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
      for (const call of turn.proxy?.calls ?? []) {
        // By default the results keep each message's role and length, never its text.
        expect(call.prompt?.map((message) => message.role)).toEqual(['system', 'user']);
        expect(call.prompt?.every((message) => message.chars > 0)).toBe(true);
        expect(Object.keys(call.prompt?.[0] ?? {})).toEqual(['role', 'chars']);
      }
    }
    expect(JSON.stringify(runs.get(name)?.results)).not.toContain('demo-shop:');
  });

  it('wrote every recorded call to the --records file', () => {
    const lines = readFileSync(proxyLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    const recorded = [
      ...[...runs.values()].map((done) => done.results),
      ...resilience.values(),
      ...inspection.values(),
      ...attacks.values(),
      ...toolRuns.values(),
      ...originRuns.values(),
      ...(streamed === undefined ? [] : [streamed.results]),
      ...[...spanRuns.values()].map((done) => done.results),
      ...[...geminiRuns.values()].map((done) => done.results),
      ...geminiToolRuns.values(),
      ...geminiResilience.values(),
    ].reduce((total, results) => total + (results.run.proxy?.records ?? 0), 0);
    expect(lines).toHaveLength(recorded);
    expect(lines.join('\n')).not.toMatch(/authorization|demo-key/iu);
    // The file keeps prompts as the profile's prompts.store says: sizes, no text.
    for (const line of lines) {
      const prompt: unknown = Reflect.get(Object(JSON.parse(line)), 'prompt');
      expect(Array.isArray(prompt) && prompt.length > 0, line).toBe(true);
    }
    expect(lines.join('\n')).not.toContain('demo-shop:');
    // And tool calls as names and sizes, without their arguments (ADR-0025).
    const asked = lines.filter((line) => {
      const calls: unknown = Reflect.get(Object(JSON.parse(line)), 'toolCalls');
      return Array.isArray(calls) && calls.length > 0;
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('"arguments"');
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

  it.each(Object.entries(INSPECTION))(
    'inspection, %s: exactly the expected check fails, on exactly the expected cases',
    (defect, expected) => {
      const results = inspection.get(defect);
      expect(results?.cases).toHaveLength(6);
      const wanted = Object.fromEntries(
        Object.entries(expected).map(([check, ids]) => [check, [...ids].toSorted()]),
      );
      expect(failingByCheck(results)).toEqual(wanted);
      const failed = new Set(Object.values(wanted).flat());
      for (const c of results?.cases ?? [])
        expect(c.status, `${defect} ${c.id}`).toBe(failed.has(c.id) ? 'fail' : 'pass');
      // The canary reached the system prompts, so prompt-leak could apply.
      expect(results?.run.issues).toBeUndefined();
    },
  );

  it('attacks: the correct shop withstands every generated kind, extraction with the model over HTTP (ADR-0080)', () => {
    const results = attacks.get('none');
    const kinds = new Set(results?.cases.map((c) => c.id.replace(/-(?:tr|en)-.*$/u, '')));
    expect(kinds).toEqual(
      new Set([
        'injection',
        'extraction',
        'cost-abuse',
        'internals',
        'offer',
        'commitment',
        'competitor',
        'false-premise',
      ]),
    );
    for (const c of results?.cases ?? []) expect(c.status, c.id).toBe('pass');
    // With the proxy, cost-abuse is measured: the writer's bound keeps the answer short (ADR-0082).
    const costAbuse = results?.cases.filter((c) => c.id.startsWith('cost-abuse-')) ?? [];
    expect(costAbuse).toHaveLength(2);
    for (const c of costAbuse) {
      const check = c.samples[0]?.turns[0]?.checks.find((x) => x.check === 'cost-budget');
      expect(check?.applicable && check.findings.map((f) => f.verdict), c.id).toEqual(['pass']);
    }
    // internals-leak judges by the model and the tools the proxy saw.
    for (const c of results?.cases.filter((x) => x.id.startsWith('internals-')) ?? []) {
      const check = c.samples[0]?.turns[0]?.checks.find((x) => x.check === 'internals-leak');
      expect(check?.applicable && check.unmeasured, c.id).toBeUndefined();
    }
  });

  it('attacks: unbounded-output fails exactly the cost-abuse cases, by cost-budget (ADR-0082)', () => {
    expect(failingByCheck(attacks.get('unbounded-output'))).toEqual({
      'cost-budget': ['cost-abuse-en-long-answer', 'cost-abuse-tr-long-answer'],
    });
  });

  it('attacks: no-leak-guard fails exactly the extraction cases, by answer-text and prompt-leak (ADR-0080)', () => {
    const results = attacks.get('no-leak-guard');
    const extraction = (results?.cases ?? [])
      .map((c) => c.id)
      .filter((id) => id.startsWith('extraction-'))
      .toSorted();
    expect(extraction).toHaveLength(4);
    expect(failingByCheck(results)).toEqual({
      'answer-text': extraction,
      'prompt-leak': extraction,
    });
  });

  it('inspection: every check applied where it should, and the results keep no prompt text', () => {
    const results = inspection.get('none');
    const applied = (id: string) =>
      (results?.cases ?? [])
        .filter((c) =>
          c.samples.some((sample) =>
            sample.turns.some((turn) =>
              turn.checks.some((check) => check.check === id && check.applicable),
            ),
          ),
        )
        .map((c) => c.id)
        .toSorted();
    expect(applied('prompt-leak')).toHaveLength(6);
    expect(applied('untrusted-in-system')).toEqual(PRODUCT_CASES);
    expect(applied('pii-in-prompt')).toEqual(['personal-data-masked-tr']);
    expect(applied('prompt-budget')).toEqual(['prompt-size-tr']);
    // Every system prompt carried the canary, but prompts are kept as sizes: the
    // canary is in the results only where it leaked into the target's answer.
    for (const [defect, kept] of inspection) {
      expect(JSON.stringify(kept).includes(CANARY), defect).toBe(defect === 'no-leak-guard');
    }
  });

  it.each(Object.entries(TOOLS))(
    'tools, %s: exactly the expected check fails, on exactly the expected cases',
    (defect, expected) => {
      const results = toolRuns.get(defect);
      expect(results?.cases).toHaveLength(4);
      const wanted = Object.fromEntries(
        Object.entries(expected).map(([check, ids]) => [check, [...ids].toSorted()]),
      );
      expect(failingByCheck(results)).toEqual(wanted);
      const failed = new Set(Object.values(wanted).flat());
      for (const c of results?.cases ?? [])
        expect(c.status, `${defect} ${c.id}`).toBe(failed.has(c.id) ? 'fail' : 'pass');
    },
  );

  it('tools: both checks applied on every turn, on calls the proxy read, and the results keep no arguments', () => {
    const turns = (toolRuns.get('none')?.cases ?? []).flatMap((c) =>
      c.samples.flatMap((sample) => sample.turns),
    );
    expect(turns).toHaveLength(5);
    for (const turn of turns) {
      for (const id of ['tool-calls', 'tool-call-valid']) {
        const check = turn.checks.find((c) => c.check === id);
        expect(check?.applicable, `${id} on ${turn.user}`).toBe(true);
        expect(check?.findings.map((f) => f.verdict)).toEqual(['pass']);
      }
    }
    const calls = turns.flatMap((turn) => turn.proxy?.calls ?? []);
    expect(calls.map((call) => call.tools).filter((tools) => tools === undefined)).toEqual([]);
    const asked = calls.flatMap((call) => call.toolCalls ?? []);
    // Not vacuous: the searches, the policy and the cheapest were asked for as tools.
    expect(asked.map((call) => call.name).toSorted()).toEqual([
      'cheapest_shown',
      'get_policy',
      'search_products',
      'search_products',
    ]);
    // prompts.store is sizes: names and lengths, never the arguments.
    expect(asked.every((call) => call.arguments === undefined && call.chars > 0)).toBe(true);
  });

  it.each(Object.entries(ORIGINS))(
    'origin, %s: only price-grounded fails, and every wrong price is traced to %s',
    (defect, stage) => {
      const results = originRuns.get(defect);
      expect(failingByCheck(results)).toEqual({ 'price-grounded': [...ORIGIN_CASES].toSorted() });
      const origins = (results?.cases ?? [])
        .flatMap((c) => c.samples.flatMap((sample) => sample.turns))
        .flatMap((turn) => turn.checks)
        .flatMap((check) => check.findings)
        .filter((finding) => finding.verdict === 'fail')
        .map((finding) => finding.origin?.stage);
      expect(origins.length).toBeGreaterThanOrEqual(ORIGIN_CASES.length);
      expect(new Set(origins)).toEqual(new Set([stage]));
      // The results keep no prompt or answer text: sizes only, the default (ADR-0015).
      for (const call of (results?.cases ?? []).flatMap((c) =>
        c.samples.flatMap((sample) => sample.turns.flatMap((turn) => turn.proxy?.calls ?? [])),
      )) {
        expect(Object.keys(call.output ?? {})).toEqual(['chars']);
      }
    },
  );

  it('streaming: the acceptance passes the same, answer for answer, with sessions the shop issues', () => {
    expect(streamed?.code, streamed?.output).toBe(0);
    expect(streamed?.results.summary.statuses).toEqual({ pass: 21 });
    expect(answers(streamed?.results)).toEqual(answers(runs.get('serial')?.results));
    for (const turn of streamed?.results.cases.flatMap((c) => c.samples[0]?.turns ?? []) ?? []) {
      const first = turn.response?.firstTextMs;
      expect(first, turn.user).toBeGreaterThan(0);
      expect(first ?? Infinity).toBeLessThanOrEqual(turn.response?.latencyMs ?? 0);
      expect(turn.issues, turn.user).toBeUndefined();
    }
  });

  it('streaming: every summary call after an answer is counted for its turn, and cost reconciles', () => {
    const results = streamed?.results;
    const provider = usageEntries().slice(streamed?.before ?? 0, streamed?.after ?? 0);
    const input = provider.reduce((total, entry) => total + entry.promptTokens, 0);
    const output = provider.reduce((total, entry) => total + entry.completionTokens, 0);
    expect(results?.run.proxy).toMatchObject({
      records: provider.length,
      attributed: provider.length,
      unattributed: 0,
      totals: { calls: provider.length, inputTokens: input, outputTokens: output },
    });
    expect(results?.run.issues).toBeUndefined();
    // Interpret, write, and the summary the shop starts after answering.
    const turns = results?.cases.flatMap((c) => c.samples[0]?.turns ?? []) ?? [];
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) expect(turn.proxy?.calls, turn.user).toHaveLength(3);
  });

  it.each(Object.entries(SPAN_RUNS))(
    'spans, %s: the acceptance passes, and every span is tied to its turn by traceparent',
    (protocol, correlation) => {
      const done = spanRuns.get(protocol);
      expect(done?.code, done?.output).toBe(0);
      expect(done?.results.summary.statuses).toEqual({ pass: 21 });
      const measured = done?.results.run;
      // The proxy keeps its own correlation for its calls.
      expect(measured?.correlation).toBe(correlation);
      expect(measured?.issues).toBeUndefined();
      const records = measured?.proxy?.records ?? 0;
      expect(records).toBeGreaterThan(0);
      expect(measured?.spans).toMatchObject({
        received: records,
        attributed: records,
        unattributed: 0,
        settled: true,
      });
      expect(measured?.spans?.totals).toEqual(measured?.proxy?.totals);
    },
  );

  it.each(Object.keys(SPAN_RUNS))(
    "spans, %s: for every turn, the calls read from spans match the proxy's records",
    (protocol) => {
      const turns =
        spanRuns.get(protocol)?.results.cases.flatMap((c) => c.samples.flatMap((s) => s.turns)) ??
        [];
      expect(turns.length).toBeGreaterThan(0);
      for (const turn of turns) {
        const proxied = turn.proxy?.calls.map((call) => ({
          model: call.model,
          input: call.usage.input,
          output: call.usage.output,
          costUsd: call.costUsd,
        }));
        const spanned = turn.spans?.calls.map((call) => ({
          model: call.model,
          input: call.usage.input,
          output: call.usage.output,
          costUsd: call.costUsd,
        }));
        expect(proxied, turn.user).toHaveLength(2);
        // The same count, models and token counts, in the same order.
        expect(spanned, turn.user).toEqual(proxied);
        for (const call of turn.spans?.calls ?? []) {
          expect(call, turn.user).toMatchObject({ provider: 'openai', error: false });
          expect(call.durationMs).toBeGreaterThan(0);
        }
      }
    },
  );

  it('spans only: a target whose calls the proxy never sees is measured from its spans', () => {
    const done = spanRuns.get('only');
    expect(done?.code, done?.output).toBe(0);
    expect(done?.results.summary.statuses).toEqual({ pass: 21 });
    const measured = done?.results.run;
    expect(measured?.correlation).toBe('traceparent');
    expect(measured?.proxy).toBeUndefined();
    expect(measured?.issues).toBeUndefined();
    // The provider's own records are what the spans must reconcile with.
    const provider = usageEntries().slice(done?.before ?? 0, done?.after ?? 0);
    const input = provider.reduce((total, entry) => total + entry.promptTokens, 0);
    const output = provider.reduce((total, entry) => total + entry.completionTokens, 0);
    expect(provider.length).toBeGreaterThan(0);
    expect(measured?.spans).toEqual({
      received: provider.length,
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
      settled: true,
    });
    for (const turn of done?.results.cases.flatMap((c) => c.samples[0]?.turns ?? []) ?? []) {
      expect(turn.proxy, turn.user).toBeUndefined();
      expect(turn.spans?.calls, turn.user).toHaveLength(2);
      expect(turn.spans?.costUsd, turn.user).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(GEMINI_RUNS))(
    "gemini, %s: the acceptance passes with the model in Gemini's protocol (ADR-0032)",
    (mode, correlation) => {
      const done = geminiRuns.get(mode);
      expect(done?.code, done?.output).toBe(0);
      expect(done?.results.summary.statuses).toEqual({ pass: 21 });
      expect(done?.results.run.correlation).toBe(correlation);
      expect(answers(done?.results)).toEqual(answers(runs.get('serial')?.results));
    },
  );

  it.each(Object.entries(GEMINI_RUNS))(
    "gemini, %s: the proxy's measurement reconciles with the provider's records, thinking included",
    (mode, correlation) => {
      const done = geminiRuns.get(mode);
      const provider = usageEntries().slice(done?.before ?? 0, done?.after ?? 0);
      const sum = (key: keyof UsageEntry) =>
        provider.reduce((total, entry) => total + entry[key], 0);
      expect(provider.length).toBeGreaterThan(0);
      expect(sum('thoughtsTokens')).toBeGreaterThan(0);
      expect(done?.results.run.proxy).toEqual({
        correlation,
        records: provider.length,
        attributed: provider.length,
        unattributed: 0,
        totals: {
          calls: provider.length,
          inputTokens: sum('promptTokens'),
          outputTokens: sum('completionTokens'),
          reasoningTokens: sum('thoughtsTokens'),
          costUsd: expect.closeTo(
            (sum('promptTokens') * PRICES.input + sum('completionTokens') * PRICES.output) / 1e6,
            12,
          ) as unknown,
        },
        missing: { cachedInputTokens: provider.length, cacheWriteTokens: provider.length },
        prompts: 'sizes',
      });
      for (const turn of done?.results.cases.flatMap((c) => c.samples[0]?.turns ?? []) ?? []) {
        expect(turn.proxy?.calls, turn.user).toHaveLength(2);
        for (const call of turn.proxy?.calls ?? []) {
          expect(call).toMatchObject({
            upstream: 'gemini',
            model: 'gemini-demo-1',
            stream: mode === 'stream',
          });
          expect(call.prompt?.map((message) => message.role)).toEqual(['system', 'user']);
        }
      }
    },
  );

  it.each(Object.entries(TOOLS))(
    'gemini tools, %s: exactly the expected check fails, on exactly the expected cases',
    (defect, expected) => {
      const results = geminiToolRuns.get(defect);
      expect(results?.cases).toHaveLength(4);
      const wanted = Object.fromEntries(
        Object.entries(expected).map(([check, ids]) => [check, [...ids].toSorted()]),
      );
      expect(failingByCheck(results)).toEqual(wanted);
    },
  );

  it('gemini tools: the proxy reads the same tool calls as over chat completions', () => {
    expect(askedTools(geminiToolRuns.get('none')).length).toBeGreaterThan(0);
    expect(askedTools(geminiToolRuns.get('none'))).toEqual(askedTools(toolRuns.get('none')));
    expect(offeredTools(geminiToolRuns.get('none'))).toEqual(offeredTools(toolRuns.get('none')));
  });

  it.each(Object.entries(RESILIENCE))(
    'gemini resilience, %s: exactly the expected check fails, on exactly the expected cases',
    (defect, expected) => {
      const results = geminiResilience.get(defect);
      expect(results?.cases).toHaveLength(6);
      const wanted = Object.fromEntries(
        Object.entries(expected).map(([check, ids]) => [check, [...ids].toSorted()]),
      );
      expect(failingByCheck(results)).toEqual(wanted);
    },
  );

  it('gemini resilience: the faults reached the provider as they do over chat completions', () => {
    expect(faultsMet(geminiResilience.get('none'))).toEqual(faultsMet(resilience.get('none')));
  });

  it('budgets: plan estimates a repeat of the serial run exactly from it', () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const code = planCommand(
      [
        '--cases',
        join(DEMO, 'cases'),
        '--calibration',
        join(dir, 'serial.results.json'),
        '--config',
        join(dir, 'yokla.config.yaml'),
      ],
      io,
      dir,
    );
    expect(code, lines.join('\n')).toBe(0);
    const spent = runs.get('serial')?.results.run.proxy?.totals['costUsd'] ?? 0;
    expect(spent).toBeGreaterThan(0);
    // Same cases, same definitions, one sample: the estimate is what the run cost.
    expect(lines[1]).toMatch(/^ {2}21 of 21 cases priced from their own calibration/u);
    expect(lines[2]).toBe(
      `  estimate: ${String(Math.round(spent * 1e6) / 1e6)} USD; upper bound: ${String(Math.round(spent * 2 * 1e6) / 1e6)} USD (2x)`,
    );
  });

  it('budgets: the gate judges latency and cost thresholds on the serial run', async () => {
    const results = join(dir, 'serial.results.json');
    const gate = async (config: string) => {
      const path = join(dir, `gate-${String(config.length)}.yaml`);
      writeFileSync(path, config);
      const lines: string[] = [];
      const io = {
        out: (line: string) => lines.push(line),
        err: (line: string) => lines.push(line),
      };
      const code = await main(['gate', '--results', results, '--config', path], io);
      return { code, output: lines.join('\n') };
    };
    expect(
      await gate('version: 1\ngate: { latencyP95Ms: 60000, costPerTurnUsd: 1, costUsd: 10 }\n'),
    ).toMatchObject({ code: 0 });
    const tight = await gate('version: 1\ngate: { latencyP95Ms: 0, costPerTurnUsd: 0.0000001 }\n');
    expect(tight.code).toBe(1);
    expect(tight.output).toMatch(/factual: latency p95 [\d.]+ ms, 0 allowed/u);
    expect(tight.output).toMatch(/factual: cost per turn [\d.e-]+ USD, 1e-7 allowed/u);
  });

  it('budgets: a capped run stops early, and the gate cannot judge it', async () => {
    const out = join(dir, 'capped.results.json');
    const quiet = { out: () => undefined, err: () => undefined };
    const code = await main(
      [
        'run',
        '--profile',
        join(dir, 'serial.profile.yaml'),
        '--cases',
        join(DEMO, 'cases'),
        '--target-url',
        `${serialShop}/v1/chat`,
        '--proxy-url',
        proxyUrl,
        '--config',
        join(dir, 'yokla.config.yaml'),
        '--max-cost',
        '0.00001',
        '--out',
        out,
      ],
      quiet,
    );
    expect(code).toBe(0);
    const capped = Results.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(capped.run.partial).toBe(true);
    expect(capped.run.issues?.[0]).toMatch(
      /^stopped at the cost cap: [\d.e-]+ USD spent, 0\.00001 USD allowed$/u,
    );
    expect(capped.cases.length).toBeLessThan(18);
    const lines: string[] = [];
    const gateCode = await main(['gate', '--results', out], {
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
    });
    expect(gateCode).toBe(2);
    expect(lines.join('\n')).toMatch(/the run is partial/u);
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shops, the proxy and the provider (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
    expect(new Set(attempts.map((attempt) => attempt.port))).toEqual(ports);
  });
});
