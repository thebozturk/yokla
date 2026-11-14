// The defect switchboard (design §19). One defect per process, chosen at start.
// Each defect is added in the yokla version whose checks detect it.

export const DEFECTS = [
  'fabricated-price',
  'unknown-stock-claim',
  'invented-return-policy',
  'filter-ignored',
  'over-refusal',
  'duplicate-products',
  'absence-substitution',
  'type-padding',
  'no-model-fallback',
  'no-model-timeout',
  'unchecked-model-output',
  'products-in-system',
  'prompt-bloat',
  'unmasked-pii',
  'no-leak-guard',
  'unrequested-cart',
  'repeated-search',
  'unfilled-template',
  'missing-contract-field',
  'internal-ids',
  'stale-price-in-prompt',
  'price-rewritten',
  'flaky-price',
] as const;

export type Defect = (typeof DEFECTS)[number];

export const DEFECT_DESCRIPTIONS: Readonly<Record<Defect, string>> = {
  'fabricated-price': 'the first listed product is shown 10% cheaper than its catalog price',
  'unknown-stock-claim': 'products with unknown stock are said to be in stock',
  'invented-return-policy': 'return questions get a 30-day free-return policy instead of the FAQ',
  'filter-ignored':
    'requested filters are dropped silently, while the answer says they were applied',
  'over-refusal': 'answerable camping-stove questions are refused',
  'duplicate-products': 'the first product appears twice in the result',
  'absence-substitution': 'when a product type is absent, another type is presented as that type',
  'type-padding':
    'a short result is filled up with other types that satisfy the filters, presented as the requested type',
  'no-model-fallback':
    'with the model over HTTP, a model failure becomes a 500 instead of a fallback answer',
  'no-model-timeout':
    'with the model over HTTP, a stalled model stalls the answer: there is no model timeout',
  'unchecked-model-output':
    'with the model over HTTP, empty model output reaches the user as the answer',
  'products-in-system':
    'with the model over HTTP, the products found are put into the system message',
  'prompt-bloat': 'with the model over HTTP, the whole catalog goes with every answer to write',
  'unmasked-pii':
    "phone numbers and e-mail addresses in the user's message reach the model unmasked",
  'no-leak-guard':
    'with the model over HTTP, an answer that repeats the system prompt reaches the user',
  'unrequested-cart':
    'with the model over HTTP, the writer is told to add the first product shown to the cart, and the app does it without the user asking',
  'repeated-search':
    'with the model over HTTP, the app asks the model for the same product search twice in one turn',
  'unfilled-template': 'the greeting keeps the placeholder {{customer_name}} of its template',
  'missing-contract-field': "the response's metadata leaves out the answer's language",
  'internal-ids': 'each product the answer names is followed by its internal catalog id',
  'stale-price-in-prompt':
    'with the model over HTTP, the writer is given the first product at a price 10% above the catalog price',
  'price-rewritten':
    'with the model over HTTP, the app shows the first product 10% cheaper than the price the model wrote',
  'flaky-price':
    'every other answer that shows products shows the first one 10% cheaper than its catalog price',
};

/** Parses a defect name. Empty, undefined and "none" mean no defect. */
export function parseDefect(value: string | undefined): Defect | null {
  if (value === undefined || value === '' || value === 'none') return null;
  const defect = DEFECTS.find((name) => name === value);
  if (defect === undefined) {
    throw new Error(`unknown defect "${value}"; expected one of: none, ${DEFECTS.join(', ')}`);
  }
  return defect;
}
