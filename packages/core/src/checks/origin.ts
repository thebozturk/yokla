// Where a failure arose (ADR-0033). A failing finding can name its subject:
// the value in the answer it is about. This finds where that value first
// appears in the turn's model calls: in a message a call sent (input), in a
// call's answer (model), or in neither (app). It is never guessed: without
// proxy data, or with a call whose messages or answer couldn't be read, the
// origin is unknown, with the reason. A turn with no model calls is a
// measurement: the app wrote the answer itself.

import { readToolResult } from '../extract/seen.ts';
import type { FindingOrigin, FindingSubject } from '../schema/results.ts';
import { collapse, decodeJsonEscapes } from '../text/match.ts';
import type { CheckContext, LanguagePack } from './types.ts';

type Match = NonNullable<FindingOrigin['match']>;

/** The answer's language pack first, then the other loaded ones. */
function packs(context: CheckContext): LanguagePack[] {
  const first = context.lang === undefined ? [] : [context.lang];
  return [...first, ...[...context.languages.values()].filter((pack) => pack !== context.lang)];
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** Every number in a JSON value, at any depth. */
function numbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const item of value) numbers(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) numbers(item, out);
  }
  return out;
}

/** How `subject` is found in `text`, or undefined when it isn't there. */
function find(context: CheckContext, subject: FindingSubject, raw: string): Match | undefined {
  const text = decodeJsonEscapes(raw);
  switch (subject.kind) {
    case 'money': {
      const amount = cents(subject.amount);
      for (const pack of packs(context)) {
        const found = pack
          .findMoney(text)
          .some(
            (mention) =>
              cents(mention.amount) === amount &&
              (subject.currency === undefined ||
                mention.currency === undefined ||
                mention.currency === subject.currency),
          );
        if (found) return 'money';
      }
      // A bare number counts only inside JSON, and says so (ADR-0033).
      const json = readToolResult(raw);
      if (json !== undefined && numbers(json.value).some((n) => cents(n) === amount)) {
        return 'number';
      }
      return undefined;
    }
    case 'duration':
      return packs(context).some((pack) =>
        pack
          .findDurations(text)
          .some((mention) => mention.amount === subject.amount && mention.unit === subject.unit),
      )
        ? 'duration'
        : undefined;
    case 'text': {
      const fold = (value: string) =>
        collapse(context.lang === undefined ? value.toLowerCase() : context.lang.fold(value));
      const needle = fold(subject.text);
      return needle !== '' && fold(text).includes(needle) ? 'text' : undefined;
    }
  }
}

/** Where `subject` first appears in the turn's model calls (ADR-0033). */
export function findOrigin(context: CheckContext, subject: FindingSubject): FindingOrigin {
  const proxy = context.turn.proxy;
  if (proxy === undefined) {
    return { stage: 'unknown', reason: 'no model proxy data for this turn' };
  }
  const calls = proxy.calls;
  for (const [index, call] of calls.entries()) {
    for (const message of call.prompt ?? []) {
      const match = find(context, subject, message.text);
      if (match !== undefined) {
        return {
          stage: 'input',
          call: index,
          role: message.role,
          ...(message.tool === undefined ? {} : { tool: message.tool }),
          match,
        };
      }
    }
  }
  // Not in any message read: before saying the model or the app wrote it, every message must have been read.
  const unread = calls.findIndex((call) => call.prompt === null);
  if (unread !== -1) {
    return {
      stage: 'unknown',
      call: unread,
      reason: 'the messages a model call sent are not known',
    };
  }
  for (const [index, call] of calls.entries()) {
    const match = call.output === null ? undefined : find(context, subject, call.output);
    if (match !== undefined) return { stage: 'model', call: index, match };
  }
  const silent = calls.findIndex((call) => call.output === null);
  if (silent !== -1) {
    return { stage: 'unknown', call: silent, reason: "a model call's answer is not known" };
  }
  return calls.length === 0
    ? { stage: 'app', reason: 'the turn made no model call' }
    : { stage: 'app' };
}
