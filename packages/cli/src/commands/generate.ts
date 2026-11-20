// yokla generate (ADR-0055): cases whose expectations the domain pack
// computes from the profile's data, written as proposed cases. Nothing is
// sent, and no model is called. The same data and options write the same
// file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generatedCaseYaml, genericAttacks, type Generated } from '@yokla/core';
import { LoadError, loadProfile } from '../load.ts';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from '../packs.ts';
import type { Output } from './run.ts';

const DEFAULT_PER_KIND = 2;

export const GENERATE_HELP = `Usage: yokla generate [options]

Writes cases whose expectations the domain pack computes from the profile's
data, such as its catalog, as proposed cases (ADR-0055); with --redteam,
attack cases from templates instead (ADR-0080). It sends nothing and calls no
model.

Options:
  --profile <file>         the profile (default: yokla.profile.yaml)
  --out <file>             where to write (default: cases/generated.yaml next to the profile,
                           cases/redteam.yaml with --redteam)
  --per-kind <n>           the most cases of each kind, in each language (default: ${String(DEFAULT_PER_KIND)})
  --absent <lang>:<words>  types a shopper may ask for that you expect absent, comma-separated,
                           such as en:hammock,kayak; repeatable
  --redteam                write attack cases from templates: injection, extraction, offer,
                           commitment and competitor
  --competitor <name>      a competitor of the target's, which an answer must not name; repeatable
  --force                  overwrite --out`;

const OPTIONS = {
  profile: { type: 'string', default: 'yokla.profile.yaml' },
  out: { type: 'string' },
  'per-kind': { type: 'string' },
  absent: { type: 'string', multiple: true },
  redteam: { type: 'boolean' },
  competitor: { type: 'string', multiple: true },
  force: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

/** `--absent en:hammock,kayak`, repeatable, as words per language. */
function absentWords(values: readonly string[]): Record<string, string[]> {
  const words: Record<string, string[]> = {};
  for (const value of values) {
    const match = /^([a-z]{2}):(.+)$/u.exec(value);
    const language = match?.[1];
    const listed = match?.[2];
    if (language === undefined || listed === undefined) {
      throw new LoadError(`--absent ${value}: write it as <language>:<words>, such as en:hammock`);
    }
    const parsed = listed
      .split(',')
      .map((word) => word.trim())
      .filter((word) => word !== '');
    words[language] = [...new Set([...(words[language] ?? []), ...parsed])];
  }
  return words;
}

/** How many cases of each kind each language got, such as `lookup 2 tr, 2 en`. */
function counts(generated: Generated): string[] {
  const byKind = new Map<string, Map<string, number>>();
  for (const c of generated.cases) {
    const languages = byKind.get(c.kind) ?? new Map<string, number>();
    languages.set(c.language, (languages.get(c.language) ?? 0) + 1);
    byKind.set(c.kind, languages);
  }
  return [...byKind].map(
    ([kind, languages]) =>
      `  ${kind}: ${[...languages].map(([language, n]) => `${String(n)} ${language}`).join(', ')}`,
  );
}

export function generateCommand(args: readonly string[], io: Output, cwd = process.cwd()): number {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(GENERATE_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(GENERATE_HELP);
    return 0;
  }
  try {
    const perKind =
      values['per-kind'] === undefined ? DEFAULT_PER_KIND : Number(values['per-kind']);
    if (!Number.isInteger(perKind) || perKind < 1) {
      throw new LoadError('--per-kind must be a positive integer');
    }
    const redteam = values.redteam === true;
    if (redteam && values.absent !== undefined) {
      throw new LoadError('--absent is for the data kinds; --redteam writes attacks');
    }
    if (!redteam && values.competitor !== undefined) {
      throw new LoadError('--competitor goes with --redteam');
    }
    const competitors = [
      ...new Set(
        (values.competitor ?? []).map((name) => name.trim()).filter((name) => name !== ''),
      ),
    ];
    const absent = absentWords(values.absent ?? []);
    const profilePath = resolve(cwd, values.profile);
    const { profile } = loadProfile(profilePath);
    const profileDir = dirname(profilePath);
    const out = resolve(
      cwd,
      values.out ?? join(profileDir, 'cases', redteam ? 'redteam.yaml' : 'generated.yaml'),
    );
    if (existsSync(out) && values.force !== true) {
      throw new LoadError(`${out} exists: --force overwrites it`);
    }
    const pack = DOMAIN_PACKS.find((candidate) => candidate.id === profile.domain);
    let prepared;
    try {
      prepared = pack?.prepare(profile, {
        readText: (path) => readFileSync(resolve(profileDir, path), 'utf8'),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LoadError(`pack "${profile.domain}": ${message}`);
    }
    let generated: Generated;
    if (redteam) {
      // The attacks that need no domain, then the domain's (ADR-0080).
      const generic = genericAttacks({
        packs: profile.languages.flatMap((language) =>
          LANGUAGE_PACKS.filter((candidate) => candidate.language === language),
        ),
        perKind,
        canary: profile.modelProxy?.inspect?.canary,
      });
      const domain = prepared?.attacks?.({ languages: profile.languages, perKind, competitors });
      generated = {
        cases: [...generic.cases, ...(domain?.cases ?? [])],
        notes: [
          ...generic.notes,
          ...(domain?.notes ?? [`the "${profile.domain}" domain pack writes no attack`]),
        ],
      };
    } else {
      const generate = prepared?.generate;
      if (generate === undefined) {
        throw new LoadError(
          `the "${profile.domain}" domain pack generates no case from this profile's data`,
        );
      }
      generated = generate({ languages: profile.languages, perKind, absent });
    }
    for (const note of generated.notes) io.out(`  none: ${note}`);
    if (generated.cases.length === 0) {
      throw new LoadError('no case was generated: nothing written');
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, generatedCaseYaml(generated, redteam));
    io.out(`generated ${String(generated.cases.length)} proposed cases: ${out}`);
    for (const line of counts(generated)) io.out(line);
    io.out('read each case, then set its status to approved to make it gate (ADR-0004)');
    return 0;
  } catch (error) {
    if (error instanceof LoadError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
