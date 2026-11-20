import { describe, expect, it } from 'vitest';
import { buildSchemas } from '../schema/build.ts';
import type { Profile } from '../schema/profile.ts';
import { checkContext, mutate, stubLanguagePack, turnView } from '../testing.ts';
import { CORE_CHECKS, CORE_DIMENSIONS } from './all.ts';
import { requestHandled } from './request.ts';
import type { CheckContext, CheckOutcome, LanguagePack, TurnView } from './types.ts';

const english: LanguagePack = {
  ...stubLanguagePack('en'),
  phrases: {
    ...stubLanguagePack('en').phrases,
    absence: ["couldn't find", 'no results'],
    deflection: ['contact customer service', 'live chat'],
  },
};

const BASE: Profile = checkContext(turnView()).profile;
const HELP_DESK: Profile =
  BASE.target.adapter === 'http'
    ? {
        ...BASE,
        target: {
          ...BASE.target,
          response: { ...BASE.target.response, contactPhrases: ['Help.Demo-Shop.example'] },
        },
      }
    : BASE;

const CARDS = { products: [{ id: 'TNT-001' }, { id: 'TNT-002' }] };

function requestTurn(
  request: unknown,
  text: string,
  evidence: TurnView['response']['evidence'] = {},
): TurnView {
  return turnView({ expect: { request }, response: { text, evidence } });
}

function run(turn: TurnView, change: Partial<Omit<CheckContext, 'turn'>> = {}): CheckOutcome {
  return requestHandled.run(checkContext(turn, { lang: english, ...change }));
}

function verdicts(outcome: CheckOutcome): string[] {
  return outcome.applicable ? outcome.findings.map((f) => f.verdict) : [`n/a: ${outcome.reason}`];
}

function failures(outcome: CheckOutcome): string[] {
  return outcome.applicable
    ? outcome.findings.filter((f) => f.verdict === 'fail').map((f) => f.message)
    : [];
}

const requestFile = (request: unknown) => ({
  version: 1,
  cases: [
    { id: 'c', suite: 'quality', language: 'en', turns: [{ user: 'hi', expect: { request } }] },
  ],
});

