// yokla analyze (ADR-0047): proposes a profile from the target's repository,
// its data and up to three probes, at no model cost, and compares the
// proposal with a profile. It writes yokla.profile.proposed.yaml, never
// yokla.profile.yaml, and overwrites nothing without --force.
// Exit codes: 0 written; 2 a wrong option, a probe that failed, or a file
// that exists without --force.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analysisReport,
  analyzeTarget,
  personPointers,
  ProbeError,
  profileDocument,
  proposalYaml,
} from '@yokla/analyzer';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from '../packs.ts';
import {
  GREETINGS,
  InitError,
  nameOf,
  parseBody,
  parseHeaders,
  parseLanguages,
  PROBE_TIMEOUT_MS,
  shown,
} from './init.ts';
import { writeReport, type Output } from './run.ts';

export const ANALYZE_HELP = `Usage: yokla analyze --url <url> [options]

Proposes a profile from the target's repository, its data and up to three
probes, for a person to review (ADR-0047). yokla makes no model call; the
target may make its own.

Options:
  --dir <path>          the target's repository (default: .)
  --url <url>           the target's chat endpoint; required
  --body <json>         the request body, with {{message}} (default: {"message": "{{message}}"})
  --header <name: value>
                        a request header; repeatable
  --session-url <url>   a request that opens the target's session
  --language <tr|en>    a language of the profile; repeatable (default: those of the
                        catalog's names, else en)
  --out <file>          where to write the proposal (default: <dir>/yokla.profile.proposed.yaml)
  --profile <file>      a profile to compare the proposal with (default:
                        <dir>/yokla.profile.yaml, when present)
  --json <file>         also write the analysis report
  --max-files <n>       list at most this many files (default: 5000)
  --force               overwrite the proposal`;

const OPTIONS = {
  dir: { type: 'string' },
  url: { type: 'string' },
  body: { type: 'string' },
  header: { type: 'string', multiple: true },
  'session-url': { type: 'string' },
  language: { type: 'string', multiple: true },
  out: { type: 'string' },
  profile: { type: 'string' },
  json: { type: 'string' },
  'max-files': { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

const percent = (ratio: number | null) =>
  ratio === null ? 'none' : `${(ratio * 100).toFixed(1)}%`;

export async function analyzeCommand(
  args: readonly string[],
  io: Output,
  version: string,
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(ANALYZE_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(ANALYZE_HELP);
    return 0;
  }
  try {
    if (values.url === undefined) throw new InitError('--url is required: the target to probe');
    let url: URL;
    try {
      url = new URL(values.url);
    } catch {
      throw new InitError(`--url "${values.url}" is not an absolute URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new InitError('analyze probes HTTP targets only');
    }
    const maxFiles = Number(values['max-files'] ?? '5000');
    if (!Number.isInteger(maxFiles) || maxFiles < 1) {
      throw new InitError('--max-files must be a positive integer');
    }
    const headers = parseHeaders(values.header ?? []);
    const body = parseBody(values.body ?? '{"message": "{{message}}"}');
    const given = values.language === undefined ? [] : parseLanguages(values.language);
    if (!JSON.stringify([values.url, headers, body]).includes('{{message}}')) {
      throw new InitError(
        'the request never sends {{message}}: put it in --body, --url or a --header',
      );
    }
    const dir = resolve(cwd, values.dir ?? '.');
    if (!existsSync(dir)) throw new InitError(`--dir ${values.dir ?? '.'} doesn't exist`);
    const out = resolve(cwd, values.out ?? join(dir, 'yokla.profile.proposed.yaml'));
    if (existsSync(out) && values.force !== true) {
      throw new InitError(`${shown(cwd, out)} already exists; --force overwrites`);
    }
    const fallbackProfile = join(dir, 'yokla.profile.yaml');
    const profilePath =
      values.profile === undefined
        ? existsSync(fallbackProfile)
          ? fallbackProfile
          : undefined
        : resolve(cwd, values.profile);

    const person = { name: nameOf(url), url: values.url, headers, body, languages: given };
    const analyzed = await analyzeTarget({
      dir,
      outDir: dirname(out),
      person,
      greetings: GREETINGS,
      probe: {
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(values['session-url'] === undefined ? {} : { sessionUrl: values['session-url'] }),
      },
      maxFiles,
      domainPacks: DOMAIN_PACKS,
      languages: LANGUAGE_PACKS,
      onInventory: (listed) => {
        const counts = new Map<string, number>();
        for (const file of listed.files) counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1);
        io.out(
          `inventory of ${shown(cwd, dir)}: ${String(listed.files.length)} files (${[...counts].map(([kind, count]) => `${kind} ${String(count)}`).join(', ')}), ${String(listed.skipped)} left out${listed.capped ? `; stopped at --max-files ${String(maxFiles)}` : ''}`,
        );
      },
      onProbes: (messages) => {
        io.out(
          `probing ${url.href}: ${String(messages.length)} message(s); yokla makes no model call, the target may make its own`,
        );
        for (const message of messages) io.out(`  ${message}`);
      },
    });
    const text = proposalYaml(analyzed.document, version);
    writeFileSync(out, text);
    io.out(`proposed ${String(analyzed.entries.length)} entries: ${shown(cwd, out)}`);
    for (const entry of analyzed.entries) {
      io.out(`  ${entry.pointer}  (${entry.provenance.source})`);
    }

    const reference =
      profilePath === undefined
        ? undefined
        : {
            path: shown(cwd, profilePath),
            document: profileDocument(readFileSync(profilePath, 'utf8')),
          };
    const report = analysisReport({
      version,
      inventory: analyzed.inventory,
      probes: analyzed.probes,
      entries: analyzed.entries,
      proposal: analyzed.document,
      exclude: personPointers(person),
      ...(reference === undefined ? {} : { reference }),
    });
    const { comparison } = report;
    if (comparison !== undefined) {
      io.out(`compared with ${comparison.profile}:`);
      io.out(
        `  same ${String(comparison.same.length)}, different ${String(comparison.different.length)}, new ${String(comparison.new.length)}, missed ${String(comparison.missed.length)}`,
      );
      io.out(`  precision ${percent(comparison.precision)}, recall ${percent(comparison.recall)}`);
      for (const entry of comparison.different) io.out(`  different: ${entry.pointer}`);
      for (const entry of comparison.new) io.out(`  new: ${entry.pointer}`);
      for (const entry of comparison.missed) io.out(`  missed: ${entry.pointer}`);
    }
    if (values.json !== undefined) {
      io.out(`json: ${writeReport(values.json, `${JSON.stringify(report, null, 2)}\n`)}`);
    }
    io.out('approve each entry in its provenance, then keep the file as yokla.profile.yaml');
    return 0;
  } catch (error) {
    if (error instanceof InitError || error instanceof ProbeError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
