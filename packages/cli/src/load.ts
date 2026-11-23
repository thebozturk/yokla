// Reads the profile and case files and validates them with the first-party
// pack schemas. Problems are reported as file:line:column.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import {
  Baseline,
  BASELINE_SCHEMA_ID,
  baselineOf,
  formatIssue,
  JsonSchemaValue,
  parseConfig,
  Results,
  RESULTS_SCHEMA_ID,
  YoklaConfig,
  type Case,
  type Profile,
  SchemaRule,
  z,
} from '@yokla/core';
import { schemas } from './schemas.ts';

export class LoadError extends Error {
  override readonly name = 'LoadError';
}

const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/** A path as messages show it: relative to `cwd` when under it. */
function display(path: string, cwd: string): string {
  const shown = relative(cwd, path);
  return shown === '' || shown.startsWith('..') ? path : shown;
}

/** Reads and validates the file at the absolute `path`; messages show it relative to `cwd`. */
function parseFile<T>(path: string, schema: z.ZodType<T>, cwd: string): { value: T; text: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new LoadError(
      `${display(path, cwd)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = parseConfig(text, display(path, cwd), schema);
  if (!result.ok) throw new LoadError(result.issues.map(formatIssue).join('\n'));
  return { value: result.value, text };
}

/** A rule with its schemaFile read, relative to `dir`, into schema (ADR-0030). */
function readSchemaRule(rule: SchemaRule, dir: string, cwd: string): SchemaRule {
  if (rule.schemaFile === undefined) return rule;
  const { value } = parseFile(resolve(dir, rule.schemaFile), JsonSchemaValue, cwd);
  return { at: rule.at, schema: value };
}

/** A turn's expectations with the files of their schemas read. */
function readTurnSchemas<E extends Readonly<Record<string, unknown>> | undefined>(
  expect: E,
  dir: string,
  cwd: string,
): E {
  const rules: unknown = expect?.['schema'];
  if (expect === undefined || !Array.isArray(rules)) return expect;
  return {
    ...expect,
    schema: SchemaRule.array()
      .parse(rules)
      .map((rule) => readSchemaRule(rule, dir, cwd)),
  };
}

/** A case with every schemaFile its expectations name read (ADR-0030). */
export function readCaseSchemas(testCase: Case, dir: string, cwd: string): Case {
  return {
    ...testCase,
    turns: testCase.turns.map((turn) =>
      turn.expect === undefined
        ? turn
        : { ...turn, expect: readTurnSchemas(turn.expect, dir, cwd) },
    ),
    ...(testCase.customer?.expect === undefined
      ? {}
      : {
          customer: {
            ...testCase.customer,
            expect: readTurnSchemas(testCase.customer.expect, dir, cwd),
          },
        }),
  };
}

/** The profile with the file of its response contract read (ADR-0030). */
export function withContract(profile: Profile, dir: string, cwd: string): Profile {
  const { target } = profile;
  const contract = target.response.schema;
  if (contract === undefined) return profile;
  const schema = readSchemaRule(contract, dir, cwd);
  // Each adapter on its own, so the target keeps its own type.
  if (target.adapter === 'websocket') {
    return { ...profile, target: { ...target, response: { ...target.response, schema } } };
  }
  return { ...profile, target: { ...target, response: { ...target.response, schema } } };
}

export interface LoadedProfile {
  readonly profile: Profile;
  readonly sha256: string;
  readonly dir: string;
  readonly path: string;
}

/** Loads a profile; a relative path, and the paths messages show, are relative to `cwd`. */
export function loadProfile(path: string, cwd: string = process.cwd()): LoadedProfile {
  const absolute = resolve(cwd, path);
  const { value, text } = parseFile(absolute, schemas.profile, cwd);
  const profile = withContract(value, dirname(absolute), cwd);
  return {
    profile,
    sha256: createHash('sha256').update(text).digest('hex'),
    dir: dirname(absolute),
    path: absolute,
  };
}

function caseFiles(path: string, cwd: string): string[] {
  const absolute = resolve(cwd, path);
  let stats: Stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new LoadError(`${display(absolute, cwd)}: no such file or directory`);
  }
  if (!stats.isDirectory()) return [absolute];
  return readdirSync(absolute)
    .filter((name) => CONFIG_EXTENSIONS.has(extname(name)))
    .toSorted()
    .map((name) => join(absolute, name));
}

/**
 * Loads cases from files and directories (every .yaml, .yml and .json file in
 * it); relative paths, and the paths messages show, are relative to `cwd`.
 */
export function loadCases(paths: readonly string[], cwd: string = process.cwd()): Case[] {
  const files = paths.flatMap((path) => caseFiles(path, cwd));
  if (files.length === 0) throw new LoadError(`no case files found in ${paths.join(', ')}`);
  const problems: string[] = [];
  const cases: Case[] = [];
  for (const file of files) {
    try {
      cases.push(
        ...parseFile(file, schemas.caseFile, cwd).value.cases.map((testCase) =>
          readCaseSchemas(testCase, dirname(file), cwd),
        ),
      );
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0) throw new LoadError(problems.join('\n'));
  return cases;
}

const RawCaseFile = z.looseObject({ cases: z.array(z.record(z.string(), z.unknown())) });

/**
 * The file that holds case `id`, and the case as written there, before
 * defaults are applied: what yokla shrink cuts and writes back (ADR-0035).
 */
export function findCaseSource(
  paths: readonly string[],
  id: string,
  cwd: string = process.cwd(),
): { readonly file: string; readonly raw: Record<string, unknown> } {
  for (const file of paths.flatMap((path) => caseFiles(path, cwd))) {
    const raw = parseFile(file, RawCaseFile, cwd).value.cases.find((c) => c['id'] === id);
    if (raw !== undefined) return { file, raw };
  }
  throw new LoadError(`no case "${id}" in ${paths.join(', ')}`);
}

/** Loads yokla.config.yaml (ADR-0010); a relative path is relative to `cwd`. */
export function loadConfig(path: string, cwd: string = process.cwd()): YoklaConfig {
  return parseFile(resolve(cwd, path), YoklaConfig, cwd).value;
}

export class ResultsError extends Error {
  override readonly name = 'ResultsError';
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ResultsError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function schemaOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'schema' in value
    ? value.schema
    : undefined;
}

function validated<T>(path: string, what: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ResultsError(
    [
      `${path}: invalid ${what}`,
      ...parsed.error.issues
        .slice(0, 10)
        .map((issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    ].join('\n'),
  );
}

/** Reads and validates a results file; any problem is a ResultsError. */
export function readResults(path: string): Results {
  const value = readJson(path);
  const schema = schemaOf(value);
  if (schema !== RESULTS_SCHEMA_ID) {
    throw new ResultsError(
      `${path}: not a ${RESULTS_SCHEMA_ID} file (schema: ${JSON.stringify(schema) ?? 'missing'})`,
    );
  }
  return validated(path, 'results', Results, value);
}

/** A baseline file, or a results file reduced to its baseline (ADR-0011). */
export function readBaseline(path: string): Baseline {
  const value = readJson(path);
  const schema = schemaOf(value);
  if (schema === RESULTS_SCHEMA_ID) return baselineOf(validated(path, 'results', Results, value));
  if (schema !== BASELINE_SCHEMA_ID) {
    throw new ResultsError(
      `${path}: not a ${BASELINE_SCHEMA_ID} or ${RESULTS_SCHEMA_ID} file (schema: ${JSON.stringify(schema) ?? 'missing'})`,
    );
  }
  return validated(path, 'baseline', Baseline, value);
}
