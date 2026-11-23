import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { gateCommand } from './gate.ts';
import { importCommand } from './import.ts';

// The fixtures, each in a shape another kind of tool writes (ADR-0097).
const FIXTURES = new URL('../../../../examples/imports/', import.meta.url).pathname;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

const fixture = (name: string) => join(FIXTURES, name);

/** Imports a fixture's results, then gates them: the import's and the gate's exit codes. */
function importAndGate(from: string, mapping: string) {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-import-'));
  const out = join(dir, 'results.json');
  const imported = capture();
  const code = importCommand(
    ['results', '--from', fixture(from), '--mapping', fixture(mapping), '--out', out],
    imported.io,
  );
  const gated = capture();
  const gate = gateCommand(['--results', out], gated.io, dir);
  return {
    code,
    out: imported.out,
    gate,
    gateOut: gated.out,
    results: Results.parse(JSON.parse(readFileSync(out, 'utf8'))),
  };
}

describe('yokla import results (ADR-0097)', () => {
  it('reads nested JSON results with their assertions, and gates them broken on a failure', () => {
    const imported = importAndGate('nested-results.json', 'nested-results.mapping.yaml');
    expect(imported.code).toBe(0);
    expect(imported.out.at(-1)).toMatch(/\(2 cases: pass 1, fail 1\)$/u);
    expect(imported.results.cases.map((c) => [c.id, c.suite, c.status, c.samples.length])).toEqual([
      ['greeting', 'factual', 'pass', 1],
      ['return-policy', 'factual', 'fail', 2],
    ]);
    expect(imported.gate).toBe(1);
    expect(imported.gateOut).toContain('  factual: 1 failing case, 0 allowed: return-policy');
  });

  it('reads flat JSON Lines with their latency, and never passes a row with no verdict', () => {
    const imported = importAndGate('flat-rows.jsonl', 'flat-rows.mapping.yaml');
    expect(imported.results.cases.map((c) => [c.id, c.status])).toEqual([
      ['opening-hours', 'pass'],
      ['shipping', 'pass'],
      ['warranty', 'unmeasured'],
    ]);
    expect(imported.results.cases[0]?.samples[0]?.turns[0]?.response?.latencyMs).toBe(820);
    expect(imported.gate).toBe(1);
    expect(imported.gateOut.join('\n')).toContain('unmeasured never counts as a pass: warranty');
  });

  it('reads a CSV of graded answers, quoted fields and all, and gates it passed', () => {
    const imported = importAndGate('graded.csv', 'graded.mapping.yaml');
    expect(imported.results.cases.map((c) => [c.id, c.status])).toEqual([
      ['stoves', 'pass'],
      ['headlamps', 'pass'],
    ]);
    expect(
      imported.results.cases[0]?.samples[0]?.turns[0]?.checks[0]?.findings[0]?.evidence,
    ).toEqual({
      answer: 'Yes, we have three: "Mini", "Duo" and "Max".',
    });
    expect(imported.gate).toBe(0);
  });
});

describe('yokla import cases (ADR-0097)', () => {
  it('writes proposed cases, and never over a file that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-import-'));
    const out = join(dir, 'imported.yaml');
    const args = [
      'cases',
      '--from',
      fixture('dataset.yaml'),
      '--mapping',
      fixture('dataset.mapping.yaml'),
      '--out',
      out,
    ];
    const first = capture();
    expect(importCommand(args, first.io)).toBe(0);
    expect(first.out).toEqual([`cases: ${out} (3 proposed)`]);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('  - id: tents\n    title: Tents\n');
    expect(text).toContain(
      '      source: import\n      evidence: dataset.yaml, row 1\n      status: proposed\n',
    );
    const again = capture();
    expect(importCommand(args, again.io)).toBe(2);
    expect(again.err).toEqual([`${out} exists: yokla import never writes over a file`]);
  });

  it('takes the profile’s first language when neither the rows nor the flag give one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-import-'));
    const from = join(dir, 'rows.csv');
    writeFileSync(from, 'question\nhello\n');
    const mapping = join(dir, 'mapping.yaml');
    writeFileSync(mapping, 'version: 1\nmessage: $.question\n');
    const profile = join(dir, 'yokla.profile.yaml');
    writeFileSync(
      profile,
      "version: 1\ntarget:\n  name: t\n  adapter: http\n  request: { url: 'http://127.0.0.1:1/chat', body: { message: '{{message}}' } }\n  response: { text: $.answer }\nlanguages: [tr, en]\ndomain: ecommerce\n",
    );
    const write = (out: string, ...more: string[]) =>
      importCommand(
        ['cases', '--from', from, '--mapping', mapping, '--out', join(dir, out), ...more],
        capture().io,
      );
    expect(write('a.yaml', '--profile', profile)).toBe(0);
    expect(readFileSync(join(dir, 'a.yaml'), 'utf8')).toContain('language: tr');
    expect(write('b.yaml', '--profile', profile, '--language', 'en')).toBe(0);
    expect(readFileSync(join(dir, 'b.yaml'), 'utf8')).toContain('language: en');
  });
});

