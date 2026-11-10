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
