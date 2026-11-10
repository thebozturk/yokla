import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Assistant } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { createFakeProvider, tokenCount, type UsageEntry } from './fake-provider.ts';
import { ScriptedModel, type ChatModel, type ModelCall } from './model.ts';
import { RemoteModel, ROLES } from './remote-model.ts';
import { createDemoShopServer } from './server.ts';

const data = loadShopData();
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

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function provider(): Promise<{ url: string; usage: UsageEntry[] }> {
  const usage: UsageEntry[] = [];
  const url = await listen(createFakeProvider({ key: 'k', onUsage: (entry) => usage.push(entry) }));
  return { url: `${url}/v1`, usage };
}

/** Conversations covering every route, follow-ups included. */
const CONVERSATIONS = [
  ['Çadır önerir misin?'],
  ['500 TL altı çadır'],
  ['Siyah kadın mont arıyorum'],
  ['Uyku matı var mı?'],
  ['İade koşulları neler?'],
  ['Kargo ücretsiz mi?'],
  ['Can you recommend a stock to invest in?'],
  ['Merhaba'],
  ["Do you have women's jackets in size M?", 'the cheaper one?'],
];

async function replies(model: ChatModel): Promise<unknown[]> {
  const shop = new Assistant({ data, model, defect: null });
  const out: unknown[] = [];
  for (const [index, turns] of CONVERSATIONS.entries()) {
    for (const message of turns) {
      out.push((await shop.reply(`s${String(index)}`, message, { bypassCache: true })).reply);
    }
  }
  return out;
}

describe('the demo-shop model over HTTP', () => {
  it('answers exactly as the model in process does, in JSON and in streams', async () => {
    const { url, usage } = await provider();
    const expected = await replies(new ScriptedModel());
    expect(await replies(new RemoteModel({ url, key: 'k' }))).toEqual(expected);
    expect(await replies(new RemoteModel({ url, key: 'k', stream: true }))).toEqual(expected);
    // Two model calls per turn, ten turns, twice.
    expect(usage).toHaveLength(40);
    expect(usage.filter((entry) => entry.stream)).toHaveLength(20);
  });

  it('forwards the turn trace to the provider', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const url = await listen(
      createServer((request, response) => {
        seen.push(request.headers);
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: 'Merhaba' } }] }));
        });
      }),
    );
    await new RemoteModel({ url, key: 'k' }).write(
      { kind: 'fallback', language: 'tr' },
      { trace: 't-1' },
    );
    await new RemoteModel({ url, key: 'k' }).write({ kind: 'fallback', language: 'tr' });
    expect(seen.map((headers) => headers['x-yokla-trace'])).toEqual(['t-1', undefined]);
    expect(seen[0]?.authorization).toBe('Bearer k');
  });
});

describe('the demo-shop server', () => {
  it('passes an incoming x-yokla-trace on to both model calls of the turn', async () => {
    const calls: (ModelCall | undefined)[] = [];
    const scripted = new ScriptedModel();
    const model: ChatModel = {
      interpret: (message, context, call) => {
        calls.push(call);
        return scripted.interpret(message, context);
      },
      write: (draft, call) => {
        calls.push(call);
        return scripted.write(draft);
      },
    };
    const url = await listen(
      createDemoShopServer({
        assistant: new Assistant({ data, model, defect: null }),
        rateLimit: false,
      }),
    );
    const ask = (headers: Record<string, string>) =>
      fetch(`${url}/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cache-bypass': '1', ...headers },
        body: JSON.stringify({ message: 'Merhaba', sessionId: `s-${String(calls.length)}` }),
      });
    expect((await ask({ 'x-yokla-trace': 'turn-9' })).status).toBe(200);
    expect((await ask({})).status).toBe(200);
    expect(calls).toEqual([{ trace: 'turn-9' }, { trace: 'turn-9' }, {}, {}]);
  });
});

/** A chat completions call to the fake provider. */
async function post(url: string, body: unknown, key = 'k'): Promise<Response> {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

describe('the fake provider', () => {
  it('counts tokens deterministically and records them, as the usage it reports', async () => {
    const { url, usage } = await provider();
    const messages = [
      { role: 'system', content: ROLES.write },
      { role: 'user', content: JSON.stringify({ draft: { kind: 'fallback', language: 'en' } }) },
    ];
    const response = await post(url, { model: 'demo-writer-1', messages });
    const body: unknown = await response.json();
    const content = 'I can help with products, prices and return terms. What are you looking for?';
    const prompt = messages.map((m) => m.content).join('');
    expect(body).toMatchObject({
      model: 'demo-writer-1',
      choices: [{ message: { content } }],
      usage: { prompt_tokens: tokenCount(prompt), completion_tokens: tokenCount(content) },
    });
    expect(usage).toEqual([
      {
        id: expect.stringMatching(/^chatcmpl-/u) as unknown,
        model: 'demo-writer-1',
        promptTokens: tokenCount(prompt),
        completionTokens: tokenCount(content),
        stream: false,
      },
    ]);
    expect(tokenCount('abcd')).toBe(1);
    expect(tokenCount('abcde')).toBe(2);
    expect(tokenCount('ğ')).toBe(1);
  });

  it('streams usage only when asked to, like the real API', async () => {
    const { url } = await provider();
    const messages = [
      { role: 'system', content: ROLES.write },
      { role: 'user', content: JSON.stringify({ draft: { kind: 'refusal', language: 'en' } }) },
    ];
    const plain = await (await post(url, { model: 'm', messages, stream: true })).text();
    const counted = await (
      await post(url, {
        model: 'm',
        messages,
        stream: true,
        stream_options: { include_usage: true },
      })
    ).text();
    expect(plain).not.toContain('"usage"');
    expect(counted).toContain('"usage":{"prompt_tokens"');
    expect(plain.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('refuses a wrong key, a bad request and other paths, without recording them', async () => {
    const { url, usage } = await provider();
    expect((await post(url, { model: 'm', messages: [] }, 'wrong')).status).toBe(401);
    expect(
      (await post(url, { model: 'm', messages: [{ role: 'system', content: 'x' }] })).status,
    ).toBe(400);
    expect((await fetch(`${url}/models`)).status).toBe(404);
    expect(usage).toEqual([]);
  });
});
