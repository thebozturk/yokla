import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer, type TestServerOptions } from '../testing/ws-server.ts';
import { openWebSocket, WebSocketError, type WebSocketOptions } from './client.ts';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(options: TestServerOptions): Promise<TestServer> {
  server = await startTestServer(options);
  return server;
}

const ends = (text: string) => text.includes('"end"');

function open(target: TestServer, change: Partial<WebSocketOptions> = {}, path = '/chat') {
  return openWebSocket(`${target.url}${path}`, {
    allowedOrigins: [target.url],
    timeoutMs: 2_000,
    ...change,
  });
}

describe('the WebSocket client (ADR-0024)', () => {
  it('sends handshake headers and subprotocols, and reads an answer up to its end', async () => {
    const target = await serve({
      protocol: (asked) => asked[0],
      onMessage(text, socket) {
        const question = /"text":"([^"]*)"/u.exec(text)?.[1] ?? '';
        socket.send(JSON.stringify({ type: 'delta', text: `You asked: ${question}` }));
        socket.send(JSON.stringify({ type: 'delta', text: '!' }));
        socket.send(JSON.stringify({ type: 'end' }));
      },
    });
    const connection = await open(target, {
      headers: { authorization: 'Bearer t-1', 'x-client': 'yokla' },
      protocols: ['chat.v1', 'chat.v0'],
    });
    const answer = await connection.exchange(JSON.stringify({ text: 'tents?' }), ends);
    expect(answer.end).toBe('message');
    expect(answer.between).toBe(0);
    expect(answer.messages.map((message) => message.text)).toEqual([
      '{"type":"delta","text":"You asked: tents?"}',
      '{"type":"delta","text":"!"}',
      '{"type":"end"}',
    ]);
    const times = answer.messages.map((message) => message.atMs);
    expect(times.toSorted((a, b) => a - b)).toEqual(times);
    expect(answer.latencyMs).toBeGreaterThanOrEqual(times.at(-1) ?? 0);
    const [handshake] = target.handshakes;
    expect(handshake?.path).toBe('/chat');
    expect(handshake?.headers['authorization']).toBe('Bearer t-1');
    expect(handshake?.headers['x-client']).toBe('yokla');
    expect(handshake?.protocols).toEqual(['chat.v1', 'chat.v0']);
    await connection.close();
    expect(target.closes).toEqual([1000]);
  });

  it('keeps one connection for every turn, and reads an answer given in one message', async () => {
    const target = await serve({
      onMessage(text, socket) {
        socket.send(JSON.stringify({ type: 'end', echo: text }));
      },
    });
    const connection = await open(target);
    const first = await connection.exchange('one', ends);
    const second = await connection.exchange('two', ends);
    expect(first.messages.map((message) => message.text)).toEqual(['{"type":"end","echo":"one"}']);
    expect(second.messages.map((message) => message.text)).toEqual(['{"type":"end","echo":"two"}']);
    expect(target.handshakes).toHaveLength(1);
    expect(target.received).toEqual(['one', 'two']);
    await connection.close();
  });

  it('refuses an origin it was not given, before connecting', async () => {
    const target = await serve({});
    const other = await startTestServer({});
    try {
      await expect(
        openWebSocket(`${other.url}/chat`, { allowedOrigins: [target.url], timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ kind: 'refused-host' });
      expect(other.handshakes).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('fails to open when the server refuses the handshake', async () => {
    const target = await serve({ refuse: () => 401 });
    const opening = open(target);
    await expect(opening).rejects.toBeInstanceOf(WebSocketError);
    const error: unknown = await opening.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'connect' });
    expect(error instanceof Error ? error.message : '').toMatch(
      /^the connection could not be opened \(code \d+/u,
    );
  });

  it('ends an answer when the connection closes, saying how, and every later one at once', async () => {
    const target = await serve({
      onMessage(_text, socket) {
        socket.send(JSON.stringify({ type: 'delta', text: 'Half' }));
        socket.close(1011, 'model failed');
      },
    });
    const connection = await open(target);
    const cut = await connection.exchange('hi', ends);
    expect(cut.end).toBe('closed');
    expect(cut.closed).toEqual({ code: 1011, reason: 'model failed' });
    expect(cut.messages.map((message) => message.text)).toEqual(['{"type":"delta","text":"Half"}']);
    const after = await connection.exchange('again', ends);
    expect(cut.sent).toBe(true);
    expect(after).toMatchObject({
      end: 'closed',
      messages: [],
      closed: { code: 1011 },
      sent: false,
    });
    expect(target.received).toEqual(['hi']);
  });

  it('ends an answer that does not finish in time, keeping what arrived', async () => {
    const target = await serve({
      onMessage(_text, socket) {
        socket.send(JSON.stringify({ type: 'delta', text: 'Thinking' }));
      },
    });
    const connection = await open(target, { timeoutMs: 150 });
    const answer = await connection.exchange('hi', ends);
    expect(answer.end).toBe('timeout');
    expect(answer.messages).toHaveLength(1);
    expect(answer.latencyMs).toBeGreaterThanOrEqual(140);
    await connection.close();
  });

  it('counts messages after an answer ended, but not a greeting before the first message', async () => {
    const target = await serve({
      onOpen(socket) {
        socket.send(JSON.stringify({ type: 'hello' }));
      },
      onMessage(_text, socket) {
        socket.send(JSON.stringify({ type: 'end' }));
        socket.send(JSON.stringify({ type: 'memory_saved' }));
        socket.send(JSON.stringify({ type: 'memory_saved' }));
      },
    });
    const connection = await open(target);
    // The greeting arrives before the first message goes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const first = await connection.exchange('one', ends);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await connection.exchange('two', ends);
    expect(first.between).toBe(0);
    expect(first.messages.map((message) => message.text)).toEqual(['{"type":"end"}']);
    expect(second.between).toBe(2);
    expect(second.messages.map((message) => message.text)).toEqual(['{"type":"end"}']);
    await connection.close();
  });

  it('reads a binary message as UTF-8 text', async () => {
    const target = await serve({
      onMessage(_text, socket) {
        socket.send(new TextEncoder().encode('{"type":"end","text":"Çadır"}'));
      },
    });
    const connection = await open(target);
    const answer = await connection.exchange('hi', ends);
    expect(answer.messages.map((message) => message.text)).toEqual([
      '{"type":"end","text":"Çadır"}',
    ]);
    await connection.close();
  });

  it('stops an answer over the size limit, counting all its messages', async () => {
    const target = await serve({
      onMessage(_text, socket) {
        socket.send('x'.repeat(60));
        socket.send('y'.repeat(60));
        socket.send(JSON.stringify({ type: 'end' }));
      },
    });
    const connection = await open(target, { maxAnswerBytes: 100 });
    await expect(connection.exchange('hi', ends)).rejects.toMatchObject({ kind: 'too-large' });
    await connection.close();
  });

  it('paces every message', async () => {
    const target = await serve({
      onMessage(_text, socket) {
        socket.send(JSON.stringify({ type: 'end' }));
      },
    });
    let paced = 0;
    const connection = await open(target, {
      pace: () => {
        paced += 1;
        return Promise.resolve();
      },
    });
    await connection.exchange('one', ends);
    await connection.exchange('two', ends);
    expect(paced).toBe(2);
    await connection.close();
  });
});
