import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASSETTE_SCHEMA_ID } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { parseRunOptions } from '../api.ts';
import { schemas } from '../schemas.ts';
import { parseRunArgs, runOptionsOf } from './run.ts';

// yokla run's flags become the library API's run options (ADR-0093): each
// flag to its option, checked as the flag is, and nothing the flags leave out.

const PROFILE = schemas.profile.parse({
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
    upstreams: [{ id: 'fake', kind: 'openai-compatible', upstream: 'http://127.0.0.1:1/v1' }],
  },
});

const CASSETTE = {
  schema: CASSETTE_SCHEMA_ID,
  profileSha256: 'a'.repeat(64),
  recordedAt: '2026-11-23T12:00:00.000Z',
  calls: [],
};

function capture() {
  const out: string[] = [];
  return { io: { out: (line: string) => out.push(line), err: () => undefined }, out };
}

const optionsOf = (...args: string[]) => runOptionsOf(parseRunArgs(args), PROFILE, capture().io);

describe("yokla run's flags as the API's options (ADR-0093)", () => {
  it('gives each flag its option', () => {
    const options = optionsOf(
      '--tag',
      'a',
      '--tag',
      'b',
      '--samples',
      '3',
      '--stop-early',
      '--concurrency',
      '2',
      '--target-url',
      'http://127.0.0.1:4/chat',
      '--proxy-url',
      'http://127.0.0.1:5',
      '--max-cost',
      '0.5',
      '--record',
      'calls.json',
      '--swap-model',
      'fake:big=mini',
      '--reverse-items',
      'search=$.results',
      '--transform',
      'typos',
      '--strategy',
      'base64+roleplay',
      '--attacker',
      'tree',
      '--branches',
      '2',
      '--fresh-customer',
      '--fresh-attacker',
      '--fresh-judge',
    );
    expect(options).toMatchObject({
      tags: ['a', 'b'],
      samples: 3,
      stopEarly: true,
      concurrency: 2,
      targetUrl: 'http://127.0.0.1:4/chat',
      proxyUrl: 'http://127.0.0.1:5',
      maxCostUsd: 0.5,
      record: true,
      swaps: [{ upstream: 'fake', asked: 'big', model: 'mini' }],
      reversals: [{ tool: 'search', at: '$.results' }],
      transforms: ['typos'],
      strategy: ['base64', 'roleplay'],
      attacker: { strategy: 'tree', branches: 2, depth: 2 },
      fresh: { customer: true, attacker: true, judge: true },
    });
    expect(options.replay).toBeUndefined();
    // The API takes what the command line gives it.
    expect(() => parseRunOptions(options)).not.toThrow();
  });

  it('leaves out what the flags leave out', () => {
    const options = optionsOf();
    expect(options).toMatchObject({
      record: false,
      swaps: [],
      reversals: [],
      transforms: [],
      fresh: { customer: undefined, attacker: undefined, judge: undefined },
    });
    for (const key of [
      'tags',
      'samples',
      'stopEarly',
      'concurrency',
      'targetUrl',
      'proxyUrl',
      'maxCostUsd',
      'replay',
      'strategy',
      'attacker',
    ] as const) {
      expect(options[key], key).toBeUndefined();
    }
    expect(() => parseRunOptions(options)).not.toThrow();
  });

  it('reads the cassette to replay, loose only with --replay-loose', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-run-options-'));
    const file = join(dir, 'calls.json');
    writeFileSync(file, JSON.stringify(CASSETTE));
    const strict = optionsOf('--replay', file).replay;
    expect(strict?.cassette).toEqual(CASSETTE);
    expect(strict?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(strict?.loose).toBeUndefined();
    expect(optionsOf('--replay', file, '--replay-loose').replay?.loose).toBe(true);
  });

  it('refuses what the command line refuses', () => {
    expect(() => optionsOf('--samples', '0')).toThrow('--samples must be a positive integer');
    expect(() => optionsOf('--concurrency', 'x')).toThrow(
      '--concurrency must be a positive integer',
    );
    expect(() => optionsOf('--max-cost', '0')).toThrow('--max-cost must be a positive number');
    expect(() => optionsOf('--max-cost', 'Infinity')).toThrow('--max-cost must be a positive');
    expect(() => optionsOf('--record', 'a.json', '--replay', 'b.json')).toThrow(
      '--record and --replay go one at a time',
    );
    expect(() => optionsOf('--replay-loose')).toThrow('--replay-loose needs --replay');
  });

  it('prints what the model transforms will take', () => {
    const { io, out } = capture();
    const options = runOptionsOf(parseRunArgs([]), PROFILE, io);
    const plan = { messages: 2, model: 'm', url: 'http://127.0.0.1:6/v1', calls: 2, cached: 1 };
    options.onTransformPlan?.({ ...plan, upperUsd: 0.01 });
    options.onTransformPlan?.({ ...plan, upperUsd: null });
    expect(out).toEqual([
      'transform: 2 message(s) to rewrite with m at http://127.0.0.1:6/v1; their text goes there',
      '  2 call(s) at most, 1 from the cache; at most $0.0100',
      'transform: 2 message(s) to rewrite with m at http://127.0.0.1:6/v1; their text goes there',
      '  2 call(s) at most, 1 from the cache; at most an unknown cost',
    ]);
  });
});
