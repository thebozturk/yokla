// The transforms a model writes (ADR-0059): paraphrase and Turkish-English
// code-switching. yokla's own prompt asks for one rewrite of a message, and a
// rewrite is sent only when it keeps exactly every text no transform
// changes (ADR-0045). Pure: the runtime makes the calls.

import type { CustomerPrompt } from '../customer/customer.ts';
import type { ModelTransform } from '../schema/common.ts';

/** yokla marks the first line of its transform prompt so. */
export const TRANSFORM_MARK = 'yokla: transform';

/** Changes whenever the prompt does, so a cached rewrite of an old prompt isn't used. */
export const TRANSFORM_PROMPT_VERSION = 1;

/** One rewrite to ask for. */
export interface RewriteAsk {
  readonly kind: ModelTransform;
  readonly message: string;
  /** The case's language. */
  readonly language: string;
  /** For code-switch: the language mixed in. */
  readonly other?: string | undefined;
  /** The text the rewrite must keep exactly. */
  readonly keep: readonly string[];
}

const ASKS: Readonly<Record<ModelTransform, (ask: RewriteAsk) => string>> = {
  paraphrase: (ask) =>
    `Write the same request in other words, in the same language (${ask.language}), with the same facts, as another shopper would write it.`,
  'code-switch': (ask) =>
    `Write the same message as a bilingual shopper would: in ${ask.language}, with some words, such as product words, in ${ask.other ?? ask.language}.`,
};

/** The prompt for one rewrite. */
export function transformPrompt(ask: RewriteAsk): CustomerPrompt {
  return {
    system: [
      TRANSFORM_MARK,
      "You rewrite one message a shopper sends to a shop's assistant, for a robustness test.",
      `Transform: ${ask.kind}. ${ASKS[ask.kind](ask)}`,
      ...(ask.keep.length === 0
        ? []
        : [
            `Keep each of these exactly as written: ${ask.keep.map((text) => JSON.stringify(text)).join(', ')}.`,
          ]),
      'Answer with the rewritten message alone, on one line, with nothing before or after it.',
    ].join('\n'),
    messages: [{ role: 'user', content: ask.message }],
  };
}

/** A rewrite as it can be sent, or why it can't. */
export type CheckedRewrite =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string };

/** Checks a model's reply: one line, not the message as written, every kept text exactly. */
export function checkRewrite(
  message: string,
  reply: string,
  keep: readonly string[],
): CheckedRewrite {
  const trimmed = reply.trim();
  // A reply in quotes is the message inside them.
  const text = /^"[^"]*"$/u.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
  if (text === '') return { ok: false, why: 'the reply is empty' };
  if (/[\r\n]/u.test(text)) return { ok: false, why: 'the reply is more than one line' };
  if (text === message.trim()) return { ok: false, why: 'the reply is the message as written' };
  const lost = keep.find((kept) => !text.includes(kept));
  if (lost !== undefined) return { ok: false, why: `"${lost}" was lost` };
  return { ok: true, text };
}
