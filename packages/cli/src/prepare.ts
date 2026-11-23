// What a run needs before it starts (ADR-0093): the profile, the cases and the
// configuration with its check modules, read from files as yokla run finds
// them or taken from objects, and the runner's options built from them. The
// library API, yokla run, shrink, explore and mcp all load here, so there is
// one path from files to results. Nothing here prints or ends the process.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  Cassette,
  CASSETTE_SCHEMA_ID,
  CORE_CHECKS,
  toJson,
  unapprovedEntries,
  YoklaConfig,
  type Case,
  type Profile,
  type z,
} from '@yokla/core';
import type { RunOptions } from '@yokla/runtime';
import { loadCheckModules, type LoadedChecks } from './checks.ts';
import {
  LoadError,
  loadCases,
  loadConfig,
  loadProfile,
  readCaseSchemas,
  withContract,
} from './load.ts';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from './packs.ts';
import { schemas } from './schemas.ts';
import { version } from './version.ts';

const DEFAULT_PROFILE = 'yokla.profile.yaml';
const DEFAULT_CONFIG = 'yokla.config.yaml';

/** A run's profile, cases and configuration, loaded and checked (ADR-0093). */
export interface Project {
  /** The profile, with the file of its response contract read. */
  readonly profile: Profile;
  /** SHA-256 of the profile's file, or of its JSON when it was given as an object. */
  readonly profileSha256: string;
  /**
   * The profile's directory: the data files it names are read from it, and
   * the model caches are kept under yokla-data/ in it.
   */
  readonly dir: string;
  readonly cases: readonly Case[];
  /** The case files and directories the cases came from; none when given as objects. */
  readonly casePaths: readonly string[];
  readonly config: YoklaConfig | undefined;
  /** The check modules the configuration names, loaded (ADR-0030). */
  readonly userChecks: LoadedChecks;
}

/** Where a run's files are; each default as yokla run takes it. */
export interface ProjectFiles {
  /** The profile (default: yokla.profile.yaml). */
  readonly profile?: string | undefined;
  /** Case files or directories (default: cases, next to the profile). */
  readonly cases?: readonly string[] | undefined;
  /** The configuration (default: yokla.config.yaml, when present). */
  readonly config?: string | undefined;
  /** What relative paths and the defaults are relative to (default: the process's). */
  readonly cwd?: string | undefined;
}

/** A run's files, and case files to load too, unless the case paths hold them (yokla mcp). */
export interface SessionFiles extends ProjectFiles {
  readonly alsoCases?: readonly string[] | undefined;
}

/** Whether a case path loads this file: the file itself, or the directory it is in. */
function holds(path: string, file: string, cwd: string): boolean {
  const absolute = resolve(cwd, path);
  if (absolute === file) return true;
  try {
    return statSync(absolute).isDirectory() && dirname(file) === absolute;
  } catch {
    return false;
  }
}

/** Nothing a machine proposed reaches the target until a person approves it (ADR-0047). */
function refuseUnapproved(profile: Profile, shown: string): void {
  const unapproved = unapprovedEntries(toJson(profile));
  if (unapproved.length === 0) return;
  throw new LoadError(
    [
      `${shown}: ${String(unapproved.length)} entr${unapproved.length === 1 ? 'y is' : 'ies are'} not approved:`,
      ...unapproved.map((entry) => `  ${entry.pointer} (${entry.status})`),
      "set a proposed entry's status in provenance to approved, or delete its line there; delete a rejected entry and its line",
    ].join('\n'),
  );
}

