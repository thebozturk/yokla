import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportCommand } from './export.ts';

const PROFILE = `version: 1
target:
  name: t
  adapter: http
  request: { url: 'http://127.0.0.1:1/chat', body: { message: '{{message}}' } }
  response: { text: $.answer }
languages: [tr]
domain: ecommerce
`;

const CASES = `version: 1
cases:
  - id: greet
    suite: quality
    language: tr
    tags: [chitchat]
    turns:
      - user: merhaba
        expect: { answer: { contains: [merhaba] } }
  - id: draft
    suite: quality
    language: tr
    provenance: { source: generator, evidence: from the data, status: proposed }
    turns: [{ user: selam }]
  - id: shop
    suite: quality
    language: tr
    tags: [search]
    turns: [{ user: çadır }]
`;

function workspace(cases = CASES): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-export-'));
  writeFileSync(join(dir, 'yokla.profile.yaml'), PROFILE);
  mkdirSync(join(dir, 'cases'));
  writeFileSync(join(dir, 'cases', 'a.yaml'), cases);
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe('yokla export (ADR-0096)', () => {
  it('writes the approved cases as rows, and names the others', async () => {
    const dir = workspace();
    const file = join(dir, 'out', 'cases.jsonl');
    const { io, out } = capture();
    const profile = join(dir, 'yokla.profile.yaml');
    expect(await exportCommand(['--profile', profile, '--out', file], io)).toBe(0);
    expect(out).toEqual([
      '  skipped draft: proposed: only approved cases are written',
      `cases: ${file} (2 rows)`,
    ]);
    const rows = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));
    expect(rows).toEqual([
      {
        schema: 'yokla.case-row/v1',
        id: 'greet',
        suite: 'quality',
        language: 'tr',
        tags: ['chitchat'],
        message: 'merhaba',
        turns: [{ message: 'merhaba', expect: { answer: { contains: ['merhaba'] } } }],
      },
      expect.objectContaining({ id: 'shop', message: 'çadır' }),
    ]);
  });

  it('writes only the cases with a tag asked for', async () => {
    const dir = workspace();
    const file = join(dir, 'cases.jsonl');
    const profile = join(dir, 'yokla.profile.yaml');
    expect(
      await exportCommand(['--profile', profile, '--out', file, '--tag', 'search'], capture().io),
    ).toBe(0);
    expect(readFileSync(file, 'utf8')).toMatch(/^\{"schema":"yokla.case-row\/v1","id":"shop"/u);
  });

  it('exits with 2 when there is nothing to write, or it can’t load or is asked wrongly', async () => {
    const dir = workspace(`version: 1
cases:
  - id: draft
    suite: quality
    language: tr
    provenance: { source: generator, evidence: from the data, status: proposed }
    turns: [{ user: selam }]
`);
    const profile = join(dir, 'yokla.profile.yaml');
    const none = capture();
    expect(
      await exportCommand(['--profile', profile, '--out', join(dir, 'x.jsonl')], none.io),
    ).toBe(2);
    expect(none.err).toEqual([
      'no case to write: only approved cases with written turns become rows',
    ]);
    const missing = capture();
    expect(await exportCommand(['--profile', profile], missing.io)).toBe(2);
    expect(missing.err[0]).toBe('--out is required');
    const unloadable = capture();
    expect(
      await exportCommand(['--profile', join(dir, 'nope.yaml'), '--out', 'x'], unloadable.io),
    ).toBe(2);
    expect(await exportCommand(['--nope'], capture().io)).toBe(2);
    const help = capture();
    expect(await exportCommand(['--help'], help.io)).toBe(0);
    expect(help.out[0]).toMatch(/^Usage: yokla export/u);
  });
});
