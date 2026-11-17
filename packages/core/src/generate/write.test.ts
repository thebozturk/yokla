import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { GeneratedCase } from '../checks/types.ts';
import { buildSchemas } from '../schema/build.ts';
import { generatedCaseYaml, generatedId } from './write.ts';

const generated = (key: string, language = 'tr'): GeneratedCase => ({
  kind: 'lookup',
  language,
  key,
  turns: [{ user: `${key} var mı?`, expect: { evidence: { products: { includes: [key] } } } }],
  basis: `catalog ${key}`,
});

describe('the generated case file (ADR-0055)', () => {
  it('names a case by its kind, language and key, in the characters an id takes', () => {
    expect(generatedId(generated('TNT-001'))).toBe('lookup-tr-tnt-001');
    expect(generatedId(generated('Kamp Ocağı, Çift'))).toBe('lookup-tr-kamp-ocagi-cift');
    expect(generatedId(generated('çadır ılık'))).toBe('lookup-tr-cadir-ilik');
  });

  it('writes proposed cases with their basis, each id once, that load as cases', () => {
    const yaml = generatedCaseYaml({
      cases: [generated('A-1'), generated('a 1'), generated('A-1', 'en')],
      notes: [],
    });
    expect(yaml.startsWith('# Written by yokla generate (ADR-0055)')).toBe(true);
    const loaded = buildSchemas({
      languages: ['tr', 'en'],
      domainPacks: [{ id: 'shop' }],
    }).caseFile.parse(parse(yaml));
    expect(loaded.cases.map((c) => c.id)).toEqual([
      'lookup-tr-a-1',
      'lookup-tr-a-1-2',
      'lookup-en-a-1',
    ]);
    expect(loaded.cases[0]).toMatchObject({
      suite: 'factual',
      language: 'tr',
      tags: ['generated', 'lookup'],
      provenance: {
        source: 'generator',
        evidence: 'yokla generate, lookup: catalog A-1',
        status: 'proposed',
      },
    });
  });
});
