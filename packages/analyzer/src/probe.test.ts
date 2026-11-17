import type { DataRow, ProbedRows } from '@yokla/core';
import { startTestServer, type TestServer, type TestServerOptions } from '@yokla/runtime/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { plannedMessages, ProbeError, probeTarget, type ProbeTarget } from './probe.ts';
import { analysisReport, probeEntries, proposalDocument, proposalYaml } from './propose.ts';

type OnHttp = NonNullable<TestServerOptions['onHttp']>;
type IncomingMessage = Parameters<OnHttp>[0];
type ServerResponse = Parameters<OnHttp>[1];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const rows: DataRow[] = [
  { id: 'T1', name_tr: 'Kubbe Çadır', price: 2499.9, currency: 'TRY' },
  { id: 'T2', name_tr: 'Plaj Çadırı', price: 899.5, currency: 'TRY' },
];

const probed: ProbedRows = {
  rows,
  id: 'id',
  evidenceFields: { id: 'id', name_tr: 'name', price: 'price', currency: 'currency' },
  probe: { message: 'tent var mı?', collection: 'products' },
  next: (shown) => {
    const name = shown[0]?.['name_tr'];
    return typeof name === 'string' ? { message: `${name} sepete`, collection: 'cart' } : undefined;
  },
};

interface Heard {
  readonly body: Record<string, unknown>;
}

function read(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      resolve(isRecord(parsed) ? parsed : {});
    });
  });
}

/** A shop: a greeting, the products for a type question, the cart after a cart request. */
async function shop(
  answer: (body: Record<string, unknown>, response: ServerResponse) => void = (body, response) => {
    const message = String(body['message']);
    // The cart's answer shows the products again, as many shops' do.
    const products =
      message.includes('tent') || message.includes('sepete')
        ? [rows[1], rows[0]].map((row) => ({
            sku: row?.['id'],
            title: row?.['name_tr'],
            cost: { value: row?.['price'], code: row?.['currency'] },
          }))
        : [];
    const cart = message.includes('sepete') ? [{ sku: 'T2', title: 'Plaj Çadırı' }] : undefined;
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        reply: {
          text: message === '' ? 'Hello!' : `You said: ${message}. How can I help?`,
          route: 'chat',
        },
        conversationId: 'c-1',
        products,
        ...(cart === undefined ? {} : { cart }),
      }),
    );
  },
): Promise<{ url: string; heard: Heard[] }> {
  const heard: Heard[] = [];
  const server = await startTestServer({
    onHttp: (request, response) => {
      void read(request).then((body) => {
        heard.push({ body });
        answer(body, response);
      });
    },
  });
  servers.push(server);
  return { url: server.url.replace(/^ws/u, 'http'), heard };
}

const target = (url: string, change: Partial<ProbeTarget> = {}): ProbeTarget => ({
  url: `${url}/chat`,
  headers: { 'content-type': 'application/json' },
  body: { message: '{{message}}', session: '{{session}}' },
  greeting: 'Hello! What can you help me with?',
  env: {},
  timeoutMs: 5_000,
  ...change,
});

describe('probeTarget (ADR-0047)', () => {
  it('greets, asks for a type, then puts the first product shown in the cart', async () => {
    const { url, heard } = await shop();
    const result = await probeTarget(target(url), probed);
    expect(heard.map((h) => h.body['message'])).toEqual([
      'Hello! What can you help me with?',
      'tent var mı?',
      'Plaj Çadırı sepete',
    ]);
    // One session for the three.
    expect(new Set(heard.map((h) => h.body['session'])).size).toBe(1);
    expect(result.inference.text.path).toBe('$.reply.text');
    expect(result.probes.map((probe) => [probe.status, probe.message])).toEqual([
      [200, 'Hello! What can you help me with?'],
      [200, 'tent var mı?'],
      [200, 'Plaj Çadırı sepete'],
    ]);
    expect(result.probes[1]?.shape).not.toContain('Kubbe');
    expect(result.collections).toEqual([
      {
        name: 'products',
        probe: 2,
        match: {
          items: '$.products[*]',
          fields: { id: 'sku', name_tr: 'title', price: 'cost.value', currency: 'cost.code' },
          matched: 2,
          ids: ['T2', 'T1'],
        },
      },
      {
        name: 'cart',
        probe: 3,
        match: {
          items: '$.cart[*]',
          fields: { id: 'sku', name_tr: 'title' },
          matched: 1,
          ids: ['T2'],
        },
      },
    ]);
  });

  it("carries what the answer gives to the next probe, as the profile's session would", async () => {
    const { url, heard } = await shop();
    await probeTarget(
      target(url, { body: { message: '{{message}}', conversationId: '{{carry.conversationId}}' } }),
      probed,
    );
    expect(heard.map((h) => h.body['conversationId'])).toEqual([undefined, 'c-1', 'c-1']);
  });

  it('sends the greeting alone without a catalog', async () => {
    const { url, heard } = await shop();
    const result = await probeTarget(target(url), undefined);
    expect(heard).toHaveLength(1);
    expect(result.collections).toEqual([]);
    expect(plannedMessages(target(url), undefined)).toEqual(['Hello! What can you help me with?']);
    expect(plannedMessages(target(url), probed)).toHaveLength(3);
  });

  it("says why an answer that can't be read stops it", async () => {
    const { url } = await shop((_body, response) => {
      response.writeHead(500).end('down');
    });
    await expect(probeTarget(target(url), probed)).rejects.toThrow(ProbeError);
    await expect(probeTarget(target(url), probed)).rejects.toThrow(/the target answered 500/u);
  });

  it('refuses any host but the target', async () => {
    await expect(probeTarget(target('http://127.0.0.1:9'), undefined)).rejects.toThrow(ProbeError);
  });
});

