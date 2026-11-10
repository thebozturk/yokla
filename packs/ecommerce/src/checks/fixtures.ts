// Test fixtures for the ecommerce checks. The real language packs can't be
// imported here (packs depend only on core), so these small stand-ins read
// the money formats the tests use. The CLI's acceptance test runs the checks
// with the real language packs.

import type { EvidenceItem, LanguagePack, TurnView } from '@yokla/core';
import { stubLanguagePack, turnView } from '@yokla/core/testing';
import type { EcommerceData } from '../data.ts';
import { ecommerceProfile } from '../schema.ts';

const foldTr = (text: string) =>
  text.toLocaleLowerCase('tr-TR').replaceAll('ı', 'i').normalize('NFD').replaceAll(/\p{M}/gu, '');

export const fakeTurkish: LanguagePack = {
  ...stubLanguagePack('tr'),
  fold: foldTr,
  findMoney: (text) =>
    [...text.matchAll(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?) ?TL/gu)].map((m) => ({
      amount: Number((m[1] ?? '').replaceAll('.', '').replace(',', '.')),
      currency: 'TRY',
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
};

export const fakeEnglish: LanguagePack = {
  ...stubLanguagePack('en'),
  fold: (text) => text.toLowerCase(),
  findMoney: (text) =>
    [...text.matchAll(/(TRY |\$)(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/gu)].map((m) => ({
      amount: Number((m[2] ?? '').replaceAll(',', '')),
      currency: m[1] === '$' ? 'USD' : 'TRY',
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
};

export function data(change: Partial<EcommerceData> = {}): EcommerceData {
  return { config: ecommerceProfile.parse({}), catalog: undefined, policies: new Map(), ...change };
}

export function answer(text: string, products: EvidenceItem[] = [], user = 'soru'): TurnView {
  return turnView({ user, response: { text, evidence: { products } } });
}
