import { createHash } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { ProxyRecord } from '@yokla/core';
import { afterEach, describe, expect, it } from 'vitest';
import { jitter } from './faults.ts';
import { startProxy, type RunningProxy } from './server.ts';

interface Received {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const CHAT = JSON.stringify({
  model: 'gpt-x',
  choices: [{ message: { content: 'Merhaba' } }],
  usage: { prompt_tokens: 11, completion_tokens: 4 },
});

/** A fake provider: answers by path, and remembers what it received. */
async function upstream(): Promise<{
  url: string;
  received: Received[];
  /** Ends the streams held open on /v1/hold. */
  held: (() => void)[];
}> {
  const received: Received[] = [];
  const held: (() => void)[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const path = (req.url ?? '').split('?')[0];
      if (path === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'up-1' });
        res.end(CHAT);
      } else if (path === '/v1/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(CHAT));
      } else if (path === '/v1/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"model":"gpt-x","choices":[{"delta":{"content":"Mer"}}]}\n\n');
        setTimeout(() => {
          res.end(
            'data: {"model":"gpt-x","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
          );
        }, 20);
      } else if (path === '/v1/hold') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"model":"gpt-x","choices":[{"delta":{"content":"Mer"}}]}\n\n');
        held.push(() => res.end('data: [DONE]\n\n'));
      } else if (path === '/v1/drop') {
        res.socket?.destroy();
      } else {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end('{"error":"slow down"}');
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return { url: `http://127.0.0.1:${String(address.port)}/v1`, received, held };
}

async function proxy(
  upstreamUrl: string,
  change: { maxCaptureBytes?: number; maxRequestBytes?: number } = {},
) {
  const records: ProxyRecord[] = [];
  const running = await startProxy({
    port: 0,
    upstreams: [{ id: 'openai', kind: 'openai-compatible', upstream: upstreamUrl }],
    onRecord: (record) => records.push(record),
    ...change,
  });
  closers.push(() => running.close());
  return { running, records };
}

