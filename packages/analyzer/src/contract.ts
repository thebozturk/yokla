// The contract step (ADR-0057): the response contract from the inventory's
// contract files, an OpenAPI 3 operation or a JSON Schema document, proposed
// only when every probe answer matches it. The answers are kept in memory
// for this check only; a violation is reported by its path and keyword,
// never by a value. No model, no cost.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contractAt,
  contractKind,
  queryJsonPath,
  readJsonSchema,
  readOpenApi,
  schemaProblems,
  toJson,
  validateJson,
  type ContractRequest,
  type JsonValue,
} from '@yokla/core';
import { parse } from 'yaml';
import type { InventoryFile } from './inventory.ts';
import type { ProposedEntry } from './propose.ts';

/** What became of one contract file. */
export interface ContractReport {
  readonly file: string;
  /** What in it was read, such as `POST /v1/chat 200 application/json`. */
  readonly read?: string;
  readonly at?: string;
  readonly outcome: 'proposed' | 'no-operation' | 'unusable' | 'violated';
  readonly details: readonly string[];
}

export interface ContractStep {
  readonly entry: ProposedEntry | undefined;
  readonly contracts: readonly ContractReport[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDocument(dir: string, path: string): unknown {
  try {
    return parse(readFileSync(join(dir, path), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Each way the answers break a schema at `at`, by path and keyword, each once. */
function violationsOf(
  at: string,
  schema: Record<string, unknown>,
  answers: readonly JsonValue[],
): string[] {
  const found = new Set<string>();
  for (const answer of answers) {
    const values = queryJsonPath(answer, at);
    if (values.length === 0) found.add(`${at}: nothing there`);
    for (const value of values) {
      for (const violation of validateJson(schema, value, at)) {
        found.add(`${violation.path} ${violation.keyword}: ${violation.message}`);
      }
    }
  }
  return [...found];
}

/** The first contract the answers keep, OpenAPI operations before JSON Schemas, each by path. */
export function contractStep(input: {
  readonly dir: string;
  readonly files: readonly InventoryFile[];
  readonly request: ContractRequest;
  readonly textPath: string;
  readonly evidencePaths: readonly string[];
  readonly answers: readonly JsonValue[];
}): ContractStep {
  const read = input.files
    .filter((file) => file.kind === 'contract')
    .map((file) => {
      const document = readDocument(input.dir, file.path);
      return { path: file.path, document, kind: contractKind(document) };
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const ordered = [
    ...read.filter((file) => file.kind === 'openapi'),
    ...read.filter((file) => file.kind === 'json-schema'),
    ...read.filter((file) => file.kind === undefined),
  ];
  const contracts: ContractReport[] = [];
  for (const { path, document, kind } of ordered) {
    if (kind === undefined || !isObject(document)) {
      const why = 'not an OpenAPI 3 or a JSON Schema document; Swagger 2 is left out';
      contracts.push({ file: path, outcome: 'unusable', details: [why] });
      continue;
    }
    const got =
      kind === 'openapi' ? readOpenApi(document, input.request) : readJsonSchema(document);
    if (!got.ok) {
      contracts.push({ file: path, outcome: got.outcome, details: [got.problem] });
      continue;
    }
    const placed = contractAt(got.schema, input.textPath, input.evidencePaths);
    const dropped = got.dropped.map((keyword) => `left out: ${keyword}`);
    const base = { file: path, read: got.read, at: placed.at };
    const problems = schemaProblems(placed.schema);
    if (problems.length > 0) {
      contracts.push({ ...base, outcome: 'unusable', details: [...dropped, ...problems] });
      continue;
    }
    const violations = violationsOf(placed.at, placed.schema, input.answers);
    if (violations.length > 0) {
      contracts.push({ ...base, outcome: 'violated', details: [...dropped, ...violations] });
      continue;
    }
    contracts.push({ ...base, outcome: 'proposed', details: dropped });
    return {
      entry: {
        pointer: '/target/response/schema',
        value: toJson({ at: placed.at, schema: placed.schema }),
        provenance: { source: 'contract', evidence: `${path}: ${got.read}`, status: 'proposed' },
      },
      contracts,
    };
  }
  return { entry: undefined, contracts };
}
