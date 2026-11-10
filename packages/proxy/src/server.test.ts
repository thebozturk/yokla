import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { ProxyRecord } from '@yokla/core';
import { afterEach, describe, expect, it } from 'vitest';
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
async function upstream(): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
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
  return { url: `http://127.0.0.1:${String(address.port)}/v1`, received };
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
  body = '',
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
    const slow = call(running, 'POST', '/openai/stream', '{"stream":true}');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closed = parse(await call(running, 'DELETE', `/_yokla/recordings/${id}`));
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