interface Raw {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A raw HTTP call, so compressed bodies arrive as the proxy sent them. */
function call(
  running: RunningProxy,
  method: string,
  path: string,
  body: string | Buffer = '',
  headers: Record<string, string> = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(`${running.url}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const parse = (raw: Raw): unknown => JSON.parse(raw.body.toString('utf8'));

describe('startProxy forwarding', () => {
  it('passes method, path, query, body and headers through, and the response byte for byte', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const body = '{"model":"gpt-x","messages":[]}';
    const res = await call(running, 'POST', '/openai/chat/completions?api-version=2', body, {
      authorization: 'Bearer secret-key',
      'content-type': 'application/json',
      'x-custom': 'kept',
      connection: 'keep-alive, x-drop-me',
      'x-drop-me': 'hop',
      'proxy-authorization': 'Basic for-the-proxy-only',
    });
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe(CHAT);
    expect(res.headers['x-request-id']).toBe('up-1');
    const [seen] = up.received;
    expect(seen).toMatchObject({ method: 'POST', url: '/v1/chat/completions?api-version=2', body });
    expect(seen?.headers).toMatchObject({
      authorization: 'Bearer secret-key',
      'x-custom': 'kept',
      host: new URL(up.url).host,
    });
    expect(seen?.headers['x-drop-me']).toBeUndefined();
    expect(seen?.headers['proxy-authorization']).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('passes compressed bodies through untouched and still reads their usage', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    await call(running, 'POST', '/_yokla/recordings');
    const res = await call(running, 'POST', '/openai/gzip', '{}', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.equals(gzipSync(CHAT))).toBe(true);
    expect(records).toMatchObject([{ model: 'gpt-x', usage: { input: 11, output: 4 } }]);
    const health = parse(await call(running, 'GET', '/_yokla/health'));
    expect(health).toMatchObject({ ok: true, upstreams: ['openai'] });
  });

  it('streams server-sent events and reads the usage chunk', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    await call(running, 'POST', '/_yokla/recordings');
    const res = await call(running, 'POST', '/openai/stream', '{"model":"gpt-x","stream":true}');
    expect(res.body.toString('utf8')).toContain('data: [DONE]');
    expect(records).toMatchObject([
      { stream: true, model: 'gpt-x', usage: { input: 3, output: 2 }, status: 200 },
    ]);
  });

  it('recognises a stream by its content type, whatever the request said', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    await call(running, 'POST', '/_yokla/recordings');
    await call(running, 'POST', '/openai/stream', '{}');
    expect(records).toMatchObject([{ stream: true, usage: { input: 3, output: 2 } }]);
  });

  it('does not record a call that ends after its recording closed', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    const opened = parse(await call(running, 'POST', '/_yokla/recordings'));
    const id =
      typeof opened === 'object' && opened !== null ? String(Reflect.get(opened, 'id')) : '';
    const slow = call(running, 'POST', '/openai/hold', '{"stream":true}');
    // The upstream holds its answer open until the recording has closed.
    for (let i = 0; i < 200 && up.held.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(up.held).toHaveLength(1);
    const closed = parse(await call(running, 'DELETE', `/_yokla/recordings/${id}`));
    for (const end of up.held) end();
    await slow;
    expect(closed).toMatchObject({ records: [] });
    expect(records).toEqual([]);
  });

  it('refuses an unknown upstream without forwarding it', async () => {
    const up = await upstream();
    const { running } = await proxy(up.url);
    const res = await call(running, 'POST', '/anthropic/v1/messages', '{}');
    expect(res.status).toBe(404);
    expect(parse(res)).toEqual({ error: 'no upstream for /anthropic/v1/messages' });
    expect((await call(running, 'GET', '/_yokla/nope')).status).toBe(404);
    expect(up.received).toEqual([]);
  });

  it('answers 502 when the upstream drops the connection, and records the failure', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    await call(running, 'POST', '/_yokla/recordings');
    const res = await call(running, 'POST', '/openai/drop', '{"model":"gpt-x"}');
    expect(res.status).toBe(502);
    expect(records).toMatchObject([{ status: null, model: 'gpt-x', usage: { input: null } }]);
    expect(records[0]?.error).toBeDefined();
  });

  it('passes a large body through, with its usage unmeasured past the capture limit', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url, { maxCaptureBytes: 10 });
    await call(running, 'POST', '/_yokla/recordings');
    const res = await call(running, 'POST', '/openai/chat/completions', '{}');
    expect(res.body.toString('utf8')).toBe(CHAT);
    expect(records[0]?.usage).toEqual({
      input: null,
      output: null,
      cachedInput: null,
      cacheWrite: null,
      reasoning: null,
    });
  });

  it('refuses a request body over the limit', async () => {
    const up = await upstream();
    const { running } = await proxy(up.url, { maxRequestBytes: 4 });
    expect((await call(running, 'POST', '/openai/chat/completions', '{"too":"long"}')).status).toBe(
      413,
    );
    expect(up.received).toEqual([]);
  });
});

describe('startProxy recordings', () => {
  it('tags each call with the turn marked in flight when it started', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    const opened = parse(await call(running, 'POST', '/_yokla/recordings'));
    const id = String(Reflect.get(Object(opened), 'id'));
    const turn = (name: string, body: string) =>
      call(running, 'PUT', `/_yokla/recordings/${id}/turns/${name}`, body);
    await call(running, 'POST', '/openai/chat/completions', '{}');
    expect(parse(await turn('turn-1', '{"inFlight":true}'))).toEqual({
      id,
      turn: 'turn-1',
      inFlight: true,
      faults: 0,
    });
    await call(running, 'POST', '/openai/chat/completions', '{}');
    await turn('turn-2', '{"inFlight":true}');
    await call(running, 'POST', '/openai/chat/completions', '{}');
    // Arming a turn without marking it in flight leaves the mark where it was.
    await turn('turn-3', '{}');
    await call(running, 'POST', '/openai/chat/completions', '{}');
    expect(records.map((record) => record.mark)).toEqual([null, 'turn-1', 'turn-2', 'turn-2']);
    expect((await turn('turn-4', '{"inFlight":"yes"}')).status).toBe(400);
    expect((await turn('turn-4', 'not json')).status).toBe(400);
    expect(
      (await call(running, 'PUT', '/_yokla/recordings/other/turns/x', '{"inFlight":true}')).status,
    ).toBe(404);
  });

  it('records calls only while a recording is open, without credentials', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    await call(running, 'POST', '/openai/chat/completions', '{}');

    const opened = parse(await call(running, 'POST', '/_yokla/recordings'));
    expect(typeof Reflect.get(Object(opened), 'id')).toBe('string');
    expect(typeof Reflect.get(Object(opened), 'startedAt')).toBe('string');
    const id =
      typeof opened === 'object' && opened !== null ? String(Reflect.get(opened, 'id')) : '';
    expect((await call(running, 'POST', '/_yokla/recordings')).status).toBe(409);

    await call(running, 'POST', '/openai/chat/completions?api-version=2', '{"model":"asked"}', {
      authorization: 'Bearer secret-key',
      'x-yokla-trace': 'turn-7',
    });
    await call(running, 'POST', '/openai/limited', '{"model":"asked"}');
    const listed = parse(await call(running, 'GET', `/_yokla/recordings/${id}`));
    expect(listed).toMatchObject({ id, records: [{ trace: 'turn-7' }, { status: 429 }] });

    const closed = parse(await call(running, 'DELETE', `/_yokla/recordings/${id}`));
    expect(closed).toMatchObject({
      id,
      records: [
        {
          upstream: 'openai',
          kind: 'openai-compatible',
          method: 'POST',
          path: '/chat/completions',
          model: 'gpt-x',
          status: 200,
          stream: false,
          trace: 'turn-7',
          usage: { input: 11, output: 4, cachedInput: null, cacheWrite: null, reasoning: null },
        },
        { path: '/limited', model: 'asked', status: 429, trace: null, usage: { input: null } },
      ],
    });
    expect(records).toHaveLength(2);
    expect(JSON.stringify(closed)).not.toContain('secret-key');
    expect((await call(running, 'GET', `/_yokla/recordings/${id}`)).status).toBe(404);

    await call(running, 'POST', '/openai/chat/completions', '{}');
    expect(records).toHaveLength(2);
  });
});

describe('startProxy prompts', () => {
  it('records the messages each call sent, from a compressed request too', async () => {
    const up = await upstream();
    const { running, records } = await proxy(up.url);
    expect(parse(await call(running, 'GET', '/_yokla/health'))).toMatchObject({
      recording: false,
    });
    const opened = parse(await call(running, 'POST', '/_yokla/recordings'));
    const id = String(Reflect.get(Object(opened), 'id'));
    // Health says a recording is open, but not which: its id is the key to its prompts.
    const health = await call(running, 'GET', '/_yokla/health');
    expect(parse(health)).toMatchObject({ recording: true });
    expect(health.body.toString('utf8')).not.toContain(id);

    const messages = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Çadır öner' },
    ];
    await call(running, 'POST', '/openai/chat/completions', JSON.stringify({ messages }));
    await call(
      running,
      'POST',
      '/openai/chat/completions',
      gzipSync(JSON.stringify({ messages: [{ role: 'user', content: 'Merhaba' }] })),
      { 'content-encoding': 'gzip' },
    );
    await call(running, 'POST', '/openai/chat/completions', 'not json');
    await call(running, 'POST', '/openai/chat/completions', 'not gzip', {
      'content-encoding': 'gzip',
    });
    expect(records.map((record) => record.prompt)).toEqual([
      [
        { role: 'system', chars: 9, text: 'Be brief.' },
        { role: 'user', chars: 10, text: 'Çadır öner' },
      ],
      [{ role: 'user', chars: 7, text: 'Merhaba' }],
      null,
      null,
    ]);
    // The upstream got the request as the app sent it.
    expect(up.received[0]?.body).toBe(JSON.stringify({ messages }));
    const listed = parse(await call(running, 'GET', `/_yokla/recordings/${id}`));
    expect(listed).toMatchObject({
      records: [{ prompt: [{ text: 'Be brief.' }, {}] }, {}, {}, {}],
    });
  });
});

/** A proxy with an open recording, and a way to ask it to settle. */
async function recorded(up: { url: string }) {
  const { running, records } = await proxy(up.url);
  const opened = parse(await call(running, 'POST', '/_yokla/recordings'));
  const id = String(Reflect.get(Object(opened), 'id'));
  const settle = async (quietMs: number, maxWaitMs: number) =>
    parse(
      await call(
        running,
        'POST',
        `/_yokla/recordings/${id}/settle`,
        JSON.stringify({ quietMs, maxWaitMs }),
      ),
    );
  return { running, records, id, settle };
}
const holding = async (up: { held: (() => void)[] }, count: number) => {
  for (let i = 0; i < 200 && up.held.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(up.held).toHaveLength(count);
};
const waited = (answer: unknown) => Number(Reflect.get(Object(answer), 'waitedMs'));

describe('startProxy settle (ADR-0016)', () => {
  it('answers once nothing is in flight and nothing started for quietMs after it was asked', async () => {
    const up = await upstream();
    const { settle } = await recorded(up);
    const answer = await settle(60, 2_000);
    expect(answer).toMatchObject({ settled: true });
    expect(waited(answer)).toBeGreaterThanOrEqual(59);
    expect(waited(answer)).toBeLessThan(1_000);
  });

  it('counts quiet from the request, not from a call that ended long before it', async () => {
    const up = await upstream();
    const { running, settle } = await recorded(up);
    await call(running, 'POST', '/openai/chat/completions', '{}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(waited(await settle(60, 2_000))).toBeGreaterThanOrEqual(59);
  });

  it('waits for a call in flight to end, then for quietMs more', async () => {
    const up = await upstream();
    const { running, settle, records } = await recorded(up);
    const slow = call(running, 'POST', '/openai/hold', '{"stream":true}');
    await holding(up, 1);
    const settling = settle(40, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 120));
    for (const end of up.held) end();
    await slow;
    const answer = await settling;
    expect(answer).toMatchObject({ settled: true });
    expect(waited(answer)).toBeGreaterThanOrEqual(155);
    // The call was recorded by the time the settle answered.
    expect(records).toHaveLength(1);
  });

  it('counts a call that starts while it waits, and gives up after maxWaitMs', async () => {
    const up = await upstream();
    const { running, settle } = await recorded(up);
    const settling = settle(80, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await call(running, 'POST', '/openai/chat/completions', '{}');
    expect(waited(await settling)).toBeGreaterThanOrEqual(125);

    const slow = call(running, 'POST', '/openai/hold', '{"stream":true}');
    await holding(up, 1);
    const answer = await settle(10, 80);
    expect(answer).toMatchObject({ settled: false, inFlight: 1 });
    expect(waited(answer)).toBeGreaterThanOrEqual(79);
    for (const end of up.held) end();
    await slow;
  });

  it('counts only calls of the recording, and a call the app gives up on ends', async () => {
    const up = await upstream();
    const { running } = await proxy(up.url);
    // A call from before the recording, still held: not the recording's.
    const before = call(running, 'POST', '/openai/hold', '{"stream":true}');
    await holding(up, 1);
    const opened = parse(await call(running, 'POST', '/_yokla/recordings'));
    const id = String(Reflect.get(Object(opened), 'id'));
    const settle = async () =>
      parse(
        await call(
          running,
          'POST',
          `/_yokla/recordings/${id}/settle`,
          JSON.stringify({ quietMs: 20, maxWaitMs: 300 }),
        ),
      );
    expect(await settle()).toMatchObject({ settled: true });
    // A call of the recording that the app abandons.
    const abandoned = request(`${running.url}/openai/hold`, { method: 'POST' });
    abandoned.on('error', () => undefined);
    abandoned.end('{"stream":true}');
    await holding(up, 2);
    abandoned.destroy();
    expect(await settle()).toMatchObject({ settled: true });
    for (const end of up.held) end();
    await before;
  });

  it('refuses an unknown recording and a malformed request', async () => {
    const up = await upstream();
    const { running, id } = await recorded(up);
    expect((await call(running, 'POST', '/_yokla/recordings/other/settle', '{}')).status).toBe(404);
    for (const body of ['{}', '{"quietMs":-1,"maxWaitMs":10}', 'not json']) {
      expect((await call(running, 'POST', `/_yokla/recordings/${id}/settle`, body)).status).toBe(
        400,
      );
    }
  });
});

/** A proxy with an open recording and one turn armed. */
async function armed(up: { url: string }, turn: string, body: unknown) {
  const { running, records } = await proxy(up.url);
  const opened = parse(await call(running, 'POST', '/_yokla/recordings'));
  const id = String(Reflect.get(Object(opened), 'id'));
  const res = await call(
    running,
    'PUT',
    `/_yokla/recordings/${id}/turns/${turn}`,
    JSON.stringify(body),
  );
  expect(res.status).toBe(200);
  const arm = (next: string, value: unknown) =>
    call(running, 'PUT', `/_yokla/recordings/${id}/turns/${next}`, JSON.stringify(value));
  return { running, records, arm };
}

describe('startProxy faults', () => {
  const zero = { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0 };

  it('answers a status fault itself, in the provider shape, without calling the provider', async () => {
    const up = await upstream();
    const { running, records, arm } = await armed(up, 'turn-1', {
      inFlight: true,
      faults: [{ fault: { kind: 'status', status: 503, retryAfterS: 2 } }],
    });
    const res = await call(running, 'POST', '/openai/chat/completions', '{"model":"gpt-x"}');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(parse(res)).toMatchObject({ error: { type: 'server_error' } });
    expect(up.received).toEqual([]);
    expect(records).toMatchObject([
      {
        status: 503,
        forwarded: false,
        usage: zero,
        model: 'gpt-x',
        fault: { kind: 'status', applied: true },
      },
    ]);
    // The next turn, armed without faults, gets the real answer.
    await arm('turn-2', { inFlight: true });
    expect(
      (await call(running, 'POST', '/openai/chat/completions', '{}')).body.toString('utf8'),
    ).toBe(CHAT);
    expect(records[1]).not.toHaveProperty('fault');
  });

  it('breaks only the listed call, and reads usage from the real answer', async () => {
    const up = await upstream();
    const { running, records } = await armed(up, 'turn-1', {
      inFlight: true,
      faults: [{ fault: { kind: 'malformed-json' }, calls: [2] }],
    });
    const first = await call(running, 'POST', '/openai/chat/completions', '{}');
    const second = await call(running, 'POST', '/openai/chat/completions', '{}');
    expect(first.body.toString('utf8')).toBe(CHAT);
    expect(second.body.toString('utf8')).toBe(CHAT.slice(0, Math.floor(CHAT.length / 2)));
    expect(Number(second.headers['content-length'])).toBe(second.body.length);
    expect(up.received).toHaveLength(2);
    expect(records.map((r) => r.fault)).toEqual([
      undefined,
      { kind: 'malformed-json', applied: true },
    ]);
    expect(records[1]?.usage).toMatchObject({ input: 11, output: 4 });
  });

  it('decodes a compressed answer to change it, and sends it uncompressed', async () => {
    const up = await upstream();
    const { running } = await armed(up, 't', {
      inFlight: true,
      faults: [{ fault: { kind: 'malformed-json' } }],
    });
    const res = await call(running, 'POST', '/openai/gzip', '{}', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString('utf8')).toBe(CHAT.slice(0, Math.floor(CHAT.length / 2)));
  });

  it('empties or cuts a stream, keeping its usage on record', async () => {
    const up = await upstream();
    const empty = await armed(up, 'e', {
      inFlight: true,
      faults: [{ fault: { kind: 'empty-content' } }],
    });
    const emptied = (
      await call(empty.running, 'POST', '/openai/stream', '{"stream":true}')
    ).body.toString('utf8');
    expect(emptied).not.toContain('Mer');
    expect(emptied).toContain('[DONE]');
    // The usage is the provider's; the answer text is what the app got (ADR-0033).
    expect(empty.records).toMatchObject([
      { usage: { input: 3, output: 2 }, fault: { applied: true }, output: { chars: 0, text: '' } },
    ]);
    const cut = await armed(up, 'c', {
      inFlight: true,
      faults: [{ fault: { kind: 'truncated-stream' } }],
    });
    const body = (
      await call(cut.running, 'POST', '/openai/stream', '{"stream":true}')
    ).body.toString('utf8');
    expect(body).toContain('Mer');
    expect(body).not.toContain('[DONE]');
  });

  it('records a fault that cannot apply as not applied, and passes the answer on', async () => {
    const up = await upstream();
    const { running, records } = await armed(up, 't', {
      inFlight: true,
      faults: [{ fault: { kind: 'invalid-tool-call' } }],
    });
    expect(
      (await call(running, 'POST', '/openai/chat/completions', '{}')).body.toString('utf8'),
    ).toBe(JSON.stringify(JSON.parse(CHAT)));
    expect(records[0]?.fault).toEqual({ kind: 'invalid-tool-call', applied: false });
  });

  it("draws a latency fault's jitter from the armed seed, not from the turn id", async () => {
    const up = await upstream();
    // A seed whose draw is long, for a turn id whose own draw would be short:
    // only the seed explains a delay at least that long (ADR-0017).
    const max = 400;
    const seed = Array.from({ length: 500 }, (_v, i) => `case-${String(i)}|0|0`).find(
      (candidate) => jitter(`${candidate}|openai|1`, max) >= 300,
    );
    const turn = Array.from({ length: 500 }, (_v, i) => `turn-${String(i)}`).find(
      (candidate) => jitter(`${candidate}|openai|1`, max) < 100,
    );
    expect(seed).toBeDefined();
    expect(turn).toBeDefined();
    const slow = await armed(up, String(turn), {
      inFlight: true,
      faults: [{ fault: { kind: 'latency', ms: 0, jitterMs: max } }],
      seed,
    });
    const startedAt = performance.now();
    await call(slow.running, 'POST', '/openai/chat/completions', '{}');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(
      jitter(`${String(seed)}|openai|1`, max) - 5,
    );
  });

  it('delays a latency fault, and holds a timeout fault without an answer', async () => {
    const up = await upstream();
    const slow = await armed(up, 'l', {
      inFlight: true,
      faults: [{ fault: { kind: 'latency', ms: 60 } }],
    });
    const startedAt = performance.now();
    await call(slow.running, 'POST', '/openai/chat/completions', '{}');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(55);
    expect(slow.records[0]?.fault).toEqual({ kind: 'latency', applied: true });

    const held = await armed(up, 'h', {
      inFlight: true,
      faults: [{ fault: { kind: 'timeout', holdMs: 80 } }],
    });
    const heldAt = performance.now();
    const outcome = await call(held.running, 'POST', '/openai/chat/completions', '{}').then(
      () => 'answered',
      () => 'no answer',
    );
    expect(outcome).toBe('no answer');
    // The client sees the connection close before the proxy's own close event runs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(performance.now() - heldAt).toBeGreaterThanOrEqual(75);
    expect(up.received).toHaveLength(1);
    expect(held.records).toMatchObject([
      { status: null, forwarded: false, usage: zero, fault: { kind: 'timeout', applied: true } },
    ]);
    expect(held.records[0]?.error).toMatch(/timeout fault/u);
  });

  it('finds a header-correlated turn by its trace', async () => {
    const up = await upstream();
    const { running } = await armed(up, 'trace-1', {
      inFlight: false,
      faults: [{ fault: { kind: 'status', status: 500 } }],
    });
    const faulted = await call(running, 'POST', '/openai/chat/completions', '{}', {
      'x-yokla-trace': 'trace-1',
    });
    const other = await call(running, 'POST', '/openai/chat/completions', '{}', {
      'x-yokla-trace': 'trace-2',
    });
    expect([faulted.status, other.status]).toEqual([500, 200]);
  });
});

const OTEL_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

/** A minimal protobuf export of one GenAI span, written by hand. */
function pbLen(field: number, bytes: number[]): number[] {
  return [(field << 3) | 2, bytes.length, ...bytes];
}

function pbStr(field: number, value: string): number[] {
  return pbLen(field, [...Buffer.from(value, 'utf8')]);
}

function pbAttr(key: string, value: string): number[] {
  return pbLen(9, [...pbStr(1, key), ...pbLen(2, pbStr(1, value))]);
}

function protobufExport(): Buffer {
  const span = [
    ...pbLen(1, [...Buffer.from(OTEL_TRACE, 'hex')]),
    ...pbLen(2, [...Buffer.from('00f067aa0ba902b7', 'hex')]),
    ...pbAttr('gen_ai.operation.name', 'chat'),
    ...pbAttr('gen_ai.request.model', 'gpt-y'),
  ];
  return Buffer.from(pbLen(1, pbLen(2, pbLen(2, span))));
}

async function openedForSpans() {
  const up = await upstream();
  const { running } = await proxy(up.url);
  const open = parse(await call(running, 'POST', '/_yokla/recordings'));
  const id = String(Reflect.get(Object(open), 'id'));
  const spans = async (): Promise<unknown> =>
    Reflect.get(Object(parse(await call(running, 'GET', `/_yokla/recordings/${id}`))), 'spans');
  return { running, id, spans };
}

/** An OTLP JSON export of these spans, all in one trace. */
const exportOf = (spans: { attributes: Record<string, unknown>[]; spanId: string }[]) =>
  JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: spans.map((span) => ({
              traceId: OTEL_TRACE,
              spanId: span.spanId,
              name: 'chat',
              startTimeUnixNano: '1763000000000000000',
              endTimeUnixNano: '1763000000500000000',
              attributes: span.attributes,
            })),
          },
        ],
      },
    ],
  });

describe('startProxy OpenTelemetry spans (ADR-0029)', () => {
  const genAi = [
    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
    { key: 'gen_ai.provider.name', value: { stringValue: 'openai' } },
    { key: 'gen_ai.response.model', value: { stringValue: 'gpt-x' } },
    { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
    { key: 'gen_ai.usage.output_tokens', value: { intValue: '9' } },
  ];
  const JSON_TYPE = { 'content-type': 'application/json' };

  it('keeps the model calls of a JSON export during a recording, and skips other spans', async () => {
    const { running, spans } = await openedForSpans();
    const answer = await call(
      running,
      'POST',
      '/_yokla/otlp/v1/traces',
      exportOf([
        { spanId: '00f067aa0ba902b7', attributes: genAi },
        {
          spanId: '00f067aa0ba902b8',
          attributes: [{ key: 'http.route', value: { stringValue: '/chat' } }],
        },
      ]),
      JSON_TYPE,
    );
    expect(answer.status).toBe(200);
    expect(parse(answer)).toEqual({});
    expect(await spans()).toEqual([
      {
        traceId: OTEL_TRACE,
        spanId: '00f067aa0ba902b7',
        provider: 'openai',
        model: 'gpt-x',
        startedAt: '2025-11-13T02:13:20.000Z',
        durationMs: 500,
        usage: { input: 120, output: 9, cachedInput: null, cacheWrite: null, reasoning: null },
        error: false,
      },
    ]);
  });

  it('reads a gzipped protobuf export, and answers in protobuf', async () => {
    const { running, spans } = await openedForSpans();
    const answer = await call(
      running,
      'POST',
      '/_yokla/otlp/v1/traces',
      gzipSync(protobufExport()),
      {
        'content-type': 'application/x-protobuf',
        'content-encoding': 'gzip',
      },
    );
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('application/x-protobuf');
    expect(answer.body).toHaveLength(0);
    expect(await spans()).toMatchObject([{ traceId: OTEL_TRACE, model: 'gpt-y' }]);
  });

  it('refuses what is no OTLP export, and keeps nothing outside a recording', async () => {
    const up = await upstream();
    const { running } = await proxy(up.url);
    const bad = await call(
      running,
      'POST',
      '/_yokla/otlp/v1/traces',
      '{"resourceLogs":[]}',
      JSON_TYPE,
    );
    expect(bad.status).toBe(400);
    expect(
      (await call(running, 'POST', '/_yokla/otlp/v1/traces', 'x', { 'content-type': 'text/plain' }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(running, 'POST', '/_yokla/otlp/v1/traces', Buffer.from([0xff, 0xff]), {
          'content-type': 'application/x-protobuf',
        })
      ).status,
    ).toBe(400);
    const outside = await call(
      running,
      'POST',
      '/_yokla/otlp/v1/traces',
      exportOf([{ spanId: '00f067aa0ba902b7', attributes: genAi }]),
      JSON_TYPE,
    );
    expect(outside.status).toBe(200);
    const open = parse(await call(running, 'POST', '/_yokla/recordings'));
    const id = String(Reflect.get(Object(open), 'id'));
    expect(
      Reflect.get(Object(parse(await call(running, 'GET', `/_yokla/recordings/${id}`))), 'spans'),
    ).toEqual([]);
  });

  it('settles once no export has come for quietMs, counting a late batch', async () => {
    const { running, id } = await openedForSpans();
    const settle = (quietMs: number, maxWaitMs: number) =>
      call(
        running,
        'POST',
        `/_yokla/recordings/${id}/spans/settle`,
        JSON.stringify({ quietMs, maxWaitMs }),
        JSON_TYPE,
      ).then(parse);
    const late = new Promise<void>((resolve) => {
      setTimeout(() => {
        void call(
          running,
          'POST',
          '/_yokla/otlp/v1/traces',
          exportOf([{ spanId: '00f067aa0ba902b7', attributes: genAi }]),
          JSON_TYPE,
        ).then(() => {
          resolve();
        });
      }, 120);
    });
    const answer = await settle(200, 5_000);
    await late;
    expect(answer).toMatchObject({ settled: true, spans: 1 });
    expect(Number(Reflect.get(Object(answer), 'waitedMs'))).toBeGreaterThanOrEqual(300);
    // It gives up after maxWaitMs, and says so.
    const exports: Promise<Raw>[] = [];
    const gaveUp = setInterval(() => {
      exports.push(call(running, 'POST', '/_yokla/otlp/v1/traces', exportOf([]), JSON_TYPE));
    }, 20);
    try {
      expect(await settle(200, 150)).toMatchObject({ settled: false });
    } finally {
      clearInterval(gaveUp);
      // Every export ends before the proxy closes, so none is cut off.
      await Promise.all(exports);
    }
  });
});

describe('startProxy with a gemini upstream (ADR-0032)', () => {
  it('records the model from the path, a stream, and no key from the query', async () => {
    const seen: Received[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const usageMetadata = {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 2,
        };
        if ((req.url ?? '').includes(':streamGenerateContent')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Mer' }] } }] })}\r\n\r\n` +
              `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'haba' }] } }], usageMetadata })}\r\n\r\n`,
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Merhaba' }] } }],
            usageMetadata,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    );
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const records: ProxyRecord[] = [];
    const running = await startProxy({
      port: 0,
      upstreams: [{ id: 'gemini', kind: 'gemini', upstream: `http://127.0.0.1:${String(port)}` }],
      onRecord: (record) => records.push(record),
    });
    closers.push(() => running.close());
    await call(running, 'POST', '/_yokla/recordings');
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: 'Kısa yaz' }] },
      contents: [{ role: 'user', parts: [{ text: 'Merhaba' }] }],
      tools: [{ functionDeclarations: [{ name: 'search_products' }] }],
    });
    const json = await call(
      running,
      'POST',
      '/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-secret',
      body,
      { 'content-type': 'application/json' },
    );
    expect(json.status).toBe(200);
    const streamed = await call(
      running,
      'POST',
      '/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      body,
      { 'content-type': 'application/json', 'x-goog-api-key': 'AIza-secret' },
    );
    expect(streamed.body.toString('utf8')).toContain('haba');
    // The key reached the provider, in the query and the header, as the app sent it.
    expect(seen.map((received) => received.url)).toEqual([
      '/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-secret',
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    ]);
    expect(seen[1]?.headers['x-goog-api-key']).toBe('AIza-secret');
    expect(records.map((record) => ({ ...record, id: '', startedAt: '', durationMs: 0 }))).toEqual(
      [false, true].map((stream) => ({
        id: '',
        upstream: 'gemini',
        kind: 'gemini',
        method: 'POST',
        path: `/v1beta/models/gemini-2.5-flash:${stream ? 'streamGenerateContent' : 'generateContent'}`,
        model: 'gemini-2.5-flash',
        startedAt: '',
        durationMs: 0,
        status: 200,
        stream,
        usage: { input: 7, output: 5, cachedInput: null, cacheWrite: null, reasoning: 2 },
        trace: null,
        mark: null,
        prompt: [
          { role: 'system', chars: 8, text: 'Kısa yaz' },
          { role: 'user', chars: 7, text: 'Merhaba' },
        ],
        tools: ['search_products'],
        toolCalls: [],
        output: { chars: 7, text: 'Merhaba' },
      })),
    );
    expect(JSON.stringify(records)).not.toContain('AIza-secret');
  });
});

