import { z } from 'zod';

/** Identifiers: lowercase letters and digits, separated by "-" or ".". */
export const ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/u;
export const Id = z.string().regex(ID_PATTERN, 'use lowercase letters, digits, "-" and "."');

/** Language codes: ISO 639-1, as provided by language packs. */
export const LanguageCode = z.string().regex(/^[a-z]{2}$/u, 'use a two-letter language code');

/**
 * The JSONPath subset yokla evaluates: `$`, then any of `.name`, `['name']`,
 * `[n]` and `[*]`. Example: `$.data.products[*]`.
 */
export const JSON_PATH_PATTERN = /^\$(?:\.[A-Za-z_][\w-]*|\['[^'\\]*'\]|\[\d+\]|\[\*\])*$/u;
export const JsonPath = z
  .string()
  .regex(
    JSON_PATH_PATTERN,
    "use a JSONPath such as $.data.items[*] (subset: .name, ['name'], [n], [*])",
  );

/** A dotted path inside an item, such as `price.amount`. */
export const FIELD_PATH_PATTERN = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/u;
export const FieldPath = z
  .string()
  .regex(FIELD_PATH_PATTERN, 'use a dotted field path such as price.amount');

/** Names of evidence fields, such as `price` or `stock`. */
export const FieldName = z.string().regex(/^[a-z][A-Za-z0-9]*$/u, 'use a camelCase field name');

export const SUITES = [
  'quality',
  'factual',
  'redteam',
  'robustness',
  'perf',
  'resilience',
] as const;
export const Suite = z.enum(SUITES);
export type Suite = z.infer<typeof Suite>;

export const ReviewStatus = z.enum(['proposed', 'approved', 'rejected']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const MACHINE_SOURCES = [
  'doc',
  'prompt',
  'contract',
  'data',
  'code',
  'probe',
  'import',
  // Written from yokla's own templates, such as yokla init's starter cases (ADR-0018).
  'template',
] as const;

/**
 * Where an entry's claim comes from (ADR-0004). An entry without provenance
 * was written by a person and counts as `source: human, status: approved`.
 * Any other source must state its evidence and status explicitly.
 */
export const Provenance = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('human'),
    evidence: z.string().min(1).optional(),
    status: ReviewStatus.default('approved'),
  }),
  z.strictObject({
    source: z.enum(MACHINE_SOURCES),
    evidence: z.string().min(1),
    status: ReviewStatus,
  }),
]);
export type Provenance = z.output<typeof Provenance>;

/** The review status of an entry, applying the default for entries without provenance. */
export function reviewStatus(entry: {
  readonly provenance?: Provenance | undefined;
}): ReviewStatus {
  return entry.provenance?.status ?? 'approved';
}
