import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Comparison, RESULTS_SCHEMA_ID } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { compareCommand } from './commands/compare.ts';
import {
  parseAttacker,
  parseReversal,
  parseStrategyOption,
  parseSwap,
  parseTransform,
} from './commands/run.ts';
import { LoadError } from './load.ts';
import { schemas } from './schemas.ts';

/** A run of one case with this status, costing `costUsd`, made with these swaps. */
function results(
  id: string,
  status: string,
  costUsd: number,
  swaps: unknown[] = [],
  definition = 'd',
): string {
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
        definitionSha256: definition.repeat(64).slice(0, 64),
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

  it('with --expect-same, exits with 1 when a status moved, and 0 when none did (ADR-0043)', () => {
    writeFileSync(join(dir, 'reversed.json'), results('reversed', 'pass', 0.008));
    const same = compare('--results', 'big.json', '--results', 'reversed.json', '--expect-same');
    expect(same.code).toBe(0);
    expect(same.out).toContain('--expect-same: every case has the same status in every run');
    const moved = compare('--results', 'big.json', '--results', 'nano.json', '--expect-same');
    expect(moved.code).toBe(1);
    expect(moved.out).toContain('--expect-same: the status of a case differs: a');
    // Without it, a moved status is reported, and the comparison exits with 0.
    expect(compare('--results', 'big.json', '--results', 'nano.json').code).toBe(0);
    // A case whose definition differs isn't compared, so it moves nothing.
    writeFileSync(join(dir, 'redefined.json'), results('redefined', 'fail', 0.008, [], 'e'));
    expect(
      compare('--results', 'big.json', '--results', 'redefined.json', '--expect-same').code,
    ).toBe(0);
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

describe('parseReversal (ADR-0043)', () => {
  it('reads the tool and the JSONPath, and refuses anything else', () => {
    expect(parseReversal('search_products=$.results')).toEqual({
      tool: 'search_products',
      at: '$.results',
    });
    expect(parseReversal("search=$['items'][*].list")).toEqual({
      tool: 'search',
      at: "$['items'][*].list",
    });
    for (const text of ['search_products', '=$.results', 'search=results', 'search=']) {
      expect(() => parseReversal(text), text).toThrow(
        '--reverse-items must be <tool>=<jsonpath>, such as search_products=$.results',
      );
    }
  });
});

describe('parseTransform (ADR-0045, ADR-0059)', () => {
  it('reads each kind, and refuses anything else', () => {
    const kinds = [
      'paraphrase',
      'code-switch',
      'no-diacritics',
      'lowercase',
      'no-punctuation',
      'typos',
    ] as const;
    for (const kind of kinds) expect(parseTransform(kind)).toBe(kind);
    for (const text of [
      '',
      'typo',
      'Lowercase',
      'uppercase',
      'no-diacritics,typos',
      'codeswitch',
    ]) {
      expect(() => parseTransform(text), text).toThrow(
        '--transform must be one of paraphrase, code-switch, no-diacritics, lowercase, no-punctuation, typos',
      );
    }
  });

  it('reads --strategy as one strategy or two in layers, and refuses others (ADR-0084)', () => {
    expect(parseStrategyOption('hex')).toEqual(['hex']);
    expect(parseStrategyOption('base64+roleplay')).toEqual(['base64', 'roleplay']);
    expect(() => parseStrategyOption('base64+hex+rot13')).toThrow(LoadError);
    expect(() => parseStrategyOption('rot26')).toThrow('--strategy rot26 is none of base64');
  });

  it('reads --attacker with its own bound, and refuses a bound without it or of the other (ADR-0087)', () => {
    expect(parseAttacker({})).toBeUndefined();
    expect(parseAttacker({ attacker: 'escalation' })).toEqual({ strategy: 'escalation', limit: 5 });
    expect(parseAttacker({ attacker: 'best-of-n' })).toEqual({ strategy: 'best-of-n', limit: 4 });
    expect(parseAttacker({ attacker: 'best-of-n', attempts: '8', 'fresh-attacker': true })).toEqual(
      {
        strategy: 'best-of-n',
        limit: 8,
        fresh: true,
      },
    );
    expect(parseAttacker({ attacker: 'escalation', 'max-turns': '3' })).toEqual({
      strategy: 'escalation',
      limit: 3,
    });
    expect(() => parseAttacker({ attacker: 'swarm' })).toThrow(
      '--attacker must be one of escalation, best-of-n, iterative, tree, translate',
    );
    expect(() => parseAttacker({ attacker: 'escalation', attempts: '2' })).toThrow(
      "--attempts doesn't go with --attacker escalation",
    );
    expect(() => parseAttacker({ attacker: 'best-of-n', 'max-turns': '2' })).toThrow(
      "--max-turns doesn't go with --attacker best-of-n",
    );
    expect(() => parseAttacker({ attempts: '2' })).toThrow('--attempts needs --attacker');
    expect(() => parseAttacker({ 'fresh-attacker': true })).toThrow(
      '--fresh-attacker needs --attacker',
    );
    expect(() => parseAttacker({ attacker: 'best-of-n', attempts: '0' })).toThrow(LoadError);
  });

  it('reads the bounds of iterative, tree and translate, each its own (ADR-0088)', () => {
    expect(parseAttacker({ attacker: 'iterative' })).toEqual({ strategy: 'iterative', limit: 4 });
    expect(parseAttacker({ attacker: 'iterative', attempts: '6' })).toEqual({
      strategy: 'iterative',
      limit: 6,
    });
    expect(parseAttacker({ attacker: 'tree' })).toEqual({
      strategy: 'tree',
      branches: 3,
      depth: 2,
    });
    expect(
      parseAttacker({ attacker: 'tree', branches: '5', depth: '3', 'fresh-attacker': true }),
    ).toEqual({ strategy: 'tree', branches: 5, depth: 3, fresh: true });
    expect(parseAttacker({ attacker: 'tree', branches: '1', depth: '1' })).toEqual({
      strategy: 'tree',
      branches: 1,
      depth: 1,
    });
    expect(parseAttacker({ attacker: 'translate' })).toEqual({ strategy: 'translate' });
    expect(() => parseAttacker({ attacker: 'tree', branches: '6' })).toThrow(
      '--branches must be 1 to 5',
    );
    expect(() => parseAttacker({ attacker: 'tree', depth: '4' })).toThrow('--depth must be 1 to 3');
    expect(() => parseAttacker({ attacker: 'tree', depth: '0' })).toThrow(
      '--depth must be a positive integer',
    );
    expect(() => parseAttacker({ attacker: 'tree', attempts: '2' })).toThrow(
      "--attempts doesn't go with --attacker tree",
    );
    expect(() => parseAttacker({ attacker: 'iterative', branches: '2' })).toThrow(
      "--branches doesn't go with --attacker iterative",
    );
    expect(() => parseAttacker({ attacker: 'iterative', 'max-turns': '2' })).toThrow(
      "--max-turns doesn't go with --attacker iterative",
    );
    expect(() => parseAttacker({ attacker: 'translate', depth: '2' })).toThrow(
      "--depth doesn't go with --attacker translate",
    );
    expect(() => parseAttacker({ attacker: 'escalation', branches: '2' })).toThrow(
      "--branches doesn't go with --attacker escalation",
    );
    expect(() => parseAttacker({ branches: '2' })).toThrow('--branches needs --attacker');
    expect(() => parseAttacker({ depth: '2' })).toThrow('--depth needs --attacker');
  });
});