const BODY = '{"model":"gpt-x","messages":[{"role":"user","content":"çadır"}]}';

/** A proxy with a recording opened with `opening`, and turn `t` armed with seed `case|0|0`. */
async function recordingWith(up: { url: string }, opening: unknown, arming: unknown = {}) {
  const { running, records } = await proxy(up.url);
  const res = await call(running, 'POST', '/_yokla/recordings', JSON.stringify(opening));
  expect(res.status).toBe(201);
  const id = String(Reflect.get(Object(parse(res)), 'id'));
  const turn = await call(
    running,
    'PUT',
    `/_yokla/recordings/${id}/turns/t`,
    JSON.stringify({ inFlight: true, seed: 'case|0|0', ...Object(arming) }),
  );
  expect(turn.status).toBe(200);
  return { running, records };
}

/** A call of turn `case|0|0` as a cassette keeps it, for what was sent and answered. */
const kept = (position: number, sent: string, answer: string) => ({
  turn: 'case|0|0',
  position,
  upstream: 'openai',
  path: '/chat/completions',
  requestSha256: createHash('sha256').update(sent).digest('hex'),
  status: 200,
  contentType: 'application/json',
  body: answer,
});

/** Two calls captured by a recording, to replay. */
async function captured(): Promise<NonNullable<ProxyRecord['capture']>[]> {
  const up = await upstream();
  const { running, records } = await recordingWith(up, { capture: true });
  await call(running, 'POST', '/openai/chat/completions', BODY);
  await call(running, 'POST', '/openai/stream', '{"stream":true}');
  return records.flatMap((record) => (record.capture === undefined ? [] : [record.capture]));
}

