import { describe, expect, it } from 'vitest';
import { Baseline } from '../schema/baseline.ts';
import type { Case } from '../schema/cases.ts';
import { Results, RESULTS_SCHEMA_ID } from '../schema/results.ts';
import { baselineChanges, baselineOf } from './baseline.ts';
import { caseDefinition, stableJson } from './definition.ts';

describe('stableJson', () => {
  it('sorts keys at every level and leaves out undefined values', () => {
    expect(stableJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"z":1}]},"b":1}',
    );
    expect(stableJson({ a: 1, b: 2 })).toBe(stableJson({ b: 2, a: 1 }));
    expect(stableJson(['x', undefined, 1.5, true])).toBe('["x",null,1.5,true]');
    expect(stableJson(undefined)).toBe('null');
  });
});

describe('caseDefinition', () => {
  const base: Case = {
    id: 'tents',
    suite: 'factual',
    language: 'tr',
    turns: [{ user: 'Çadır var mı?', expect: { answerable: true, filters: { maxPrice: 500 } } }],
    tags: [],
  };
  const changed = (change: Partial<Case>) => caseDefinition({ ...base, ...change });

  it('ignores what does not decide the verdict, the known-gap marker included', () => {
    const same = caseDefinition(base);
    expect(changed({ id: 'renamed' })).toBe(same);
    expect(changed({ title: 'A title' })).toBe(same);
    expect(changed({ suite: 'quality' })).toBe(same);
    expect(changed({ tags: ['smoke'] })).toBe(same);
    expect(changed({ knownGap: { reason: 'not built' } })).toBe(same);
    expect(
      changed({
        turns: [
          { user: 'Çadır var mı?', expect: { filters: { maxPrice: 500 }, answerable: true } },
        ],
      }),
    ).toBe(same);
  });

  it('changes with the language, turns, expectations, requests, samples and checks', () => {
    const same = caseDefinition(base);
    const variants = [
      changed({ language: 'en' }),
      changed({
        turns: [{ user: 'Çadır var mı', expect: { answerable: true, filters: { maxPrice: 500 } } }],
      }),
      changed({
        turns: [
          { user: 'Çadır var mı?', expect: { answerable: true, filters: { maxPrice: 400 } } },
        ],
      }),
      changed({
        turns: [{ ...base.turns[0], user: 'Çadır var mı?', request: { headers: { 'x-a': '1' } } }],
      }),
      changed({ turns: [...base.turns, { user: 'daha ucuz?' }] }),
      changed({ samples: 3 }),
      changed({ checks: ['price-grounded'] }),
    ];
    for (const variant of variants) expect(variant).not.toBe(same);
    expect(new Set(variants).size).toBe(variants.length);
  });
});

type CaseResult = Results['cases'][number];
const sha = (char: string) => char.repeat(64);

function results(cases: Partial<CaseResult>[], profileSha = sha('a')): Results {
  return Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.1.0' },
    run: {
      id: 'run-1',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 'shop', sha256: profileSha },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'none',
      partial: false,
    },
    cases: cases.map((c) => ({
      id: 'x',
      suite: 'factual',
      language: 'tr',
      status: 'pass',
      unstable: false,
      dimensions: [],
      samples: [
        {
          index: 0,
          cache: 'cold',
          turns: [
            {
              user: 'u',
              response: { status: 200, latencyMs: 9, text: 'ANSWER', evidence: {} },
              checks: [],
            },
          ],
        },
      ],
      ...c,
    })),
    checks: [],
    summary: { cases: cases.length, statuses: {} },
  });
}

describe('baselineOf', () => {
  it('keeps the run, and per case its id, suite, status and definition, sorted by id', () => {
    const baseline = baselineOf(
      results([
        { id: 'b', status: 'fail', definitionSha256: sha('1') },
        { id: 'a', suite: 'quality' },
      ]),
    );
    expect(Baseline.safeParse(baseline).success).toBe(true);
    expect(baseline).toEqual({
      schema: 'yokla.baseline/v1',
      yokla: { version: '0.1.0' },
      run: {
        id: 'run-1',
        startedAt: '2026-11-10T12:00:00.000Z',
        profile: { target: 'shop', sha256: sha('a') },
      },
      cases: [
        { id: 'a', suite: 'quality', status: 'pass' },
        { id: 'b', suite: 'factual', status: 'fail', definitionSha256: sha('1') },
      ],
    });
    expect(JSON.stringify(baseline)).not.toContain('ANSWER');
  });
});

describe('baselineOf and proposed cases', () => {
  it('leaves a proposed case out: it gates only once a person approves it (ADR-0004)', () => {
    const baseline = baselineOf(results([{ id: 'a' }, { id: 'p', review: 'proposed' }]));
    expect(baseline.cases.map((c) => c.id)).toEqual(['a']);
  });
});

describe('baselineChanges', () => {
  const before = baselineOf(
    results([
      { id: 'kept', definitionSha256: sha('1') },
      { id: 'fixed', status: 'fail', definitionSha256: sha('2') },
      { id: 'edited', definitionSha256: sha('3') },
      { id: 'gone' },
    ]),
  );

  it('lists added, removed, re-statused and redefined cases, and a new profile', () => {
    const after = baselineOf(
      results(
        [
          { id: 'kept', definitionSha256: sha('1') },
          { id: 'fixed', definitionSha256: sha('2') },
          { id: 'edited', status: 'fail', definitionSha256: sha('4') },
          { id: 'new', status: 'unmeasured' },
        ],
        sha('b'),
      ),
    );
    expect(baselineChanges(before, after)).toEqual([
      '~ profile changed',
      '~ edited: pass → fail',
      '~ edited: definition changed',
      '~ fixed: fail → pass',
      '+ new (unmeasured)',
      '- gone (was pass)',
    ]);
  });

  it('says when nothing changed, and what a first baseline holds', () => {
    expect(baselineChanges(before, before)).toEqual(['no changes']);
    expect(baselineChanges(undefined, before)).toEqual(['new baseline: 4 cases']);
  });

  it('does not call a missing definition a change', () => {
    const after = baselineOf(
      results([{ id: 'kept' }, { id: 'fixed', status: 'fail' }, { id: 'edited' }, { id: 'gone' }]),
    );
    expect(baselineChanges(before, after)).toEqual(['no changes']);
  });
});
