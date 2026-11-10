// The config and results schemas for the first-party packs, and their JSON
// Schema files in packages/cli/schemas/ (ADR-0006).

import { buildSchemas, Results, z } from '@yokla/core';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from './packs.ts';

const [firstLanguage, ...otherLanguages] = LANGUAGE_PACKS.map((pack) => pack.language);
if (firstLanguage === undefined) throw new Error('no language pack is loaded');

export const schemas = buildSchemas({
  languages: [firstLanguage, ...otherLanguages],
  domainPacks: DOMAIN_PACKS,
});

/** JSON Schema documents by file name. Config schemas describe what people write. */
export function jsonSchemas(): Record<string, unknown> {
  const options = { target: 'draft-2020-12' } as const;
  return {
    'profile.v1.schema.json': z.toJSONSchema(schemas.profile, { ...options, io: 'input' }),
    'cases.v1.schema.json': z.toJSONSchema(schemas.caseFile, { ...options, io: 'input' }),
    'results.v1.schema.json': z.toJSONSchema(Results, { ...options, io: 'output' }),
  };
}
