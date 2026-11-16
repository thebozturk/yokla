import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataAnalyzer, DomainPack } from '@yokla/core';
import { stubLanguagePack } from '@yokla/core/testing';
import { startTestServer, type TestServer, type TestServerOptions } from '@yokla/runtime/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeTarget, personPointers, type PersonInputs } from './index.ts';
import { probeEntries } from './propose.ts';

type OnHttp = NonNullable<TestServerOptions['onHttp']>;

const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** A target that answers every message in JSON, and records each one. */
async function target(): Promise<{ url: string; heard: string[] }> {
  const heard: string[] = [];
  const onHttp: OnHttp = (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const message =
        typeof body === 'object' && body !== null && 'message' in body ? String(body.message) : '';
      heard.push(message);
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ answer: `You asked: ${message}`, products: [] }));
    });
  };
  const server = await startTestServer({ onHttp });
  servers.push(server);
  return { url: server.url.replace(/^ws/u, 'http'), heard };
}

/** A pack whose data names languages, or none. */
function pack(languages: readonly string[]): DomainPack {
  const analyzer: DataAnalyzer = {
    analyze: () => ({
      entries:
        languages.length === 0
          ? []
          : [{ pointer: '/languages', value: [...languages], evidence: 'data/names.jsonl' }],
    }),
  };
  return {
    id: 'shop',
    analyzer,
    dimensions: {},
    prepare: () => ({ checks: [] }),
  };
}

const person = (url: string, languages: string[] = []): PersonInputs => ({
  name: 'assistant',
  url: `${url}/chat`,
  headers: {},
  body: { message: '{{message}}' },
  languages,
});

async function analyzed(url: string, given: string[], found: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'names.jsonl'), '{"id":"A"}\n');
  return analyzeTarget({
    dir,
    outDir: dir,
    person: person(url, given),
    greetings: { en: 'Hello!', tr: 'Merhaba!' },
    probe: { env: {}, timeoutMs: 5_000 },
    maxFiles: 100,
    domainPacks: [pack(found)],
    languages: [stubLanguagePack('tr'), stubLanguagePack('en')],
  });
}

describe('analyzeTarget (ADR-0047)', () => {
  it("greets in the person's first language, else the data's", async () => {
    const { url, heard } = await target();
    await analyzed(url, ['tr'], ['en']);
    await analyzed(url, [], ['tr', 'en']);
    expect(heard).toEqual(['Merhaba!', 'Merhaba!']);
  });

  it('proposes English, from no source, when neither the person nor the data names a language', async () => {
    const { url, heard } = await target();
    const result = await analyzed(url, [], []);
    expect(heard).toEqual(['Hello!']);
    expect(result.document['languages']).toEqual(['en']);
    expect(result.entries.find((entry) => entry.pointer === '/languages')?.provenance).toEqual({
      source: 'template',
      evidence: 'no language was given, and no data file names one; en is the default',
      status: 'proposed',
    });
    // The domain too: the only pack, as a guess.
    expect(result.document['domain']).toBe('shop');
  });

  it("writes the person's languages as theirs, with no provenance", async () => {
    const { url } = await target();
    const given = await analyzed(url, ['tr', 'en'], []);
    expect(given.document['languages']).toEqual(['tr', 'en']);
    expect(given.entries.map((entry) => entry.pointer)).not.toContain('/languages');
  });
});

describe('personPointers (ADR-0047)', () => {
  it("names the person's own inputs, and their languages only when they gave some", () => {
    expect(personPointers(person('http://x'))).toEqual([
      '/target/name',
      '/target/adapter',
      '/target/request',
    ]);
    expect(personPointers(person('http://x', ['tr']))).toContain('/languages');
  });
});

describe('probeEntries (ADR-0047)', () => {
  it('maps two columns of one evidence field once, by the first', () => {
    const entries = probeEntries(
      {
        inference: {
          response: { text: '$.a' },
          text: { path: '$.a', sample: 'x', rule: 'r' },
          alternatives: [],
          route: undefined,
          carry: [],
          replayed: 'x',
        },
        sessionOpen: undefined,
        probes: [],
        collections: [
          {
            name: 'products',
            probe: 2,
            match: {
              items: '$.p[*]',
              fields: { id: 'id', name_tr: 'ad', name_en: 'name' },
              matched: 1,
              ids: ['A'],
            },
          },
        ],
      },
      { id: 'id', name_tr: 'name', name_en: 'name' },
    );
    expect(
      entries
        .filter((entry) => entry.pointer.includes('/fields/'))
        .map((entry) => [entry.pointer, entry.value]),
    ).toEqual([
      ['/target/response/evidence/products/fields/id', 'id'],
      ['/target/response/evidence/products/fields/name', 'ad'],
    ]);
  });
});
