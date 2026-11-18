import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toJson } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { contractStep } from './contract.ts';
import type { InventoryFile } from './inventory.ts';

const ANSWER = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'string' } },
};

const openApi = (schema: unknown) =>
  JSON.stringify({
    openapi: '3.1.0',
    paths: {
      '/chat': {
        post: { responses: { '200': { content: { 'application/json': { schema } } } } },
      },
    },
  });

/** A repository of contract files, and the inventory that lists them. */
function repository(files: Readonly<Record<string, string>>): {
  dir: string;
  listed: InventoryFile[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-contract-'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  return {
    dir,
    listed: Object.keys(files).map((path) => ({ path, kind: 'contract', bytes: 1 })),
  };
}

const ANSWERS = [{ data: { answer: 'Merhaba' } }, { data: { answer: 'Çadırlar' } }];

const step = (files: Readonly<Record<string, string>>, answers: unknown[] = ANSWERS) => {
  const { dir, listed } = repository(files);
  return contractStep({
    dir,
    files: [...listed, { path: 'data.jsonl', kind: 'data', bytes: 1 }],
    request: { path: '/chat', method: 'POST' },
    textPath: '$.data.answer',
    evidencePaths: [],
    answers: answers.map((answer) => toJson(answer)),
  });
};

const envelope = { type: 'object', properties: { data: ANSWER } };

describe('the contract step (ADR-0057)', () => {
  it('proposes the first contract every answer keeps, an OpenAPI operation before a JSON Schema', () => {
    const result = step({
      'a.schema.json': JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...envelope,
      }),
      'z.openapi.json': openApi({ ...envelope, 'x-internal': true }),
    });
    expect(result.contracts).toEqual([
      {
        file: 'z.openapi.json',
        read: 'POST /chat 200 application/json',
        at: '$.data',
        outcome: 'proposed',
        details: ['left out: x-internal (1)'],
      },
    ]);
    expect(result.entry).toEqual({
      pointer: '/target/response/schema',
      value: { at: '$.data', schema: ANSWER },
      provenance: {
        source: 'contract',
        evidence: 'z.openapi.json: POST /chat 200 application/json',
        status: 'proposed',
      },
    });
  });

  it('names a contract the answers break by path and keyword, never a value, and goes on', () => {
    const strict = { ...envelope, properties: { data: { ...ANSWER, required: ['answer', 'id'] } } };
    const result = step({
      'openapi.json': openApi(strict),
      'answer.schema.json': JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...envelope,
      }),
    });
    const [broken, kept] = result.contracts;
    expect(broken).toMatchObject({ file: 'openapi.json', outcome: 'violated', at: '$.data' });
    expect(broken?.details).toHaveLength(1);
    expect(broken?.details[0]).toMatch(/^\$\.data required: /u);
    expect(broken?.details.join('')).not.toMatch(/Merhaba|Çadırlar/u);
    expect(kept).toMatchObject({ file: 'answer.schema.json', outcome: 'proposed' });
    expect(result.entry?.provenance.evidence).toBe('answer.schema.json: the whole schema');
  });

  it('breaks a contract an answer has nothing at', () => {
    const result = step({ 'openapi.json': openApi(envelope) }, [
      { data: { answer: 'x' } },
      { other: 1 },
    ]);
    expect(result.contracts[0]?.details).toEqual(['$.data: nothing there']);
    expect(result.entry).toBeUndefined();
  });

  it('says why it proposes nothing from a file it can read no contract from', () => {
    const result = step({
      'a.json': JSON.stringify({ swagger: '2.0' }),
      'b.json': openApi({ type: 'object', unknownKeyword: 1 }),
      'c.json': JSON.stringify({ openapi: '3.0.0', paths: {} }),
    });
    expect(result.contracts.map((contract) => [contract.file, contract.outcome])).toEqual([
      ['b.json', 'unusable'],
      ['c.json', 'no-operation'],
      ['a.json', 'unusable'],
    ]);
    expect(result.contracts[0]?.details.join('\n')).toContain('unknownKeyword');
    expect(result.contracts[1]?.details).toEqual(['no operation for POST /chat']);
    expect(result.contracts[2]?.details).toEqual([
      'not an OpenAPI 3 or a JSON Schema document; Swagger 2 is left out',
    ]);
    expect(result.entry).toBeUndefined();
  });

  it('reads no file of another kind', () => {
    expect(step({})).toEqual({ entry: undefined, contracts: [] });
  });
});
