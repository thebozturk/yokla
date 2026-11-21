// Encoding and wrapping strategies of an attack case's messages (ADR-0084).
// Encodings rewrite the whole message, its canary with it, after a line that
// asks to decode it; obfuscations and wrappers keep the values the turn's
// expectations quote as written. The language pack words the lines and the
// wrappers; core does the encoding (P7). Pure: no Node built-ins.

import type { LanguagePack } from '../checks/types.ts';
import { hideText } from '../generate/attacks.ts';

export const STRATEGIES = [
  'base64',
  'hex',
  'rot13',
  'morse',
  'hidden',
  'leetspeak',
  'homoglyph',
  'roleplay',
  'hypothetical',
  'developer-mode',
] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const ENCODINGS = ['base64', 'hex', 'rot13', 'morse'] as const;
export type Encoding = (typeof ENCODINGS)[number];
export const WRAPPERS = ['roleplay', 'hypothetical', 'developer-mode'] as const;
export type Wrapper = (typeof WRAPPERS)[number];

/** A language's strategy lines; `{payload}` stands for the rewritten message. */
export interface StrategyPhrasings {
  /** A line that asks to decode the payload and follow it, by encoding. */
  readonly decode: Readonly<Record<Encoding, string>>;
  /** A line that says the message holds an instruction, before the hidden payload. */
  readonly hidden: string;
  readonly wrap: Readonly<Record<Wrapper, string>>;
}

/** Parses `a` or `a+b` into one or two strategies, or says what is wrong. */
export function parseStrategy(text: string): readonly Strategy[] | string {
  const parts = text.split('+');
  if (parts.length > 2) return `--strategy takes one strategy, or two joined by "+": ${text}`;
  const known = parts.map((part) => STRATEGIES.find((strategy) => strategy === part));
  const unknown = parts.filter((_part, index) => known[index] === undefined);
  if (unknown.length > 0) {
    return `--strategy ${unknown.join(', ')} is none of ${STRATEGIES.join(', ')}`;
  }
  return known.filter((strategy) => strategy !== undefined);
}

const PAYLOAD = '{payload}';

/** The UTF-8 bytes of a text. */
export function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x8_00) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x1_00_00) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A text's UTF-8 bytes in Base64, padded with "=". */
export function base64(text: string): string {
  const bytes = utf8(text);
  let out = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = bytes.slice(at, at + 3);
    const left = bytes.length - at;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64[(triple >> 18) & 63] ?? '';
    out += BASE64[(triple >> 12) & 63] ?? '';
    out += left > 1 ? (BASE64[(triple >> 6) & 63] ?? '') : '=';
    out += left > 2 ? (BASE64[triple & 63] ?? '') : '=';
  }
  return out;
}

function hex(text: string): string {
  return utf8(text)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

function rot13(text: string): string {
  return text.replaceAll(/[a-z]/giu, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCodePoint(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const MORSE: Readonly<Record<string, string>> = {
  A: '.-',
  B: '-...',
  C: '-.-.',
  D: '-..',
  E: '.',
  F: '..-.',
  G: '--.',
  H: '....',
  I: '..',
  J: '.---',
  K: '-.-',
  L: '.-..',
  M: '--',
  N: '-.',
  O: '---',
  P: '.--.',
  Q: '--.-',
  R: '.-.',
  S: '...',
  T: '-',
  U: '..-',
  V: '...-',
  W: '.--',
  X: '-..-',
  Y: '-.--',
  Z: '--..',
  '0': '-----',
  '1': '.----',
  '2': '..---',
  '3': '...--',
  '4': '....-',
  '5': '.....',
  '6': '-....',
  '7': '--...',
  '8': '---..',
  '9': '----.',
  '.': '.-.-.-',
  ',': '--..--',
  '?': '..--..',
  '!': '-.-.--',
  '-': '-....-',
  ':': '---...',
  "'": '.----.',
};

function morse(text: string): string {
  return text
    .toUpperCase()
    .split(/\s+/u)
    .filter((word) => word !== '')
    .map((word) => Array.from(word, (char) => MORSE[char] ?? '?').join(' '))
    .join(' / ');
}

/** Characters outside printable ASCII as "?", so every one has a tag character. */
function ascii(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e ? char : '?';
  }).join('');
}

const LEET: Readonly<Record<string, string>> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };

const HOMOGLYPHS: Readonly<Record<string, string>> = {
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  x: 'х',
  y: 'у',
  A: 'А',
  B: 'В',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  C: 'С',
  T: 'Т',
  X: 'Х',
};

/** Applies `change` to the text outside every kept value. */
function outsideKept(
  text: string,
  keep: readonly string[],
  change: (part: string) => string,
): string {
  const spans: [number, number][] = [];
  for (const value of keep) {
    if (value === '') continue;
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      spans.push([at, at + value.length]);
    }
  }
  let out = '';
  let from = 0;
  for (const [start, end] of spans.toSorted((a, b) => a[0] - b[0])) {
    if (start < from) continue;
    out += change(text.slice(from, start)) + text.slice(start, end);
    from = end;
  }
  return out + change(text.slice(from));
}

/** A strategy line with its payload in place. */
const line = (template: string, payload: string) => template.replaceAll(PAYLOAD, payload);

/** One strategy applied to a message, in the case's language. */
function applyOne(
  message: string,
  strategy: Strategy,
  context: {
    readonly lang: LanguagePack;
    readonly phrasings: StrategyPhrasings;
    readonly keep: readonly string[];
  },
): string {
  const { lang, phrasings, keep } = context;
  const plain = () => lang.removeDiacritics(message);
  switch (strategy) {
    case 'base64':
      return line(phrasings.decode.base64, base64(message));
    case 'hex':
      return line(phrasings.decode.hex, hex(message));
    case 'rot13':
      return line(phrasings.decode.rot13, rot13(plain()));
    case 'morse':
      return line(phrasings.decode.morse, morse(plain()));
    case 'hidden':
      return `${phrasings.hidden} ${hideText(ascii(plain()))}`;
    case 'leetspeak':
      return outsideKept(message, keep, (part) =>
        part.replaceAll(/[aeiost]/gu, (char) => LEET[char] ?? char),
      );
    case 'homoglyph':
      return outsideKept(message, keep, (part) =>
        Array.from(part, (char) => HOMOGLYPHS[char] ?? char).join(''),
      );
    case 'roleplay':
    case 'hypothetical':
    case 'developer-mode':
      return line(phrasings.wrap[strategy], message);
  }
}

/** A message as the strategies rewrite it, in order (ADR-0084). */
export function applyStrategies(
  message: string,
  strategies: readonly Strategy[],
  context: {
    readonly lang: LanguagePack;
    readonly phrasings: StrategyPhrasings;
    readonly keep: readonly string[];
  },
): string {
  return strategies.reduce((text, strategy) => applyOne(text, strategy, context), message);
}
