import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESULTS_SCHEMA_ID, type Results } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { LoadError, loadCases, loadProfile } from './load.ts';
import { printSummary } from './commands/run.ts';
import { main } from './main.ts';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-cli-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

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
  - id: a
    suite: quality
    language: tr
    turns: [{ user: merhaba }]
`;

describe('loading', () => {
  it('loads a profile and hashes the file', () => {
    const dir = workspace({ 'yokla.profile.yaml': PROFILE });
    const loaded = loadProfile(join(dir, 'yokla.profile.yaml'));
    expect(loaded.profile.target.name).toBe('t');
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded.dir).toBe(dir);
  });

  it('reports profile problems with their position', () => {
    const dir = workspace({ 'p.yaml': PROFILE.replace('adapter: http', 'adaptr: http') });
    expect(() => loadProfile(join(dir, 'p.yaml'))).toThrow(
      /p\.yaml:4:3: target\.adaptr: unknown key/u,
    );
  });

  it('loads every case file of a directory, in name order', () => {
    const dir = workspace({
      'cases/b.yaml': CASES.replace('id: a', 'id: b'),
      'cases/a.yml': CASES,
      'cases/notes.txt': 'ignored',
    });
    expect(loadCases([join(dir, 'cases')]).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('collects the problems of every case file', () => {
    const dir = workspace({
      'cases/a.yaml': CASES.replace('suite: quality', 'suite: vibes'),
      'cases/b.yaml': CASES.replace('language: tr', 'language: de'),
    });
    expect(() => loadCases([join(dir, 'cases')])).toThrow(
      /a\.yaml:4:12: cases\[0\]\.suite[\s\S]*b\.yaml:5:15: cases\[0\]\.language/u,
    );
  });

  it('fails clearly on a missing path or an empty directory', () => {
    expect(() => loadCases(['/no/such/yokla/cases'])).toThrow(LoadError);
    const dir = workspace({ 'cases/readme.md': '' });
    expect(() => loadCases([join(dir, 'cases')])).toThrow(/no case files/u);
  });
});

describe('yokla', () => {
  it('prints its version and help', async () => {
    const version = capture();
    expect(await main(['--version'], version.io)).toBe(0);
    expect(version.out[0]).toMatch(/^\d+\.\d+\.\d+/u);
    const help = capture();
    expect(await main([], help.io)).toBe(0);
    expect(help.out[0]).toMatch(/Usage:/u);
  });

  it('prints a JSON Schema', async () => {
    const { io, out } = capture();
    expect(await main(['schema', 'results'], io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ title: 'yokla results v1' });
  });

  it('exits with 2 on an unknown command, option or schema', async () => {
    expect(await main(['launch'], capture().io)).toBe(2);
    expect(await main(['run', '--frobnicate'], capture().io)).toBe(2);
    expect(await main(['schema', 'nope'], capture().io)).toBe(2);
  });

  it('exits with 2 and reports a configuration problem before any request', async () => {
    const dir = workspace({
      'yokla.profile.yaml': PROFILE.replace("'{{message}}'", "'{{mesage}}'"),
      'cases/a.yaml': CASES,
    });
    const { io, err } = capture();
    expect(await main(['run', '--profile', join(dir, 'yokla.profile.yaml')], io)).toBe(2);
    expect(err.join('\n')).toMatch(/unknown placeholder \{\{mesage\}\}/u);
  });

  it('rejects a non-numeric sample count', async () => {
    const dir = workspace({ 'yokla.profile.yaml': PROFILE, 'cases/a.yaml': CASES });
    const { io, err } = capture();
    expect(
      await main(['run', '--profile', join(dir, 'yokla.profile.yaml'), '--samples', 'many'], io),
    ).toBe(2);
    expect(err[0]).toBe('--samples must be a positive integer');
  });
});

describe('the run summary', () => {
  const results: Results = {
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id: 'r',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'none',
      partial: false,
    },
    cases: [],
    checks: [],
    summary: { cases: 0, statuses: {} },
  };

  it('states what the target logs observed, and run issues', () => {
    const { io, out, err } = capture();
    printSummary(
      {
        ...results,
        run: {
          ...results.run,
          observation: {
            source: 'target-logs',
            correlation: 'request-id',
            lines: 3,
            matched: 2,
            unmatched: 1,
            totals: { costUsd: 0.0012345678, modelCalls: 3 },
          },
          issues: ['something broke'],
        },
      },
      'runs/r.json',
      io,
    );
    expect(out).toContain('target logs: 2 of 3 turns matched; costUsd 0.001235, modelCalls 3');
    expect(err).toEqual(['  run: something broke']);
  });

  it('says nothing about logs when none are configured', () => {
    const { io, out, err } = capture();
    printSummary(results, 'runs/r.json', io);
    expect(out.join('\n')).not.toMatch(/target logs/u);
    expect(err).toEqual([]);
  });
});
