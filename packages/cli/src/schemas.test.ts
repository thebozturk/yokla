import { readFileSync } from 'node:fs';
import { formatIssue, parseConfig, type z } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { jsonSchemas, schemas } from './schemas.ts';

describe('JSON Schema files', () => {
  // Regenerate with: pnpm test -u
  it.each(Object.entries(jsonSchemas()))('%s matches the committed file', async (name, schema) => {
    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(`../schemas/${name}`);
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../../../examples/demo-shop/${path}`, import.meta.url), 'utf8');
}

function parse<T>(path: string, schema: z.ZodType<T>): T {
  const result = parseConfig(read(path), path, schema);
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
  return result.value;
}

describe('the demo-shop config', () => {
  const profile = parse('yokla.profile.yaml', schemas.profile);
  const cases = parse('cases/acceptance.yaml', schemas.caseFile).cases;

  it('has a valid profile', () => {
    expect(profile.target.name).toBe('demo-shop');
    expect(Object.keys(profile.target.response.evidence ?? {})).toEqual(['products']);
  });

  it('has valid cases with unique ids in the profile languages', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) expect(profile.languages, c.id).toContain(c.language);
  });
});
