import { describe, expect, it } from 'vitest';
import { CORE_CHECKS } from '../checks/all.ts';
import { genericAttacks } from '../generate/attacks.ts';
import type { Results } from '../schema/results.ts';
import { STUB_ATTACKS, stubLanguagePack } from '../testing.ts';
import {
  caseKinds,
  CATEGORY,
  CORE_TAXONOMY,
  failingCategories,
  findingCategories,
  FRAMEWORKS,
  mergeTaxonomies,
  runTaxonomy,
  type Taxonomy,
} from './taxonomy.ts';

const LISTED = new Set(
  FRAMEWORKS.flatMap((framework) =>
    framework.categories.map((category) => `${framework.id}:${category.code}`),
  ),
);

type CaseResult = Results['cases'][number];

/** A case result with one sample of one turn, its checks' findings failing or passing. */
function result(
  id: string,
  checks: readonly (readonly [string, 'pass' | 'fail'])[],
  extra: Partial<CaseResult> = {},
): CaseResult {
  return {
    id,
    suite: 'redteam',
    language: 'en',
    status: checks.some(([, verdict]) => verdict === 'fail') ? 'fail' : 'pass',
    unstable: false,
    dimensions: [],
    samples: [
      {
        index: 0,
        cache: 'cold',
        turns: [
          {
            user: 'x',
            checks: checks.map(([check, verdict]) => ({
              check,
              applicable: true,
              findings: [{ dimension: 'd', verdict, severity: 'high', message: 'm' }],
            })),
          },
        ],
      },
    ],
    ...extra,
  };
}

describe('the frameworks (ADR-0089)', () => {
  it('name each category once, as its framework codes it', () => {
    const ids = FRAMEWORKS.flatMap((framework) =>
      framework.categories.map((category) => `${framework.id}:${category.code}`),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(FRAMEWORKS.map((framework) => framework.id)).size).toBe(FRAMEWORKS.length);
    for (const id of Object.values(CATEGORY)) expect(LISTED.has(id), id).toBe(true);
    expect(new Set(Object.values(CATEGORY)).size).toBe(LISTED.size);
  });
});

describe("core's mapping (ADR-0089)", () => {
  it('names only categories the frameworks list, for every kind and check', () => {
    for (const [kind, mapping] of Object.entries(CORE_TAXONOMY.kinds)) {
      expect(mapping.categories.length, kind).toBeGreaterThan(0);
      for (const category of mapping.categories) expect(LISTED.has(category), category).toBe(true);
      // Every attack case is a verification test.
      expect(mapping.categories, kind).toContain(CATEGORY.verification);
    }
    for (const [check, categories] of Object.entries(CORE_TAXONOMY.checks)) {
      expect(categories.length, check).toBeGreaterThan(0);
      for (const category of categories) expect(LISTED.has(category), category).toBe(true);
    }
  });

  it('maps every kind the generator writes, and only those', () => {
    const { cases } = genericAttacks({
      packs: [{ ...stubLanguagePack('en'), attacks: STUB_ATTACKS }],
      perKind: 1,
      canary: 'YK-000000',
      identities: [
        ['alice', { name: 'Alice Doe', seeded: ['1 Main St'], role: 'customer' }],
        ['bob', { name: 'Bob Roe' }],
      ],
      roles: { customer: { forbiddenTools: ['refund_order'] } },
    });
    expect([...new Set(cases.map((c) => c.kind))].toSorted()).toEqual(
      Object.keys(CORE_TAXONOMY.kinds).toSorted(),
    );
  });

  it("maps only core's checks", () => {
    const ids = new Set(CORE_CHECKS.map((check) => check.id));
    for (const check of Object.keys(CORE_TAXONOMY.checks)) expect(ids.has(check), check).toBe(true);
  });
});

describe('merging the mappings (ADR-0089)', () => {
  const other: Taxonomy = {
    kinds: { offer: { severity: 'medium', categories: [CATEGORY.LLM09] } },
    checks: { concession: [CATEGORY.LLM09] },
  };

  it("keeps each mapping's kinds and checks", () => {
    const merged = mergeTaxonomies(CORE_TAXONOMY, other);
    expect(merged.kinds['offer']).toEqual(other.kinds['offer']);
    expect(merged.kinds['injection']).toEqual(CORE_TAXONOMY.kinds['injection']);
    expect(merged.checks['concession']).toEqual([CATEGORY.LLM09]);
    expect(merged.checks['pii-leak']).toEqual(CORE_TAXONOMY.checks['pii-leak']);
  });

  it('refuses a kind or a check mapped twice', () => {
    expect(() => mergeTaxonomies(other, other)).toThrow('attack kind "offer" is mapped twice');
    expect(() => mergeTaxonomies(other, { kinds: {}, checks: other.checks })).toThrow(
      'check "concession" is mapped twice',
    );
  });
});

