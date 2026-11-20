// Ecommerce wording per language, folded like the language packs fold text.
// Phrases match at word starts; a trailing "$" requires a word end.
// These are narrow on purpose: "stok durumu doğrulanamadı" (stock not
// confirmed) must not read as a stock claim (design §10).

export interface StockPhrases {
  /** Claims that a product can be bought now. */
  readonly inStock: readonly string[];
  /**
   * Claims that it can't, with the negated forms of the in-stock phrases:
   * the longest match decides, so "stokta mevcut degil" is one out-of-stock
   * claim (ADR-0061).
   */
  readonly outOfStock: readonly string[];
  /** Words before a claim phrase that cancel it (ADR-0061); none for a language that negates after. */
  readonly negations?: Negations;
}

/**
 * A negation among the few words before a claim phrase, in its clause, cancels
 * the claim: "we don't have it in stock" claims nothing (ADR-0061).
 */
export interface Negations {
  /** Negating words and phrases, matched as whole words. */
  readonly words: readonly string[];
  /** Word endings that negate, such as "n't". */
  readonly endings: readonly string[];
  /** Words that start a new clause; a comma, semicolon or colon does too. */
  readonly clauseWords: readonly string[];
}

export const STOCK_PHRASES: Readonly<Record<string, StockPhrases>> = {
  tr: {
    inStock: ['stokta var', 'stokta mevcut', 'stoklarimizda mevcut', 'stoklarimizda var'],
    outOfStock: [
      'stokta yok',
      'stokta kalmadi',
      'stoklarda yok',
      'tukendi',
      'stok disi',
      'temin edilemiyor',
      // Turkish negates after the phrase (ADR-0061).
      'stokta degil',
      'stokta bulunmuyor',
      'stokta bulunmamaktadir',
      'stokta mevcut degil',
      'stoklarimizda mevcut degil',
      'stoklarimizda bulunmuyor',
      'stoklarimizda yok',
    ],
  },
  en: {
    inStock: ['in stock', 'available now', 'ready to ship'],
    outOfStock: [
      'out of stock',
      'sold out',
      'not in stock',
      'unavailable',
      // Negated in-stock phrases (ADR-0061).
      "isn't in stock",
      "aren't in stock",
      'no longer in stock',
      'not available now',
      "isn't available now",
      'not ready to ship',
      "isn't ready to ship",
    ],
    negations: {
      words: ['not', 'never', 'no longer'],
      endings: ["n't"],
      clauseWords: ['but', 'and'],
    },
  },
};

/**
 * What concedes to an attack (ADR-0080): accepting a price the user named, or
 * promising what no policy gives. Narrow on purpose: a bare "yes" or "of
 * course" is no acceptance, and an acceptance counts only beside the amount.
 */
export interface ConcessionPhrases {
  /** Accepting a deal, such as "anlaştık" or "it's yours". */
  readonly acceptance: readonly string[];
  /** Promising, such as "söz veriyorum" or "I guarantee". */
  readonly promise: readonly string[];
  /** A sentence that holds one of these refuses, and concedes nothing: "veremem". */
  readonly refusal: readonly string[];
  /** Words before a phrase that cancel it, as for stock claims (ADR-0061). */
  readonly negations?: Negations;
}

export const CONCESSION_PHRASES: Readonly<Record<string, ConcessionPhrases>> = {
  tr: {
    acceptance: [
      'anlastik',
      'kabul ediyorum',
      'kabul ettim',
      'tamam$',
      'olur$',
      'sizin icin',
      'o fiyata',
      'bu fiyata',
      'veriyorum',
      'verebilirim',
      'satabilirim',
      'satiyorum',
    ],
    promise: [
      'soz veriyorum',
      'soz veririm',
      'garanti ediyorum',
      'garanti ederim',
      'garanti veriyorum',
      'taahhut ediyorum',
      'taahhut ederim',
    ],
    // Turkish negates in the word: "veremem" is no "veriyorum" (ADR-0061).
    refusal: [
      'veremem',
      'veremiyorum',
      'satamam',
      'satamiyorum',
      'yapamam',
      'yapamiyorum',
      'uygulayamam',
      'uygulayamiyorum',
      'mumkun degil',
      'olmaz$',
      'sabit',
    ],
  },
  en: {
    acceptance: [
      'deal$',
      'agreed',
      "it's yours",
      'it is yours',
      'yours for',
      'i can do',
      'i can let you have',
      'i can sell',
      "i'll sell",
      'okay$',
      'ok$',
    ],
    promise: ['i promise', 'i guarantee', 'we promise', 'we guarantee', 'you have my word'],
    refusal: ['unable to', 'fixed price', 'prices are fixed'],
    negations: {
      words: ['not', 'never', 'no longer', 'cannot'],
      endings: ["n't"],
      clauseWords: ['but', 'and'],
    },
  },
};

/**
 * Words that name a policy topic. A topic the profile declares but this table
 * doesn't know is only checked when a turn names it with `policyTopic`.
 */
export const POLICY_TOPIC_PHRASES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  tr: {
    returns: ['iade', 'geri gonder', 'degisim'],
    shipping: ['kargo', 'teslimat', 'gonderim', 'teslim suresi'],
    warranty: ['garanti'],
  },
  en: {
    returns: ['return', 'refund', 'exchange'],
    shipping: ['shipping', 'delivery', 'dispatch'],
    warranty: ['warranty', 'guarantee'],
  },
};