/** yokla import with these arguments: its exit code and what it said on standard error. */
function run(...args: string[]) {
  const { io, err } = capture();
  return { code: importCommand(args, io), err };
}

describe('yokla import refuses what it can’t read (ADR-0097)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-import-'));

  it('asks what to import, and for its three files', () => {
    expect(run('--from', 'a.csv').err[0]).toBe(
      'say what to import: yokla import cases, or yokla import results',
    );
    expect(run('both', '--from', 'a.csv').code).toBe(2);
    expect(run('cases', 'more').code).toBe(2);
    expect(run('cases', '--from', 'a.csv').err[0]).toBe('--from, --mapping and --out are required');
    expect(run('--nope').code).toBe(2);
    const help = capture();
    expect(importCommand(['--help'], help.io)).toBe(0);
    expect(help.out[0]).toMatch(/^Usage: yokla import/u);
  });

  it('names a file it can’t read, a format it doesn’t know, and a mapping that is wrong', () => {
    const out = join(dir, 'r.json');
    expect(
      run('results', '--from', join(dir, 'a.txt'), '--mapping', 'm', '--out', out).err,
    ).toEqual([`${join(dir, 'a.txt')}: give a .json, .jsonl, .csv, .yaml or .yml file`]);
    const missing = run(
      'results',
      '--from',
      join(dir, 'none.csv'),
      '--mapping',
      fixture('graded.mapping.yaml'),
      '--out',
      out,
    );
    expect(missing.code).toBe(2);
    expect(missing.err[0]).toMatch(/none\.csv: ENOENT/u);
    const wrong = join(dir, 'wrong.yaml');
    writeFileSync(wrong, 'version: 1\nverdict: yes\n');
    expect(
      run('results', '--from', fixture('graded.csv'), '--mapping', wrong, '--out', out).err[0],
    ).toMatch(/^mapping: invalid\n {2}verdict/u);
    const broken = join(dir, 'broken.yaml');
    writeFileSync(broken, 'version: [');
    expect(
      run('results', '--from', fixture('graded.csv'), '--mapping', broken, '--out', out).err,
    ).toEqual([`${broken}: not YAML or JSON`]);
    const ragged = join(dir, 'ragged.csv');
    writeFileSync(ragged, 'a,b\n1\n');
    expect(
      run('results', '--from', ragged, '--mapping', fixture('graded.mapping.yaml'), '--out', out)
        .err,
    ).toEqual(['ragged.csv: CSV row 1 has 1 fields, and the header 2']);
  });

  it('exits with 2 when no row becomes a case or a result', () => {
    const empty = join(dir, 'empty.csv');
    writeFileSync(empty, 'case,question\n,\n');
    const results = run(
      'results',
      '--from',
      empty,
      '--mapping',
      fixture('graded.mapping.yaml'),
      '--out',
      join(dir, 'e.json'),
    );
    expect(results.code).toBe(2);
    expect(results.err).toEqual([
      '  row 1: the mapping finds no case id',
      'no result to write: the mapping finds no case id in any row',
    ]);
    const cases = run(
      'cases',
      '--from',
      empty,
      '--mapping',
      fixture('graded.mapping.yaml'),
      '--out',
      join(dir, 'e.yaml'),
    );
    expect(cases.code).toBe(2);
    expect(cases.err.at(-1)).toBe('no case to write: the mapping finds no message in any row');
  });
});
