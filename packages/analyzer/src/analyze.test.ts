import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataAnalyzer, DataFile, DomainPack, JsonValue } from '@yokla/core';
import { stubLanguagePack } from '@yokla/core/testing';
import { startTestServer, type TestServer, type TestServerOptions } from '@yokla/runtime/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analysisReport,
  analyzeTarget,
  isDataText,
  personPointers,
  type PersonInputs,
} from './index.ts';
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
        answers: [],
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

describe('data from outside the repository (ADR-0065)', () => {
  it("gives the pack a file from outside --dir beside the repository's, its path from the proposal", async () => {
    const { url } = await target();
    const base = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
    mkdirSync(join(base, 'repo', 'data'), { recursive: true });
    writeFileSync(join(base, 'repo', 'data', 'names.jsonl'), '{"id":"A"}\n');
    mkdirSync(join(base, 'export'));
    writeFileSync(join(base, 'export', 'catalog.csv'), 'id,price\nB,10\nC,20\n');
    const seen: DataFile[][] = [];
    const recording: DomainPack = {
      ...pack([]),
      analyzer: {
        analyze: (files) => {
          seen.push([...files]);
          return { entries: [] };
        },
      },
    };
    await analyzeTarget({
      dir: join(base, 'repo'),
      outDir: base,
      person: person(url),
      greetings: { en: 'Hello!' },
      probe: { env: {}, timeoutMs: 5_000 },
      maxFiles: 100,
      data: [join(base, 'export', 'catalog.csv')],
      domainPacks: [recording],
      languages: [stubLanguagePack('en')],
    });
    expect(seen[0]).toEqual([
      { path: './repo/data/names.jsonl', rows: [{ id: 'A' }] },
      {
        path: './export/catalog.csv',
        rows: [
          { id: 'B', price: '10' },
          { id: 'C', price: '20' },
        ],
      },
    ]);
  });

  it.each([
    ['catalog.jsonl', '{"id":"A"}', true],
    ['CATALOG.JSONL', '{"id":"A"}', true],
    ['catalog.csv', 'id\nA', true],
    ['catalog.json', '[{"id":"A"}]', true],
    ['catalog.json', '{"id":"A"}', false],
    ['catalog.json', '[]', false],
    ['catalog.json', '[1, 2]', false],
    ['catalog.json', 'not json', false],
    ['catalog.txt', '{"id":"A"}', false],
  ])('reads %s holding %s as data: %s', (path, text, data) => {
    expect(isDataText(path, text)).toBe(data);
  });
});

/** The analysis report's comparison of two documents (ADR-0065). */
const compared = (proposal: JsonValue, reference: JsonValue) =>
  analysisReport({
    version: '0.0.0',
    inventory: { files: [], skipped: 0, capped: false },
    probes: [],
    entries: [],
    proposal,
    reference: { path: 'yokla.profile.yaml', document: reference },
    exclude: [],
  }).comparison;
const schema = { type: 'object', required: ['answer'] };
const withText = (more: Record<string, JsonValue> = {}) => ({
  target: { response: { text: '$.answer', ...more } },
});

describe('the comparison without the response contract (ADR-0065)', () => {
  it('counts the proposal again without a schema only it has', () => {
    const result = compared(withText({ schema }), withText());
    expect(result).toMatchObject({ precision: 1 / 3, recall: 1 });
    expect(result?.withoutSchema).toEqual({
      same: 1,
      different: 0,
      new: 0,
      missed: 0,
      precision: 1,
      recall: 1,
    });
  });

  it('leaves the schema out of both sides, whichever holds it', () => {
    expect(compared(withText(), withText({ schema }))?.withoutSchema).toMatchObject({
      missed: 0,
      recall: 1,
    });
    const other = { type: 'object', required: ['text'] };
    expect(
      compared(withText({ schema }), withText({ schema: other }))?.withoutSchema,
    ).toMatchObject({
      same: 1,
      different: 0,
      precision: 1,
    });
  });

  it('gives no second count when neither side has a schema', () => {
    const result = compared(withText(), { target: { response: { text: '$.text' } } });
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('withoutSchema');
  });
});

/** A report naming these data files as cut (ADR-0066). */
const reported = (cut: readonly string[]) =>
  analysisReport({
    version: '0.0.0',
    inventory: { files: [], skipped: 0, capped: false },
    probes: [],
    entries: [],
    proposal: {},
    exclude: [],
    cut,
  });

describe('the data files read only in part (ADR-0066)', () => {
  it('names them in the report, and nothing when none was cut', () => {
    expect(reported(['./data/catalog.jsonl']).cut).toEqual(['./data/catalog.jsonl']);
    expect(reported([])).not.toHaveProperty('cut');
  });
});
