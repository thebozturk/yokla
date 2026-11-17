// The case file yokla generate writes (ADR-0055): each generated case as a
// proposed case, with provenance `generator` whose evidence names the data
// its expectations came from. Nothing gates until a person approves it.

import { Document } from 'yaml';
import type { Generated, GeneratedCase } from '../checks/types.ts';

/** Text as an id's characters: lower case without diacritics, runs of anything else as one "-". */
function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll('ı', 'i')
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
}

/** A generated case's id: its kind, its language and its key. */
export function generatedId(generated: GeneratedCase): string {
  return [generated.kind, generated.language, generated.key]
    .map(slug)
    .filter((part) => part !== '')
    .join('-');
}

/** The generated cases as a case file, in the pack's order, each id once. */
export function generatedCaseYaml(generated: Generated): string {
  const taken = new Map<string, number>();
  const cases = generated.cases.map((c) => {
    const base = generatedId(c);
    const seen = (taken.get(base) ?? 0) + 1;
    taken.set(base, seen);
    return {
      id: seen === 1 ? base : `${base}-${String(seen)}`,
      suite: 'factual',
      language: c.language,
      tags: ['generated', c.kind],
      turns: c.turns,
      provenance: {
        source: 'generator',
        evidence: `yokla generate, ${c.kind}: ${c.basis}`,
        status: 'proposed',
      },
    };
  });
  const doc = new Document({ version: 1, cases }, { aliasDuplicateObjects: false });
  doc.commentBefore = [
    ' Written by yokla generate (ADR-0055): cases whose expectations the domain pack',
    " computed from the profile's data, before anything was sent. They run, but gate",
    ' only once a person reads them and sets their status to approved (ADR-0004).',
    ' See docs/guide/cli.md.',
  ].join('\n');
  return doc.toString({ lineWidth: 100 });
}
