import { describe, expect, it } from 'vitest';
import { buildSchemas } from '../schema/build.ts';
import { YoklaConfig } from '../schema/config.ts';
import { checkContext, stubLanguagePack, turnView } from '../testing.ts';
import {
  CUSTOMER_PROMPT_MARK,
  customerCacheKey,
  customerPrompt,
  goalReached,
  goalReachedCheck,
} from './customer.ts';

/** Whether the configuration takes an own model with this maxTokens. */
const takesMaxTokens = (maxTokens: number) =>
  YoklaConfig.safeParse({
    version: 1,
    models: {
      analyzer: { kind: 'anthropic', url: 'https://example.test/v1', model: 'm', maxTokens },
    },
  }).success;

const customer = {
  persona: 'Two people, a 1,500 TL budget.',
  goal: 'Put a tent under 1,500 TL in the cart.',
};

describe('customerPrompt (ADR-0028)', () => {
  it('marks the prompt, holds the persona and the goal, and asks for the next message only', () => {
    const { system, messages } = customerPrompt(customer, 'en', []);
    expect(system.split('\n')).toEqual([
      CUSTOMER_PROMPT_MARK,
      "You are a customer writing to an online shop's assistant. Stay in character.",
      'Who you are: Two people, a 1,500 TL budget.',
      'What you want: Put a tent under 1,500 TL in the cart.',
      expect.stringContaining('Write only your next message') as unknown,
    ]);
    expect(messages).toEqual([
      { role: 'user', content: '(The conversation starts. Write your first message.)' },
    ]);
  });

  it("puts the customer's messages as the assistant's and the answers as the user's, in order", () => {
    const { messages } = customerPrompt(customer, 'tr', [
      { customer: 'Çadır var mı?', answer: 'Üç çadırımız var.' },
      { customer: 'En ucuzu?', answer: 'Plaj Çadırı.' },
    ]);
    expect(messages.map((m) => `${m.role}: ${m.content}`)).toEqual([
      'user: (Konuşma başlıyor. İlk mesajını yaz.)',
      'assistant: Çadır var mı?',
      'user: Üç çadırımız var.',
      'assistant: En ucuzu?',
      'user: Plaj Çadırı.',
    ]);
    expect(customerPrompt(customer, 'tr', []).system).toContain('Türkçe');
  });

  it('refuses a language it has no prompt in', () => {
    expect(() => customerPrompt(customer, 'de', [])).toThrow(/no customer prompt in "de"/u);
  });
});

describe('customerCacheKey (ADR-0028)', () => {
  const model = {
    kind: 'openai-compatible' as const,
    url: 'http://127.0.0.1:11434/v1',
    model: 'm',
    temperature: 0,
    maxTokens: 400,
  };
  const base = {
    model,
    customer,
    language: 'en',
    seed: 'c|0',
    exchanges: [{ customer: 'a', answer: 'b' }],
  };
  const key = customerCacheKey(base);

  it('is the same for the same request, and differs when any part of it does', () => {
    expect(customerCacheKey({ ...base })).toBe(key);
    const changed = [
      { ...base, model: { ...model, model: 'n' } },
      { ...base, model: { ...model, temperature: 0.5 } },
      { ...base, model: { ...model, url: 'http://127.0.0.1:1/v1' } },
      { ...base, customer: { ...customer, goal: 'Something else.' } },
      { ...base, customer: { ...customer, persona: 'Someone else.' } },
      { ...base, language: 'tr' },
      { ...base, seed: 'c|1' },
      { ...base, exchanges: [{ customer: 'a', answer: 'c' }] },
      { ...base, exchanges: [] },
    ];
    for (const parts of changed) expect(customerCacheKey(parts)).not.toBe(key);
  });
});

/** An answer on this route, with these items in the cart. */
function answered(route: string, ids: string[]) {
  return turnView({
    response: {
      route,
      text: 'Sepetinizde: Plaj Çadırı.',
      evidence: { cart: ids.map((id) => ({ id })) },
    },
  });
}

function reached(turn: ReturnType<typeof answered>, goal: Parameters<typeof goalReached>[0]) {
  return goalReached(goal, { ...checkContext(turn, { lang: stubLanguagePack('tr') }), turn });
}