describe('startProxy recording and replaying a cassette (ADR-0040)', () => {
  it('captures each forwarded call: its turn, position, request hash and the answer', async () => {
    const up = await upstream();
    const { running, records } = await recordingWith(up, { capture: true });
    await call(running, 'POST', '/openai/chat/completions', BODY);
    await call(running, 'POST', '/openai/stream', '{"stream":true}');
    expect(records.map((record) => record.capture)).toEqual([
      {
        turn: 'case|0|0',
        position: 0,
        upstream: 'openai',
        path: '/chat/completions',
        requestSha256: createHash('sha256').update(BODY).digest('hex'),
        status: 200,
        contentType: 'application/json',
        body: CHAT,
      },
      expect.objectContaining({
        position: 1,
        path: '/stream',
        contentType: 'text/event-stream',
        body: expect.stringContaining('"content":"Mer"') as unknown,
      }),
    ]);
  });

  it('captures nothing without capture, nor a call outside an armed turn', async () => {
    const up = await upstream();
    const plain = await recordingWith(up, {});
    await call(plain.running, 'POST', '/openai/chat/completions', BODY);
    expect(plain.records[0]?.capture).toBeUndefined();
    const { running, records } = await proxy(up.url);
    await call(running, 'POST', '/_yokla/recordings', '{"capture":true}');
    await call(running, 'POST', '/openai/chat/completions', BODY);
    expect(records[0]?.capture).toBeUndefined();
    // A call the proxy answers itself, under a status fault, never reached the provider.
    const faulted = await recordingWith(
      up,
      { capture: true },
      { faults: [{ fault: { kind: 'status', status: 503 } }] },
    );
    await call(faulted.running, 'POST', '/openai/chat/completions', BODY);
    expect(faulted.records[0]).toMatchObject({ status: 503, forwarded: false });
    expect(faulted.records[0]?.capture).toBeUndefined();
  });

  it('answers from the cassette, forwarding nothing, with the recorded usage', async () => {
    const calls = await captured();
    const up = await upstream();
    const { running, records } = await recordingWith(up, { replay: { calls } });
    const res = await call(running, 'POST', '/openai/chat/completions', BODY);
    expect(res.body.toString('utf8')).toBe(CHAT);
    const streamed = await call(running, 'POST', '/openai/stream', '{"stream":true}');
    expect(streamed.headers['content-type']).toBe('text/event-stream');
    expect(streamed.body.toString('utf8')).toContain('"content":"Mer"');
    expect(up.received).toEqual([]);
    expect(records.map((r) => [r.forwarded, r.replay, r.usage.input, r.output?.text])).toEqual([
      [false, { diverged: false }, 11, 'Merhaba'],
      [false, { diverged: false }, 3, 'Mer'],
    ]);
  });

  it('refuses a call the cassette has no match for, unless loose, which answers by position', async () => {
    const calls = await captured();
    const up = await upstream();
    const strict = await recordingWith(up, { replay: { calls } });
    const refused = await call(strict.running, 'POST', '/openai/chat/completions', '{"other":1}');
    expect(refused.status).toBe(502);
    expect(refused.body.toString('utf8')).toContain('yokla replay: the cassette has no call');
    expect(strict.records[0]).toMatchObject({ status: 502, replay: { diverged: true } });
    const loose = await recordingWith(up, { replay: { loose: true, calls } });
    const answered = await call(loose.running, 'POST', '/openai/chat/completions', '{"other":1}');
    expect(answered.body.toString('utf8')).toBe(CHAT);
    expect(loose.records[0]?.replay).toEqual({ diverged: true });
    // Loose answers by the call's own position, never with another position's answer.
    const two = [kept(0, '{"a":1}', '"first"'), kept(1, '{"b":1}', '"second"')];
    const byPosition = await recordingWith(up, { replay: { loose: true, calls: two } });
    const matched = await call(byPosition.running, 'POST', '/openai/chat/completions', '{"b":1}');
    expect(matched.body.toString('utf8')).toBe('"second"');
    // The second call's position, 1, was answered already: nothing is left for it.
    const late = await call(byPosition.running, 'POST', '/openai/chat/completions', '{"c":1}');
    expect(late.status).toBe(502);
    // Another turn has nothing recorded: even loose can't answer it.
    const other = await recordingWith(up, { replay: { loose: true, calls } }, { seed: 'case|0|1' });
    expect((await call(other.running, 'POST', '/openai/chat/completions', BODY)).status).toBe(502);
    expect(up.received).toEqual([]);
  });

  it('uses each recorded call once, and applies a turn fault to a replayed answer', async () => {
    const calls = await captured();
    const up = await upstream();
    const { running, records } = await recordingWith(
      up,
      { replay: { calls } },
      { faults: [{ fault: { kind: 'answer', text: 'Uydurma: 1.169,10 TL' } }] },
    );
    const res = await call(running, 'POST', '/openai/chat/completions', BODY);
    expect(parse(res)).toMatchObject({
      choices: [{ message: { content: 'Uydurma: 1.169,10 TL' } }],
    });
    expect(records[0]).toMatchObject({
      fault: { kind: 'answer', applied: true },
      output: { text: 'Uydurma: 1.169,10 TL' },
      // The usage is the provider's, read from the recorded answer.
      usage: { input: 11, output: 4 },
    });
    expect((await call(running, 'POST', '/openai/chat/completions', BODY)).status).toBe(502);
  });

  it('refuses an opening it cannot read', async () => {
    const up = await upstream();
    const { running } = await proxy(up.url);
    expect((await call(running, 'POST', '/_yokla/recordings', '{"replay":{}}')).status).toBe(400);
    expect((await call(running, 'POST', '/_yokla/recordings', '{')).status).toBe(400);
    // A cassette too large to read opens nothing, rather than a recording that forwards.
    const small = await proxy(up.url, { maxRequestBytes: 8 });
    const large = await call(small.running, 'POST', '/_yokla/recordings', '{"capture":true}');
    expect(large.status).toBe(413);
    expect(parse(await call(small.running, 'GET', '/_yokla/health'))).toMatchObject({
      recording: false,
    });
  });
});

