// What the ecommerce pack adds to the profile and to case expectations.

import { FieldPath, Id, Provenance, z, type DomainPackSchemas } from '@yokla/core';

export const FACT_KINDS = [
  'price',
  'stock',
  'discount',
  'shipping',
  'returns',
  'warranty',
] as const;

const Policy = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('none') }).meta({
    description: 'No source: any concrete claim about this policy is a finding.',
  }),
  z
    .strictObject({
      source: z.literal('faq'),
      path: z.string().min(1).meta({ description: 'JSON Lines file, relative to the profile.' }),
      topic: Id.optional().meta({
        description: 'The FAQ topic to read; defaults to the policy key.',
      }),
    })
    .meta({ description: 'FAQ rows carry topic, lang and answer.' }),
  z.strictObject({ source: z.literal('text'), text: z.string().min(1) }),
]);

const Catalog = z.strictObject({
  kind: z.literal('file'),
  path: z.string().min(1).meta({ description: 'JSON Lines file, relative to the profile.' }),
  fields: z.strictObject({
    id: FieldPath,
    type: FieldPath,
    price: FieldPath,
    currency: FieldPath.optional(),
    stock: FieldPath.optional().meta({ description: 'null in the data means unknown, not zero.' }),
  }),
});

const Campaign = z.strictObject({
  id: Id,
  amount: z.number().nonnegative(),
  currency: z.string().min(1),
  provenance: Provenance.optional(),
});

export const ecommerceProfile = z.strictObject({
  neverFabricate: z.array(z.enum(FACT_KINDS)).default([...FACT_KINDS]),
  policies: z.record(Id, Policy).default({}),
  catalog: Catalog.optional(),
  typeSeparator: z.string().min(1).optional().meta({
    description:
      'Separates the levels of a product type, e.g. "/" in "outdoor/camping/tent". Without it, types match only exactly.',
  }),
  campaigns: z
    .array(Campaign)
    .default([])
    .meta({ description: 'Amounts an answer may show besides product prices (design §10).' }),
});
export type EcommerceProfile = z.output<typeof ecommerceProfile>;

export const ecommerceExpectations = {
  filters: z
    .strictObject({
      maxPrice: z.number().nonnegative().optional(),
      minPrice: z.number().nonnegative().optional(),
      attributes: z
        .record(Id, z.string().min(1))
        .optional()
        .meta({ description: 'Evidence field name → required value.' }),
    })
    .meta({ description: 'The filters the user asked for.' }),
  productType: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).meta({
    description:
      'The product type(s) the user asked for, as catalog types. A product of a type under one of them (by typeSeparator) matches.',
  }),
  absentType: z
    .string()
    .min(1)
    .meta({ description: 'The requested product type is absent from the catalog.' }),
  answerable: z
    .boolean()
    .meta({ description: 'The request is answerable; a refusal is over-refusal.' }),
  policyTopic: Id.meta({ description: 'The turn asks about this policy.' }),
};

export const ecommerceSchemas: DomainPackSchemas = {
  id: 'ecommerce',
  profile: ecommerceProfile,
  expectations: ecommerceExpectations,
};
