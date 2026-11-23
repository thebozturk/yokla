import { describe, expect, it } from 'vitest';
import {
  csvRecords,
  formatOf,
  idOf,
  ImportMapping,
  importCases,
  importedCaseYaml,
  importResults,
  readRows,
  RowsError,
  type ImportRun,
} from './index.ts';
import { indexOf, textOf, valueOf, verdictOf } from './mapping.ts';

const mapping = (value: unknown): ImportMapping =>
  ImportMapping.parse({ version: 1, ...Object(value) });

/** What the run was asked to hash. */
const hashed: string[] = [];

const RUN: ImportRun = {
  id: 'imported-1',
  startedAt: '2026-11-23T12:00:00.000Z',
  finishedAt: '2026-11-23T12:00:02.000Z',
  environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
  yoklaVersion: '0.0.0-test',
  source: { name: 'graded.json', sha256: 'a'.repeat(64) },
  sha256: (text) => {
    hashed.push(text);
    return 'b'.repeat(64);
  },
  language: 'en',
};

describe('reading rows (ADR-0097)', () => {
  it('knows a file’s format by its extension', () => {
    expect(['a.json', 'a.JSONL', 'a.csv', 'a.yaml', 'a.yml', 'a.txt', 'a'].map(formatOf)).toEqual([
      'json',
      'jsonl',
      'csv',
      'yaml',
      'yaml',
      undefined,
      undefined,
    ]);
  });

  it('reads CSV by RFC 4180: quotes, doubled quotes, line breaks in a field, and CRLF', () => {
    expect(csvRecords('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n"two\r\nlines",z\n\nlast,\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\r\nlines', 'z'],
      ['last', ''],
    ]);
    expect(csvRecords('a,b')).toEqual([['a', 'b']]);
    // A quote inside a field that didn't start with one is the field's own.
    expect(csvRecords('x,a"b\n')).toEqual([['x', 'a"b']]);
    // The last record needs no line break, even when its last field is empty.
    expect(csvRecords('a,b\nc,')).toEqual([
      ['a', 'b'],
      ['c', ''],
    ]);
    expect(csvRecords('')).toEqual([]);
    expect(() => csvRecords('a,"b')).toThrow(new RowsError('a quoted CSV field is never closed'));
  });

  it('gives each CSV row as an object of its columns, and refuses a ragged one', () => {
    expect(readRows('q,a\nhi,hello\n', 'csv')).toEqual([{ q: 'hi', a: 'hello' }]);
    expect(readRows('', 'csv')).toEqual([]);
    expect(() => readRows('q,a\nhi\n', 'csv')).toThrow('CSV row 1 has 1 fields, and the header 2');
  });

  it('reads each line of JSON Lines, and the rows of JSON or YAML', () => {
    expect(readRows('{"a":1}\n  \n{"a":2}\n', 'jsonl')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => readRows('{"a":1}\nnope\n', 'jsonl')).toThrow('line 2 is not JSON');
    expect(readRows('[{"a":1}]', 'json')).toEqual([{ a: 1 }]);
    expect(readRows('{"results":[{"a":1},{"a":2}]}', 'json', '$.results[*]')).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    expect(readRows('- a: 1\n', 'yaml')).toEqual([{ a: 1 }]);
    expect(() => readRows('{"a":1}', 'json')).toThrow('the file is not a list');
    expect(() => readRows('{', 'json')).toThrow('the file is not JSON');
    expect(() => readRows('a: [', 'yaml')).toThrow('the file is not YAML');
  });
});

