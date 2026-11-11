import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSchemas,
  CORE_CHECKS,
  Results,
  z,
  type Case,
  type Check,
  type DomainPack,
  type Profile,
  type PromptStorage,
  type ProxyRecord,
} from '@yokla/core';
import { stubLanguagePack } from '@yokla/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, runSuite, type RunOptions } from './run.ts';

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}
type Reply = (received: Received, index: number, response: ServerResponse) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const servers: Server[] = [];

async function target(reply: Reply): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text === '' ? {} : JSON.parse(text);
      const entry = { headers: request.headers, body: isRecord(body) ? body : {} };
      received.push(entry);
      reply(entry, received.length - 1, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return { url: `http://127.0.0.1:${String(address.port)}/chat`, received };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const { profile: profileSchema, caseFile } = buildSchemas({
  languages: ['tr', 'en'],
  domainPacks: [{ id: 'shop', expectations: { answerable: z.boolean() } }],
});

function profile(url: string, targetChange: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    version: 1,
    target: {
      name: 'fake',
      adapter: 'http',
      request: { url, body: { message: '{{message}}', sessionId: '{{session}}' } },
      response: {
        text: '$.answer',
        route: '$.route',
        evidence: {
          items: {
            items: '$.items[*]',
            fields: { id: 'id', price: { from: 'price', as: 'number' } },
          },
        },
      },
      ...targetChange,
    },
    languages: ['tr'],
    domain: 'shop',
  });
}

function cases(...list: Record<string, unknown>[]): Case[] {
  return caseFile.parse({
    version: 1,
    cases: list.map((c, index) => ({
      id: `c${String(index)}`,
      suite: 'quality',
      language: 'tr',
      ...c,
    })),
  }).cases;
}

let counter = 0;
function options(p: Profile, c: Case[], change: Partial<RunOptions> = {}): RunOptions {
  return {
    profile: p,
    profileSha256: 'a'.repeat(64),
    profileDir: tmpdir(),
    cases: c,
    env: {},
    yoklaVersion: '0.0.0-test',
    ids: () => `id-${String((counter += 1)).padStart(8, '0')}`,
    ...change,
  };
}

const answer = (extra: Record<string, unknown> = {}) => ({
  answer: 'Tamam',
  route: 'search',
  items: [{ id: 'P1', price: '19.90' }],
  ...extra,
});

