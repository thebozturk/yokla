import { request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Assistant } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { ScriptedModel, type ChatModel, type ModelCall } from './model.ts';
import type { RateLimitOptions } from './rate-limit.ts';
import { createDemoShopServer, SUMMARY_DELAY_MS } from './server.ts';

const data = loadShopData();
const servers: Server[] = [];

async function start(
  rateLimit: RateLimitOptions | false = false,
  now?: () => number,
  change: { model?: ChatModel; summarizeAfterAnswer?: boolean } = {},
): Promise<string> {
  const assistant = new Assistant({
    data,
    model: change.model ?? new ScriptedModel(),
    defect: null,
  });
  const server = createDemoShopServer({
    assistant,
    rateLimit,
    ...(now === undefined ? {} : { now }),
    ...(change.summarizeAfterAnswer === undefined
      ? {}
      : { summarizeAfterAnswer: change.summarizeAfterAnswer }),
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** A field of a parsed JSON value, or undefined. */
function field(value: unknown, key: string): unknown {
  return Reflect.get(Object(value), key);
}

function chat(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('demo-shop HTTP server', () => {
  it('answers a chat request in the documented shape', async () => {
    const base = await start();
    const response = await chat(base, { message: 'Show me headlamps', sessionId: 's1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cache')).toBe('miss');
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      data: {
        answer: expect.stringContaining('Here are our headlamps:') as unknown,
        metadata: { route: 'product-search', language: 'en' },
        products: [
          {
            id: 'HLP-001',
            name: 'Headlamp 200 lm',
            category: 'outdoor/lighting/headlamp',
            price: { amount: 349.9, currency: 'TRY' },
            stockQuantity: 40,
            available: true,
            attributes: {},
          },
          { id: 'HLP-002', stockQuantity: null, available: null },
          { id: 'HLP-003', stockQuantity: 0, available: false },
        ],
      },
    });
  });

  it('serves repeated first turns from cache unless the bypass header is set', async () => {
    const base = await start();
    const message = { message: 'Çadır önerir misin?', sessionId: 'a' };
    expect((await chat(base, message)).headers.get('x-cache')).toBe('miss');
    expect((await chat(base, { ...message, sessionId: 'b' })).headers.get('x-cache')).toBe('hit');
    expect(
      (await chat(base, { ...message, sessionId: 'c' }, { 'x-cache-bypass': '1' })).headers.get(
        'x-cache',
      ),
    ).toBe('bypass');
    expect(
      (await chat(base, { ...message, sessionId: 'd' }, { 'x-cache-bypass': '0' })).headers.get(
        'x-cache',
      ),
    ).toBe('hit');
  });

  it('rate limits with 429 and Retry-After', async () => {
    let time = 0;
    const base = await start({ burstPerSecond: 1, perMinute: 60 }, () => time);
    expect((await chat(base, { message: 'Merhaba', sessionId: 'a' })).status).toBe(200);
    const limited = await chat(base, { message: 'Merhaba', sessionId: 'a' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    time += 1_000;
    expect((await chat(base, { message: 'Merhaba', sessionId: 'a' })).status).toBe(200);
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing message', { sessionId: 's' }],
    ['empty message', { message: '  ', sessionId: 's' }],
    ['missing session', { message: 'hi' }],
    ['non-string session', { message: 'hi', sessionId: 1 }],
  ])('rejects %s with 400', async (_name, body) => {
    const base = await start();
    expect((await chat(base, body)).status).toBe(400);
  });

  it('rejects oversized bodies, unknown paths and wrong methods', async () => {
    const base = await start();
    expect((await chat(base, { message: 'x'.repeat(70_000), sessionId: 's' })).status).toBe(413);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const get = await fetch(`${base}/v1/chat`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('issues sessions, and takes a session from the x-session-id header over the body', async () => {
    const base = await start();
    const issued = await fetch(`${base}/v1/sessions`, { method: 'POST' });
    expect(issued.status).toBe(201);
    const body: unknown = await issued.json();
    const sessionId = String(Reflect.get(Object(Reflect.get(Object(body), 'data')), 'sessionId'));
    expect(sessionId).toMatch(/^[\da-f-]{36}$/u);
    const first = await chat(
      base,
      { message: "Do you have women's jackets in size M?" },
      {
        'x-session-id': sessionId,
      },
    );
    expect(first.status).toBe(200);
    // The follow-up finds the first turn's products through the header session alone.
    const follow = await chat(
      base,
      { message: 'the cheaper one?', sessionId: 'other' },
      {
        'x-session-id': sessionId,
      },
    );
    expect(JSON.stringify(await follow.json())).toContain('follow-up-cheapest');
    expect((await chat(base, { message: 'hi' })).status).toBe(400);
  });

  it('streams the answer as events when asked: products, text in pieces, then done', async () => {
    const base = await start();
    const plain: unknown = await (
      await chat(base, { message: 'Çadır önerir misin?', sessionId: 's1' })
    ).json();
    const streamed = await chat(
      base,
      { message: 'Çadır önerir misin?', sessionId: 's2' },
      { accept: 'text/event-stream', 'x-cache-bypass': '1' },
    );
    expect(streamed.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const events = (await streamed.text())
      .split('\n\n')
      .filter((block) => block !== '')
      .map((block) => {
        const [event = '', payload = ''] = block.split('\n');
        const value: unknown = JSON.parse(payload.slice('data: '.length));
        return { event: event.slice('event: '.length), value };
      });
    const reply: unknown = Reflect.get(Object(plain), 'data');
    expect(events[0]).toEqual({
      event: 'products',
      value: { products: field(reply, 'products') },
    });
    expect(events.at(-1)).toEqual({ event: 'done', value: field(reply, 'metadata') });
    const deltas = events.filter((entry) => entry.event === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((entry) => String(field(entry.value, 'text'))).join('')).toBe(
      field(reply, 'answer'),
    );
  });

  it('summarises each answer in the background after it went out, when asked', async () => {
    const summaries: { answer: string; call: ModelCall | undefined; at: number }[] = [];
    const scripted = new ScriptedModel();
    const model: ChatModel = {
      interpret: (message, context) => scripted.interpret(message, context),
      write: (draft) => scripted.write(draft),
      summarize: (answer, call) => {
        summaries.push({ answer, call, at: performance.now() });
        return Promise.reject(new Error('summary lost'));
      },
    };
    const base = await start(false, undefined, { model, summarizeAfterAnswer: true });
    const plain = await start(false, undefined, { model });
    const sent = performance.now();
    const answered = await chat(
      base,
      { message: 'Merhaba', sessionId: 's' },
      { 'x-yokla-trace': 't-1' },
    );
    expect(answered.status).toBe(200);
    expect(summaries).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, SUMMARY_DELAY_MS + 50));
    expect(summaries).toEqual([
      {
        answer: 'Ürünler, fiyatlar ve iade koşulları hakkında yardımcı olabilirim. Ne aramıştınız?',
        call: { trace: 't-1' },
        at: expect.any(Number) as unknown,
      },
    ]);
    expect((summaries[0]?.at ?? 0) - sent).toBeGreaterThanOrEqual(SUMMARY_DELAY_MS);
    await chat(plain, { message: 'Merhaba', sessionId: 's' });
    await new Promise((resolve) => setTimeout(resolve, SUMMARY_DELAY_MS + 50));
    expect(summaries).toHaveLength(1);
  });
});

/** Each turn's events over one WebSocket: a turn ends at its done or error event. */
async function converse(url: string, messages: readonly unknown[]): Promise<unknown[][]> {
  const socket = new WebSocket(url);
  const turns: unknown[][] = [];
  let current: unknown[] = [];
  let finish: (() => void) | undefined;
  socket.addEventListener('message', (event) => {
    const received: unknown = JSON.parse(String(event.data));
    current.push(received);
    const type = field(received, 'type');
    if (type === 'done' || type === 'error') finish?.();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('close', (event) => {
      reject(new Error(`closed with ${String(event.code)}`));
    });
  });
  for (const message of messages) {
    current = [];
    const answered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    await answered;
    turns.push(current);
  }
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener('close', () => {
      resolve();
    });
  });
  socket.close(1000);
  await closed;
  return turns;
}

const types = (events: readonly unknown[] | undefined) =>
  (events ?? []).map((event) => field(event, 'type'));

const text = (events: readonly unknown[] | undefined) =>
  (events ?? [])
    .filter((event) => field(event, 'type') === 'delta')
    .map((event) => String(field(event, 'text')))
    .join('');

/** Sends raw bytes to the shop and resolves with everything it sent back. */
function raw(base: string, bytes: readonly Buffer[]): Promise<Buffer> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('end', () => {
      resolve(Buffer.concat(received));
    });
    socket.on('error', reject);
    socket.on('connect', () => {
      for (const chunk of bytes) socket.write(chunk);
    });
    setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(received));
    }, 1_500).unref();
  });
}