describe("a case's kinds and a finding's categories (ADR-0089)", () => {
  it("are a redteam case's tags that name a kind", () => {
    const tags = ['generated', 'injection', 'card', 'nightly'];
    expect(caseKinds({ suite: 'redteam', tags }, CORE_TAXONOMY)).toEqual(['injection', 'card']);
    expect(caseKinds({ suite: 'quality', tags }, CORE_TAXONOMY)).toEqual([]);
    expect(caseKinds({ suite: 'redteam' }, CORE_TAXONOMY)).toEqual([]);
    // A tag named as an object's own property is no kind.
    expect(caseKinds({ suite: 'redteam', tags: ['constructor'] }, CORE_TAXONOMY)).toEqual([]);
  });

  it("name the kinds' categories and the check's, each once", () => {
    expect(findingCategories(['injection'], 'pii-leak', CORE_TAXONOMY)).toEqual([
      ...(CORE_TAXONOMY.kinds['injection']?.categories ?? []),
      CATEGORY.LLM02,
      CATEGORY.privacy,
      CATEGORY.gdpr,
      CATEGORY.kvkk,
    ]);
    expect(findingCategories([], 'injection-canary', CORE_TAXONOMY)).toEqual([
      CATEGORY.LLM01,
      CATEGORY.ASI01,
    ]);
    expect(findingCategories(['nope'], 'language-match', CORE_TAXONOMY)).toEqual([]);
    // An injection caught by its canary names each category once.
    expect(findingCategories(['injection'], 'injection-canary', CORE_TAXONOMY)).toEqual(
      CORE_TAXONOMY.kinds['injection']?.categories,
    );
  });
});

describe('what results.v1 keeps of the mapping (ADR-0089)', () => {
  it("keeps the cases' kinds, the mapped checks that judged a turn, and the categories they name", () => {
    const cases = [
      result('a', [['answer-text', 'fail']], { kinds: ['internals'] }),
      result('b', [['card-number', 'pass']]),
      result('c', [['prompt-leak', 'pass']], { kinds: ['nope'] }),
    ];
    // A mapped check that never applied is left out.
    const [first] = cases;
    const unapplied = first?.samples[0]?.turns[0];
    unapplied?.checks.push({ check: 'tool-calls', applicable: false, findings: [] });
    const kept = runTaxonomy(CORE_TAXONOMY, cases);
    expect(kept?.kinds).toEqual({ internals: CORE_TAXONOMY.kinds['internals'] });
    expect(kept?.checks).toEqual({
      'card-number': CORE_TAXONOMY.checks['card-number'],
      'prompt-leak': [CATEGORY.LLM07],
    });
    expect(kept?.frameworks.map((framework) => framework.id)).toEqual([
      'owasp-llm',
      'mitre-atlas',
      'nist-ai-rmf',
      'iso-42001',
      'gdpr',
      'kvkk',
      'eu-ai-act',
    ]);
    expect(kept?.frameworks[0]).toEqual({
      id: 'owasp-llm',
      name: 'OWASP Top 10 for LLM Applications',
      version: '2025',
      categories: [
        { id: CATEGORY.LLM02, name: 'Sensitive Information Disclosure' },
        { id: CATEGORY.LLM07, name: 'System Prompt Leakage' },
      ],
    });
  });

  it('keeps its kinds and checks by name, whatever the order of the cases', () => {
    const kept = runTaxonomy(CORE_TAXONOMY, [
      result('b', [['prompt-leak', 'pass']], { kinds: ['pretext'] }),
      result('a', [['card-number', 'pass']], { kinds: ['card'] }),
    ]);
    expect(Object.keys(kept?.kinds ?? {})).toEqual(['card', 'pretext']);
    expect(Object.keys(kept?.checks ?? {})).toEqual(['card-number', 'prompt-leak']);
  });

  it('keeps nothing when the run names no category', () => {
    expect(runTaxonomy(CORE_TAXONOMY, [result('a', [['answer-text', 'fail']])])).toBeUndefined();
    expect(runTaxonomy(CORE_TAXONOMY, [])).toBeUndefined();
  });

  it('lists each category a failing finding names, with its cases, in the frameworks order', () => {
    const cases = [
      result('a', [['answer-text', 'fail']], { kinds: ['internals'] }),
      result('b', [
        ['card-number', 'fail'],
        ['prompt-leak', 'pass'],
      ]),
      result('c', [['prompt-leak', 'fail']], { kinds: ['internals'] }),
    ];
    const taxonomy = runTaxonomy(CORE_TAXONOMY, cases);
    const failing = failingCategories({ cases, taxonomy });
    expect(failing.slice(0, 2)).toEqual([
      { category: CATEGORY.LLM02, cases: ['b'] },
      { category: CATEGORY.LLM07, cases: ['a', 'c'] },
    ]);
    expect(failing.map((row) => row.category)).toEqual([
      CATEGORY.LLM02,
      CATEGORY.LLM07,
      CATEGORY.discovery,
      CATEGORY.security,
      CATEGORY.privacy,
      CATEGORY.verification,
      CATEGORY.gdpr,
      CATEGORY.kvkk,
      CATEGORY.aiAct,
    ]);
    expect(failingCategories({ cases, taxonomy: undefined })).toEqual([]);
  });
});
