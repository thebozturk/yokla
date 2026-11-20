// What the ecommerce pack adds to the profile and to case expectations.

import {
  FieldName,
  FieldPath,
  Id,
  JsonPath,
  LanguageCode,
  Provenance,
  z,
  type DomainPackSchemas,
} from '@yokla/core';

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
    inStock: FieldPath.optional().meta({
      description: 'Available or not, a boolean, for a catalog without quantities (ADR-0020).',
    }),
    name: z
      .union([FieldPath, z.record(LanguageCode, FieldPath)])
      .optional()
      .meta({
        description:
          "The product's name: one field, or one per language such as { tr: name_tr, en: name_en }. yokla explore asks for products by it (ADR-0044).",
      }),
    typeLabel: z
      .union([FieldPath, z.record(LanguageCode, FieldPath)])
      .optional()
      .meta({
        description:
          'The words a shopper uses for the product\'s type, such as "sleeping bag": one field, or one per language. yokla explore asks for a type by it, in place of its last level (ADR-0050).',
      }),
    attributes: z.record(Id, FieldPath).optional().meta({
      description:
        'The evidence field each attribute filter names, and the catalog field that holds it, such as { color: color }. yokla generate asks for products by them (ADR-0055).',
    }),
  }),
});

const Campaign = z.strictObject({
  id: Id,
  amount: z.number().nonnegative(),
  currency: z.string().min(1),
  provenance: Provenance.optional(),
});

/** A rule of the target's on who may buy what, and where (ADR-0082). */
const Restriction = z
  .strictObject({
    products: z.array(z.string().min(1)).min(1).optional().meta({
      description: 'The catalog ids it covers.',
    }),
    types: z.array(z.string().min(1)).min(1).optional().meta({
      description: 'The catalog types it covers, with the types under them.',
    }),
    minAge: z.int().min(1).max(120).optional().meta({ description: 'The youngest buyer.' }),
    notSoldIn: z
      .array(z.union([z.string().min(1), z.record(LanguageCode, z.string().min(1))]))
      .min(1)
      .optional()
      .meta({
        description:
          "Places the target doesn't sell or deliver it to, as a shopper writes them: one name, or one per language such as { tr: Almanya, en: Germany }.",
      }),
    source: z.string().min(1).meta({
      description: 'Where the rule is written, such as a policy page or a file.',
    }),
  })
  .refine((rule) => rule.products !== undefined || rule.types !== undefined, {
    message: 'a restriction needs products or types',
  })
  .refine((rule) => rule.minAge !== undefined || rule.notSoldIn !== undefined, {
    message: 'a restriction needs minAge or notSoldIn',
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
  restrictions: z.array(Restriction).default([]).meta({
    description:
      "Who may buy what, and where: the target's own rules, which yokla generate --redteam attacks (ADR-0082).",
  }),
  cartEvidence: Id.optional().meta({
    description:
      'The evidence collection that holds the cart, such as cart; a restricted product must not be in it (ADR-0082).',
  }),
  priceSources: z
    .array(
      z.union([
        z.strictObject({
          evidence: Id.meta({ description: 'An evidence collection of this or an earlier turn.' }),
          fields: z.array(FieldName).min(1).meta({ description: 'Its fields that hold amounts.' }),
        }),
        z.strictObject({
          file: z.string().min(1).meta({
            description: 'A data snapshot, relative to the profile: JSON, or JSON Lines (.jsonl).',
          }),
          paths: z.array(JsonPath).min(1).meta({ description: 'Where the amounts are in it.' }),
        }),
      ]),
    )
    .default([])
    .meta({
      description:
        "Further amounts an answer may quote, such as an order history's (ADR-0020). They ground amounts; they don't make price-grounded apply.",
    }),
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
  concession: z
    .strictObject({
      amount: z.number().positive().optional().meta({
        description: 'The price the user names; no sentence may accept it.',
      }),
    })
    .meta({
      description:
        'An attack asks the assistant to accept a price or to promise what no policy gives; the answer must not concede (ADR-0080).',
    }),
};

export const ecommerceSchemas: DomainPackSchemas = {
  id: 'ecommerce',
  profile: ecommerceProfile,
  expectations: ecommerceExpectations,
};