describe('runSuite', () => {
  it('runs a case and produces valid results.v1, unmeasured until checks run', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const results = await runSuite(
      options(profile(t.url), cases({ turns: [{ user: 'Çadır var mı?' }] })),
    );
    expect(Results.safeParse(results).success).toBe(true);
    expect(t.received[0]?.body).toMatchObject({ message: 'Çadır var mı?' });
    const turn = results.cases[0]?.samples[0]?.turns[0];
    expect(turn?.response).toMatchObject({
      status: 200,
      text: 'Tamam',
      route: 'search',
      evidence: { items: [{ id: 'P1', price: 19.9 }] },
    });
    expect(results.cases[0]?.status).toBe('unmeasured');
    expect(results.summary).toEqual({ cases: 1, statuses: { unmeasured: 1 } });
    expect(results.run).toMatchObject({
      correlation: 'none',
      partial: false,
      profile: { target: 'fake' },
    });
  });

  it("records each case's definition hash, which follows what decides the verdict", async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const hashes = async (...list: Record<string, unknown>[]) =>
      (await runSuite(options(profile(t.url), cases(...list)))).cases.map(
        (c) => c.definitionSha256,
      );
    const plain = { turns: [{ user: 'a', expect: { answerable: true } }] };
    const [first] = await hashes(plain);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      await hashes(plain, { ...plain, title: 'Same case, other title', tags: ['smoke'] }),
    ).toEqual([first, first]);
    const [stricter] = await hashes({ turns: [{ user: 'a', expect: { answerable: false } }] });
    expect(stricter).not.toBe(first);
  });

  it('carries a server-issued id into the next turn and keeps the session', async () => {
    const t = await target((received, index, response) => {
      json(
        response,
        answer({ conversationId: index === 0 ? 'conv-1' : received.body['conversationId'] }),
      );
    });
    const p = profile(t.url, {
      request: {
        url: t.url,
        body: {
          message: '{{message}}',
          sessionId: '{{session}}',
          conversationId: '{{carry.conversationId}}',
        },
      },
      session: { carry: [{ name: 'conversationId', from: '$.conversationId' }] },
    });
    await runSuite(options(p, cases({ turns: [{ user: 'Mont' }, { user: 'daha ucuz?' }] })));
    expect(t.received.map((r) => r.body['conversationId'])).toEqual([undefined, 'conv-1']);
    expect(t.received[0]?.body['sessionId']).toBe(t.received[1]?.body['sessionId']);
  });

  it('sends a request id, records it, and maps the target id', async () => {
    const t = await target((received, _i, response) => {
      json(response, answer({ requestId: received.headers['x-request-id'] }));
    });
    const p = profile(t.url, {
      request: {
        url: t.url,
        body: { message: '{{message}}' },
        requestId: { header: 'x-request-id' },
      },
      response: { text: '$.answer', id: '$.requestId' },
    });
    const results = await runSuite(options(p, cases({ turns: [{ user: 'x' }] })));
    const turn = results.cases[0]?.samples[0]?.turns[0];
    expect(turn?.requestId).toMatch(/^id-\d{8}$/u);
    expect(turn?.response?.id).toBe(turn?.requestId);
  });

  it('bypasses the cache with a header on every request', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const p = profile(t.url, { cacheBypass: { kind: 'header', name: 'x-cache-bypass' } });
    await runSuite(options(p, cases({ turns: [{ user: 'a' }, { user: 'b' }] })));
    expect(t.received.map((r) => r.headers['x-cache-bypass'])).toEqual(['1', '1']);
  });

  it('runs the cache-bypass command once per sample, in the profile directory', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const dir = mkdtempSync(join(tmpdir(), 'yokla-run-'));
    const run = [process.execPath, '-e', 'require("fs").appendFileSync("flush.log", "x")'];
    const p = profile(t.url, { cacheBypass: { kind: 'command', run } });
    await runSuite(
      options(p, cases({ samples: 3, turns: [{ user: 'a' }, { user: 'b' }] }), { profileDir: dir }),
    );
    expect(readFileSync(join(dir, 'flush.log'), 'utf8')).toBe('xxx');
    expect(t.received).toHaveLength(6);
  });

  it('gives each sample its own session', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const results = await runSuite(
      options(profile(t.url), cases({ turns: [{ user: 'a' }] }), { samples: 3 }),
    );
    expect(results.cases[0]?.samples).toHaveLength(3);
    expect(new Set(t.received.map((r) => r.body['sessionId'])).size).toBe(3);
  });

  it('stops a sample at a failed turn and marks the case as an error', async () => {
    const t = await target((_r, _i, response) => {
      json(response, { message: 'boom' }, 500);
    });
    const results = await runSuite(
      options(profile(t.url), cases({ turns: [{ user: 'a' }, { user: 'b' }] })),
    );
    const sample = results.cases[0]?.samples[0];
    expect(sample?.turns).toHaveLength(1);
    expect(sample?.turns[0]?.error).toBe('HTTP 500');
    expect(results.cases[0]?.status).toBe('error');
    expect(t.received).toHaveLength(1);
  });

  it('reports a response that is not JSON or has no answer text', async () => {
    const t = await target((_r, index, response) => {
      if (index === 0) response.end('<html>oops</html>');
      else json(response, { reply: 'no answer field' });
    });
    const results = await runSuite(
      options(profile(t.url), cases({ turns: [{ user: 'a' }] }, { turns: [{ user: 'b' }] })),
    );
    expect(results.cases.map((c) => c.samples[0]?.turns[0]?.error)).toEqual([
      'the response is not JSON',
      'answer text not found at $.answer',
    ]);
  });

  it('keeps non-fatal mapping problems as issues', async () => {
    const t = await target((_r, _i, response) => {
      json(response, { answer: 'ok', items: [] });
    });
    const results = await runSuite(options(profile(t.url), cases({ turns: [{ user: 'a' }] })));
    const turn = results.cases[0]?.samples[0]?.turns[0];
    expect(turn?.error).toBeUndefined();
    expect(turn?.issues).toEqual(['route not found at $.route']);
  });

  it('checks the configuration before contacting the target', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const p = profile(t.url, {
      request: {
        url: t.url,
        headers: { authorization: 'Bearer {{env.TOKEN}}' },
        body: { m: '{{mesage}}' },
      },
    });
    const run = runSuite(
      options(
        p,
        cases(
          { id: 'dup', turns: [{ user: 'a' }] },
          { id: 'dup', language: 'en', turns: [{ user: 'b' }] },
        ),
      ),
    );
    await expect(run).rejects.toBeInstanceOf(ConfigError);
    await expect(run).rejects.toThrow(
      /unknown placeholder \{\{mesage\}\}[\s\S]*TOKEN is not set[\s\S]*"dup" is used more than once[\s\S]*doesn't list/u,
    );
    expect(t.received).toHaveLength(0);
  });

  it('refuses an expectation on an evidence collection the profile does not map', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const c = cases({ turns: [{ user: 'a', expect: { evidence: { offers: { min: 1 } } } }] });
    await expect(runSuite(options(profile(t.url), c))).rejects.toThrow(
      /expects evidence "offers", which the profile doesn't map/u,
    );
    expect(t.received).toHaveLength(0);
  });

  it('marks a clarifying question and does not hold it to product expectations', async () => {
    const t = await target((_r, _i, response) => {
      json(response, { answer: 'Tek çocuk için mi?', route: 'clarification', items: [] });
    });
    const p = profile(t.url, {
      response: {
        text: '$.answer',
        route: '$.route',
        clarification: { routes: ['clarification'] },
        evidence: { items: { items: '$.items[*]', fields: { id: 'id' } } },
      },
    });
    const results = await runSuite(
      options(p, cases({ turns: [{ user: 'a', expect: { evidence: { items: { min: 1 } } } }] }), {
        checks: CORE_CHECKS,
      }),
    );
    const turn = results.cases[0]?.samples[0]?.turns[0];
    expect(turn?.clarifying).toBe(true);
    expect(turn?.checks.find((c) => c.check === 'evidence-count')).toMatchObject({
      applicable: false,
    });
    expect(results.cases[0]?.status).toBe('unmeasured');
  });

  it('sends a TEST-NET client address per case when configured', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const p = profile(t.url, {
      limits: { clientIdentity: { header: 'x-forwarded-for', pool: 'test-net' } },
    });
    await runSuite(
      options(p, cases({ turns: [{ user: 'a' }, { user: 'b' }] }, { turns: [{ user: 'c' }] })),
    );
    expect(t.received.map((r) => r.headers['x-forwarded-for'])).toEqual([
      '192.0.2.1',
      '192.0.2.1',
      '192.0.2.2',
    ]);
  });

  it('runs cases in parallel and keeps their order', async () => {
    const t = await target((received, _i, response) => {
      setTimeout(
        () => {
          json(response, answer({ answer: String(received.body['message']) }));
        },
        received.body['message'] === 'slow' ? 50 : 0,
      );
    });
    const results = await runSuite(
      options(profile(t.url), cases({ turns: [{ user: 'slow' }] }, { turns: [{ user: 'fast' }] }), {
        concurrency: 2,
      }),
    );
    expect(results.cases.map((c) => c.samples[0]?.turns[0]?.response?.text)).toEqual([
      'slow',
      'fast',
    ]);
  });

  it('can target another url and refuses nothing else', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const results = await runSuite(
      options(profile('http://127.0.0.1:1/chat'), cases({ turns: [{ user: 'a' }] }), {
        targetUrl: t.url,
      }),
    );
    expect(results.cases[0]?.status).toBe('unmeasured');
    expect(t.received).toHaveLength(1);
  });
});

function dirWithWord(word: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-packs-'));
  writeFileSync(join(dir, 'word.txt'), word);
  return dir;
}

