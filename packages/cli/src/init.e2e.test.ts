// yokla init end to end (ADR-0018): against the demo-shop, as its own process,
// init writes a profile that needs no edit for the starter cases. Once a
// person approves them, they run and gate; before that they run and don't
// gate. JSON answers, streamed answers and a session the shop issues all work.
// Everything runs behind a network guard that allows only the demo-shop.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCases, loadProfile } from './load.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const children: ChildProcess[] = [];
let guard: NetworkGuard | undefined;
let shop = '';

async function startShop(): Promise<string> {
  const child = spawn(process.execPath, [join(DEMO, 'src/main.ts'), '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
      if (url !== undefined) resolve(url);
    });
    child.on('exit', (code) => {
      reject(new Error(`demo-shop exited early with ${String(code)}`));
    });
  });
}

beforeAll(async () => {
  shop = await startShop();
  const port = Number(new URL(shop).port);
  guard = installNetworkGuard((host, p) => host === '127.0.0.1' && p === port);
}, 60_000);

afterAll(() => {
  guard?.uninstall();
  // Stop exactly the process these tests started, by its handle.
  for (const child of children) child.kill();
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const JSON_BODY = '{"message": "{{message}}", "sessionId": "{{session}}"}';

/** init into a new directory; returns it with what init said. */
async function init(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-init-'));
  const result = await cli(['init', '--url', `${shop}/v1/chat`, ...args, '--dir', dir]);
  return { ...result, dir };
}

function approve(dir: string): void {
  const path = join(dir, 'cases', 'starter.yaml');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replaceAll('status: proposed', 'status: approved'),
  );
}

async function runAndGate(dir: string) {
  const out = join(dir, 'runs', 'results.json');
  const run = await cli([
    'run',
    '--profile',
    join(dir, 'yokla.profile.yaml'),
    '--cases',
    join(dir, 'cases'),
    '--out',
    out,
  ]);
  const results = Results.parse(JSON.parse(readFileSync(out, 'utf8')));
  const gate = await cli(['gate', '--results', out]);
  return { run, gate, results };
}

// The runs wait out the demo-shop's rate limit (3 requests a second), as yokla does.
describe('yokla init against the demo-shop', { timeout: 60_000 }, () => {
  it('writes a profile and starter cases for a JSON answer, which run and gate once approved', async () => {
    const written = await init(['--body', JSON_BODY, '--language', 'en', '--language', 'tr']);
    expect(written.code, written.err).toBe(0);
    expect(written.out).toContain('answer text: $.data.answer');
    expect(written.out).toContain('yokla makes no model call');

    const { profile } = loadProfile(join(written.dir, 'yokla.profile.yaml'));
    expect(profile.target.response).toMatchObject({
      text: '$.data.answer',
      route: '$.data.metadata.route',
    });
    expect(profile.target.session.mode).toBe('client');
    const profileText = readFileSync(join(written.dir, 'yokla.profile.yaml'), 'utf8');
    expect(profileText).not.toContain('I can help');
    const cases = loadCases([join(written.dir, 'cases')]);
    expect(cases).toHaveLength(7);
    expect(cases.every((c) => c.provenance?.status === 'proposed')).toBe(true);
    expect(readFileSync(join(written.dir, '.gitignore'), 'utf8')).toBe('runs/\nyokla-data/\n');

    // Proposed: the cases run, and the gate leaves them out.
    const proposed = await runAndGate(written.dir);
    expect(proposed.results.cases.every((c) => c.review === 'proposed')).toBe(true);
    expect(proposed.gate.out).toContain('7 proposed cases not gating until a person approves');

    // Approved: every starter case passes, and the gate passes on them.
    approve(written.dir);
    const approved = await runAndGate(written.dir);
    expect(approved.run.code, approved.run.out).toBe(0);
    expect(approved.results.summary.statuses).toEqual({ pass: 7 });
    expect(approved.gate.code, approved.gate.out).toBe(0);
    expect(approved.gate.out).not.toContain('proposed');
  });

  it('reads a streamed answer, whose starter cases pass too', async () => {
    const written = await init(['--body', JSON_BODY, '--header', 'accept: text/event-stream']);
    expect(written.code, written.err).toBe(0);
    const { profile } = loadProfile(join(written.dir, 'yokla.profile.yaml'));
    expect(profile.target.response.stream).toEqual({
      format: 'sse',
      text: { event: 'delta', from: '$.text' },
      done: 'done',
    });
    expect(profile.target.response.route).toBe('$.last.done.route');
    approve(written.dir);
    const { results, gate } = await runAndGate(written.dir);
    expect(results.summary.statuses).toEqual({ pass: 6 });
    expect(gate.code).toBe(0);
  });

  it('opens the session the shop issues, and carries it to every turn', async () => {
    const written = await init([
      '--body',
      '{"message": "{{message}}"}',
      '--header',
      'x-session-id: {{carry.session}}',
      '--session-url',
      '/v1/sessions',
    ]);
    expect(written.code, written.err).toBe(0);
    const { profile } = loadProfile(join(written.dir, 'yokla.profile.yaml'));
    expect(profile.target.session).toMatchObject({
      mode: 'none',
      open: {
        request: { url: '/v1/sessions', body: {} },
        carry: [{ name: 'session', from: '$.data.sessionId' }],
      },
    });
    approve(written.dir);
    const { results } = await runAndGate(written.dir);
    expect(results.summary.statuses).toEqual({ pass: 6 });
  });

  it('never overwrites a file without --force', async () => {
    const written = await init(['--body', JSON_BODY]);
    const path = join(written.dir, 'yokla.profile.yaml');
    writeFileSync(path, '# mine\n');
    const again = await cli([
      'init',
      '--url',
      `${shop}/v1/chat`,
      '--body',
      JSON_BODY,
      '--dir',
      written.dir,
    ]);
    expect(again.code).toBe(2);
    expect(again.err).toContain('already exist; --force overwrites');
    expect(readFileSync(path, 'utf8')).toBe('# mine\n');
    const forced = await cli([
      'init',
      '--url',
      `${shop}/v1/chat`,
      '--body',
      JSON_BODY,
      '--dir',
      written.dir,
      '--force',
    ]);
    expect(forced.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('text: $.data.answer');
  });

  it('writes nothing when the probe fails, and says what the answer held', async () => {
    // Without a session id the shop answers 400.
    const failed = await init(['--body', '{"message": "{{message}}"}']);
    expect(failed.code).toBe(2);
    expect(failed.err).toContain('yokla init wrote nothing: the target answered 400');
    expect(readdirSync(failed.dir)).toEqual([]);
  });

  it('reads the answer where --text says, and nowhere else', async () => {
    const given = await init(['--body', JSON_BODY, '--text', '$.data.answer']);
    expect(given.code, given.err).toBe(0);
    expect(readFileSync(join(given.dir, 'yokla.profile.yaml'), 'utf8')).toContain(
      '# given with --text',
    );
    const wrong = await init(['--body', JSON_BODY, '--text', '$.data.nope']);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain('no text at $.data.nope');
    expect(existsSync(join(wrong.dir, 'yokla.profile.yaml'))).toBe(false);
  });

  it('refuses a request that never sends the message, and an unknown language', async () => {
    const silent = await init(['--body', '{"text": "hi"}']);
    expect(silent.code).toBe(2);
    expect(silent.err).toContain('the request never sends {{message}}');
    const unknown = await init(['--body', JSON_BODY, '--language', 'de']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('--language is tr or en');
    expect((await cli(['init'])).err).toContain('--url is required');
  });

  it('contacts nothing but the demo-shop', () => {
    expect(guard?.attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
