// Assembles the profile and case schemas from the loaded packs (design §17).

import { z } from 'zod';
import { caseShape, coreExpectations } from './cases.ts';
import { profileShape } from './profile.ts';

/** What a domain pack contributes to the config schemas. */
export interface DomainPackSchemas {
  readonly id: string;
  /** The pack's profile section, under a key equal to the pack id. */
  readonly profile?: z.ZodType;
  /** Keys the pack owns in a turn's `expect`. */
  readonly expectations?: Readonly<Record<string, z.ZodType>>;
}

export interface SchemaOptions {
  /** Language codes of the loaded language packs. */
  readonly languages: readonly [string, ...string[]];
  readonly domainPacks: readonly DomainPackSchemas[];
}

export function buildSchemas(options: SchemaOptions) {
  const [firstPack, ...otherPacks] = options.domainPacks;
  if (firstPack === undefined) throw new Error('at least one domain pack is required');

  const expectations: Record<string, z.ZodType> = Object.fromEntries(
    Object.entries(coreExpectations).map(([key, schema]) => [key, schema.optional()]),
  );
  const sections: Record<string, z.ZodType> = {};
  const seen = new Set<string>();
  for (const pack of options.domainPacks) {
    if (seen.has(pack.id)) throw new Error(`domain pack "${pack.id}" is loaded twice`);
    seen.add(pack.id);
    if (pack.id in profileShape)
      throw new Error(`domain pack id "${pack.id}" clashes with a profile field`);
    if (pack.profile !== undefined) sections[pack.id] = pack.profile.optional();
    for (const [key, schema] of Object.entries(pack.expectations ?? {})) {
      if (key in coreExpectations)
        throw new Error(
          `expectation "${key}" of pack "${pack.id}" clashes with a core expectation`,
        );
      if (key in expectations)
        throw new Error(`expectation "${key}" is defined by two domain packs`);
      expectations[key] = schema.optional();
    }
  }

  const language = z.enum(options.languages);
  const profile = z
    .strictObject({
      ...profileShape,
      languages: z.array(language).min(1),
      domain: z.enum([firstPack.id, ...otherPacks.map((pack) => pack.id)]),
      refusal: z
        .strictObject({
          canonical: z.partialRecord(language, z.array(z.string().min(1)).min(1)).optional(),
        })
        .optional(),
      ...sections,
    })
    .meta({ title: 'yokla profile v1' });

  const caseFile = z
    .strictObject({
      version: z.literal(1),
      cases: z.array(z.strictObject(caseShape(language, z.strictObject(expectations)))).min(1),
    })
    .meta({ title: 'yokla cases v1' });

  return { profile, caseFile };
}
