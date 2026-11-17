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
