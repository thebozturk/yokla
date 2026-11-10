// English text handling: folding, money and durations.

import type { DurationMention, MoneyMention } from '@yokla/core';

export function fold(text: string): string {
  return text.toLowerCase().replaceAll('’', "'").normalize('NFD').replaceAll(/\p{M}/gu, '');
}

// Thousands groups with an optional decimal dot (1,299.90), or plain digits
// with an optional decimal dot (1299 or 899.50).
const NUMBER = String.raw`(?<num>\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d])`;
const CODE = String.raw`(?:TRY|TL|USD|EUR|GBP)(?![\p{L}\p{N}])`;
const WORD = String.raw`(?:lira|dollars?|euros?|pounds?)(?![\p{L}])`;
const SYMBOL = '[₺$€£]';

const AFTER = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])${NUMBER}\s?(?<cur>${CODE}|${WORD}|${SYMBOL})`,
  'giu',
);
const BEFORE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?<cur>(?:TRY|TL|USD|EUR|GBP)(?![\p{L}])|${SYMBOL})\s?${NUMBER}(?![.,]\d)`,
  'giu',
);

function currencyOf(marker: string): string {
  const folded = fold(marker);
  if (folded === 'try' || folded === 'tl' || folded === '₺' || folded === 'lira') return 'TRY';
  if (folded === 'usd' || folded === '$' || folded.startsWith('dollar')) return 'USD';
  if (folded === 'eur' || folded === '€' || folded.startsWith('euro')) return 'EUR';
  return 'GBP';
}

export function findMoney(text: string): MoneyMention[] {
  const mentions: MoneyMention[] = [];
  for (const pattern of [AFTER, BEFORE]) {
    for (const match of text.matchAll(pattern)) {
      const num = match.groups?.['num'];
      const cur = match.groups?.['cur'];
      if (num === undefined || cur === undefined) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (mentions.some((m) => start < m.end && m.start < end)) continue;
      mentions.push({
        amount: Number(num.replaceAll(',', '')),
        currency: currencyOf(cur),
        raw: match[0],
        start,
        end,
      });
    }
  }
  return mentions.toSorted((a, b) => a.start - b.start);
}

const SYMBOLS: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£' };

export function formatMoney(amount: number, currency: string): string {
  const [whole = '0', fraction = '00'] = amount.toFixed(2).split('.');
  const grouped = whole.replaceAll(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const symbol = SYMBOLS[currency];
  return symbol === undefined
    ? `${currency} ${grouped}.${fraction}`
    : `${symbol}${grouped}.${fraction}`;
}

const DURATION =
  /(?<![\p{L}\p{N}])(?<num>\d+)[\s-]?(?<unit>days?|weeks?|months?|years?)(?![\p{L}])/giu;

export function findDurations(text: string): DurationMention[] {
  return [...text.matchAll(DURATION)].map((match) => {
    const unit = fold(match.groups?.['unit'] ?? 'day').replace(/s$/u, '');
    return {
      amount: Number(match.groups?.['num']),
      unit: unit === 'week' || unit === 'month' || unit === 'year' ? unit : 'day',
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    };
  });
}
