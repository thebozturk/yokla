// yokla mcp end to end (ADR-0041): a scripted client drives `yokla mcp` as a
// child process over stdio, as a coding agent would, against a demo-shop with
// the model over HTTP behind the proxy and the fake provider. The shop has
// price-rewritten, so the app lowers a price the model wrote. The client
// lists and runs the cases, reads a failing case, shrinks it, and verifies a
// fix that isn't in yet. It then "fixes" the shop by restarting it on the same
// port without the defect, and verify_fix reports the failure fixed with no
// regression; a shop that breaks the response contract instead shows the
// regressions. A second session shows the cost cap refusing a run. The child
// runs behind the network guard, loaded with --import, and stdout carries
// protocol messages only.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyCommand } from './commands/proxy.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const BIN = new URL('./bin.ts', import.meta.url).pathname;
const PRELOAD = new URL('./mcp-guard.test.preload.ts', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'yokla-mcp-e2e-'));
const casesDir = join(dir, 'cases');
const guardLog = join(dir, 'guard.jsonl');

const field = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((at, key) => Reflect.get(Object(at), key), value);
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.map((item: unknown) => item) : [];

const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
const stopProxy = new AbortController();
let proxyDone: Promise<number> | undefined;
let proxyUrl = '';
let providerUrl = '';
let shopPort = 0;
let shop: ChildProcess | undefined;

/** Starts a demo-shop script and resolves with the first URL it prints. */
function start(script: string, args: string[]): Promise<{ url: string; child: ChildProcess }> {
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
        resolve({ url, child });
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`${script} exited early with ${String(code)}`));
    });
  });
}

/** (Re)starts the shop on its port, with these defects. */
async function startShop(...defects: string[]): Promise<void> {
  if (shop !== undefined) {
    const stopping = shop;
    await new Promise<void>((resolve) => {
      stopping.once('exit', () => {
        resolve();
      });
      stopping.kill();
    });
  }
  const started = await start('src/main.ts', [
    '--port',
    String(shopPort),
    '--model-url',
    `${proxyUrl}/fake`,
    ...defects.flatMap((defect) => ['--defect', defect]),
  ]);
  shop = started.child;
  shopPort = Number(new URL(started.url).port);
}

interface Answer {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** A scripted MCP client over a child yokla mcp's stdio. */
class Client {
  readonly lines: string[] = [];
  readonly stderr: string[] = [];
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, (answer: Answer) => void>();
  #id = 0;
  readonly exited: Promise<number | null>;