describe('runSuite with packs', () => {
  const seen: { history: number; lang: string | undefined; expect: unknown }[] = [];

  function shopPack(word: string | Error): DomainPack {
    return {
      id: 'shop',
      dimensions: { mention: 'majority-of-n' },
      prepare: (_profile, io) => {
        if (word instanceof Error) throw word;
        const expected = io.readText('word.txt').trim() || word;
        const check: Check = {
          id: 'mentions-word',
          description: 'the answer mentions the word',
          run: (context) => {
            seen.push({
              history: context.history.length,
              lang: context.lang?.language,
              expect: context.turn.expect['answerable'],
            });
            if (context.turn.response.text === 'skip')
              return { applicable: false, reason: 'skipped' };
            return {
              applicable: true,
              findings: [
                {
                  dimension: 'mention',
                  verdict: context.turn.response.text.includes(expected) ? 'pass' : 'fail',
                  severity: 'medium',
                  message: `looked for ${expected}`,
                },
              ],
            };
          },
        };
        return { checks: [check] };
      },
    };
  }

  it('runs the pack checks, aggregates per dimension and summarises', async () => {
    const t = await target((received, _i, response) => {
      json(response, answer({ answer: String(received.body['message']) }));
    });
    const results = await runSuite(
      options(
        profile(t.url),
        cases({ turns: [{ user: 'say tent' }] }, { turns: [{ user: 'say boot' }] }),
        {
          packs: [shopPack('unused')],
          profileDir: dirWithWord('tent'),
        },
      ),
    );
    expect(results.cases.map((c) => c.status)).toEqual(['pass', 'fail']);
    expect(results.cases[1]?.dimensions).toEqual([
      { dimension: 'mention', policy: 'majority-of-n', verdict: 'fail', samples: 1, failed: 1 },
    ]);
    expect(results.checks).toEqual([
      { check: 'mentions-word', applied: 2, notApplicable: 0, passed: 1, failed: 1, errors: 0 },
    ]);
    expect(results.summary.statuses).toEqual({ pass: 1, fail: 1 });
  });

  it('gives checks the earlier turns, the language pack and the expectations', async () => {
    seen.length = 0;
    const t = await target((_r, _i, response) => {
      json(response, answer({ answer: 'tent' }));
    });
    await runSuite(
      options(
        profile(t.url),
        cases({ turns: [{ user: 'a', expect: { answerable: true } }, { user: 'b' }] }),
        {
          packs: [shopPack('tent')],
          languages: [stubLanguagePack('tr')],
          profileDir: dirWithWord(''),
        },
      ),
    );
    expect(seen).toEqual([
      { history: 0, lang: 'tr', expect: true },
      { history: 1, lang: 'tr', expect: undefined },
    ]);
  });

  it('is unmeasured when the pack check never applies', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer({ answer: 'skip' }));
    });
    const results = await runSuite(
      options(profile(t.url), cases({ turns: [{ user: 'a' }] }), {
        packs: [shopPack('x')],
        profileDir: dirWithWord(''),
      }),
    );
    expect(results.cases[0]?.status).toBe('unmeasured');
    expect(results.checks[0]).toMatchObject({ applied: 0, notApplicable: 1 });
  });

  it('refuses to run without the domain pack, with a failing pack, or with duplicate checks', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const c = cases({ turns: [{ user: 'a' }] });
    const other: DomainPack = { id: 'bank', dimensions: {}, prepare: () => ({ checks: [] }) };
    await expect(runSuite(options(profile(t.url), c, { packs: [other] }))).rejects.toThrow(
      /no domain pack "shop"/u,
    );
    await expect(
      runSuite(options(profile(t.url), c, { packs: [shopPack(new Error('catalog missing'))] })),
    ).rejects.toThrow(/pack "shop": catalog missing/u);
    const pack = shopPack('x');
    const prepared = pack.prepare(profile(t.url), { readText: () => 'x' });
    await expect(
      runSuite(
        options(profile(t.url), c, {
          packs: [pack],
          checks: prepared.checks,
          profileDir: dirWithWord('x'),
        }),
      ),
    ).rejects.toThrow(/check "mentions-word" is defined twice/u);
    expect(t.received).toHaveLength(0);
  });
});

const telemetry = (requestId: unknown, costs: (number | null)[]) =>
  `[Telemetry] ${JSON.stringify({
    requestId,
    modelCallUsage: costs.map((costUsd) => ({ costUsd })),
    cacheHit: false,
  })}\n`;

const logs = (change: Record<string, unknown> = {}) => ({
  source: { kind: 'file', path: 'app.log' },
  contains: '[Telemetry]',
  correlate: { by: 'request-id' },
  fields: {
    costUsd: { from: '$.modelCallUsage[*].costUsd', reduce: 'sum' },
    cacheHit: '$.cacheHit',
  },
  ...change,
});

function logged(url: string, change: Record<string, unknown> = {}): Profile {
  return profile(url, {
    request: { url, body: { message: '{{message}}' }, requestId: { header: 'x-request-id' } },
    observe: { logs: logs(change) },
  });
}

