// yokla export (ADR-0096): writes the project's cases as neutral rows, one
// JSON line per case, by the schema yokla schema case-row prints, for a tool
// that reads a dataset. Only approved cases with written turns are written;
// each other case is named with why. It contacts nothing.
// Exit codes: 0 written; 2 the files can't be loaded, or no case was written.

import { parseArgs } from 'node:util';
import { ConfigError } from '@yokla/runtime';
import { caseRows, loadProject, selectByTags } from '../api.ts';
import { LoadError } from '../load.ts';
import { writeReport, type Output } from './run.ts';

export const EXPORT_HELP = `Usage: yokla export --out <file> [options]

Writes the cases as neutral rows, one JSON line per case (ADR-0096): its id,
suite, language and tags, its first message, and each turn's message with its
expectations. A tool sends each message to the assistant, and yokla's
assertion function judges the answer (createAssertion in the library API).

Options:
  --out <file>          where to write the rows, JSON Lines
  --profile <file>      the profile (default: yokla.profile.yaml)
  --cases <path>        a case file or directory; repeatable (default: cases)
  --tag <tag>           only the cases with this tag; repeatable
  --config <file>       the configuration (default: yokla.config.yaml, when present)

Exit codes: 0 written; 2 the files can't be loaded, or no case was written.`;

const OPTIONS = {
  out: { type: 'string' },
  profile: { type: 'string' },
  cases: { type: 'string', multiple: true },
  tag: { type: 'string', multiple: true },
  config: { type: 'string' },
  help: { type: 'boolean' },
} as const;

export async function exportCommand(args: readonly string[], io: Output): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(EXPORT_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(EXPORT_HELP);
    return 0;
  }
  if (values.out === undefined) {
    io.err('--out is required');
    io.err(EXPORT_HELP);
    return 2;
  }
  try {
    const project = await loadProject({
      profile: values.profile,
      cases: values.cases,
      config: values.config,
    });
    const { rows, skipped } = caseRows(selectByTags(project.cases, values.tag ?? []));
    for (const { id, reason } of skipped) io.out(`  skipped ${id}: ${reason}`);
    if (rows.length === 0) {
      io.err('no case to write: only approved cases with written turns become rows');
      return 2;
    }
    const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    io.out(`cases: ${writeReport(values.out, text)} (${String(rows.length)} rows)`);
    return 0;
  } catch (error) {
    if (error instanceof LoadError || error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
