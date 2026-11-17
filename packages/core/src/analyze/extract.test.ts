import { describe, expect, it } from 'vitest';
import {
  ANALYZER_MARK,
  analyzerPrompt,
  chunkFiles,
  estimateExtraction,
  estimateTokens,
  extractSource,
  isTestPath,
  mergeExtracted,
  readableFiles,
  readReply,
  verifyEntry,
  type ReturnedEntry,
  type SourceFile,
  type VerifiedEntry,
} from './extract.ts';

const server: SourceFile = {
  path: 'src/server.ts',
  kind: 'code',
  text: [
    "import { createServer } from 'node:http';",
    '',
    'export const DEFAULT_RATE_LIMIT = { burstPerSecond: 3, perMinute: 120 };',
    'const MAX_BODY_BYTES = 64 * 1024;',
    "  const value = request.headers['x-cache-bypass'];",
  ].join('\n'),
};

const readme: SourceFile = {
  path: 'README.md',
  kind: 'doc',
  text: [
    '# Shop',
    '- **Response cache.** Send `x-cache-bypass: 1` to skip reading the cache.',
    '- **Rate limit.** A burst of 3 requests per second and 120 per minute.',
  ].join('\n'),
};

const model: SourceFile = {
  path: 'src/model.ts',
  kind: 'code',
  text: [
    '  tr: {',
    "    refusal: 'Bu konuda   yardımcı olamıyorum.',",
    '  },',
    '  en: {',
    '    refusal: "I can\'t help with that.",',
  ].join('\n'),
};

const files = [server, readme, model];
const lines = (path: string) => files.find((file) => file.path === path)?.text.split('\n') ?? [];
const [chunk] = chunkFiles(readableFiles(files), 8_000, 200_000).chunks;

const entry = (change: Partial<ReturnedEntry>): ReturnedEntry => ({
  field: 'limits.perMinute',
  value: 120,
  file: 'src/server.ts',
  line: 3,
  quote: 'export const DEFAULT_RATE_LIMIT = { burstPerSecond: 3, perMinute: 120 };',
  ...change,
});

const verify = (change: Partial<ReturnedEntry>, languages = ['tr', 'en']) =>
  chunk === undefined ? undefined : verifyEntry(entry(change), chunk, lines, languages);

const headerCheck = (
  value: Record<string, string>,
  quote = 'Send `x-cache-bypass: 1` to skip reading the cache.',
) => verify({ field: 'cacheBypass.header', value, file: 'README.md', line: 2, quote });

const refusalCheck = (value: Record<string, string>, languages = ['tr', 'en']) =>
  verify(
    {
      field: 'refusal',
      value,
      file: 'src/model.ts',
      line: 2,
      quote: "refusal: 'Bu konuda   yardımcı olamıyorum.',",
    },
    languages,
  );

const verified = (change: Partial<VerifiedEntry>): VerifiedEntry => ({
  ...entry({}),
  kind: 'code',
  ...change,
});

const refusalEntry = (language: string, sentence: string, line: number) =>
  verified({ field: 'refusal', value: { language, sentence }, line, quote: sentence });

