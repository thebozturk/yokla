// Quantities stated in a text (ADR-0021): integers from 2 to 99, in digits or
// as the language pack's number words. The numbers inside the text's money
// amounts and durations aren't quantities, nor is a number followed by % or °.
// Pure.

import type { LanguagePack } from '../checks/types.ts';

export interface QuantityMention {
  readonly value: number;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

// A decimal point or thousands separator joins digits on both sides; a full stop ends a sentence.
const DIGITS = /(?<![\p{N}]|\p{N}[.,])\d{1,2}(?![\p{N}]|[.,]\p{N}|\s?[%°])/gu;
const WORD = /\p{L}+/gu;

export function findQuantities(text: string, lang: LanguagePack): QuantityMention[] {
  const taken = [...lang.findMoney(text), ...lang.findDurations(text)];
  const free = (start: number, end: number) =>
    !taken.some((mention) => start < mention.end && end > mention.start);
  const found: QuantityMention[] = [];
  for (const match of text.matchAll(DIGITS)) {
    const value = Number(match[0]);
    const start = match.index;
    const end = start + match[0].length;
    // Two digits at most, so 99 at most.
    if (value >= 2 && free(start, end)) {
      found.push({ value, raw: match[0], start, end });
    }
  }
  for (const match of text.matchAll(WORD)) {
    const value = lang.numberWords[lang.fold(match[0])];
    const start = match.index;
    const end = start + match[0].length;
    if (value !== undefined && free(start, end)) found.push({ value, raw: match[0], start, end });
  }
  return found.toSorted((a, b) => a.start - b.start);
}
