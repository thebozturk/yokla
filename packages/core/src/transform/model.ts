// The transforms a model writes (ADR-0059): paraphrase and Turkish-English
// code-switching. yokla's own prompt asks for one rewrite of a message, and a
// rewrite is sent only when it keeps exactly every text no transform
// changes (ADR-0045). Pure: the runtime makes the calls.

import type { LanguagePack } from '../checks/types.ts';
import type { CustomerPrompt } from '../customer/customer.ts';
import type { ModelTransform } from '../schema/common.ts';

/** yokla marks the first line of its transform prompt so. */
export const TRANSFORM_MARK = 'yokla: transform';

/** Changes whenever the prompt does, so a cached rewrite of an old prompt isn't used. */
export const TRANSFORM_PROMPT_VERSION = 2;

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

const KEEP_THE_REQUEST =
  'Keep the same requests and facts: add none and drop none; change only how they are written.';

const ASKS: Readonly<Record<ModelTransform, (ask: RewriteAsk) => string>> = {
  paraphrase: (ask) =>
    `Write the same request in other words, in the same language (${ask.language}), as another shopper would write it. ${KEEP_THE_REQUEST}`,
  'code-switch': (ask) =>
    `Write the same message as a bilingual shopper would: keep ${ask.language} as its language, replace a few words, such as product words, with their ${ask.other ?? ask.language} words, and write nothing else in ${ask.other ?? ask.language}. ${KEEP_THE_REQUEST}`,
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

/** How many sentences a text holds: ends before a space or the end, never a point between digits. */
function sentences(text: string): number {
  return Math.max(1, (text.match(/[.?!…]+(?=\s|$)/gu) ?? []).length);
}

/** How many of a text's words are common words of a language, as language-match counts them. */
function commonCount(text: string, pack: LanguagePack): number {
  const common = new Set(pack.commonWords);
  return text.split(/[^\p{L}]+/u).filter((word) => word !== '' && common.has(pack.fold(word)))
    .length;
}

/** The case's language and the one a code-switch mixes in, to tell which one a rewrite is in. */
export interface SwitchedLanguages {
  readonly own: LanguagePack;
  readonly mixed: LanguagePack;
}

/**
 * Checks a model's reply: one line, not the message as written, every kept
 * text exactly, no sentence more than the message, and, for a code-switch,
 * no more common words of the mixed-in language than of its own (ADR-0059,
 * ADR-0060).
 */
export function checkRewrite(
  message: string,
  reply: string,
  keep: readonly string[],
  switched?: SwitchedLanguages,
): CheckedRewrite {
  const trimmed = reply.trim();
  // A reply in quotes is the message inside them.
  const text = /^"[^"]*"$/u.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
  if (text === '') return { ok: false, why: 'the reply is empty' };
  if (/[\r\n]/u.test(text)) return { ok: false, why: 'the reply is more than one line' };
  if (text === message.trim()) return { ok: false, why: 'the reply is the message as written' };
  const lost = keep.find((kept) => !text.includes(kept));
  if (lost !== undefined) return { ok: false, why: `"${lost}" was lost` };
  if (sentences(text) > sentences(message)) return { ok: false, why: 'the reply adds a sentence' };
  if (
    switched !== undefined &&
    commonCount(text, switched.mixed) > commonCount(text, switched.own)
  ) {
    return { ok: false, why: `the reply is no longer in ${switched.own.language}` };
  }
  return { ok: true, text };
}
