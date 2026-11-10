// The English language pack (design §17). Phrases are folded (see fold) and
// match at the start of a word; a trailing "$" requires the word to end there.

import type { LanguagePack } from '@yokla/core';
import { findDurations, findMoney, fold, formatMoney } from './text.ts';

export const english: LanguagePack = {
  language: 'en',
  fold,
  findMoney,
  findDurations,
  formatMoney,
  phrases: {
    refusal: [
      "i can't help",
      'i cannot help',
      "i'm unable to help",
      'i am unable to help',
      "i can't assist",
      'i cannot assist',
      "i won't be able to",
      "i'm not able to help",
      "i can't provide",
      "i'm sorry, but i can't",
    ],
    inability: [
      "i can't verify",
      'i cannot verify',
      "can't confirm",
      'cannot confirm',
      'unable to confirm',
      'unable to verify',
      'not confirmed',
      "i'm not sure",
      "i don't know",
    ],
    absence: [
      "don't carry",
      'do not carry',
      "don't have",
      'do not have',
      "couldn't find",
      'could not find',
      "don't sell",
      'do not sell',
      'no results',
      'not available',
    ],
    alternative: [
      'instead',
      'as an alternative',
      'alternatively',
      'similar',
      'as a different product',
    ],
    free: ['free of charge', 'free$', 'no charge', 'at no cost', 'without charge', 'complimentary'],
    deflection: [
      'contact customer service',
      'contact our customer service',
      'contact our support',
      'contact support',
      'customer support team',
      'help center',
      'live chat',
    ],
  },
};

export { findDurations, findMoney, fold, formatMoney } from './text.ts';