describe('the proposal (ADR-0047)', () => {
  const person = {
    name: 'assistant',
    url: 'http://127.0.0.1:3000/chat',
    headers: { 'content-type': 'application/json' },
    body: { message: '{{message}}' },
    languages: [],
  };

  it('holds the request as given, every entry at its pointer, and a provenance map at the top', async () => {
    const { url } = await shop();
    const result = await probeTarget(target(url), probed);
    const entries = probeEntries(result, probed.evidenceFields);
    const document = proposalDocument(person, 'none', entries);
    expect(Object.keys(document)[0]).toBe('provenance');
    expect(document['target']).toEqual({
      name: 'assistant',
      adapter: 'http',
      request: {
        url: 'http://127.0.0.1:3000/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { message: '{{message}}' },
      },
      response: {
        text: '$.reply.text',
        route: '$.reply.route',
        evidence: {
          products: {
            items: '$.products[*]',
            fields: { id: 'sku', name: 'title', price: 'cost.value', currency: 'cost.code' },
          },
          cart: { items: '$.cart[*]', fields: { id: 'sku', name: 'title' } },
        },
      },
      session: { mode: 'none', carry: [{ name: 'conversationId', from: '$.conversationId' }] },
    });
    const provenance = document['provenance'];
    if (!isRecord(provenance)) throw new Error('no provenance map');
    expect(provenance['/target/response/evidence/products/fields/price']).toEqual({
      source: 'probe',
      evidence: "probe 2: cost.value equals the catalog's price in 2 of 2 items",
      status: 'proposed',
    });
    expect(Object.keys(provenance)).toEqual(entries.map((entry) => entry.pointer));
  });

  it('writes the same YAML for the same proposal, with how to approve it', () => {
    const document = proposalDocument(person, 'client', [
      {
        pointer: '/ecommerce/typeSeparator',
        value: '/',
        provenance: { source: 'data', evidence: 'x', status: 'proposed' },
      },
    ]);
    const text = proposalYaml(document, '9.9.9');
    expect(text).toBe(
      proposalYaml(
        proposalDocument(person, 'client', [
          {
            pointer: '/ecommerce/typeSeparator',
            value: '/',
            provenance: { source: 'data', evidence: 'x', status: 'proposed' },
          },
        ]),
        '9.9.9',
      ),
    );
    expect(text).toMatch(/^# Proposed by yokla analyze 9\.9\.9 \(ADR-0047\)\. Nothing here runs/u);
    expect(text).toContain('set its status in provenance to approved');
    expect(text).toContain('ecommerce:\n  typeSeparator: /');
  });

  it('compares the proposal with a profile, leaving the person out', () => {
    const report = analysisReport({
      version: '9.9.9',
      inventory: {
        files: [{ path: 'data/c.jsonl', kind: 'data', bytes: 10 }],
        skipped: 1,
        capped: false,
      },
      probes: [],
      entries: [],
      proposal: { target: { request: { url: 'a' }, response: { text: '$.a' } }, languages: ['tr'] },
      reference: {
        path: 'yokla.profile.yaml',
        document: {
          target: { request: { url: 'b' }, response: { text: '$.a', route: '$.r' } },
          languages: ['en'],
        },
      },
      exclude: ['/target/request'],
    });
    expect(report.comparison).toMatchObject({
      profile: 'yokla.profile.yaml',
      same: [{ pointer: '/target/response/text', value: '$.a' }],
      different: [{ pointer: '/languages', value: ['tr'], reference: ['en'] }],
      missed: [{ pointer: '/target/response/route', value: '$.r' }],
      precision: 0.5,
      recall: 1 / 3,
    });
    expect(
      analysisReport({
        version: '9.9.9',
        inventory: { files: [], skipped: 0, capped: false },
        probes: [],
        entries: [],
        proposal: {},
        exclude: [],
      }).comparison,
    ).toBeUndefined();
  });
});