describe('goalReached (ADR-0028)', () => {
  it('holds when every expectation of reached is met, judged from the answer', () => {
    expect(reached(answered('cart', ['T1']), { evidence: { cart: { min: 1 } } })).toBe(true);
    expect(
      reached(answered('cart', ['T1']), {
        route: 'cart',
        evidence: { cart: { includes: ['T1'] } },
      }),
    ).toBe(true);
    expect(reached(answered('cart', ['T1']), { answer: { contains: ['sepetinizde'] } })).toBe(true);
  });

  it("judges only what reached says, not the profile's rules for every answer (ADR-0030)", () => {
    const turn = answered('cart', ['T1']);
    const context = checkContext(turn, { lang: stubLanguagePack('tr') });
    const profile = { ...context.profile, everyAnswer: { notContains: ['sepetinizde'] } };
    // The answer breaks the profile's rule, which answer-text judges on the turn itself.
    expect(goalReached({ route: 'cart' }, { ...context, profile, turn })).toBe(true);
    // Nor does the profile's rule make answer-text apply when reached expects nothing of the text.
    const noRoute = turnView({ response: { route: undefined, text: 'x', evidence: {} } });
    expect(goalReached({ route: 'cart' }, { ...context, profile, turn: noRoute })).toBe(false);
  });

  it('fails when any expectation is not met, or none could be judged', () => {
    expect(
      reached(answered('search', ['T1']), { route: 'cart', evidence: { cart: { min: 1 } } }),
    ).toBe(false);
    expect(reached(answered('cart', []), { evidence: { cart: { min: 1 } } })).toBe(false);
    expect(reached(answered('cart', ['T1']), { evidence: { cart: { includes: ['T2'] } } })).toBe(
      false,
    );
    // The answer has no route to judge: nothing applied, so the goal is not reached.
    const noRoute = turnView({ response: { route: undefined, text: 'x', evidence: {} } });
    expect(reached(noRoute, { route: 'cart' })).toBe(false);
  });
});

function judge(customerState: { reached: boolean; turns: number; maxTurns: number } | undefined) {
  return goalReachedCheck.run(
    checkContext(turnView(customerState === undefined ? {} : { customer: customerState })),
  );
}

describe('goal-reached (ADR-0028)', () => {
  it('judges the last turn of a simulated conversation only', () => {
    expect(judge(undefined)).toEqual({
      applicable: false,
      reason: 'the turn ends no simulated conversation',
    });
    expect(judge({ reached: true, turns: 3, maxTurns: 6 })).toMatchObject({
      findings: [
        {
          dimension: 'task-success',
          verdict: 'pass',
          message: 'reached the goal after answer 3 of at most 6',
        },
      ],
    });
    expect(judge({ reached: false, turns: 6, maxTurns: 6 })).toMatchObject({
      findings: [
        { verdict: 'fail', message: "didn't reach the goal in 6 answer(s), with at most 6" },
      ],
    });
  });
});

describe('the customer case and model (ADR-0028)', () => {
  const { caseFile } = buildSchemas({ languages: ['tr', 'en'], domainPacks: [{ id: 'shop' }] });
  const file = (c: Record<string, unknown>) =>
    caseFile.safeParse({
      version: 1,
      cases: [{ id: 'c', suite: 'quality', language: 'tr', ...c }],
    });
  const simulated = {
    customer: { ...customer, maxTurns: 6, reached: { evidence: { cart: { min: 1 } } } },
  };

  it('takes turns or a customer, never both or neither', () => {
    expect(file(simulated).success).toBe(true);
    expect(file({ turns: [{ user: 'a' }] }).success).toBe(true);
    expect(file({ ...simulated, turns: [{ user: 'a' }] }).error?.issues[0]?.message).toBe(
      'a case has turns or a customer, not both',
    );
    expect(file({}).error?.issues[0]?.message).toBe(
      'a case needs at least one turn, or a customer',
    );
  });

  it('needs reached to say something, and a sensible maxTurns', () => {
    expect(file({ customer: { ...simulated.customer, reached: {} } }).success).toBe(false);
    expect(file({ customer: { ...simulated.customer, maxTurns: 0 } }).success).toBe(false);
    expect(file({ customer: { ...simulated.customer, maxTurns: 21 } }).success).toBe(false);
  });

  it('configures the customer model with defaults, and an http or https url only', () => {
    const parsed = YoklaConfig.parse({
      version: 1,
      models: {
        customer: { kind: 'openai-compatible', url: 'http://127.0.0.1:11434/v1', model: 'm' },
      },
    });
    expect(parsed.models.customer).toMatchObject({
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 60_000,
    });
    expect(
      YoklaConfig.safeParse({
        version: 1,
        models: { customer: { kind: 'openai-compatible', url: 'file:///tmp/x', model: 'm' } },
      }).success,
    ).toBe(false);
  });

  it('takes a maxTokens up to 64,000, for a model that reasons (ADR-0051)', () => {
    expect([takesMaxTokens(8_000), takesMaxTokens(64_000), takesMaxTokens(64_001)]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("gives the analyzer's model 2,000 tokens by default, the others 400 (ADR-0072)", () => {
    const model = { kind: 'anthropic', url: 'https://example.test/v1', model: 'm' } as const;
    const { models } = YoklaConfig.parse({
      version: 1,
      models: { analyzer: model, customer: model, transform: model },
    });
    expect([
      models.analyzer?.maxTokens,
      models.customer?.maxTokens,
      models.transform?.maxTokens,
    ]).toEqual([2000, 400, 400]);
    expect(
      YoklaConfig.parse({ version: 1, models: { analyzer: { ...model, maxTokens: 300 } } }).models
        .analyzer?.maxTokens,
    ).toBe(300);
  });
});