describe('runSuite with target logs', () => {
  const observedByChecks: unknown[] = [];
  const observing: Check = {
    id: 'sees-observed',
    description: 'records what the logs observed',
    run: (context) => {
      observedByChecks.push(context.turn.observed);
      return { applicable: false, reason: 'records only' };
    },
  };

  it('ties each turn to its log line, totals the numbers and shows them to the checks', async () => {
    observedByChecks.length = 0;
    const dir = mkdtempSync(join(tmpdir(), 'yokla-logs-'));
    const log = join(dir, 'app.log');
    writeFileSync(log, 'booting\n');
    const t = await target((received, _i, response) => {
      appendFileSync(log, `[Http] {"requestId":"${String(received.headers['x-request-id'])}"}\n`);
      appendFileSync(log, telemetry(received.headers['x-request-id'], [0.25, 0.5]));
      json(response, answer());
    });
    const results = await runSuite(
      options(logged(t.url), cases({ turns: [{ user: 'a' }, { user: 'b' }] }), {
        profileDir: dir,
        logSettleMs: 0,
        checks: [observing],
      }),
    );
    expect(Results.safeParse(results).success).toBe(true);
    const fields = { costUsd: 0.75, cacheHit: false };
    expect(results.cases[0]?.samples[0]?.turns.map((turn) => turn.observed)).toEqual([
      { source: 'target-logs', correlation: 'request-id', fields },
      { source: 'target-logs', correlation: 'request-id', fields },
    ]);
    expect(observedByChecks).toEqual([fields, fields]);
    expect(results.run.observation).toEqual({
      source: 'target-logs',
      correlation: 'request-id',
      lines: 2,
      matched: 2,
      unmatched: 0,
      totals: { costUsd: 1.5 },
      missing: {},
    });
    expect(results.run.issues).toBeUndefined();
  });

  it('reports a turn without a log line instead of skipping it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-logs-'));
    const log = join(dir, 'app.log');
    writeFileSync(log, '');
    const t = await target((received, index, response) => {
      if (index === 0) appendFileSync(log, telemetry(received.headers['x-request-id'], [0.1]));
      json(response, answer());
    });
    const results = await runSuite(
      options(logged(t.url), cases({ turns: [{ user: 'a' }] }, { turns: [{ user: 'b' }] }), {
        profileDir: dir,
        logSettleMs: 0,
      }),
    );
    const [first, second] = results.cases.map((c) => c.samples[0]?.turns[0]);
    expect(first?.observed?.fields).toEqual({ costUsd: 0.1, cacheHit: false });
    expect(first?.issues).toBeUndefined();
    expect(second?.observed).toBeUndefined();
    expect(second?.issues).toEqual(['no matching line in the target logs']);
    expect(results.run.observation).toMatchObject({ lines: 1, matched: 1, unmatched: 1 });
  });

  it("ties turns by the target's id, or by order", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-logs-'));
    const log = join(dir, 'app.log');
    writeFileSync(log, '');
    const t = await target((_r, index, response) => {
      appendFileSync(log, telemetry(`srv-${String(index)}`, [index]));
      json(response, answer({ requestId: `srv-${String(index)}` }));
    });
    const twoCases = cases({ turns: [{ user: 'a' }] }, { turns: [{ user: 'b' }] });
    const byTargetId = profile(t.url, {
      response: { text: '$.answer', id: '$.requestId' },
      observe: { logs: logs({ correlate: { by: 'target-id' } }) },
    });
    const first = await runSuite(
      options(byTargetId, twoCases, { profileDir: dir, logSettleMs: 0 }),
    );
    expect(first.cases.map((c) => c.samples[0]?.turns[0]?.observed?.fields['costUsd'])).toEqual([
      0, 1,
    ]);

    writeFileSync(log, '');
    const byOrder = profile(t.url, { observe: { logs: logs({ correlate: { by: 'order' } }) } });
    const second = await runSuite(options(byOrder, twoCases, { profileDir: dir, logSettleMs: 0 }));
    expect(second.cases.map((c) => c.samples[0]?.turns[0]?.observed)).toEqual([
      { source: 'target-logs', correlation: 'order', fields: { costUsd: 2, cacheHit: false } },
      { source: 'target-logs', correlation: 'order', fields: { costUsd: 3, cacheHit: false } },
    ]);
  });

  it('counts the fields a line has no value for, and leaves them out of the totals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-logs-'));
    const log = join(dir, 'app.log');
    writeFileSync(log, '');
    const t = await target((received, index, response) => {
      appendFileSync(
        log,
        telemetry(received.headers['x-request-id'], index === 0 ? [null] : [0.3]),
      );
      json(response, answer());
    });
    const results = await runSuite(
      options(logged(t.url), cases({ turns: [{ user: 'a' }, { user: 'b' }] }), {
        profileDir: dir,
        logSettleMs: 0,
      }),
    );
    expect(results.cases[0]?.samples[0]?.turns.map((turn) => turn.observed?.fields)).toEqual([
      { costUsd: null, cacheHit: false },
      { costUsd: 0.3, cacheHit: false },
    ]);
    expect(results.run.observation).toMatchObject({
      matched: 2,
      totals: { costUsd: 0.3 },
      missing: { costUsd: 1 },
    });
  });

  it('leaves out turns the target never answered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-logs-'));
    const log = join(dir, 'app.log');
    writeFileSync(log, '');
    const t = await target((_r, index, response) => {
      if (index === 0) {
        response.socket?.destroy();
        return;
      }
      appendFileSync(log, telemetry('any', [0.4]));
      json(response, answer());
    });
    const byOrder = profile(t.url, { observe: { logs: logs({ correlate: { by: 'order' } }) } });
    const results = await runSuite(
      options(byOrder, cases({ turns: [{ user: 'a' }] }, { turns: [{ user: 'b' }] }), {
        profileDir: dir,
        logSettleMs: 0,
      }),
    );
    const [lost, answered] = results.cases.map((c) => c.samples[0]?.turns[0]);
    expect(lost?.response).toBeUndefined();
    expect(lost?.error).toBeDefined();
    expect(lost?.issues).toBeUndefined();
    expect(answered?.observed?.fields).toEqual({ costUsd: 0.4, cacheHit: false });
    expect(results.run.observation).toMatchObject({ lines: 1, matched: 1, unmatched: 0 });
  });

  it('waits for the logs to settle before reading them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-logs-'));
    const log = join(dir, 'app.log');
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const slept: number[] = [];
    const clock = {
      now: () => performance.now(),
      sleep: (ms: number) => {
        slept.push(ms);
        writeFileSync(log, telemetry(t.received[0]?.headers['x-request-id'], [0.2]));
        return Promise.resolve();
      },
    };
    const results = await runSuite(
      options(logged(t.url), cases({ turns: [{ user: 'a' }] }), {
        profileDir: dir,
        logSettleMs: 250,
        clock,
      }),
    );
    expect(slept).toEqual([250]);
    expect(results.run.observation?.matched).toBe(1);
  });

  it('keeps the run when the logs cannot be read, and says so', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const results = await runSuite(
      options(logged(t.url), cases({ turns: [{ user: 'a' }] }), {
        profileDir: mkdtempSync(join(tmpdir(), 'yokla-logs-')),
        logSettleMs: 0,
      }),
    );
    expect(Results.safeParse(results).success).toBe(true);
    expect(results.run.observation).toBeUndefined();
    expect(results.run.issues).toEqual([
      expect.stringMatching(/^the target's logs could not be read: .*ENOENT/u),
    ]);
    const turn = results.cases[0]?.samples[0]?.turns[0];
    expect(turn?.observed).toBeUndefined();
    expect(turn?.issues).toBeUndefined();
    expect(results.cases[0]?.status).toBe('unmeasured');
  });

  it('refuses a correlation the profile cannot support, before any request', async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const c = cases({ turns: [{ user: 'a' }] });
    const noRequestId = profile(t.url, { observe: { logs: logs() } });
    await expect(runSuite(options(noRequestId, c))).rejects.toThrow(
      /correlates by request id, but request.requestId is not configured/u,
    );
    const noTargetId = profile(t.url, {
      observe: { logs: logs({ correlate: { by: 'target-id' } }) },
    });
    await expect(runSuite(options(noTargetId, c))).rejects.toThrow(
      /correlates by target id, but response.id is not mapped/u,
    );
    const byOrder = profile(t.url, { observe: { logs: logs({ correlate: { by: 'order' } }) } });
    await expect(runSuite(options(byOrder, c, { concurrency: 2 }))).rejects.toThrow(
      /correlates by order, which needs a concurrency of 1/u,
    );
    await expect(
      runSuite(options(byOrder, c, { concurrency: 1, logSettleMs: 0 })),
    ).resolves.toBeDefined();
    expect(t.received).toHaveLength(1);
  });
});

