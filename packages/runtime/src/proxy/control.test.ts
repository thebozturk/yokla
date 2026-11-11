import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ProxyControl, ProxyControlError } from './control.ts';

const servers: Server[] = [];
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

const RECORD = {
  id: 'c1',
  upstream: 'openai',
  kind: 'openai-compatible',
  method: 'POST',
  path: '/chat/completions',
  model: 'm',
  startedAt: '2026-11-10T12:00:00.000Z',
  durationMs: 12.5,
  status: 200,
  stream: false,
  usage: { input: 3, output: 1, cachedInput: null, cacheWrite: null, reasoning: null },
  trace: null,
};

/** A stand-in for the proxy's control endpoint. */
async function control(answers: Record<string, [number, unknown]>): Promise<string> {
  const server = createServer((request, response) => {
    const answer = answers[`${request.method ?? ''} ${request.url ?? ''}`];
    const [status, body] = answer ?? [404, { error: 'not here' }];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('ProxyControl', () => {
  it('checks health, opens a recording and closes it with its records', async () => {
    const url = await control({
      'GET /_yokla/health': [200, { ok: true, upstreams: ['openai'], recording: false }],
      'POST /_yokla/recordings': [201, { id: 'rec-1', startedAt: '2026-11-10T12:00:00.000Z' }],
      'DELETE /_yokla/recordings/rec-1': [200, { id: 'rec-1', startedAt: 'x', records: [RECORD] }],
      'PUT /_yokla/recordings/rec-1/turns/turn%201': [200, { id: 'rec-1', turn: 'turn 1' }],
    });
    const proxy = new ProxyControl(url);
    expect(await proxy.health()).toEqual({ ok: true, upstreams: ['openai'], recording: false });
    expect(await proxy.open()).toEqual({ id: 'rec-1', startedAt: '2026-11-10T12:00:00.000Z' });
    await expect(proxy.turn('rec-1', 'turn 1', { inFlight: true })).resolves.toBeUndefined();
    expect(await proxy.close('rec-1')).toEqual([RECORD]);
  });

  it('reports what the proxy said when it refuses, and an unexpected answer', async () => {
    const url = await control({
      'POST /_yokla/recordings': [409, { error: 'recording r is already open' }],
      'GET /_yokla/health': [200, { ok: 'yes' }],
      'DELETE /_yokla/recordings/x': [200, 'not json'],
    });
    const proxy = new ProxyControl(url);
    await expect(proxy.open()).rejects.toThrow(
      new ProxyControlError('the model proxy answered 409: recording r is already open'),
    );
    await expect(proxy.health()).rejects.toThrow(/unexpected answer/u);
    await expect(proxy.close('x')).rejects.toThrow(/unexpected answer/u);
  });

  it("says when nothing answers, and refuses a proxy that isn't local", async () => {
    const url = await control({});
    const closed = servers.pop();
    await new Promise<void>((resolve) => closed?.close(() => resolve()));
    await expect(new ProxyControl(url).health()).rejects.toThrow(/doesn't answer/u);
    expect(() => new ProxyControl('http://192.0.2.1:8787')).toThrow(/must be local/u);
  });
});