describe('the mapping (ADR-0097)', () => {
  it('finds a value by its path, or takes a constant', () => {
    const row = { a: { b: [1, 2] }, c: 'x' };
    expect(valueOf(row, '$.a.b[*]')).toBe(1);
    expect(valueOf(row, { value: 'quality' })).toBe('quality');
    expect(valueOf(row, '$.nope')).toBeUndefined();
    expect(valueOf(row, undefined)).toBeUndefined();
  });

  it('reads text and indexes as a CSV holds them', () => {
    expect([textOf('a'), textOf(2), textOf(true), textOf(null), textOf({})]).toEqual([
      'a',
      '2',
      'true',
      undefined,
      undefined,
    ]);
    expect([
      indexOf(2),
      indexOf('3'),
      indexOf(' '),
      indexOf(-1),
      indexOf(1.5),
      indexOf('x'),
    ]).toEqual([2, 3, undefined, undefined, undefined, undefined]);
  });

  it('reads a verdict by the values that pass and the values that fail', () => {
    const verdict = { at: '$.v', pass: [true, 'yes'], fail: [false] };
    expect(verdictOf({ v: 'yes' }, verdict)).toEqual({ verdict: 'pass', value: 'yes' });
    expect(verdictOf({ v: false }, verdict)).toEqual({ verdict: 'fail', value: false });
    expect(verdictOf({ v: 'maybe' }, verdict)).toEqual({
      unmeasured: 'the row\'s verdict "maybe" is neither one that passes nor one that fails',
    });
    expect(verdictOf({}, verdict)).toEqual({
      unmeasured: 'the mapping finds no verdict in the row',
    });
  });

  it('refuses a key it doesn’t know, and an empty list of verdicts', () => {
    expect(ImportMapping.safeParse({ version: 1, nope: '$.a' }).success).toBe(false);
    expect(
      ImportMapping.safeParse({ version: 1, verdict: { at: '$.v', pass: [], fail: [0] } }).success,
    ).toBe(false);
    expect(ImportMapping.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe('importing cases (ADR-0097)', () => {
  it('writes a proposed case per id, its rows’ messages as turns in their order', () => {
    const { cases, problems } = importCases(
      [
        { id: 'Return Policy!', q: 'and then?', turn: 1, tags: ['policy', 'Faq'] },
        { id: 'Return Policy!', q: 'Can I return it?', turn: 0 },
        { id: 'greeting', q: 'Hi', tags: 'Chitchat' },
        { q: '' },
        { q: 'no id' },
      ],
      mapping({
        case: '$.id',
        message: '$.q',
        turn: '$.turn',
        tags: '$.tags',
        suite: { value: 'factual' },
      }),
      { source: 'data.jsonl', language: 'tr' },
    );
    expect(cases).toEqual([
      {
        id: 'return-policy',
        title: 'Return Policy!',
        suite: 'factual',
        language: 'tr',
        tags: ['policy', 'faq'],
        turns: [{ user: 'Can I return it?' }, { user: 'and then?' }],
        provenance: { source: 'import', evidence: 'data.jsonl, rows 1, 2', status: 'proposed' },
      },
      {
        id: 'greeting',
        suite: 'factual',
        language: 'tr',
        tags: ['chitchat'],
        turns: [{ user: 'Hi' }],
        provenance: { source: 'import', evidence: 'data.jsonl, row 3', status: 'proposed' },
      },
      expect.objectContaining({ id: 'row-5', turns: [{ user: 'no id' }] }),
    ]);
    expect(problems).toEqual(['row 4: the mapping finds no message']);
  });

  it('takes a suite it knows, else quality, and the row’s language over the default', () => {
    const { cases } = importCases(
      [
        { q: 'a', s: 'redteam', l: 'en' },
        { q: 'b', s: 'nonsense' },
      ],
      mapping({ message: '$.q', suite: '$.s', language: '$.l' }),
      { source: 'x.csv', language: 'tr' },
    );
    expect(cases.map((c) => [c['suite'], c['language']])).toEqual([
      ['redteam', 'en'],
      ['quality', 'tr'],
    ]);
  });

  it('makes a name a yokla id', () => {
    expect([
      idOf('Return Policy!'),
      idOf('a.b_c'),
      idOf('--x--'),
      idOf('.x.'),
      idOf('!!!'),
    ]).toEqual(['return-policy', 'a.b-c', 'x', 'x', undefined]);
  });

  it('writes the cases as a case file that says what they are', () => {
    const text = importedCaseYaml([{ id: 'a', turns: [{ user: 'hi' }] }], 'data.csv');
    expect(text).toMatch(/^# Imported by yokla import \(ADR-0097\) from data\.csv:/u);
    expect(text).toContain('version: 1\ncases:\n  - id: a\n');
  });
});

const GRADED = mapping({
  case: '$.id',
  message: '$.q',
  answer: '$.a',
  verdict: { at: '$.ok', pass: [true], fail: [false] },
  reason: '$.why',
  score: '$.score',
  findings: {
    at: '$.asserts[*]',
    check: '$.name',
    verdict: { at: '$.ok', pass: [true], fail: [false] },
    reason: '$.why',
  },
});

describe('importing results (ADR-0097)', () => {
  it('makes each row a sample, its verdict decide, and its assertions explain', () => {
    const { results, problems } = importResults(
      [
        {
          id: 'Policy',
          q: 'How long?',
          a: '90 days',
          ok: false,
          why: 'expected 30',
          score: 0.5,
          asserts: [
            { name: 'contains', ok: false, why: 'no "30"' },
            { name: 'polite', ok: true },
            { ok: true },
          ],
        },
        { id: 'Policy', q: 'How long?', a: '30 days', ok: true },
        { q: 'no id', ok: true },
      ],
      GRADED,
      RUN,
    );
    expect(problems).toEqual(['row 3: the mapping finds no case id']);
    const [policy] = results.cases;
    expect(policy).toMatchObject({
      id: 'policy',
      suite: 'quality',
      language: 'en',
      status: 'fail',
      definitionSha256: 'b'.repeat(64),
    });
    expect(hashed).toContain('["policy",["How long?","How long?"]]');
    expect(policy?.samples.map((sample) => sample.index)).toEqual([0, 1]);
    const [first] = policy?.samples[0]?.turns ?? [];
    expect(first?.user).toBe('How long?');
    // No latency mapped: the answer isn't a timed response, and is kept with the verdict.
    expect(first?.response).toBeUndefined();
    expect(first?.checks).toEqual([
      {
        check: 'imported',
        applicable: true,
        findings: [
          {
            dimension: 'verdict',
            verdict: 'fail',
            severity: 'high',
            message: 'expected 30',
            evidence: { score: 0.5, answer: '90 days' },
          },
          { dimension: 'contains', verdict: 'fail', severity: 'medium', message: 'no "30"' },
          { dimension: 'polite', verdict: 'pass', severity: 'medium', message: 'polite' },
          { dimension: 'assertion-3', verdict: 'pass', severity: 'medium', message: 'assertion 3' },
        ],
      },
    ]);
    expect(policy?.dimensions.map((d) => [d.dimension, d.policy, d.verdict])).toEqual([
      ['assertion-3', 'advisory', 'pass'],
      ['contains', 'advisory', 'fail'],
      ['polite', 'advisory', 'pass'],
      ['verdict', 'worst-of-n', 'fail'],
    ]);
    expect(results.run).toMatchObject({
      id: 'imported-1',
      durationMs: 2000,
      profile: { target: 'imported', sha256: 'a'.repeat(64) },
      correlation: 'none',
      partial: false,
    });
    expect(results.summary.statuses).toEqual({ fail: 1 });
  });

  it('lets an assertion explain but not decide: a passing verdict passes', () => {
    const { results } = importResults(
      [
        {
          id: 'a',
          q: 'q',
          ok: true,
          asserts: [
            { name: 'strict', ok: false },
            { name: 'unsure', ok: 'maybe' },
          ],
        },
      ],
      GRADED,
      RUN,
    );
    expect(results.cases[0]?.status).toBe('pass');
    // An assertion whose verdict can't be found is left out.
    expect(
      results.cases[0]?.samples[0]?.turns[0]?.checks[0]?.findings.map((f) => f.dimension),
    ).toEqual(['verdict', 'strict']);
  });

  it('times only a latency of 0 or more, and orders the samples by their index', () => {
    const { results } = importResults(
      [
        { id: 'a', q: 'second', ok: true, ms: -5, s: 1 },
        { id: 'a', q: 'first', ok: true, ms: 10, s: 0 },
      ],
      mapping({
        case: '$.id',
        message: '$.q',
        latencyMs: '$.ms',
        sample: '$.s',
        verdict: { at: '$.ok', pass: [true], fail: [false] },
      }),
      RUN,
    );
    const samples = results.cases[0]?.samples ?? [];
    expect(samples.map((sample) => [sample.index, sample.turns[0]?.user])).toEqual([
      [0, 'first'],
      [1, 'second'],
    ]);
    expect(samples.map((sample) => sample.turns[0]?.response?.latencyMs)).toEqual([10, undefined]);
  });

  it('never passes a row whose verdict it can’t find', () => {
    const rows = [
      { id: 'none', q: 'q' },
      { id: 'other', q: 'q', ok: 'maybe' },
    ];
    const { results } = importResults(rows, GRADED, RUN);
    expect(results.cases.map((c) => [c.id, c.status])).toEqual([
      ['none', 'unmeasured'],
      ['other', 'unmeasured'],
    ]);
    expect(results.cases[0]?.samples[0]?.turns[0]?.checks[0]?.unmeasured).toEqual([
      { dimension: 'verdict', reason: 'the mapping finds no verdict in the row' },
    ]);
    const unmapped = importResults(
      [{ id: 'a', q: 'q' }],
      mapping({ case: '$.id', message: '$.q' }),
      RUN,
    );
    expect(unmapped.results.cases[0]?.samples[0]?.turns[0]?.checks[0]?.unmeasured).toEqual([
      { dimension: 'verdict', reason: 'the mapping has no verdict' },
    ]);
  });

  it('gives a timed answer a response, and names the verdict when there is no reason', () => {
    const { results } = importResults(
      [{ id: 'a', q: 'q', a: 'answer', ok: true, ms: '820' }],
      mapping({
        case: '$.id',
        message: '$.q',
        answer: '$.a',
        latencyMs: '$.ms',
        verdict: { at: '$.ok', pass: [true], fail: [false] },
      }),
      RUN,
    );
    const [turn] = results.cases[0]?.samples[0]?.turns ?? [];
    expect(turn?.response).toEqual({ status: 200, latencyMs: 820, text: 'answer', evidence: {} });
    expect(turn?.checks[0]?.findings[0]).toEqual({
      dimension: 'verdict',
      verdict: 'pass',
      severity: 'high',
      message: "the row's verdict: true",
    });
  });

  it('groups a case’s rows into samples by the mapping, or by their order per turn', () => {
    const rows = [
      { id: 'a', t: 0, q: 'one', ok: true },
      { id: 'a', t: 1, q: 'two', ok: true },
      { id: 'a', t: 0, q: 'one again', ok: false },
      { id: 'a', t: 1, q: 'two again', ok: true },
    ];
    const byOrder = importResults(
      rows,
      mapping({
        case: '$.id',
        message: '$.q',
        turn: '$.t',
        verdict: { at: '$.ok', pass: [true], fail: [false] },
      }),
      RUN,
    );
    expect(byOrder.results.cases[0]?.samples.map((s) => s.turns.map((t) => t.user))).toEqual([
      ['one', 'two'],
      ['one again', 'two again'],
    ]);
    const bySample = importResults(
      rows.map((row, index) => ({ ...row, s: index % 2 })),
      mapping({
        case: '$.id',
        message: '$.q',
        turn: '$.t',
        sample: '$.s',
        verdict: { at: '$.ok', pass: [true], fail: [false] },
      }),
      RUN,
    );
    expect(
      bySample.results.cases[0]?.samples.map((s) => [s.index, s.turns.map((t) => t.user)]),
    ).toEqual([
      [0, ['one', 'one again']],
      [1, ['two', 'two again']],
    ]);
  });
});