interface FakeProxy {
  readonly url: string;
  readonly records: ProxyRecord[];
  readonly calls: string[];
  /** The turn the runner last marked as in flight. */
  readonly mark: () => string | null;
  /** What the runner told the proxy about each turn. */
  readonly armed: { turn: string; body: unknown }[];
}

/** A stand-in for the proxy's control endpoint; the fake target adds its records. */
async function fakeProxy(
  answers: { health?: unknown; open?: number; close?: number } = {},
): Promise<FakeProxy> {
  const records: ProxyRecord[] = [];
  const calls: string[] = [];
  let mark: string | null = null;
  const armed: { turn: string; body: unknown }[] = [];
  const server = createServer((request, response) => {
    const key = `${request.method ?? ''} ${(request.url ?? '').split('?')[0] ?? ''}`;
    calls.push(key);
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (key === 'GET /_yokla/health') {
      reply(200, answers.health ?? { ok: true, upstreams: ['fake'], recording: false });
    } else if (key === 'POST /_yokla/recordings') {
      const status = answers.open ?? 201;
      reply(
        status,
        status === 201 ? { id: 'rec-1', startedAt: new Date().toISOString() } : { error: 'busy' },
      );
    } else if (key.startsWith('PUT /_yokla/recordings/rec-1/turns/')) {
      const turn = decodeURIComponent(key.slice('PUT /_yokla/recordings/rec-1/turns/'.length));
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        armed.push({ turn, body });
        if (Reflect.get(Object(body), 'inFlight') === true) mark = turn;
        reply(200, { id: 'rec-1', turn });
      });
    } else if (key === 'GET /_yokla/recordings/rec-1') {
      reply(200, { id: 'rec-1', startedAt: 'x', records });
    } else if (key === 'DELETE /_yokla/recordings/rec-1') {
      const status = answers.close ?? 200;
      reply(status, status === 200 ? { id: 'rec-1', startedAt: 'x', records } : { error: 'gone' });
    } else reply(404, { error: 'nope' });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    records,
    calls,
    mark: () => mark,
    armed,
  };
}

function call(trace: string | null, mark: string | null, model = 'm'): ProxyRecord {
  return {
    id: `call-${String((counter += 1))}`,
    upstream: 'fake',
    kind: 'openai-compatible',
    method: 'POST',
    path: '/chat/completions',
    model,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    status: 200,
    stream: false,
    usage: { input: 1000, output: 100, cachedInput: null, cacheWrite: null, reasoning: null },
    trace,
    mark,
  };
}

const proxied = (url: string, correlation: 'serial' | 'header'): Profile => ({
  ...profile(url, {
    request: { url, body: { message: '{{message}}' }, requestId: { header: 'x-request-id' } },
  }),
  modelProxy: {
    port: 1,
    upstreams: [{ id: 'fake', kind: 'openai-compatible', upstream: 'http://127.0.0.1:9/v1' }],
    correlation,
    prompts: { store: 'sizes' },
  },
});

/** Writes server-sent events, one write per event, a little apart. */
function events(response: ServerResponse, list: [string, unknown][]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const write = (index: number) => {
    const entry = list[index];
    if (entry === undefined) {
      response.end();
      return;
    }
    response.write(`event: ${entry[0]}\ndata: ${JSON.stringify(entry[1])}\n\n`);
    setTimeout(() => {
      write(index + 1);
    }, 5);
  };
  write(0);
}

const STREAMED = {
  stream: {
    format: 'sse',
    text: { event: 'text_delta', from: '$.text' },
    done: 'turn_complete',
    error: { event: 'error', from: '$.message' },
  },
  text: '$.text',
  route: '$.last.turn_complete.route',
  evidence: {
    items: { items: '$.all.ui[*].items[*]', fields: { id: 'id', price: 'price' } },
  },
};

describe('runSuite with a streaming target (ADR-0016)', () => {
  it('reads the answer, route and evidence from the stream, and times the first text', async () => {
    const t = await target((received, _i, response) => {
      const conversation = received.body['conversation'];
      events(response, [
        ['ui', { items: [{ id: 'P1', price: 19.9 }] }],
        ['text_delta', { text: 'Ta' }],
        ['text_delta', { text: 'mam' }],
        ['turn_complete', { route: 'search', conversation: conversation ?? 'c-1' }],
      ]);
    });
    const streaming = profile(t.url, {
      request: {
        url: t.url,
        body: { message: '{{message}}', conversation: '{{carry.conversation}}' },
      },
      response: STREAMED,
      session: {
        mode: 'none',
        carry: [{ name: 'conversation', from: '$.last.turn_complete.conversation' }],
      },
    });
    const results = await runSuite(
      options(
        streaming,
        cases({ turns: [{ user: 'a', expect: { route: 'search' } }, { user: 'b' }] }),
        { checks: CORE_CHECKS },
      ),
    );
    expect(Results.safeParse(results).success).toBe(true);
    const [first, second] = results.cases[0]?.samples[0]?.turns ?? [];
    expect(first?.response).toMatchObject({
      text: 'Tamam',
      route: 'search',
      evidence: { items: [{ id: 'P1', price: 19.9 }] },
    });
    const firstText = first?.response?.firstTextMs ?? -1;
    expect(firstText).toBeGreaterThan(0);
    expect(firstText).toBeLessThan(first?.response?.latencyMs ?? 0);
    expect(first?.checks.find((c) => c.check === 'route-expected')?.findings[0]?.verdict).toBe(
      'pass',
    );
    // The value carried from the first turn's stream reached the second request.
    expect(t.received.map((r) => r.body['conversation'])).toEqual([undefined, 'c-1']);
    expect(second?.error).toBeUndefined();
  });

  it('calls an answer incomplete when its stream ends early or reports an error', async () => {
    const t = await target((received, _i, response) => {
      events(
        response,
        received.body['message'] === 'cut'
          ? [['text_delta', { text: 'Ta' }]]
          : [
              ['text_delta', { text: 'Ta' }],
              ['error', { message: 'model overloaded' }],
              ['turn_complete', {}],
            ],
      );
    });
    const streaming = profile(t.url, { response: STREAMED });
    const results = await runSuite(
      options(streaming, cases({ turns: [{ user: 'cut' }] }, { turns: [{ user: 'error' }] })),
    );
    expect(results.cases.map((c) => c.samples[0]?.turns[0]?.error)).toEqual([
      'the stream ended before its "turn_complete" event',
      'the stream reported an error: model overloaded',
    ]);
    expect(results.cases.map((c) => c.status)).toEqual(['error', 'error']);
  });
});