describe('which files the model reads (ADR-0049)', () => {
  it.each([
    'test/app.ts',
    'src/tests/a.py',
    'src/__tests__/a.js',
    'src/server.test.ts',
    'src/server.spec.js',
    'pkg/server_test.go',
    'app/test_server.py',
  ])('leaves out the test file %s', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each([
    'src/testing.ts',
    'src/contest.ts',
    'docs/test-plan.md',
    'latest/app.py',
    'src/attest.py',
  ])('reads %s, which is no test file', (path) => {
    expect(isTestPath(path)).toBe(false);
  });

  it('reads docs first and code last, by path within a kind, and nothing else', () => {
    const read = readableFiles([
      { path: 'src/b.ts', kind: 'code', text: '' },
      { path: 'src/a.ts', kind: 'code', text: '' },
      { path: 'src/a.test.ts', kind: 'code', text: '' },
      { path: 'data/c.jsonl', kind: 'data', text: '' },
      { path: 'logo.svg', kind: 'other', text: '' },
      { path: '.env.example', kind: 'env-example', text: '' },
      { path: 'package.json', kind: 'manifest', text: '' },
      { path: 'openapi.yaml', kind: 'contract', text: '' },
      { path: 'prompts/system.txt', kind: 'prompt', text: '' },
      { path: 'README.md', kind: 'doc', text: '' },
    ]);
    expect(read.map((file) => file.path)).toEqual([
      'README.md',
      'prompts/system.txt',
      'openapi.yaml',
      'package.json',
      '.env.example',
      'src/a.ts',
      'src/b.ts',
    ]);
  });
});

describe('chunkFiles (ADR-0049)', () => {
  it('numbers each line, under its file', () => {
    const { chunks, left } = chunkFiles([readme], 8_000, 200_000);
    expect(left).toEqual([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text.split('\n').slice(0, 3)).toEqual([
      '=== README.md',
      '1| # Shop',
      '2| - **Response cache.** Send `x-cache-bypass: 1` to skip reading the cache.',
    ]);
    expect(chunks[0]?.parts).toEqual([{ path: 'README.md', kind: 'doc', from: 1, to: 3 }]);
    expect(chunks[0]?.tokens).toBe(estimateTokens(chunks[0]?.text ?? ''));
  });

  it('cuts a large file at line breaks, keeping its line numbers', () => {
    const big: SourceFile = {
      path: 'big.ts',
      kind: 'code',
      text: Array.from({ length: 30 }, (_, i) => `const line${String(i + 1)} = ${String(i)};`).join(
        '\n',
      ),
    };
    const { chunks } = chunkFiles([big], 100, 200_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((piece) => piece.tokens <= 100)).toBe(true);
    const parts = chunks.flatMap((piece) => piece.parts);
    expect(parts[0]?.from).toBe(1);
    expect(parts.at(-1)?.to).toBe(30);
    // Each part starts on the line after the one before it ends.
    for (const [index, part] of parts.slice(1).entries()) {
      expect(part.from).toBe((parts[index]?.to ?? 0) + 1);
    }
    expect(chunks[1]?.text).toMatch(/^=== big\.ts\n\d+\| const line/u);
  });

  it('puts several small files in one chunk', () => {
    const { chunks } = chunkFiles(readableFiles(files), 8_000, 200_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.parts.map((part) => part.path)).toEqual([
      'README.md',
      'src/model.ts',
      'src/server.ts',
    ]);
  });

  it('sends a line longer than a chunk alone', () => {
    const long: SourceFile = { path: 'min.js', kind: 'code', text: `a\n${'x'.repeat(1_000)}\nb` };
    const { chunks } = chunkFiles([long], 50, 200_000);
    expect(chunks.flatMap((piece) => piece.parts.map((part) => [part.from, part.to]))).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('stops at the budget, and names the files not sent', () => {
    const { chunks, left } = chunkFiles(readableFiles(files), 8_000, 60);
    expect(left).toEqual(['src/model.ts', 'src/server.ts']);
    expect(chunks.flatMap((piece) => piece.parts.map((part) => part.path))).toEqual(['README.md']);
  });
});

describe('analyzerPrompt (ADR-0049)', () => {
  it("is yokla's own: marked, with the fields, the languages and the chunk", () => {
    if (chunk === undefined) throw new Error('no chunk');
    const prompt = analyzerPrompt(chunk, ['tr', 'en']);
    expect(prompt.system.split('\n')[0]).toBe(ANALYZER_MARK);
    expect(prompt.system).toContain('limits.perMinute');
    expect(prompt.system).toContain('cacheBypass.header');
    expect(prompt.system).toContain('{"entries": [');
    expect(prompt.messages).toEqual([
      { role: 'user', content: `The profile's languages: tr, en\n\n${chunk.text}` },
    ]);
  });
});

describe('readReply (ADR-0049)', () => {
  const good = {
    field: 'limits.perMinute',
    value: 120,
    file: 'src/server.ts',
    line: 3,
    quote: 'x',
  };

  it('reads the entries, in JSON whole or around prose', () => {
    expect(readReply(JSON.stringify({ entries: [good] }))).toEqual([good]);
    expect(readReply(`Here you go:\n${JSON.stringify({ entries: [good] })}\nDone.`)).toEqual([
      good,
    ]);
    expect(readReply('no JSON')).toEqual([]);
    expect(readReply('{"entries": "none"}')).toEqual([]);
  });

  it('drops entries of an unknown field or the wrong shape', () => {
    const reply = {
      entries: [
        { ...good, field: 'limits.perDay' },
        { ...good, value: 2.5 },
        { ...good, value: 0 },
        { ...good, value: '120' },
        { ...good, field: 'cacheBypass.header', value: { name: 'x-bypass' } },
        { ...good, field: 'refusal', value: { sentence: 'No.' } },
        { ...good, line: '3' },
        { ...good, line: 3.5 },
        { ...good, file: 3 },
        { ...good, quote: null },
        'not an entry',
        { ...good, field: 'refusal', value: { language: 'en', sentence: 'No.' } },
      ],
    };
    expect(readReply(JSON.stringify(reply))).toEqual([
      { ...good, field: 'refusal', value: { language: 'en', sentence: 'No.' } },
    ]);
  });
});

describe('verifyEntry (ADR-0049)', () => {
  it('keeps a value whose quote is on its line', () => {
    expect(verify({})).toMatchObject({ ok: true, entry: { kind: 'code', value: 120 } });
    expect(verify({ field: 'limits.burstPerSecond', value: 3 })?.ok).toBe(true);
  });

  it('finds the quote within two lines of the line given', () => {
    expect(verify({ line: 1 })?.ok).toBe(true);
    expect(verify({ line: 5 })?.ok).toBe(true);
    expect(verify({ line: 5, quote: "import { createServer } from 'node:http';" })).toMatchObject({
      ok: false,
      problem: { reason: 'the quote is not on that line' },
    });
  });

  it.each([
    [{ file: 'src/other.ts' }, 'the file and line were not in the chunk sent'],
    [{ line: 99 }, 'the file and line were not in the chunk sent'],
    [{ quote: '  ' }, 'the quote is empty'],
    [{ quote: 'perMinute: 1200' }, 'the quote is not on that line'],
    [{ value: 12 }, 'the value is not in the quote'],
    [{ value: 999 }, 'the value is not in the quote'],
  ])('drops %j: %s', (change, reason) => {
    expect(verify(change)).toMatchObject({ ok: false, problem: { reason } });
  });

  it('needs a number to stand alone: 12 is not in "120", nor 1 in "1.5"', () => {
    const text: SourceFile = {
      path: 'a.md',
      kind: 'doc',
      text: 'up to 1.5 per second, 120 per minute',
    };
    const [only] = chunkFiles([text], 8_000, 200_000).chunks;
    if (only === undefined) throw new Error('no chunk');
    const check = (value: number) =>
      verifyEntry(
        { field: 'limits.perMinute', value, file: 'a.md', line: 1, quote: text.text },
        only,
        () => text.text.split('\n'),
        ['en'],
      ).ok;
    expect([check(120), check(12), check(1), check(5)]).toEqual([true, false, false, false]);
  });

  it('needs the header name, then its value after it', () => {
    expect(headerCheck({ name: 'X-Cache-Bypass', value: '1' })?.ok).toBe(true);
    expect(headerCheck({ name: 'x-cache', value: '1' })).toMatchObject({
      ok: false,
      problem: { reason: 'the header name is not in the quote' },
    });
    expect(headerCheck({ name: 'x-cache-bypass', value: 'true' })).toMatchObject({
      ok: false,
      problem: { reason: 'the header value is not in the quote, after the name' },
    });
    expect(headerCheck({ name: 'x-cache-bypass', value: 'Send' })?.ok).toBe(false);
  });

  it("needs the whole refusal sentence, in one of the profile's languages", () => {
    expect(refusalCheck({ language: 'tr', sentence: 'Bu konuda yardımcı olamıyorum.' })?.ok).toBe(
      true,
    );
    expect(
      refusalCheck({ language: 'tr', sentence: 'Bu konuda yardımcı olamıyoruz.' }),
    ).toMatchObject({
      ok: false,
      problem: { reason: 'the sentence is not in the quote' },
    });
    expect(
      refusalCheck({ language: 'de', sentence: 'Bu konuda yardımcı olamıyorum.' }),
    ).toMatchObject({
      ok: false,
      problem: { reason: "the language is not one of the profile's" },
    });
  });
});

describe('mergeExtracted (ADR-0049)', () => {
  it('gives one entry per value, with its first evidence', () => {
    const { entries, conflicts } = mergeExtracted([
      verified({}),
      verified({
        file: 'README.md',
        line: 3,
        kind: 'doc',
        quote: 'A burst of 3 requests per second and 120 per minute.',
      }),
    ]);
    expect(conflicts).toEqual([]);
    expect(entries).toEqual([
      {
        pointer: '/target/limits/perMinute',
        value: 120,
        kind: 'code',
        evidence:
          'src/server.ts:3: "export const DEFAULT_RATE_LIMIT = { burstPerSecond: 3, perMinute: 120 };"',
      },
    ]);
  });

  it('proposes no limit whose values disagree, and says so', () => {
    const { entries, conflicts } = mergeExtracted([verified({}), verified({ value: 60, line: 5 })]);
    expect(entries).toEqual([]);
    expect(conflicts.map((conflict) => [conflict.pointer, conflict.evidence.length])).toEqual([
      ['/target/limits/perMinute', 2],
    ]);
  });

  it('gives the cache bypass as a header entry', () => {
    const { entries } = mergeExtracted([
      verified({
        field: 'cacheBypass.header',
        value: { name: 'x-cache-bypass', value: '1' },
        kind: 'doc',
      }),
    ]);
    expect(entries.map((found) => [found.pointer, found.value, found.kind])).toEqual([
      ['/target/cacheBypass', { kind: 'header', name: 'x-cache-bypass', value: '1' }, 'doc'],
    ]);
  });

  it("gathers refusals into their language's list, each once", () => {
    const { entries } = mergeExtracted([
      refusalEntry('tr', 'Bu konuda yardımcı olamıyorum.', 2),
      refusalEntry('en', "I can't help with that.", 5),
      refusalEntry('tr', 'Bu konuda  yardımcı olamıyorum.', 2),
      refusalEntry('tr', 'Buna yanıt veremem.', 9),
    ]);
    expect(entries.map((found) => [found.pointer, found.value])).toEqual([
      ['/refusal/canonical/tr', ['Bu konuda yardımcı olamıyorum.', 'Buna yanıt veremem.']],
      ['/refusal/canonical/en', ["I can't help with that."]],
    ]);
    expect(entries[0]?.evidence).toBe(
      'src/server.ts:2: "Bu konuda yardımcı olamıyorum."; src/server.ts:9: "Buna yanıt veremem."',
    );
  });

  it('cuts a long quote in the evidence', () => {
    const quote = `${'a '.repeat(100)}120`;
    const [found] = mergeExtracted([verified({ quote })]).entries;
    expect(found?.evidence.length).toBeLessThan(150);
    expect(found?.evidence).toMatch(/\.\.\."$/u);
  });
});

describe('extractSource (ADR-0049)', () => {
  it('follows the kind of the file', () => {
    expect(
      ['doc', 'prompt', 'contract', 'code', 'manifest', 'env-example'].map(extractSource),
    ).toEqual(['doc', 'prompt', 'contract', 'code', 'code', 'code']);
  });
});

describe('estimateExtraction (ADR-0049)', () => {
  const chunks = chunkFiles(readableFiles(files), 8_000, 200_000).chunks;

  it("prices every chunk's prompt and the most each reply can be, with twice that as the bound", () => {
    const estimate = estimateExtraction(chunks, ['tr'], {
      maxTokens: 1_000,
      price: { input: 1, output: 4 },
    });
    const [first] = chunks;
    if (first === undefined) throw new Error('no chunk');
    const prompt = analyzerPrompt(first, ['tr']);
    const input = estimateTokens(prompt.system) + estimateTokens(prompt.messages[0]?.content ?? '');
    expect(estimate).toEqual({
      chunks: 1,
      inputTokens: input,
      maxOutputTokens: 1_000,
      costUsd: (input * 1 + 1_000 * 4) / 1_000_000,
      upperUsd: ((input * 1 + 1_000 * 4) / 1_000_000) * 2,
    });
  });

  it('counts the most output once per chunk', () => {
    const many = chunkFiles(readableFiles(files), 60, 200_000).chunks;
    expect(many.length).toBeGreaterThan(1);
    expect(estimateExtraction(many, ['tr'], { maxTokens: 500 }).maxOutputTokens).toBe(
      many.length * 500,
    );
  });

  it('gives no cost without a price', () => {
    expect(estimateExtraction(chunks, ['tr'], { maxTokens: 500 })).toMatchObject({
      costUsd: null,
      upperUsd: null,
      maxOutputTokens: 500,
    });
  });
});
