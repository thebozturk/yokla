// Turkish text handling: folding, money and durations.

import type { DurationMention, MoneyMention } from '@yokla/core';

/** Turkish lower-casing (I → ı, İ → i), then no dotless ı and no diacritics. */
export function fold(text: string): string {
  return text
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .replaceAll('’', "'")
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '');
}

// Thousands groups with an optional decimal comma (1.299,90); a decimal dot
// with one or two digits (1299.90); or plain digits with an optional decimal
// comma (1299 or 899,50).
const NUMBER = String.raw`(?<num>\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+\.\d{1,2}|\d+(?:,\d{1,2})?)(?![\d])`;
const CODE = String.raw`(?:TL|TRY|USD|EUR|GBP)(?:['’]\p{L}+)?(?![\p{L}\p{N}])`;
const WORD = String.raw`(?:lira|dolar|euro|avro|sterlin)\p{L}*`;
const SYMBOL = '[₺$€£]';

const AFTER = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])${NUMBER}\s?(?<cur>${CODE}|${WORD}|${SYMBOL})`,
  'giu',
);
const BEFORE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?<cur>(?:TL|TRY|USD|EUR|GBP)(?![\p{L}])|${SYMBOL})\s?${NUMBER}(?![.,]\d)`,
  'giu',
);

function currencyOf(marker: string): string {
  const folded = fold(marker);
  if (
    folded.startsWith('tl') ||
    folded.startsWith('try') ||
    folded === '₺' ||
    folded.startsWith('lira')
  ) {
    return 'TRY';
  }
  if (folded.startsWith('usd') || folded === '$' || folded.startsWith('dolar')) return 'USD';
  if (folded.startsWith('eur') || folded === '€' || folded.startsWith('avro')) return 'EUR';
  return 'GBP';
}

function amountOf(raw: string): number {
  if (/^\d+\.\d{1,2}$/u.test(raw)) return Number(raw);
  return Number(raw.replaceAll('.', '').replace(',', '.'));
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
        amount: amountOf(num),
        currency: currencyOf(cur),
        raw: match[0],
        start,
        end,
      });
    }
  }
  return mentions.toSorted((a, b) => a.start - b.start);
}

export function formatMoney(amount: number, currency: string): string {
  const [whole = '0', fraction = '00'] = amount.toFixed(2).split('.');
  const grouped = whole.replaceAll(/\B(?=(\d{3})+(?!\d))/gu, '.');
  return currency === 'TRY' ? `${grouped},${fraction} TL` : `${grouped},${fraction} ${currency}`;
}

const UNITS: Readonly<Record<string, DurationMention['unit']>> = {
  gun: 'day',
  hafta: 'week',
  ay: 'month',
  yil: 'year',
  sene: 'year',
};
// Suffixes a duration word can take: "14 günlük", "30 günde", "2 yıldır".
const SUFFIX =
  /^(?:|l[iu]k|l[iu]g[iu]|d[ae]n?|t[ae]n?|d[iu]r|t[iu]r|[iu]|y[iu]|[ae]|n[iu]n|s[iu]|ler|lar|l[ae]r[iu])$/u;
const DURATION =
  /(?<![\p{L}\p{N}])(?<num>\d+)\s?(?<unit>gün|gun|hafta|ay|yıl|yil|sene)(?<suffix>\p{L}*)/giu;

export function findDurations(text: string): DurationMention[] {
  const mentions: DurationMention[] = [];
  for (const match of text.matchAll(DURATION)) {
    const unit = UNITS[fold(match.groups?.['unit'] ?? '')];
    const suffix = fold(match.groups?.['suffix'] ?? '');
    if (unit === undefined || !SUFFIX.test(suffix)) continue;
    mentions.push({
      amount: Number(match.groups?.['num']),
      unit,
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return mentions;
}
