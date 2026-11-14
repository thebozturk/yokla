// The simulated customer (ADR-0028): yokla's prompt for the model that plays
// a customer, the conversation as that model sees it, what keys its cached
// replies, and whether an answer reached the goal. Nothing here is about a
// particular assistant. Core is pure: the runtime sends the calls and hashes
// the keys.

import { answerText, evidenceCount, routeExpected } from '../checks/generic.ts';
import type { Check, CheckContext, TurnView } from '../checks/types.ts';
import type { CaseCustomer } from '../schema/cases.ts';
import type { OwnModel } from '../schema/config.ts';

/** The first line of every customer prompt, so a fake provider can tell it apart. */
export const CUSTOMER_PROMPT_MARK = 'yokla: simulated customer';

interface Template {
  readonly role: string;
  readonly persona: string;
  readonly goal: string;
  readonly ask: string;
  readonly start: string;
}

const TEMPLATES: Readonly<Record<string, Template>> = {
  en: {
    role: "You are a customer writing to an online shop's assistant. Stay in character.",
    persona: 'Who you are:',
    goal: 'What you want:',
    ask: 'Write only your next message to the assistant: one or two short sentences, in English, as a customer would type them. Never say that you are a test or a simulation.',
    start: '(The conversation starts. Write your first message.)',
  },
  tr: {
    role: 'Bir online mağazanın asistanına yazan bir müşterisin. Rolünden çıkma.',
    persona: 'Kimsin:',
    goal: 'Ne istiyorsun:',
    ask: 'Asistana yalnızca bir sonraki mesajını yaz: bir müşterinin yazacağı gibi, Türkçe, bir iki kısa cümle. Test ya da simülasyon olduğunu asla söyleme.',
    start: '(Konuşma başlıyor. İlk mesajını yaz.)',
  },
};

/** The languages the customer prompt is written in. */
export const CUSTOMER_LANGUAGES: readonly string[] = Object.keys(TEMPLATES);

/** One exchange of the conversation so far: the customer's message and the answer. */
export interface Exchanged {
  readonly customer: string;
  readonly answer: string;
}

export interface CustomerPrompt {
  readonly system: string;
  /** The customer model writes as the assistant; the target's answers come in as the user's. */
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
}

/** The prompt for the customer's next message, after the exchanges so far. */
export function customerPrompt(
  customer: Pick<CaseCustomer, 'persona' | 'goal'>,
  language: string,
  exchanges: readonly Exchanged[],
): CustomerPrompt {
  const template = TEMPLATES[language];
  if (template === undefined) {
    throw new Error(
      `no customer prompt in "${language}"; there is one in ${CUSTOMER_LANGUAGES.join(', ')}`,
    );
  }
  const system = [
    CUSTOMER_PROMPT_MARK,
    template.role,
    `${template.persona} ${customer.persona}`,
    `${template.goal} ${customer.goal}`,
    template.ask,
  ].join('\n');
  // A conversation starts with the other party's message, as every provider requires.
  const messages = [
    { role: 'user' as const, content: template.start },
    ...exchanges.flatMap((exchange) => [
      { role: 'assistant' as const, content: exchange.customer },
      { role: 'user' as const, content: exchange.answer },
    ]),
  ];
  return { system, messages };
}

/**
 * What keys a cached customer reply: the model, the customer, the seed and the
 * conversation so far. The runtime hashes it; equal keys mean an equal request.
 */
export function customerCacheKey(parts: {
  readonly model: Pick<OwnModel, 'kind' | 'url' | 'model' | 'temperature' | 'maxTokens'>;
  readonly customer: Pick<CaseCustomer, 'persona' | 'goal'>;
  readonly language: string;
  readonly seed: string;
  readonly exchanges: readonly Exchanged[];
}): string {
  const { model, customer } = parts;
  return JSON.stringify([
    [model.kind, model.url, model.model, model.temperature, model.maxTokens],
    [customer.persona, customer.goal, parts.language, parts.seed],
    parts.exchanges.map((exchange) => [exchange.customer, exchange.answer]),
  ]);
}

const REACHED_CHECKS: readonly Check[] = [routeExpected, answerText, evidenceCount];

/**
 * Whether an answer reached the goal: every check of `reached` applied to it
 * and passed. Judged from the answer alone, so it needs no model proxy.
 */
export function goalReached(
  reached: CaseCustomer['reached'],
  context: Omit<CheckContext, 'turn'> & { readonly turn: TurnView },
): boolean {
  const turn = { ...context.turn, expect: { ...reached } };
  let applied = 0;
  for (const check of REACHED_CHECKS) {
    const outcome = check.run({ ...context, turn });
    // These checks judge the answer alone, so none leaves a dimension unmeasured.
    if (!outcome.applicable) continue;
    if (outcome.findings.some((finding) => finding.verdict !== 'pass')) return false;
    applied += 1;
  }
  return applied > 0;
}

export const goalReachedCheck: Check = {
  id: 'goal-reached',
  description: "The simulated customer reached its goal within the case's maxTurns.",
  run(context) {
    const { customer } = context.turn;
    if (customer === undefined) {
      return { applicable: false, reason: 'the turn ends no simulated conversation' };
    }
    return {
      applicable: true,
      findings: [
        {
          dimension: 'task-success',
          verdict: customer.reached ? 'pass' : 'fail',
          severity: 'high',
          message: customer.reached
            ? `reached the goal after answer ${String(customer.turns)} of at most ${String(customer.maxTurns)}`
            : `didn't reach the goal in ${String(customer.turns)} answer(s), with at most ${String(customer.maxTurns)}`,
          evidence: {
            turns: customer.turns,
            maxTurns: customer.maxTurns,
            reached: customer.reached,
          },
        },
      ],
    };
  },
};