describe('request-handled (ADR-0075)', () => {
  it('does not apply to a turn that says no kind of request, or an unknown kind', () => {
    expect(
      verdicts(run(turnView({ response: { text: 'Here are tents', evidence: CARDS } }))),
    ).toEqual(['n/a: the turn says no kind of request']);
    expect(verdicts(run(requestTurn('product', 'Here are tents', CARDS)))).toEqual([
      'n/a: the turn says no kind of request',
    ]);
  });

  it('is a core check, in the request dimension', () => {
    expect(CORE_CHECKS).toContain(requestHandled);
    expect(CORE_DIMENSIONS.has('request')).toBe(true);
    const outcome = run(requestTurn('chitchat', 'Here you go', CARDS));
    expect(outcome.applicable && outcome.findings.map((f) => f.dimension)).toEqual([
      'request',
      'request',
    ]);
  });

  describe('chitchat', () => {
    it('passes a polite answer with no cards', () => {
      expect(verdicts(run(requestTurn('chitchat', "You're welcome! Anything else?")))).toEqual([
        'pass',
        'pass',
      ]);
    });

    it('fails cards, in any collection the profile maps', () => {
      expect(failures(run(requestTurn('chitchat', "You're welcome!", CARDS)))).toEqual([
        'answered a chitchat turn with evidence items: 2 products',
      ]);
      expect(
        failures(run(requestTurn('chitchat', 'Hi!', { products: [], cart: [{ id: 'TNT-001' }] }))),
      ).toEqual(['answered a chitchat turn with evidence items: 1 cart']);
    });

    it('fails cards on a turn the target answered with a clarifying question', () => {
      const turn = { ...requestTurn('chitchat', 'Which tent?', CARDS), clarifying: true };
      expect(verdicts(run(turn))).toEqual(['fail', 'pass']);
    });

    it('fails a failed-search sentence', () => {
      expect(
        failures(run(requestTurn('chitchat', "Sorry, I couldn't find any products for thanks."))),
      ).toEqual(['answered a chitchat turn with a failed-search sentence ("couldn\'t find")']);
    });

    it('needs no pointer to a person', () => {
      expect(verdicts(run(requestTurn('chitchat', 'Goodbye!')))).toEqual(['pass', 'pass']);
    });
  });

  describe('support', () => {
    it('passes an absence sentence that also sends the user elsewhere', () => {
      const text = "I couldn't find your order here; please contact customer service.";
      expect(verdicts(run(requestTurn('support', text)))).toEqual(['pass', 'pass']);
    });

    it('fails an absence sentence alone', () => {
      expect(verdicts(run(requestTurn('support', 'No results for your order.')))).toEqual([
        'pass',
        'fail',
      ]);
    });

    it('counts a profile contact phrase as sending the user elsewhere', () => {
      const text = 'No results here. Write to help.demo-shop.example about your order.';
      expect(verdicts(run(requestTurn('support', text)))).toEqual(['pass', 'fail']);
      expect(verdicts(run(requestTurn('support', text), { profile: HELP_DESK }))).toEqual([
        'pass',
        'pass',
      ]);
    });

    it('fails cards', () => {
      expect(verdicts(run(requestTurn('support', 'Here are our tents:', CARDS)))).toEqual([
        'fail',
        'pass',
      ]);
    });
  });

  describe('handoff', () => {
    it('fails without a pointer to a person or a channel', () => {
      expect(failures(run(requestTurn('handoff', 'What are you looking for?')))).toEqual([
        'the user asked for a person and was not told how to reach one',
      ]);
    });

    it("passes with a phrase of the language pack's deflection list", () => {
      expect(
        verdicts(run(requestTurn('handoff', 'Our live chat connects you to a person.'))),
      ).toEqual(['pass', 'pass', 'pass']);
    });

    it("passes with one of the profile's contactPhrases, matched after folding", () => {
      const text = 'Write to HELP.demo-shop.EXAMPLE and a person answers.';
      expect(verdicts(run(requestTurn('handoff', text)))).toEqual(['pass', 'pass', 'fail']);
      expect(verdicts(run(requestTurn('handoff', text), { profile: HELP_DESK }))).toEqual([
        'pass',
        'pass',
        'pass',
      ]);
    });

    it('fails cards and a failed-search sentence even with a pointer', () => {
      const text = 'No results. Contact customer service.';
      expect(verdicts(run(requestTurn('handoff', text, CARDS)))).toEqual(['fail', 'pass', 'pass']);
      expect(verdicts(run(requestTurn('handoff', 'No results for a person.')))).toEqual([
        'pass',
        'fail',
        'fail',
      ]);
    });
  });

  it('judges the cards without a language pack, and leaves the wording unmeasured', () => {
    const outcome = run(requestTurn('handoff', 'Contact customer service.'), { lang: undefined });
    expect(outcome).toMatchObject({
      applicable: true,
      findings: [{ verdict: 'pass' }],
      unmeasured: [{ dimension: 'request' }],
    });
    expect(verdicts(run(requestTurn('chitchat', 'Hi', CARDS), { lang: undefined }))).toEqual([
      'fail',
    ]);
  });

  it('catches the mutations of a clean chit-chat turn', () => {
    const clean = requestTurn('chitchat', "You're welcome!");
    expect(verdicts(run(clean))).toEqual(['pass', 'pass']);
    const carded = mutate(clean, (turn) => ({
      ...turn,
      response: { ...turn.response, evidence: CARDS },
    }));
    expect(verdicts(run(carded))).toEqual(['fail', 'pass']);
    const searched = mutate(clean, (turn) => ({
      ...turn,
      response: { ...turn.response, text: 'No results for "thanks".' },
    }));
    expect(verdicts(run(searched))).toEqual(['pass', 'fail']);
    const handoff = mutate(clean, (turn) => ({ ...turn, expect: { request: 'handoff' } }));
    expect(verdicts(run(handoff))).toEqual(['pass', 'pass', 'fail']);
  });

  it('is a case expectation of three kinds, and no other', () => {
    const { caseFile } = buildSchemas({ languages: ['en'], domainPacks: [{ id: 'shop' }] });
    for (const kind of ['chitchat', 'handoff', 'support'])
      expect(caseFile.safeParse(requestFile(kind)).success).toBe(true);
    for (const kind of ['product', 'greeting', ''])
      expect(caseFile.safeParse(requestFile(kind)).success).toBe(false);
  });
});