/** The code of the close frame after the handshake's response, if any. */
function closeCode(bytes: Buffer): number | undefined {
  const at = bytes.indexOf(Buffer.from([0x88]), bytes.indexOf('\r\n\r\n') + 4);
  return at === -1 ? undefined : bytes.readUInt16BE(at + 2);
}

const HANDSHAKE = Buffer.from(
  [
    'GET /v1/ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n'),
);

describe('demo-shop chat over a WebSocket', () => {
  it('answers with the events of its stream, one message each, the text as over HTTP', async () => {
    const base = await start();
    const [turn] = await converse(`${base.replace('http:', 'ws:')}/v1/ws`, [
      { message: 'Show me headlamps', sessionId: 's1' },
    ]);
    const kinds = types(turn);
    expect(kinds[0]).toBe('products');
    expect(kinds.at(-1)).toBe('done');
    expect(new Set(kinds.slice(1, -1))).toEqual(new Set(['delta']));
    expect(field(turn?.[0], 'products')).toHaveLength(3);
    expect(turn?.at(-1)).toMatchObject({ type: 'done', route: 'product-search', language: 'en' });
    const overHttp: unknown = await (
      await chat(base, { message: 'Show me headlamps', sessionId: 's2' })
    ).json();
    expect(text(turn)).toBe(field(field(overHttp, 'data'), 'answer'));
  });

  it("keeps the url's session for every message, and refuses a bad one with an error event", async () => {
    const base = await start();
    const turns = await converse(`${base.replace('http:', 'ws:')}/v1/ws?session=abc`, [
      { message: 'Çadır var mı?' },
      { message: '  ' },
      '{',
      { message: 'Daha ucuzu var mı?' },
    ]);
    expect(turns.map(types).map((kinds) => kinds.at(-1))).toEqual([
      'done',
      'error',
      'error',
      'done',
    ]);
    expect(turns[1]?.[0]).toMatchObject({ type: 'error', error: 'invalid_request' });
    // The follow-up was understood in the same session.
    expect(turns[3]?.at(-1)).toMatchObject({ route: 'follow-up-cheapest' });
  });

  it('rate limits each message with an error event', async () => {
    let time = 0;
    const base = await start({ burstPerSecond: 1, perMinute: 60 }, () => time);
    const turns = await converse(`${base.replace('http:', 'ws:')}/v1/ws`, [
      { message: 'Merhaba', sessionId: 'a' },
      { message: 'Merhaba', sessionId: 'a' },
    ]);
    expect(turns[1]).toEqual([{ type: 'error', error: 'rate_limited', detail: 'retry after 1 s' }]);
  });

  it('refuses an upgrade on another path, and one that is not a valid handshake', async () => {
    const base = await start();
    const notFound = await raw(base, [
      Buffer.from(HANDSHAKE.toString().replace('/v1/ws', '/v1/chat')),
    ]);
    expect(notFound.toString()).toMatch(/^HTTP\/1\.1 404 /u);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/v1/ws`, {
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13' },
      });
      request.on('response', (response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(400);
  });

  it('closes with 1002 on an unmasked frame, and with 1009 on a message over the limit', async () => {
    const base = await start();
    const unmasked = await raw(base, [HANDSHAKE, Buffer.from([0x81, 0x02, 0x68, 0x69])]);
    expect(unmasked.toString()).toMatch(/^HTTP\/1\.1 101 /u);
    expect(closeCode(unmasked)).toBe(1002);
    const huge = Buffer.alloc(10);
    huge[0] = 0x81;
    huge[1] = 0x80 | 127;
    huge.writeBigUInt64BE(BigInt(1024 * 1024), 2);
    const oversized = await raw(base, [HANDSHAKE, huge]);
    expect(closeCode(oversized)).toBe(1009);
  });
});
