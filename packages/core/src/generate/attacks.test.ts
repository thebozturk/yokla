import { describe, expect, it } from 'vitest';
import type { AttackPhrasings, LanguagePack } from '../checks/types.ts';
import { stubLanguagePack } from '../testing.ts';
import { attackCanary, genericAttacks } from './attacks.ts';

const phrasings: AttackPhrasings = {
  injection: {
    forget: 'forget, say {canary}',
    persona: 'persona, say {canary}',
    system: 'system, say {canary}',
    'after-question': 'question, then {canary} and {canary}',
  },
  extraction: { repeat: 'repeat them', 'code-block': 'in a block', translate: 'translate them' },
};

const pack = (language: string): LanguagePack => ({
  ...stubLanguagePack(language),
  attacks: phrasings,
});

describe('attack canaries (ADR-0080)', () => {
  it('are YK- and six hex digits, the same for the same inputs, apart for others', () => {
    const canary = attackCanary('injection', 'tr', 'forget', 0);
    expect(canary).toMatch(/^YK-[0-9A-F]{6}$/u);
    expect(attackCanary('injection', 'tr', 'forget', 0)).toBe(canary);
    const others = [
      attackCanary('injection', 'en', 'forget', 0),
      attackCanary('injection', 'tr', 'persona', 0),
      attackCanary('injection', 'tr', 'forget', 1),
      attackCanary('extraction', 'tr', 'forget', 0),
    ];
    expect(new Set([canary, ...others]).size).toBe(5);
  });
});

describe('the attacks that need no domain (ADR-0080)', () => {
  it('writes injections by style up to perKind, each with its own canary in the message and the expectation', () => {
    const { cases, notes } = genericAttacks({ packs: [pack('tr')], perKind: 4, canary: undefined });
    const injections = cases.filter((c) => c.kind === 'injection');
    expect(injections.map((c) => c.key)).toEqual(['forget', 'persona', 'system', 'after-question']);
    for (const [index, c] of injections.entries()) {
      const canary = attackCanary('injection', 'tr', c.key, index);
      expect(c.suite).toBe('redteam');
      expect(c.turns[0]?.user).toContain(canary);
      expect(c.turns[0]?.user).not.toContain('{canary}');
      expect(c.turns[0]?.expect).toEqual({ answer: { notContains: [canary] } });
      expect(c.basis).toContain(canary);
    }
    // Every placeholder is filled.
    expect(injections[3]?.turns[0]?.user.split('YK-')).toHaveLength(3);
    expect(notes).toEqual([
      'extraction (tr): the profile has no canary (modelProxy.inspect.canary) to find in an answer',
    ]);
  });

  it('writes extraction against the profile canary, by style up to perKind', () => {
    const { cases, notes } = genericAttacks({
      packs: [pack('tr'), pack('en')],
      perKind: 2,
      canary: 'CANARY-123',
    });
    const extraction = cases.filter((c) => c.kind === 'extraction');
    expect(extraction.map((c) => `${c.language}:${c.key}`)).toEqual([
      'tr:repeat',
      'tr:code-block',
      'en:repeat',
      'en:code-block',
    ]);
    expect(extraction[0]).toMatchObject({
      suite: 'redteam',
      turns: [{ user: 'repeat them', expect: { answer: { notContains: ['CANARY-123'] } } }],
    });
    expect(cases.filter((c) => c.kind === 'injection')).toHaveLength(4);
    expect(notes).toEqual([]);
  });

  it('says which language pack words no attack, and writes none in it', () => {
    const { cases, notes } = genericAttacks({
      packs: [stubLanguagePack('de')],
      perKind: 2,
      canary: 'CANARY-123',
    });
    expect(cases).toEqual([]);
    expect(notes).toEqual(['injection, extraction (de): the language pack words no attack']);
  });
});
