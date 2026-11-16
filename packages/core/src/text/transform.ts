// Robustness transforms (ADR-0045): a case's message as a user might write
// it, without diacritics, in lower case, without punctuation, or with a typo.
// What the language does is the language pack's (P7); punctuation and typos
// are the same in every language. Pure.

import type { LanguagePack } from '../checks/types.ts';
import { TRANSFORM_KINDS, type TransformKind } from '../schema/common.ts';
import { seededIndex } from '../seed.ts';

export interface TransformContext {
  /** The pack of the case's language. */
  readonly lang: LanguagePack;
  /** What identifies the turn in every run: case id, sample index and turn index (ADR-0017). */
  readonly seed: string;
  /** Text the turn's expectations quote; left as written wherever the message holds it. */
  readonly keep: readonly string[];
}

export interface TransformedMessage {
  readonly text: string;
  /** The kinds that changed the message, in the order they applied. */
  readonly changedBy: readonly TransformKind[];
}

interface Segment {
  readonly text: string;
  /** Left as written by every transform. */
  readonly kept: boolean;
}

/** A word that holds a digit, "@" or "/": an amount, a size, a phone number, an address or an id. */
const KEPT_WORD = /\S*[\p{N}@/]\S*/gu;
/** A run of punctuation; a mark between letters, other than an apostrophe or hyphen, parts words. */
const PUNCTUATION = /\p{P}+/gu;
const JOINER = /^['’\-‐]+$/u;
const LETTER = /\p{L}/u;
/** A word a typo may change: four letters or more. */
const TYPO_WORD = /\p{L}{4,}/gu;

/**
 * The spans of the message left as written: kept words, money amounts with
 * their currency as the language pack finds them, and every occurrence of a
 * kept value.
 */
function keptSpans(message: string, context: TransformContext): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of message.matchAll(KEPT_WORD)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  for (const money of context.lang.findMoney(message)) spans.push([money.start, money.end]);
  const { keep } = context;
  for (const value of keep) {
    if (value === '') continue;
    for (let at = message.indexOf(value); at !== -1; at = message.indexOf(value, at + 1)) {
      spans.push([at, at + value.length]);
    }
  }
  // Merged, in order: overlapping or touching spans become one.
  const merged: [number, number][] = [];
  for (const [start, end] of spans.toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function segmentsOf(message: string, context: TransformContext): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const [start, end] of keptSpans(message, context)) {
    if (start > at) segments.push({ text: message.slice(at, start), kept: false });
    segments.push({ text: message.slice(start, end), kept: true });
    at = end;
  }
  if (at < message.length) segments.push({ text: message.slice(at), kept: false });
  return segments;
}

function withoutPunctuation(text: string): string {
  return text.replaceAll(PUNCTUATION, (run, offset: number) => {
    const before = text[offset - 1] ?? '';
    const after = text[offset + run.length] ?? '';
    // "ürün,fiyat" keeps its words apart; "women's" and "e-posta" become one word.
    return LETTER.test(before) && LETTER.test(after) && !JOINER.test(run) ? ' ' : '';
  });
}

/**
 * One typo, drawn from the seed: in a word of four letters or more, never at
 * its first letter, two neighbouring letters swapped, one dropped or one
 * doubled. A word whose letters can't be swapped gets one dropped instead.
 */
function typo(word: string, seed: string): string {
  const letters = Array.from(word);
  const swappable = letters.flatMap((letter, i) =>
    i >= 1 && i + 1 < letters.length && letter !== letters[i + 1] ? [i] : [],
  );
  const kinds = ['swap', 'drop', 'double'] as const;
  const kind = kinds[seededIndex(`${seed}|kind`, kinds.length)];
  if (kind === 'swap' && swappable.length > 0) {
    const i = swappable[seededIndex(`${seed}|at`, swappable.length)] ?? 1;
    return [...letters.slice(0, i), letters[i + 1], letters[i], ...letters.slice(i + 2)].join('');
  }
  // Any letter but the first.
  const i = 1 + seededIndex(`${seed}|at`, letters.length - 1);
  return kind === 'double'
    ? [...letters.slice(0, i + 1), letters[i], ...letters.slice(i + 1)].join('')
    : [...letters.slice(0, i), ...letters.slice(i + 1)].join('');
}

/** One typo in one of the segments' words, chosen by the seed; none without a word to change. */
function withTypo(segments: readonly Segment[], seed: string): Segment[] {
  const words = segments.flatMap((segment, index) =>
    segment.kept
      ? []
      : [...segment.text.matchAll(TYPO_WORD)].map((match) => ({
          index,
          start: match.index,
          word: match[0],
        })),
  );
  if (words.length === 0) return [...segments];
  const chosen = words[seededIndex(`${seed}|typos|word`, words.length)];
  if (chosen === undefined) return [...segments];
  return segments.map((segment, index) => {
    if (index !== chosen.index) return segment;
    const end = chosen.start + chosen.word.length;
    const changed = typo(chosen.word, `${seed}|typos`);
    return {
      text: segment.text.slice(0, chosen.start) + changed + segment.text.slice(end),
      kept: false,
    };
  });
}

function apply(
  kind: TransformKind,
  segments: readonly Segment[],
  context: TransformContext,
): Segment[] {
  const each = (change: (text: string) => string): Segment[] =>
    segments.map((segment) =>
      segment.kept ? segment : { ...segment, text: change(segment.text) },
    );
  switch (kind) {
    case 'no-diacritics': {
      return each((text) => context.lang.removeDiacritics(text));
    }
    case 'lowercase': {
      return each((text) => context.lang.lowerCase(text));
    }
    case 'no-punctuation': {
      return each(withoutPunctuation);
    }
    case 'typos': {
      return withTypo(segments, context.seed);
    }
  }
}

const joined = (segments: readonly Segment[]): string => segments.map((s) => s.text).join('');

/**
 * The message as the transforms change it, in the order of TRANSFORM_KINDS.
 * Words that hold a digit, "@" or "/", money amounts with their currency,
 * and the values in `keep`, stay as written.
 */
export function transformMessage(
  message: string,
  kinds: readonly TransformKind[],
  context: TransformContext,
): TransformedMessage {
  let segments = segmentsOf(message, context);
  const changedBy: TransformKind[] = [];
  for (const kind of TRANSFORM_KINDS) {
    if (!kinds.includes(kind)) continue;
    const before = joined(segments);
    segments = apply(kind, segments, context);
    if (joined(segments) !== before) changedBy.push(kind);
  }
  return { text: joined(segments), changedBy };
}

/** The strings of a list; nothing for anything else. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * The text a turn's expectations quote, which a transform leaves as written:
 * the values of `notSentToModel`, and the phrases of `answer.contains` and
 * `answer.notContains`.
 */
export function quotedValues(expect: Readonly<Record<string, unknown>> | undefined): string[] {
  const answer = expect?.['answer'];
  const phrases =
    typeof answer === 'object' && answer !== null && !Array.isArray(answer)
      ? Object.entries(answer).flatMap(([key, value]) =>
          key === 'contains' || key === 'notContains' ? strings(value) : [],
        )
      : [];
  return [...strings(expect?.['notSentToModel']), ...phrases];
}