  constructor(args: string[]) {
    this.#child = spawn(
      process.execPath,
      ['--conditions=@yokla/source', '--import', PRELOAD, BIN, 'mcp', ...args],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          YOKLA_GUARD_PORTS: [...ports].join(','),
          YOKLA_GUARD_LOG: guardLog,
        },
      },
    );
    children.push(this.#child);
    let buffered = '';
    this.#child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      for (const line of parts.filter((part) => part !== '')) {
        this.lines.push(line);
        const answer: unknown = JSON.parse(line);
        const id = Number(field(answer, 'id'));
        const error = field(answer, 'error');
        this.#pending.get(id)?.({
          id,
          result: field(answer, 'result'),
          ...(error === undefined
            ? {}
            : {
                error: {
                  code: Number(field(error, 'code')),
                  message: String(field(error, 'message')),
                },
              }),
        });
        this.#pending.delete(id);
      }
    });
    this.#child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    this.exited = new Promise((resolve) => {
      this.#child.on('exit', resolve);
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<Answer> {
    this.#id += 1;
    const id = this.#id;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  notify(method: string): void {
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  /** Calls a tool; its structured content, or the text of its error as `error`. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const answer = await this.request('tools/call', { name, arguments: args });
    return field(answer.result, 'isError') === true
      ? { error: field(answer.result, 'content', 0, 'text') }
      : field(answer.result, 'structuredContent');
  }

  close(): Promise<number | null> {
    this.#child.stdin?.end();
    return this.exited;
  }
}

function profile(): string {
  const text = readFileSync(join(DEMO, 'yokla.profile.yaml'), 'utf8').replaceAll(
    './data/',
    join(DEMO, 'data/'),
  );
  const path = join(dir, 'yokla.profile.yaml');
  writeFileSync(
    path,
    `${text}\nmodelProxy:\n  port: 1\n  correlation: serial\n  upstreams:\n    - { id: fake, kind: openai-compatible, upstream: '${providerUrl}' }\n`,
  );
  return path;
}

const config = join(dir, 'yokla.config.yaml');
const session = (maxCost: string) => [
  '--profile',
  join(dir, 'yokla.profile.yaml'),
  '--cases',
  casesDir,
  '--config',
  config,
  '--target-url',
  `http://127.0.0.1:${String(shopPort)}/v1/chat`,
  '--proxy-url',
  proxyUrl,
  '--out',
  join(dir, 'runs'),
  '--max-cost',
  maxCost,
];

const SHRUNK = 'tents-after-small-talk-tr';
const steps: Record<string, unknown> = {};
let initialized: Answer | undefined;
let listed: Answer | undefined;
let unknownTool: Answer | undefined;
let badArguments: unknown;
let client: Client | undefined;
let capped: unknown[] = [];
let exitCode: number | null = null;

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  mkdirSync(casesDir);
  cpSync(join(DEMO, 'cases', 'acceptance.yaml'), join(casesDir, 'acceptance.yaml'));
  cpSync(join(DEMO, 'cases-shrink', 'shrink.yaml'), join(casesDir, 'shrink.yaml'));
  writeFileSync(
    config,
    'version: 1\nprices:\n  fake:\n    demo-writer-1: { input: 1, output: 2 }\n',
  );
  providerUrl = (await start('src/provider-main.ts', ['--port', '0'])).url;
  profile();
  const proxyLines: string[] = [];
  proxyDone = proxyCommand(
    ['--profile', join(dir, 'yokla.profile.yaml'), '--port', '0'],
    { out: (line) => proxyLines.push(line), err: (line) => proxyLines.push(line) },
    stopProxy.signal,
  );
  for (let i = 0; i < 200 && proxyUrl === ''; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    proxyUrl = /http:\/\/127\.0\.0\.1:\d+/u.exec(proxyLines[0] ?? '')?.[0] ?? '';
  }
  if (proxyUrl === '') throw new Error(`yokla proxy didn't start:\n${proxyLines.join('\n')}`);
  ports.add(Number(new URL(proxyUrl).port));
  await startShop('price-rewritten');

  client = new Client(session('1'));
  initialized = await client.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'scripted-agent', version: '1' },
  });
  client.notify('notifications/initialized');
  listed = await client.request('tools/list');
  steps['list'] = await client.call('list_cases');
  steps['run'] = await client.call('run_cases');
  const run = String(field(steps['run'], 'run'));
  steps['explain'] = await client.call('explain_finding', { run, case: SHRUNK });
  steps['shrink'] = await client.call('shrink_case', {
    run,
    case: SHRUNK,
    reproduce: 2,
    samples: 1,
  });
  steps['notYet'] = await client.call('verify_fix', { run, case: SHRUNK });
  await startShop();
  steps['fixed'] = await client.call('verify_fix', { run, case: SHRUNK });
  await startShop('missing-contract-field');
  steps['regressed'] = await client.call('verify_fix', { run, case: SHRUNK });
  unknownTool = await client.request('tools/call', { name: 'rm_rf' });
  badArguments = await client.call('explain_finding', { run: '../../etc/passwd', case: SHRUNK });
  exitCode = await client.close();

  // A second session whose cap a single run spends.
  await startShop();
  const small = new Client(session('0.000001'));
  await small.request('initialize', { protocolVersion: '2025-11-25' });
  // tents-tr failed in the first run and passes now, but the cap stops the check after it.
  capped = [
    await small.call('verify_fix', { run, case: 'tents-tr' }),
    await small.call('run_cases', { cases: ['tents-tr'] }),
    await small.call('list_cases'),
  ];
  await small.close();
}, 600_000);

afterAll(async () => {
  stopProxy.abort();
  await proxyDone;
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('yokla mcp against the demo-shop (ADR-0041)', () => {
  it('speaks the protocol: a version, five tools, and errors an agent can read', () => {
    expect(initialized?.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'yokla' },
    });
    const tools = field(listed?.result, 'tools');
    expect(Array.isArray(tools) ? tools.map((tool: unknown) => field(tool, 'name')) : []).toEqual([
      'list_cases',
      'run_cases',
      'explain_finding',
      'shrink_case',
      'verify_fix',
    ]);
    expect(unknownTool?.error).toEqual({ code: -32602, message: 'no tool "rm_rf"' });
    expect(String(field(badArguments, 'error'))).toMatch(/^invalid arguments: run: /u);
    expect(exitCode).toBe(0);
  });

  it('runs the cases, and each price the app rewrote fails with the origin app', () => {
    expect(field(steps['list'], 'cases', 'length')).toBe(22);
    const run = steps['run'];
    expect(field(run, 'statuses')).toEqual({ fail: 13, pass: 9 });
    const notPassed = list(field(run, 'notPassed'));
    expect(notPassed.map((c) => field(c, 'id'))).toContain(SHRUNK);
    for (const c of notPassed) {
      const failing = list(field(c, 'failing'));
      const id = String(field(c, 'id'));
      expect(new Set(failing.map((f) => field(f, 'check'))), id).toEqual(
        new Set(['price-grounded']),
      );
      expect(new Set(failing.map((f) => field(f, 'origin', 'stage'))), id).toEqual(
        new Set(['app']),
      );
    }
    expect(existsSync(String(field(run, 'results')))).toBe(true);
    expect(field(run, 'cost', 'spentUsd')).toBeGreaterThan(0);
    expect(field(run, 'cost', 'remainingUsd')).toBeLessThan(1);
  });

  it('explains the failing case turn by turn, with the model calls behind it', () => {
    const explain = steps['explain'];
    expect(explain).toMatchObject({
      case: SHRUNK,
      status: 'fail',
      failingDimensions: ['fabrication'],
    });
    const turns = list(field(explain, 'turns'));
    expect(turns.map((turn) => field(turn, 'user'))).toEqual([
      'Merhaba',
      'Teşekkürler, iyi günler',
      'Çadır önerir misin?',
    ]);
    expect(field(turns[2], 'failing', 0)).toMatchObject({
      check: 'price-grounded',
      origin: { stage: 'app' },
    });
    // The products the answer returned, which price-grounded compares with.
    expect(list(field(turns[2], 'answer', 'evidence', 'products')).length).toBeGreaterThan(0);
    expect(list(field(turns[2], 'calls')).map((call) => field(call, 'model'))).toEqual([
      'demo-writer-1',
      'demo-writer-1',
    ]);
  });

  it('shrinks it to the one turn that fails, as a proposed case', () => {
    expect(steps['shrink']).toMatchObject({
      outcome: 'written',
      case: `${SHRUNK}-min`,
      file: join(casesDir, `${SHRUNK}.min.yaml`),
      turns: ['Çadır önerir misin?'],
      target: { check: 'price-grounded', stage: 'app' },
    });
    expect(readFileSync(join(casesDir, `${SHRUNK}.min.yaml`), 'utf8')).toContain(
      'status: proposed',
    );
  });

  it('verify_fix: not fixed while the defect is in, fixed once it is out, and names regressions', () => {
    expect(steps['notYet']).toMatchObject({
      fixed: false,
      checked: [
        { id: SHRUNK, failsTarget: true },
        { id: `${SHRUNK}-min`, failsTarget: true },
      ],
    });
    expect(steps['fixed']).toMatchObject({
      fixed: true,
      checked: [
        { id: SHRUNK, status: 'pass', failsTarget: false },
        { id: `${SHRUNK}-min`, status: 'pass', failsTarget: false },
      ],
      regressions: [],
    });
    // The quality suite's failures aren't run, and are named for run_cases to check.
    expect(list(field(steps['fixed'], 'otherNotPassing')).map((c) => field(c, 'id'))).toEqual([
      'stoves-tr',
      'cheaper-follow-up-en',
    ]);
    expect(list(field(steps['fixed'], 'ran'))).toHaveLength(16);
    const regressions = list(field(steps['regressed'], 'regressions'));
    expect(regressions.map((c) => String(field(c, 'id'))).toSorted()).toEqual([
      'returns-en',
      'returns-tr',
      'shipping-tr',
      'warranty-en',
    ]);
    for (const c of regressions) expect(field(c, 'failing', 0, 'check')).toBe('json-schema');
  });

  it('claims nothing fixed in a run its cap cut short, then refuses runs, and keeps reading', () => {
    expect(capped[0]).toMatchObject({
      fixed: false,
      partial: true,
      checked: [{ id: 'tents-tr', status: 'pass', failsTarget: false }],
    });
    expect(String(field(capped[1], 'error'))).toMatch(
      /the session's cost cap of 0\.000001 USD is spent/u,
    );
    expect(field(capped[2], 'cases', 'length')).toBeGreaterThan(0);
  });

  it('stdout carries protocol messages only', () => {
    for (const line of client?.lines ?? []) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(client?.stderr.join('')).toContain(
      'yokla mcp: serving 22 cases of demo-shop over stdio, capped at 1 USD',
    );
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shop and the proxy, in yokla mcp or here (ADR-0003)', () => {
    const attempts = readFileSync(guardLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));
    expect(attempts.filter((attempt) => field(attempt, 'allowed') !== true)).toEqual([]);
    expect(new Set(attempts.map((attempt) => field(attempt, 'port')))).toEqual(
      new Set([shopPort, Number(new URL(proxyUrl).port)]),
    );
    expect((guard?.attempts ?? []).filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
