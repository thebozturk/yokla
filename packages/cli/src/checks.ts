// The check modules yokla.config.yaml names (ADR-0030): each is imported,
// its default export validated against contract version 1, and its file
// hashed, so the results show when a check changed. Only what the config names
// is loaded; nothing is installed or looked for. A module runs in yokla's
// process with the user's permissions, as a test file does.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CORE_DIMENSIONS,
  customProblems,
  userCheck,
  UserCheckDefinition,
  userPolicies,
  type AggregationPolicy,
  type Case,
  type Check,
  type DomainPack,
} from '@yokla/core';
import { LoadError } from './load.ts';

export interface LoadedChecks {
  readonly checks: readonly Check[];
  readonly policies: Readonly<Record<string, AggregationPolicy>>;
  readonly modules: readonly { id: string; module: string; sha256: string }[];
}

/** Imports one module and validates its default export. */
async function loadModule(
  absolute: string,
  shown: string,
): Promise<{ definition: UserCheckDefinition; sha256: string }> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new LoadError(`${shown}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let exported: unknown;
  try {
    const module: unknown = await import(pathToFileURL(absolute).href);
    exported = Reflect.get(Object(module), 'default');
  } catch (error) {
    throw new LoadError(
      `${shown}: the module could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = UserCheckDefinition.safeParse(exported);
  if (!parsed.success) {
    throw new LoadError(
      [
        `${shown}: the default export is not a check by contract version 1`,
        ...parsed.error.issues.map(
          (issue) => `  ${issue.path.map(String).join('.') || '(the export)'}: ${issue.message}`,
        ),
      ].join('\n'),
    );
  }
  return {
    definition: parsed.data,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Loads the check modules the config names, relative to its file, and checks
 * them against the cases and the built-in checks' dimensions.
 */
export async function loadCheckModules(
  paths: readonly string[],
  configPath: string,
  cases: readonly Case[],
  packs: readonly DomainPack[],
): Promise<LoadedChecks> {
  const dir = dirname(resolve(configPath));
  const definitions: UserCheckDefinition[] = [];
  const modules: { id: string; module: string; sha256: string }[] = [];
  for (const path of paths) {
    const absolute = resolve(dir, path);
    const module = relative(dir, absolute).split(sep).join('/');
    const { definition, sha256 } = await loadModule(absolute, module);
    const twice = definitions.find((other) => other.id === definition.id);
    if (twice !== undefined) {
      throw new LoadError(`${module}: the check id "${definition.id}" is taken by another module`);
    }
    definitions.push(definition);
    modules.push({ id: definition.id, module, sha256 });
  }
  const builtIn = new Set([
    ...CORE_DIMENSIONS,
    ...packs.flatMap((pack) => Object.keys(pack.dimensions)),
  ]);
  const { policies, problems } = userPolicies(definitions, builtIn);
  problems.push(...customProblems(cases, definitions));
  if (problems.length > 0) throw new LoadError(problems.join('\n'));
  return { checks: definitions.map((definition) => userCheck(definition)), policies, modules };
}
