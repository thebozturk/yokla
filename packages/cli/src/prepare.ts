// What a run needs before it starts, as yokla run, yokla shrink and yokla mcp
// load it: the profile, the cases, the configuration with its check modules,
// and a cassette to replay (ADR-0040).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  Cassette,
  CASSETTE_SCHEMA_ID,
  CORE_CHECKS,
  toJson,
  unapprovedEntries,
  type Case,
  type Profile,
  type YoklaConfig,
} from '@yokla/core';
import type { RunOptions } from '@yokla/runtime';
import { loadCheckModules } from './checks.ts';
import { LoadError, loadCases, loadConfig, loadProfile } from './load.ts';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from './packs.ts';

/** Where a run's files and target are, as the command line gives them. */
export interface RunSetup {
  readonly profile: string;
  /** Case files or directories; by default `cases` next to the profile. */
  readonly cases?: readonly string[] | undefined;
  /** The configuration; by default `yokla.config.yaml`, when present. */
  readonly config?: string | undefined;
  readonly targetUrl?: string | undefined;
  readonly proxyUrl?: string | undefined;
  /** Case files to load too, unless the case paths already hold them. */
  readonly alsoCases?: readonly string[] | undefined;
}

/** Whether a case path loads this file: the file itself, or the directory it is in. */
function holds(path: string, file: string): boolean {
  const absolute = resolve(path);
  if (absolute === file) return true;
  try {
    return statSync(absolute).isDirectory() && dirname(file) === absolute;
  } catch {
    return false;
  }
}

export interface PreparedRun {
  readonly profile: Profile;
  readonly profileSha256: string;
  readonly profileDir: string;
  readonly casePaths: readonly string[];
  readonly cases: readonly Case[];
  readonly config: YoklaConfig | undefined;
  /** Everything a run takes but its cases. */
  readonly base: Omit<RunOptions, 'cases'>;
}

/** Loads the profile, the cases and the configuration, and the check modules it names. */
export async function prepareRun(setup: RunSetup, version: string): Promise<PreparedRun> {
  const loaded = loadProfile(setup.profile);
  // Nothing a machine proposed reaches the target until a person approves it (ADR-0047).
  const unapproved = unapprovedEntries(toJson(loaded.profile));
  if (unapproved.length > 0) {
    throw new LoadError(
      [
        `${setup.profile}: ${String(unapproved.length)} entr${unapproved.length === 1 ? 'y is' : 'ies are'} not approved:`,
        ...unapproved.map((entry) => `  ${entry.pointer} (${entry.status})`),
        "set a proposed entry's status in provenance to approved, or delete its line there; delete a rejected entry and its line",
      ].join('\n'),
    );
  }
  const given = setup.cases ?? [resolve(loaded.dir, 'cases')];
  const casePaths = [
    ...given,
    ...(setup.alsoCases ?? []).filter((file) => !given.some((path) => holds(path, file))),
  ];
  const cases = loadCases(casePaths);
  const configPath =
    setup.config ?? (existsSync('yokla.config.yaml') ? 'yokla.config.yaml' : undefined);
  const config = configPath === undefined ? undefined : loadConfig(configPath);
  // The user's own checks (ADR-0030); a case naming one needs it loaded.
  const own = await loadCheckModules(
    config?.checks ?? [],
    configPath ?? 'yokla.config.yaml',
    cases,
    DOMAIN_PACKS,
  );
  return {
    profile: loaded.profile,
    profileSha256: loaded.sha256,
    profileDir: loaded.dir,
    casePaths,
    cases,
    config,
    base: {
      profile: loaded.profile,
      profileSha256: loaded.sha256,
      profileDir: loaded.dir,
      env: process.env,
      yoklaVersion: version,
      checks: [...CORE_CHECKS, ...own.checks],
      policies: own.policies,
      checkModules: own.modules,
      packs: DOMAIN_PACKS,
      languages: LANGUAGE_PACKS,
      ...(setup.targetUrl === undefined ? {} : { targetUrl: setup.targetUrl }),
      ...(setup.proxyUrl === undefined ? {} : { proxyUrl: setup.proxyUrl }),
      ...(config === undefined ? {} : { prices: config.prices, models: config.models }),
    },
  };
}

/** Reads a cassette (ADR-0040); one from another schema version is refused. */
export function readCassette(path: string): { cassette: Cassette; sha256: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new LoadError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LoadError(`${path}: not JSON`);
  }
  const schema: unknown = Reflect.get(Object(value), 'schema');
  if (schema !== CASSETTE_SCHEMA_ID) {
    throw new LoadError(
      `${path}: not a ${CASSETTE_SCHEMA_ID} file (schema: ${JSON.stringify(schema) ?? 'missing'})`,
    );
  }
  const parsed = Cassette.safeParse(value);
  if (!parsed.success) throw new LoadError(`${path}: an invalid cassette`);
  return { cassette: parsed.data, sha256: createHash('sha256').update(text).digest('hex') };
}
