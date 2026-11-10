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

const telemetry = (requestId: unknown, costs: number[]) =>
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
