// yokla import (ADR-0097): reads another tool's cases or results through the
// user's mapping. `cases` writes proposed cases with `source: import` and no
// expectations, never over a file that exists; `results` writes results.v1,
// which reports and gates like any run. It contacts nothing.
// Exit codes: 0 written; 2 a file can't be read, the mapping is invalid, or
// nothing was imported.

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { formatOf, importedCaseYaml } from '@yokla/interop-rows';
import { parseConfig, z } from '@yokla/core';
import { importCases, importResults } from '../api.ts';
import { LoadError, loadProfile } from '../load.ts';
import { writeReport, type Output } from './run.ts';

export const IMPORT_HELP = `Usage: yokla import <cases|results> --from <file> --mapping <file> --out <file> [options]

Reads another tool's cases or results through a mapping you write: where each
value is in its rows (ADR-0097, yokla schema import-mapping). It contacts
nothing, and names no tool.

  cases     writes a case file of proposed cases with source: import and no
            expectations; they gate once a person writes what each expects and
            approves it. It never writes over a file that exists.
  results   writes a results file, which yokla report, gate, compare and
            baseline read like any run. A row whose verdict the mapping can't
            find is unmeasured, never a pass.

Options:
  --from <file>         the other tool's file: .json, .jsonl, .csv, .yaml or .yml
  --mapping <file>      the mapping, YAML or JSON
  --out <file>          where to write the cases or the results
  --language <code>     the language of a case whose row the mapping gives none
                        (default: the profile's first, else en)
  --profile <file>      the profile whose first language is the default
                        (default: yokla.profile.yaml, when present)

Exit codes: 0 written; 2 a file can't be read, the mapping is invalid, or nothing was imported.`;

const OPTIONS = {
  from: { type: 'string' },
  mapping: { type: 'string' },
  out: { type: 'string' },
  language: { type: 'string' },
  profile: { type: 'string' },
  help: { type: 'boolean' },
} as const;

/** A file's text; a problem is a LoadError. */
function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new LoadError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The default language: the profile's first, else en. */
function languageOf(given: string | undefined, profile: string | undefined): string {
  if (given !== undefined) return given;
  const path = profile ?? (existsSync('yokla.profile.yaml') ? 'yokla.profile.yaml' : undefined);
  return path === undefined ? 'en' : (loadProfile(path).profile.languages[0] ?? 'en');
}

export function importCommand(args: readonly string[], io: Output): number {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(IMPORT_HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    io.out(IMPORT_HELP);
    return 0;
  }
  const [what, ...more] = positionals;
  if ((what !== 'cases' && what !== 'results') || more.length > 0) {
    io.err('say what to import: yokla import cases, or yokla import results');
    io.err(IMPORT_HELP);
    return 2;
  }
  const { from, mapping, out } = values;
  if (from === undefined || mapping === undefined || out === undefined) {
    io.err('--from, --mapping and --out are required');
    io.err(IMPORT_HELP);
    return 2;
  }
  try {
    const format = formatOf(from);
    if (format === undefined) {
      throw new LoadError(`${from}: give a .json, .jsonl, .csv, .yaml or .yml file`);
    }
    const loaded = parseConfig(read(mapping), mapping, z.unknown());
    if (!loaded.ok) throw new LoadError(`${mapping}: not YAML or JSON`);
    const options = {
      format,
      source: basename(from),
      language: languageOf(values.language, values.profile),
    };
    const text = read(from);
    if (what === 'cases') {
      if (existsSync(out))
        throw new LoadError(`${out} exists: yokla import never writes over a file`);
      const { cases, problems } = importCases(text, loaded.value, options);
      for (const problem of problems) io.err(`  ${problem}`);
      if (cases.length === 0) {
        io.err('no case to write: the mapping finds no message in any row');
        return 2;
      }
      io.out(
        `cases: ${writeReport(out, importedCaseYaml(cases, options.source))} (${String(cases.length)} proposed)`,
      );
      return 0;
    }
    const { results, problems } = importResults(text, loaded.value, options);
    for (const problem of problems) io.err(`  ${problem}`);
    if (results.cases.length === 0) {
      io.err('no result to write: the mapping finds no case id in any row');
      return 2;
    }
    const statuses = Object.entries(results.summary.statuses)
      .map(([status, count]) => `${status} ${String(count)}`)
      .join(', ');
    io.out(
      `results: ${writeReport(out, `${JSON.stringify(results, null, 2)}\n`)} (${String(results.cases.length)} cases: ${statuses})`,
    );
    return 0;
  } catch (error) {
    if (error instanceof LoadError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
