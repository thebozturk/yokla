import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Comparison, RESULTS_SCHEMA_ID } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { compareCommand } from './commands/compare.ts';
import { parseSwap } from './commands/run.ts';
import { LoadError } from './load.ts';
import { schemas } from './schemas.ts';

/** A run of one case with this status, costing `costUsd`, made with these swaps. */
function results(id: string, status: string, costUsd: number, swaps: unknown[] = []): string {
  return JSON.stringify({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id,
      startedAt: '2026-11-16T12:00:00.000Z',
      finishedAt: '2026-11-16T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'serial',
      partial: false,
      proxy: {
        correlation: 'serial',
        records: 1,
        attributed: 1,
        unattributed: 0,
        totals: { costUsd },
        missing: {},
      },
      ...(swaps.length === 0 ? {} : { swaps }),
    },
    cases: [
      {
        id: 'a',
        suite: 'factual',
        language: 'tr',
        status,
        unstable: false,
        dimensions: [],
        samples: [],
      },
    ],
    checks: [],
    summary: { cases: 1, statuses: { [status]: 1 } },
  });
}

const swap = (model: string) => [{ upstream: 'fake', asked: 'big', model, calls: 1 }];

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe('yokla compare (ADR-0042)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-compare-'));
  writeFileSync(join(dir, 'big.json'), results('big', 'pass', 0.008));
  writeFileSync(join(dir, 'mini.json'), results('mini', 'pass', 0.004, swap('mini')));
  writeFileSync(join(dir, 'nano.json'), results('nano', 'fail', 0.002, swap('nano')));
  writeFileSync(join(dir, 'lenient.yaml'), 'version: 1\ngate: { maxFailures: 1 }\n');
  const compare = (...args: string[]) => {
    const { io, out, err } = capture();
    const code = compareCommand(
      args.map((a) => (a.startsWith('--') ? a : join(dir, a))),
      io,
      dir,
    );
    return { code, out, err };
  };

  it('compares the runs, gates each, and names the cheapest that passes', () => {
    const { code, out } = compare(
      '--results',
      'big.json',
      '--results',
      'mini.json',
      '--results',
      'nano.json',
      '--json',
      'out/comparison.json',
    );
    expect(code).toBe(0);
    expect(out).toContain('cheapest passing run: B (fake: big → mini), 0.004000 USD');
    expect(out).toContain('  a  pass / pass / fail');
    expect(out).toContain(
      'note: no yokla.config.yaml; the gate defaults apply: no failing or unmeasured case',
    );
    const written = Comparison.parse(
      JSON.parse(readFileSync(join(dir, 'out/comparison.json'), 'utf8')),
    );
    expect(written.cheapest).toEqual({ runs: ['mini'], costUsd: 0.004 });
  });

  it("gates each run by the configuration's thresholds", () => {
    const { out } = compare(
      '--results',
      'mini.json',
      '--results',
      'nano.json',
      '--config',
      'lenient.yaml',
    );
    // One failing case is allowed: nano passes its gate, and is the cheapest.
    expect(out).toContain('cheapest passing run: B (fake: big → nano), 0.002000 USD');
  });

  it('refuses fewer than two runs, and a file it cannot read', () => {
    const one = compare('--results', 'big.json');
    expect(one.code).toBe(2);
    expect(one.err[0]).toBe(
      '--results is needed at least twice: a comparison takes two runs or more',
    );
    const missing = compare('--results', 'big.json', '--results', 'nope.json');
    expect(missing.code).toBe(2);
    expect(missing.err[0]).toMatch(/nope\.json/u);
    expect(compare('--frobnicate').code).toBe(2);
  });
});

describe('parseSwap (ADR-0042)', () => {
  const profile = schemas.profile.parse({
    version: 1,
    target: {
      name: 't',
      adapter: 'http',
      request: { url: 'http://127.0.0.1:3/chat', body: { message: '{{message}}' } },
      response: { text: '$.answer' },
    },
    languages: ['tr'],
    domain: 'ecommerce',
    modelProxy: {
      upstreams: [
        { id: 'fake', kind: 'openai-compatible', upstream: 'http://127.0.0.1:1/v1' },
        { id: 'gateway', kind: 'openai-compatible', upstream: 'http://127.0.0.1:2/v1' },
      ],
    },
  });

  it('reads the upstream, the asked model and the model, and another upstream when named', () => {
    expect(parseSwap('fake:demo-writer-1=demo-writer-mini', profile)).toEqual({
      upstream: 'fake',
      asked: 'demo-writer-1',
      model: 'demo-writer-mini',
    });
    expect(parseSwap('fake:demo-writer-1=gateway/demo-writer-mini', profile)).toEqual({
      upstream: 'fake',
      asked: 'demo-writer-1',
      model: 'demo-writer-mini',
      to: 'gateway',
    });
    // A model name may hold ":" and "/": a "vendor/" no upstream is named stays in it.
    expect(parseSwap('fake:llama3:8b=vendor/model-x', profile)).toEqual({
      upstream: 'fake',
      asked: 'llama3:8b',
      model: 'vendor/model-x',
    });
  });

  it('refuses a swap without its three parts', () => {
    for (const text of ['fake', 'fake:a', ':a=b', 'fake:=b', 'fake:a=', 'fake:a=gateway/']) {
      expect(() => parseSwap(text, profile), text).toThrow(LoadError);
    }
  });
});
