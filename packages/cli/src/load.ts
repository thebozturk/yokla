// Reads the profile and case files and validates them with the first-party
// pack schemas. Problems are reported as file:line:column.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { formatIssue, parseConfig, type Case, type Profile, type z } from '@yokla/core';
import { schemas } from './schemas.ts';

export class LoadError extends Error {
  override readonly name = 'LoadError';
}

const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

function display(path: string): string {
  const shown = relative(process.cwd(), path);
  return shown === '' || shown.startsWith('..') ? path : shown;
}

function parseFile<T>(path: string, schema: z.ZodType<T>): { value: T; text: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new LoadError(
      `${display(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = parseConfig(text, display(path), schema);
  if (!result.ok) throw new LoadError(result.issues.map(formatIssue).join('\n'));
  return { value: result.value, text };
}

export interface LoadedProfile {
  readonly profile: Profile;
  readonly sha256: string;
  readonly dir: string;
  readonly path: string;
}

export function loadProfile(path: string): LoadedProfile {
  const absolute = resolve(path);
  const { value, text } = parseFile(absolute, schemas.profile);
  return {
    profile: value,
    sha256: createHash('sha256').update(text).digest('hex'),
    dir: dirname(absolute),
    path: absolute,
  };
}

function caseFiles(path: string): string[] {
  const absolute = resolve(path);
  let stats: Stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new LoadError(`${display(absolute)}: no such file or directory`);
  }
  if (!stats.isDirectory()) return [absolute];
  return readdirSync(absolute)
    .filter((name) => CONFIG_EXTENSIONS.has(extname(name)))
    .toSorted()
    .map((name) => join(absolute, name));
}

/** Loads cases from files and directories (every .yaml, .yml and .json file in it). */
export function loadCases(paths: readonly string[]): Case[] {
  const files = paths.flatMap(caseFiles);
  if (files.length === 0) throw new LoadError(`no case files found in ${paths.join(', ')}`);
  const problems: string[] = [];
  const cases: Case[] = [];
  for (const file of files) {
    try {
      cases.push(...parseFile(file, schemas.caseFile).value.cases);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0) throw new LoadError(problems.join('\n'));
  return cases;
}