/** Loads a run's files as yokla run finds them, and the check modules the configuration names. */
export async function loadFiles(files: SessionFiles = {}): Promise<Project> {
  const cwd = resolve(files.cwd ?? process.cwd());
  const profilePath = files.profile ?? DEFAULT_PROFILE;
  const loaded = loadProfile(profilePath, cwd);
  refuseUnapproved(loaded.profile, profilePath);
  const given = files.cases ?? [resolve(loaded.dir, 'cases')];
  const casePaths = [
    ...given,
    ...(files.alsoCases ?? []).filter((file) => !given.some((path) => holds(path, file, cwd))),
  ];
  const cases = loadCases(casePaths, cwd);
  const fallback = join(cwd, DEFAULT_CONFIG);
  const configPath =
    files.config === undefined
      ? existsSync(fallback)
        ? fallback
        : undefined
      : resolve(cwd, files.config);
  const config = configPath === undefined ? undefined : loadConfig(configPath, cwd);
  // The user's own checks (ADR-0030); a case naming one needs it loaded.
  const userChecks = await loadCheckModules(
    config?.checks ?? [],
    configPath ?? fallback,
    cases,
    DOMAIN_PACKS,
  );
  return {
    profile: loaded.profile,
    profileSha256: loaded.sha256,
    dir: loaded.dir,
    cases,
    casePaths,
    config,
    userChecks,
  };
}

/** A run's profile, cases and configuration as a person writes them, and their directory. */
export interface ProjectObjects {
  readonly profile: unknown;
  readonly cases: readonly unknown[];
  readonly config?: unknown;
  /** What the files they name are relative to, and where the model caches are kept. */
  readonly dir: string;
}

/** An object validated by a schema; a problem names what it is and where. */
function validated<T>(what: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new LoadError(
    [
      `${what}: invalid`,
      ...parsed.error.issues
        .slice(0, 10)
        .map((issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    ].join('\n'),
  );
}

/** The same as loadFiles, from objects (ADR-0093). */
export async function projectOf(objects: ProjectObjects): Promise<Project> {
  const dir = resolve(objects.dir);
  const profile = withContract(validated('profile', schemas.profile, objects.profile), dir, dir);
  refuseUnapproved(profile, 'profile');
  const cases = validated('cases', schemas.caseFile, {
    version: 1,
    cases: objects.cases,
  }).cases.map((testCase) => readCaseSchemas(testCase, dir, dir));
  const config =
    objects.config === undefined ? undefined : validated('config', YoklaConfig, objects.config);
  const userChecks = await loadCheckModules(
    config?.checks ?? [],
    join(dir, DEFAULT_CONFIG),
    cases,
    DOMAIN_PACKS,
  );
  return {
    profile,
    profileSha256: createHash('sha256').update(JSON.stringify(objects.profile)).digest('hex'),
    dir,
    cases,
    casePaths: [],
    config,
    userChecks,
  };
}

/** Where a run sends its turns and the environment it reads. */
export interface Reach {
  readonly targetUrl?: string | undefined;
  readonly proxyUrl?: string | undefined;
  /** For {{env.NAME}} and the model keys (default: the process's). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** The runner's options for a project, everything but its cases. */
export function runnerOptions(project: Project, reach: Reach = {}): Omit<RunOptions, 'cases'> {
  const { config, userChecks } = project;
  return {
    profile: project.profile,
    profileSha256: project.profileSha256,
    profileDir: project.dir,
    env: reach.env ?? process.env,
    yoklaVersion: version(),
    checks: [...CORE_CHECKS, ...userChecks.checks],
    policies: userChecks.policies,
    checkModules: userChecks.modules,
    packs: DOMAIN_PACKS,
    languages: LANGUAGE_PACKS,
    ...(reach.targetUrl === undefined ? {} : { targetUrl: reach.targetUrl }),
    ...(reach.proxyUrl === undefined ? {} : { proxyUrl: reach.proxyUrl }),
    ...(config === undefined
      ? {}
      : { prices: config.prices, models: config.models, judge: config.judge }),
  };
}

/** A cassette read from its file, with the file's hash (ADR-0040). */
export interface ReadCassette {
  readonly cassette: Cassette;
  readonly sha256: string;
}

/** Reads a cassette (ADR-0040); one from another schema version is refused. */
export function readCassette(path: string): ReadCassette {
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
