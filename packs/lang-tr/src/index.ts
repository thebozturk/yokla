// The Turkish language pack (design §17). Phrases are folded (see fold) and
// match at the start of a word; a trailing "$" requires the word to end there.

import type { LanguagePack } from '@yokla/core';
import { findDurations, findMoney, fold, formatMoney } from './text.ts';

export const turkish: LanguagePack = {
  language: 'tr',
  fold,
  findMoney,
  findDurations,
  formatMoney,
  phrases: {
    refusal: [
      'yardimci olamiyorum',
      'yardimci olamam',
      'yardimci olamayacagim',
      'yanit veremiyorum',
      'cevap veremiyorum',
      'bu konuda bilgi veremiyorum',
      'bunu yapamam',
      'oneri sunamiyorum',
      'oneride bulunamiyorum',
    ],
    inability: [
      'dogrulayamiyorum',
      'dogrulanamadi',
      'teyit edemiyorum',
      'emin degilim',
      'bilgim yok$',
      'bilmiyorum',
      'bilemiyorum',
    ],
    absence: [
      'bulunmuyor',
      'bulunmamaktadir',
      'bulamadim',
      'bulunamadi',
      'mevcut degil',
      'yok$',
      'yoktur',
      'satmiyoruz',
      'kalmadi',
    ],
    alternative: ['bunun yerine', 'onun yerine', 'alternatif', 'farkli bir urun', 'benzer'],
    free: ['ucretsiz', 'bedava', 'ucret alinmaz', 'ucret odemeden'],
    deflection: [
      'musteri hizmetlerimize',
      'musteri hizmetlerine',
      'canli destek',
      'yardim merkezi',
      'destek ekibimize',
      'cagri merkezi',
    ],
  },
};

export { findDurations, findMoney, fold, formatMoney } from './text.ts';