/** A proxy with two OpenAI-compatible upstreams on the same fake provider, and a Gemini one. */
async function swapping(up: { url: string }) {
  const records: ProxyRecord[] = [];
  const running = await startProxy({
    port: 0,
    upstreams: [
      { id: 'openai', kind: 'openai-compatible', upstream: up.url },
      { id: 'gateway', kind: 'openai-compatible', upstream: up.url },
      { id: 'gem', kind: 'gemini', upstream: up.url.replace(/\/v1$/u, '') },
    ],
    onRecord: (record) => records.push(record),
  });
  closers.push(() => running.close());
  return { running, records };
}

const ASKED = { model: 'gpt-x', messages: [{ role: 'user', content: 'çadır' }] };

describe('startProxy swapping a model (ADR-0042)', () => {
  it('sends a call that asks for the swapped model to the other, and records the model asked for', async () => {
    const up = await upstream();
    const { running, records } = await swapping(up);
    const opened = await call(
      running,
      'POST',
      '/_yokla/recordings',
      JSON.stringify({ swaps: [{ upstream: 'openai', asked: 'gpt-x', model: 'gpt-mini' }] }),
    );
    expect(opened.status).toBe(201);
    const id = String(Reflect.get(Object(parse(opened)), 'id'));
    // A compressed body is read, changed and sent uncompressed with its new length.
    const zipped = gzipSync(JSON.stringify(ASKED));
    await call(running, 'POST', '/openai/chat/completions', zipped, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(zipped.length),
    });
    // The same model on another upstream isn't this swap's.
    await call(running, 'POST', '/gateway/chat/completions', JSON.stringify(ASKED));
    await call(
      running,
      'POST',
      '/openai/chat/completions',
      JSON.stringify({ ...ASKED, model: 'gpt-other' }),
    );
    // The swap is the recording's: once it closes, nothing changes.
    await call(running, 'DELETE', `/_yokla/recordings/${id}`);
    await call(running, 'POST', '/openai/chat/completions', JSON.stringify(ASKED));
    expect(up.received.map((received) => JSON.parse(received.body) as unknown)).toEqual([
      { ...ASKED, model: 'gpt-mini' },
      ASKED,
      { ...ASKED, model: 'gpt-other' },
      ASKED,
    ]);
    expect(up.received[0]?.headers['content-encoding']).toBeUndefined();
    expect(up.received[0]?.headers['content-length']).toBe(
      String(Buffer.byteLength(JSON.stringify({ ...ASKED, model: 'gpt-mini' }))),
    );
    expect(records.map((record) => [record.upstream, record.asked])).toEqual([
      ['openai', 'gpt-x'],
      ['gateway', undefined],
      ['openai', undefined],
    ]);
    // The prompt is read from the body as it was sent.
    expect(records[0]?.prompt).toEqual([{ role: 'user', chars: 5, text: 'çadır' }]);
  });

  it('sends a swap to another upstream of the same kind, and refuses one it cannot apply', async () => {
    const up = await upstream();
    const { running, records } = await swapping(up);
    const open = (swaps: unknown) =>
      call(running, 'POST', '/_yokla/recordings', JSON.stringify({ swaps }));
    const refused = async (swaps: unknown) => {
      const answer = await open(swaps);
      expect(answer.status).toBe(400);
      return String(Reflect.get(Object(parse(answer)), 'error'));
    };
    expect(await refused([{ upstream: 'nope', asked: 'a', model: 'b' }])).toBe(
      'a model swap can\'t apply: no upstream "nope"',
    );
    expect(await refused([{ upstream: 'openai', asked: 'a', model: 'b', to: 'nope' }])).toBe(
      'a model swap can\'t apply: no upstream "nope"',
    );
    expect(await refused([{ upstream: 'openai', asked: 'a', model: 'b', to: 'gem' }])).toBe(
      'a model swap can\'t apply: upstream "gem" is gemini, not openai-compatible like "openai"',
    );
    expect(
      (await open([{ upstream: 'openai', asked: 'gpt-x', model: 'gpt-mini', to: 'gateway' }]))
        .status,
    ).toBe(201);
    await call(running, 'POST', '/openai/chat/completions', JSON.stringify(ASKED));
    expect(records[0]).toMatchObject({ upstream: 'gateway', asked: 'gpt-x' });
  });

  it('applies a fault plan by the upstream the app called, wherever the swap sends the call', async () => {
    const up = await upstream();
    const { running, records } = await swapping(up);
    const opened = await call(
      running,
      'POST',
      '/_yokla/recordings',
      JSON.stringify({
        swaps: [{ upstream: 'openai', asked: 'gpt-x', model: 'gpt-mini', to: 'gateway' }],
      }),
    );
    const id = String(Reflect.get(Object(parse(opened)), 'id'));
    await call(
      running,
      'PUT',
      `/_yokla/recordings/${id}/turns/t`,
      JSON.stringify({
        inFlight: true,
        faults: [{ fault: { kind: 'status', status: 503 }, upstream: 'openai' }],
      }),
    );
    const answer = await call(running, 'POST', '/openai/chat/completions', JSON.stringify(ASKED));
    expect(answer.status).toBe(503);
    expect(records[0]).toMatchObject({ fault: { kind: 'status', applied: true } });
    expect(up.received).toEqual([]);
  });

  it("changes a Gemini call's model in its path", async () => {
    const up = await upstream();
    const { running, records } = await swapping(up);
    await call(
      running,
      'POST',
      '/_yokla/recordings',
      JSON.stringify({
        swaps: [{ upstream: 'gem', asked: 'gemini-2.5-flash', model: 'gemini-mini' }],
      }),
    );
    await call(
      running,
      'POST',
      '/gem/v1beta/models/gemini-2.5-flash:generateContent?key=k',
      '{"contents":[]}',
    );
    expect(up.received[0]?.url).toBe('/v1beta/models/gemini-mini:generateContent?key=k');
    expect(up.received[0]?.body).toBe('{"contents":[]}');
    expect(records[0]).toMatchObject({ asked: 'gemini-2.5-flash', model: 'gemini-mini' });
  });
});
