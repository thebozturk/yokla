import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildSchemas } from '../schema/build.ts';
import { EMPTY_COVERAGE } from './coverage.ts';
import type { ExploreResult, KeptCandidate } from './search.ts';
import { explorationEvidence, exploredCaseYaml } from './write.ts';

const reaching: KeptCandidate = {
  id: 'cart-1',
  candidate: {
    operator: 'cart',
    from: 'tents-tr',
    suite: 'factual',
    language: 'tr',
    turns: [{ user: 'Çadır var mı?' }, { user: 'Plaj Çadırı ürününü sepete ekler misin?' }],
  },
  reached: ['route:cart', 'tool:add_to_cart'],
  failed: [],
};
const failing: KeptCandidate = {
  id: 'fault-1',
  candidate: {
    operator: 'fault',
    from: 'cart-1',
    suite: 'resilience',
    language: 'tr',
    turns: [{ user: 'Çadır var mı?', faults: [{ fault: { kind: 'status', status: 503 } }] }],
  },
  reached: ['fault:fallback/status'],
  failed: ['graceful-under-fault (resilience)', 'answer-text (contract)'],
};
const opening: KeptCandidate = {
  id: 'policy-1',
  candidate: {
    operator: 'policy',
    from: undefined,
    suite: 'factual',
    language: 'en',
    turns: [{ user: 'What are your warranty terms?' }],
  },
  reached: [],
  failed: ['policy-claim (fabrication)'],
};

const result = (kept: KeptCandidate[]): ExploreResult => ({
  kept,
  coverage: EMPTY_COVERAGE,
  added: [],
  runs: kept.length,
  stopped: false,
});

describe('the case file of an exploration (ADR-0044)', () => {
  it('says where a case came from, what it failed on which turn, and what it reached', () => {
    expect(explorationEvidence(reaching)).toBe(
      'yokla explore, cart from tents-tr: reached route:cart, tool:add_to_cart',
    );
    expect(explorationEvidence(failing)).toBe(
      'yokla explore, fault from cart-1: failed graceful-under-fault (resilience), answer-text (contract) on turn 1; reached fault:fallback/status',
    );
    expect(explorationEvidence(opening)).toBe(
      'yokla explore, policy from an opening turn: failed policy-claim (fabrication) on turn 1',
    );
  });

  it('writes the kept cases as proposed, those a check failed on first, in a valid case file', () => {
    const text = exploredCaseYaml(result([reaching, failing, opening]));
    expect(text).toMatch(/^# Written by yokla explore \(ADR-0044\)/u);
    const { caseFile } = buildSchemas({ languages: ['tr', 'en'], domainPacks: [{ id: 'shop' }] });
    const file = caseFile.parse(parse(text));
    expect(file.cases.map((c) => c.id)).toEqual(['fault-1', 'policy-1', 'cart-1']);
    expect(file.cases[0]).toMatchObject({
      suite: 'resilience',
      language: 'tr',
      turns: [{ user: 'Çadır var mı?', faults: [{ fault: { kind: 'status', status: 503 } }] }],
      provenance: { source: 'explore', status: 'proposed', evidence: explorationEvidence(failing) },
    });
    expect(file.cases[2]?.turns.map((turn) => turn.user)).toEqual([
      'Çadır var mı?',
      'Plaj Çadırı ürününü sepete ekler misin?',
    ]);
  });
});
