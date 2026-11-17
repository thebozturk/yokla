import { z } from 'zod';
import { schemaProblems } from '../jsonschema/jsonschema.ts';

/** Identifiers: lowercase letters and digits, separated by "-" or ".". */
export const ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/u;
export const Id = z.string().regex(ID_PATTERN, 'use lowercase letters, digits, "-" and "."');

/** Robustness transforms of a case's messages (ADR-0045), in the order they apply. */
export const TRANSFORM_KINDS = [
  // Written by models.transform before the run (ADR-0059); they apply first.
  'paraphrase',
  'code-switch',
  'no-diacritics',
  'lowercase',
  'no-punctuation',
  'typos',
] as const;
/** The transforms a model writes (ADR-0059). */
export const MODEL_TRANSFORMS = ['paraphrase', 'code-switch'] as const;
export type ModelTransform = (typeof MODEL_TRANSFORMS)[number];
export const TransformKind = z.enum(TRANSFORM_KINDS);
export type TransformKind = z.output<typeof TransformKind>;

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

/**
 * A regular expression (ADR-0030): its source, always with the `u` flag, or
 * with `i`, `m` or `s` added in the object form.
 */
export type PatternSpec =
  string | { readonly pattern: string; readonly flags?: string | undefined };

/** The pattern compiled; throws when it isn't a valid regular expression. */
export function compilePattern(spec: PatternSpec): RegExp {
  return typeof spec === 'string'
    ? new RegExp(spec, 'u')
    : new RegExp(spec.pattern, `u${spec.flags ?? ''}`);
}

/** How a pattern is shown in a message: /source/flags. */
export function showPattern(spec: PatternSpec): string {
  return typeof spec === 'string' ? `/${spec}/` : `/${spec.pattern}/${spec.flags ?? ''}`;
}

export const Pattern = z
  .union([
    z.string().min(1),
    z.strictObject({
      pattern: z.string().min(1),
      flags: z
        .string()
        .regex(/^(?!.*(.).*\1)[ims]+$/u, 'use any of i, m and s, each once')
        .optional(),
    }),
  ])
  .superRefine((spec, context) => {
    try {
      compilePattern(spec);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: `not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  })
  .meta({
    description:
      'A JavaScript regular expression, always with the u flag; the object form adds i, m or s (ADR-0030). It sees the answer as it came, not folded.',
  });

/**
 * A JSON Schema in the subset yokla checks (ADR-0030); any other keyword
 * refuses it, with where it is.
 */
export const JsonSchemaValue = z
  .union([z.boolean(), z.record(z.string(), z.json())])
  .superRefine((schema, context) => {
    for (const problem of schemaProblems(schema)) {
      context.addIssue({ code: 'custom', message: `the schema is refused: ${problem}` });
    }
  })
  .meta({
    description:
      'A JSON Schema, in the subset of draft 2020-12 yokla checks; anything else refuses it (ADR-0030).',
  });

/** What part of a response a schema holds, and the schema (ADR-0030). */
export const SchemaRule = z
  .strictObject({
    at: JsonPath.default('$').meta({
      description:
        'What is validated: every value this path selects in the response document, the JSON body or what a stream became. Selecting nothing fails.',
    }),
    schema: JsonSchemaValue.optional(),
    schemaFile: z.string().min(1).optional().meta({
      description: 'A JSON or YAML file holding the schema, relative to the file that names it.',
    }),
  })
  .refine((rule) => (rule.schema === undefined) !== (rule.schemaFile === undefined), {
    message: 'give the schema inline, as schema, or as schemaFile, not both',
  })
  .meta({ description: 'A JSON Schema the response, or a part of it, must match (ADR-0030).' });
export type SchemaRule = z.output<typeof SchemaRule>;

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
  // Cut down from a failing case by yokla shrink (ADR-0035).
  'shrink',
  // Found by yokla explore on a path no written case took (ADR-0044).
  'explore',
  // Generated from the domain pack's data by yokla generate (ADR-0055).
  'generator',
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
