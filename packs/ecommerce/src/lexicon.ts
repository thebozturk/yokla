// Ecommerce wording per language, folded like the language packs fold text.
// Phrases match at word starts; a trailing "$" requires a word end.
// These are narrow on purpose: "stok durumu doğrulanamadı" (stock not
// confirmed) must not read as a stock claim (design §10).

export interface StockPhrases {
  /** Claims that a product can be bought now. */
  readonly inStock: readonly string[];
  /** Claims that it can't. */
  readonly outOfStock: readonly string[];
}

export const STOCK_PHRASES: Readonly<Record<string, StockPhrases>> = {
  tr: {
    inStock: [
      'stokta var',
      'stokta mevcut',
      'stoklarimizda mevcut',
      'stoklarimizda var',
      'hemen teslim',
    ],
    outOfStock: [
      'stokta yok',
      'stokta kalmadi',
      'stoklarda yok',
      'tukendi',
      'stok disi',
      'temin edilemiyor',
    ],
  },
  en: {
    inStock: ['in stock', 'available now', 'ready to ship'],
    outOfStock: ['out of stock', 'sold out', 'not in stock', 'unavailable'],
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
