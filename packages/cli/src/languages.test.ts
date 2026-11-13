// language-match with the shipped language packs (ADR-0018): the two common
// word lists are disjoint, and real answers in each language are told apart
// in both directions. Only the CLI depends on both packs, so the test is here.

import { languageMatch, type LanguagePack } from '@yokla/core';
import { checkContext, turnView } from '@yokla/core/testing';
import { english } from '@yokla/pack-lang-en';
import { turkish } from '@yokla/pack-lang-tr';
import { describe, expect, it } from 'vitest';

const LANGUAGES = new Map<string, LanguagePack>([
  ['tr', turkish],
  ['en', english],
]);

function verdict(text: string, language: 'tr' | 'en'): string {
  const outcome = languageMatch.run(
    checkContext(turnView({ expect: { language }, response: { text } }), {
      languages: LANGUAGES,
    }),
  );
  if (!outcome.applicable) return `n/a: ${outcome.reason}`;
  return outcome.findings[0]?.verdict ?? 'unmeasured';
}

const TURKISH = [
  'Merhaba! Size nasıl yardımcı olabilirim? Ürünler, siparişler ve iade hakkında soru sorabilirsiniz.',
  'Bu çadır dört kişilik ve kurulumu çok kolay, ama stok durumu şu an doğrulanamadı.',
  'Açılmış elektronik ürünleri teslimattan sonra 15 gün içinde iade edebilirsiniz.',
  'Yatırım tavsiyesi veremiyorum, ama size uygun bir ürün bulmanıza yardımcı olabilirim.',
];
const ENGLISH = [
  'Hello! I can help you find products, check an order or answer questions about returns.',
  "I found one that fits: the travel adapter with 65W charging. It works in more than 150 countries and it's in stock.",
  'Opened electronics can be returned within 15 days of delivery, and the item must be in its original condition.',
  "I can't recommend stocks or other investments, since that's financial advice and outside what I can help with.",
];

describe('the common word lists', () => {
  it('share no word, so a word counts for one language only', () => {
    const shared = turkish.commonWords.filter((word) => english.commonWords.includes(word));
    expect(shared).toEqual([]);
  });
});

describe('language-match with the shipped packs', () => {
  it.each(TURKISH)('passes Turkish as tr and fails it as en: %s', (text) => {
    expect(verdict(text, 'tr')).toBe('pass');
    expect(verdict(text, 'en')).toBe('fail');
  });

  it.each(ENGLISH)('passes English as en and fails it as tr: %s', (text) => {
    expect(verdict(text, 'en')).toBe('pass');
    expect(verdict(text, 'tr')).toBe('fail');
  });

  it('leaves a product list without sentences unmeasured', () => {
    expect(verdict('Plaj Çadırı: 899,50 TL. Kubbe Çadır: 2.499,90 TL.', 'tr')).toBe('unmeasured');
  });
});