describe('runSuite with the model proxy', () => {
  const prices = { fake: { m: { input: 1, output: 10 } } };

  it('ties the calls made while each request was in flight to its turn, and prices them', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      // The proxy tags each call with the turn marked when it arrives.
      proxy.records.push(call(null, proxy.mark()), call(null, proxy.mark(), 'unpriced'));
      json(response, answer());
    });
    const results = await runSuite(
      options(proxied(t.url, 'serial'), cases({ turns: [{ user: 'a' }, { user: 'b' }] }), {
        proxyUrl: proxy.url,
        prices,
      }),
    );
    expect(Results.safeParse(results).success).toBe(true);
    const turns = results.cases[0]?.samples[0]?.turns ?? [];
    expect(turns.map((turn) => turn.proxy?.calls.map((c) => c.costUsd))).toEqual([
      [0.002, null],
      [0.002, null],
    ]);
    expect(turns[0]?.proxy).toMatchObject({ correlation: 'serial', costUsd: null });
    expect(results.run.correlation).toBe('serial');
    expect(results.run.proxy).toEqual({
      correlation: 'serial',
      records: 4,
      attributed: 4,
      unattributed: 0,
      totals: { calls: 4, inputTokens: 4000, outputTokens: 400, costUsd: 0.004 },
      missing: { cachedInputTokens: 4, cacheWriteTokens: 4, reasoningTokens: 4, costUsd: 2 },
      prompts: 'sizes',
    });
    expect(proxy.calls.map((c) => c.replace(/turns\/.+$/u, 'turns/<turn>'))).toEqual([
      'GET /_yokla/health',
      'POST /_yokla/recordings',
      'PUT /_yokla/recordings/rec-1/turns/<turn>',
      'PUT /_yokla/recordings/rec-1/turns/<turn>',
      'DELETE /_yokla/recordings/rec-1',
    ]);
    expect(proxy.armed.map((a) => a.body)).toEqual([
      { inFlight: true, faults: [] },
      { inFlight: true, faults: [] },
    ]);
    // Each turn was marked with its own request id.
    expect(turns.map((turn) => turn.requestId)).not.toContain(undefined);
  });

  it('keeps of each prompt only what the profile stores, and says which', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      proxy.records.push(
        { ...call(null, proxy.mark()), prompt: [{ role: 'user', chars: 5, text: 'gizli' }] },
        { ...call(null, proxy.mark()), prompt: null },
        call(null, proxy.mark()),
      );
      json(response, answer());
    });
    const run = async (prompts: PromptStorage) => {
      proxy.records.splice(0);
      const base = proxied(t.url, 'serial');
      const stored: Profile =
        base.modelProxy === undefined
          ? base
          : { ...base, modelProxy: { ...base.modelProxy, prompts } };
      const results = await runSuite(
        options(stored, cases({ turns: [{ user: 'a' }] }), { proxyUrl: proxy.url }),
      );
      expect(Results.safeParse(results).success).toBe(true);
      expect(results.run.proxy?.prompts).toBe(prompts.store);
      return {
        prompts: results.cases[0]?.samples[0]?.turns[0]?.proxy?.calls.map((c) => c.prompt),
        json: JSON.stringify(results),
      };
    };
    const sha = createHash('sha256').update('gizli', 'utf8').digest('hex');
    const sized = await run({ store: 'sizes' });
    expect(sized.prompts).toEqual([[{ role: 'user', chars: 5 }], null, undefined]);
    expect(sized.json).not.toContain('gizli');
    expect((await run({ store: 'hashed' })).prompts?.[0]).toEqual([
      { role: 'user', chars: 5, sha256: sha },
    ]);
    expect((await run({ store: 'redacted', redact: ['iz'] })).prompts?.[0]).toEqual([
      { role: 'user', chars: 5, text: 'g[redacted]li' },
    ]);
    expect((await run({ store: 'full' })).prompts?.[0]).toEqual([
      { role: 'user', chars: 5, sha256: sha, text: 'gizli' },
    ]);
  });

  it('sends a trace per turn in header correlation and ties calls by it, in parallel too', async () => {
    const proxy = await fakeProxy();
    const t = await target((received, _i, response) => {
      const trace = received.headers['x-yokla-trace'];
      proxy.records.push(call(typeof trace === 'string' ? trace : null, null), call(null, null));
      json(response, answer());
    });
    const results = await runSuite(
      options(
        proxied(t.url, 'header'),
        cases({ turns: [{ user: 'a' }] }, { turns: [{ user: 'b' }] }),
        {
          proxyUrl: proxy.url,
          concurrency: 2,
        },
      ),
    );
    const turns = results.cases.map((c) => c.samples[0]?.turns[0]);
    for (const turn of turns) {
      expect(turn?.proxy?.trace).toBe(turn?.requestId);
      expect(turn?.proxy?.calls).toHaveLength(1);
    }
    expect(t.received.map((r) => r.headers['x-yokla-trace'])).toEqual(
      t.received.map((r) => r.headers['x-request-id']),
    );
    expect(results.run.proxy).toMatchObject({
      correlation: 'header',
      attributed: 2,
      unattributed: 2,
    });
    expect(proxy.armed).toEqual([]);
  });

  it("refuses to run when the proxy doesn't answer, routes other upstreams or is busy", async () => {
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const c = cases({ turns: [{ user: 'a' }] });
    await expect(
      runSuite(options(proxied(t.url, 'serial'), c, { proxyUrl: 'http://127.0.0.1:9' })),
    ).rejects.toThrow(/doesn't answer.*; start it with yokla proxy/u);
    const other = await fakeProxy({
      health: { ok: true, upstreams: ['openai'], recording: false },
    });
    await expect(
      runSuite(options(proxied(t.url, 'serial'), c, { proxyUrl: other.url })),
    ).rejects.toThrow(/the model proxy doesn't route fake; start it with this profile/u);
    const busy = await fakeProxy({ open: 409 });
    await expect(
      runSuite(options(proxied(t.url, 'serial'), c, { proxyUrl: busy.url })),
    ).rejects.toThrow(ConfigError);
    await expect(
      runSuite(options(proxied(t.url, 'serial'), c, { proxyUrl: busy.url, concurrency: 2 })),
    ).rejects.toThrow(/correlates serially, which needs a concurrency of 1/u);
    expect(t.received).toHaveLength(0);
  });

  it('keeps the run when the records cannot be read, and says so instead of reporting zero calls', async () => {
    const proxy = await fakeProxy({ close: 500 });
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const results = await runSuite(
      options(proxied(t.url, 'serial'), cases({ turns: [{ user: 'a' }] }), { proxyUrl: proxy.url }),
    );
    expect(results.run.proxy).toBeUndefined();
    expect(results.cases[0]?.samples[0]?.turns[0]?.proxy).toBeUndefined();
    expect(results.run.issues).toEqual([
      expect.stringMatching(/^the model proxy's records could not be read: .*500/u),
    ]);
  });

  it('judges a failed answer under faults as a finding, with only the fault judges', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, index, response) => {
      if (index === 0) json(response, { error: 'model failed' }, 500);
      else json(response, answer());
    });
    const ran: string[] = [];
    const watcher: Check = {
      id: 'watcher',
      description: 'records the turns it sees',
      run: (context) => {
        ran.push(context.turn.user);
        return { applicable: false, reason: 'records only' };
      },
    };
    const faults = [{ fault: { kind: 'status', status: 503 } }];
    const results = await runSuite(
      options(
        proxied(t.url, 'serial'),
        cases({
          turns: [
            { user: 'a', faults, expect: { deadlineMs: 60_000 } },
            { user: 'b', faults },
          ],
        }),
        { proxyUrl: proxy.url, checks: [...CORE_CHECKS, watcher] },
      ),
    );
    expect(Results.safeParse(results).success).toBe(true);
    const [failed, answered] = results.cases[0]?.samples[0]?.turns ?? [];
    expect(failed?.error).toBeUndefined();
    expect(failed?.issues).toContain('gave no usable answer under the injected faults: HTTP 500');
    expect(failed?.checks.filter((c) => c.applicable).map((c) => c.check)).toEqual([
      'graceful-under-fault',
      'answered-within-deadline',
    ]);
    expect(
      failed?.checks.find((c) => c.check === 'graceful-under-fault')?.findings[0]?.verdict,
    ).toBe('fail');
    // The case goes on, and the second turn, answered, is judged by every check.
    expect(
      answered?.checks.find((c) => c.check === 'graceful-under-fault')?.findings[0]?.verdict,
    ).toBe('pass');
    expect(ran).toEqual(['b']);
    expect(results.cases[0]?.status).toBe('fail');
    expect(proxy.armed.map((a) => a.body)).toEqual([
      { inFlight: true, faults },
      { inFlight: true, faults },
    ]);
  });

  it('judges no answer at all under faults the same way', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      response.socket?.destroy();
    });
    const results = await runSuite(
      options(
        proxied(t.url, 'serial'),
        cases({ turns: [{ user: 'a', faults: [{ fault: { kind: 'timeout', holdMs: 10 } }] }] }),
        { proxyUrl: proxy.url, checks: CORE_CHECKS },
      ),
    );
    const turn = results.cases[0]?.samples[0]?.turns[0];
    expect(turn?.error).toBeUndefined();
    expect(turn?.response).toBeUndefined();
    expect(turn?.issues?.[0]).toMatch(/^gave no usable answer under the injected faults: /u);
    expect(results.cases[0]?.status).toBe('fail');
  });

  it('arms faults without marking in header correlation, and refuses faults without a proxy', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      json(response, answer());
    });
    const faults = [{ fault: { kind: 'latency', ms: 1 } }];
    await runSuite(
      options(proxied(t.url, 'header'), cases({ turns: [{ user: 'a', faults }, { user: 'b' }] }), {
        proxyUrl: proxy.url,
      }),
    );
    expect(proxy.armed.map((a) => a.body)).toEqual([
      { inFlight: false, faults: [{ fault: { kind: 'latency', ms: 1, jitterMs: 0 } }] },
    ]);
    await expect(
      runSuite(options(profile(t.url), cases({ id: 'faulty', turns: [{ user: 'a', faults }] }))),
    ).rejects.toThrow(/case "faulty" injects faults, which needs a modelProxy in the profile/u);
  });

  it('judges a turn budget with the proxy data, and leaves it unmeasured without a proxy', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      proxy.records.push(call(null, proxy.mark()), call(null, proxy.mark()));
      json(response, answer());
    });
    const priced = await runSuite(
      options(
        proxied(t.url, 'serial'),
        cases(
          { turns: [{ user: 'a', expect: { budget: { costUsd: 0.005, modelCalls: 2 } } }] },
          { turns: [{ user: 'b', expect: { budget: { costUsd: 0.003 } } }] },
        ),
        { proxyUrl: proxy.url, prices, checks: CORE_CHECKS },
      ),
    );
    // Two calls of 1000 input and 100 output tokens at 1 and 10 $/MTok: 0.004 $ a turn.
    expect(priced.cases.map((c) => c.status)).toEqual(['pass', 'fail']);
    const unpriced = await runSuite(
      options(
        proxied(t.url, 'serial'),
        cases({ turns: [{ user: 'a', expect: { budget: { costUsd: 1 } } }] }),
        {
          proxyUrl: proxy.url,
          checks: CORE_CHECKS,
        },
      ),
    );
    expect(unpriced.cases[0]?.status).toBe('unmeasured');
    expect(unpriced.cases[0]?.dimensions).toEqual([
      { dimension: 'cost', policy: 'worst-of-n', verdict: 'unmeasured', samples: 0, failed: 0 },
    ]);
    const plain = await runSuite(
      options(
        profile(t.url),
        cases({ turns: [{ user: 'a', expect: { budget: { modelCalls: 3 } } }] }),
        {
          checks: CORE_CHECKS,
        },
      ),
    );
    expect(
      plain.cases[0]?.samples[0]?.turns[0]?.checks.find((c) => c.check === 'cost-budget'),
    ).toEqual({
      check: 'cost-budget',
      applicable: true,
      findings: [],
      unmeasured: [{ dimension: 'cost', reason: 'no model proxy data for this turn' }],
    });
    expect(plain.cases[0]?.status).toBe('unmeasured');
  });

  it("gives the checks each call's prompt text, while the results keep sizes", async () => {
    const proxy = await fakeProxy();
    const prompts: ProxyRecord['prompt'][] = [];
    const t = await target((_r, _i, response) => {
      for (const prompt of prompts.splice(0, 1))
        proxy.records.push({ ...call(null, proxy.mark()), prompt });
      json(response, answer());
    });
    const base = proxied(t.url, 'serial');
    const inspecting: Profile =
      base.modelProxy === undefined
        ? base
        : { ...base, modelProxy: { ...base.modelProxy, inspect: { canary: 'YK-CANARY-1' } } };
    const expect1 = { notSentToModel: ['0532 111 22 33'], budget: { inputTokens: 999 } };
    prompts.push(
      [
        { role: 'system', chars: 15, text: 'Kurallar YK-CANARY-1' },
        { role: 'user', chars: 11, text: '05321112233' },
      ],
      // A prompt stored without its text can't be inspected, nor one the proxy couldn't read.
      [{ role: 'user', chars: 11 }],
      null,
    );
    const results = await runSuite(
      options(
        inspecting,
        cases({
          turns: [
            { user: 'a', expect: expect1 },
            { user: 'b', expect: expect1 },
            { user: 'c', expect: expect1 },
          ],
        }),
        { proxyUrl: proxy.url, checks: CORE_CHECKS },
      ),
    );
    expect(Results.safeParse(results).success).toBe(true);
    const [first, second, third] = results.cases[0]?.samples[0]?.turns ?? [];
    const outcome = (turn: typeof first, id: string) => {
      const check = turn?.checks.find((c) => c.check === id);
      return check?.applicable === true
        ? [
            ...check.findings.map((f) => f.verdict),
            ...(check.unmeasured ?? []).map(() => 'unmeasured'),
          ]
        : ['n/a'];
    };
    expect(
      ['pii-in-prompt', 'prompt-budget', 'prompt-leak'].map((id) => outcome(first, id)),
    ).toEqual([['fail'], ['fail'], ['pass']]);
    for (const turn of [second, third]) {
      expect(['pii-in-prompt', 'prompt-leak'].map((id) => outcome(turn, id))).toEqual([
        ['unmeasured'],
        ['unmeasured'],
      ]);
    }
    expect(JSON.stringify(results)).not.toMatch(/YK-CANARY|05321112233/u);
    expect(results.run.issues).toBeUndefined();
  });

  it('says when the declared canary reached no system prompt in the whole run', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      proxy.records.push({
        ...call(null, proxy.mark()),
        prompt: [
          { role: 'system', chars: 8, text: 'Kurallar' },
          { role: 'user', chars: 11, text: 'YK-CANARY-1' },
        ],
      });
      json(response, answer());
    });
    const base = proxied(t.url, 'serial');
    const inspecting: Profile =
      base.modelProxy === undefined
        ? base
        : { ...base, modelProxy: { ...base.modelProxy, inspect: { canary: 'YK-CANARY-1' } } };
    const results = await runSuite(
      options(inspecting, cases({ turns: [{ user: 'a' }] }), {
        proxyUrl: proxy.url,
        checks: CORE_CHECKS,
      }),
    );
    expect(results.run.issues).toEqual([
      "the canary in modelProxy.inspect.canary reached no system prompt during the run, so prompt-leak couldn't apply",
    ]);
    const silent = await runSuite(
      options(base, cases({ turns: [{ user: 'a' }] }), { proxyUrl: proxy.url }),
    );
    expect(silent.run.issues).toBeUndefined();
  });

  it('stops starting samples and cases at the cost cap, and says so', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      proxy.records.push(call(null, proxy.mark()), call(null, proxy.mark()));
      json(response, answer());
    });
    // Each turn makes two calls of 0.002 $: 0.004 $ a turn.
    const capped = await runSuite(
      options(
        proxied(t.url, 'serial'),
        cases(
          { turns: [{ user: 'a' }] },
          { samples: 3, turns: [{ user: 'b' }] },
          { turns: [{ user: 'c' }] },
        ),
        { proxyUrl: proxy.url, prices, maxCostUsd: 0.007 },
      ),
    );
    expect(capped.run.partial).toBe(true);
    expect(capped.run.issues).toEqual([
      'stopped at the cost cap: 0.008 USD spent, 0.007 USD allowed',
    ]);
    expect(capped.cases.map((c) => [c.id, c.samples.length])).toEqual([
      ['c0', 1],
      ['c1', 1],
    ]);
    expect(t.received).toHaveLength(2);
    // Reaching the cap exactly stops the run too.
    proxy.records.length = 0;
    const exact = await runSuite(
      options(
        proxied(t.url, 'serial'),
        cases({ turns: [{ user: 'a' }] }, { turns: [{ user: 'b' }] }),
        {
          proxyUrl: proxy.url,
          prices,
          maxCostUsd: 0.004,
        },
      ),
    );
    expect(exact.cases).toHaveLength(1);
    expect(exact.run.issues).toEqual([
      'stopped at the cost cap: 0.004 USD spent, 0.004 USD allowed',
    ]);
  });

  it('stops when a call has no cost, and runs to the end under the cap', async () => {
    const proxy = await fakeProxy();
    const t = await target((_r, _i, response) => {
      proxy.records.push(call(null, proxy.mark()));
      json(response, answer());
    });
    const twoCases = cases({ turns: [{ user: 'a' }] }, { turns: [{ user: 'b' }] });
    const unpriced = await runSuite(
      options(proxied(t.url, 'serial'), twoCases, { proxyUrl: proxy.url, maxCostUsd: 1 }),
    );
    expect(unpriced.run).toMatchObject({
      partial: true,
      issues: ["stopped: a model call has no cost, so the cost cap of 1 USD can't be enforced"],
    });
    expect(unpriced.cases).toHaveLength(1);
    proxy.records.length = 0;
    const under = await runSuite(
      options(proxied(t.url, 'serial'), twoCases, { proxyUrl: proxy.url, prices, maxCostUsd: 1 }),
    );
    expect(under.run.partial).toBe(false);
    expect(under.run.issues).toBeUndefined();
    expect(under.cases).toHaveLength(2);
    await expect(runSuite(options(profile(t.url), twoCases, { maxCostUsd: 1 }))).rejects.toThrow(
      /a cost cap needs a modelProxy in the profile/u,
    );
  });
});
