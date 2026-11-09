// Reads the workspace and enforces layers.json (ADR-0006).
// Run from the repository root: node scripts/check-layers.ts

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { parse } from 'yaml';
import {
  checkLayers,
  type LayerSpec,
  type LayersConfig,
  type RootManifest,
  type WorkspacePackage,
} from './layers/check.ts';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return isRecord(value) ? value : fail(`${path}: expected a JSON object`);
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) return fail(`${where}: expected an array of strings`);
  return value.map((item, index) =>
    typeof item === 'string' ? item : fail(`${where}[${String(index)}]: expected a string`),
  );
}

function mergedDependencies(
  manifest: Record<string, unknown>,
  where: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) return fail(`${where}: "${field}" must be an object`);
    for (const [name, version] of Object.entries(deps)) {
      merged[name] =
        typeof version === 'string' ? version : fail(`${where}: ${field}.${name} must be a string`);
    }
  }
  return merged;
}

function readLayersConfig(path: string): LayersConfig {
  const raw = readJson(path);
  const layers = raw['layers'];
  if (!isRecord(layers)) return fail(`${path}: "layers" must be an object`);
  const parsed: Record<string, LayerSpec> = {};
  for (const [layer, spec] of Object.entries(layers)) {
    if (!isRecord(spec)) return fail(`${path}: layer "${layer}" must be an object`);
    const mayDependOn = spec['mayDependOn'];
    parsed[layer] = {
      packages: stringArray(spec['packages'], `${path}: ${layer}.packages`),
      mayDependOn:
        mayDependOn === '*' ? '*' : stringArray(mayDependOn, `${path}: ${layer}.mayDependOn`),
    };
  }
  return { layers: parsed };
}

function workspaceDirs(path: string): string[] {
  const raw: unknown = parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) return fail(`${path}: expected a mapping`);
  return stringArray(raw['packages'], `${path}: packages`).flatMap((pattern) => {
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      return fail(`${path}: unsupported workspace pattern "${pattern}"; use "<dir>/*"`);
    }
    const parent = pattern.slice(0, -2);
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(posix.join(parent, entry.name, 'package.json')),
      )
      .map((entry) => posix.join(parent, entry.name));
  });
}

function readPackage(dir: string): WorkspacePackage {
  const manifestPath = posix.join(dir, 'package.json');
  const manifest = readJson(manifestPath);
  const name = manifest['name'];
  if (typeof name !== 'string') return fail(`${manifestPath}: "name" must be a string`);

  const tsconfigPath = posix.join(dir, 'tsconfig.json');
  const references: string[] = [];
  if (existsSync(tsconfigPath)) {
    const refs = readJson(tsconfigPath)['references'] ?? [];
    if (!Array.isArray(refs)) return fail(`${tsconfigPath}: "references" must be an array`);
    for (const ref of refs) {
      const refPath: unknown = isRecord(ref) ? ref['path'] : undefined;
      if (typeof refPath !== 'string')
        return fail(`${tsconfigPath}: each reference needs a "path"`);
      references.push(posix.normalize(posix.join(dir, refPath)));
    }
  }
  return { dir, name, dependencies: mergedDependencies(manifest, manifestPath), references };
}

const config = readLayersConfig('layers.json');
const root: RootManifest = {
  dependencies: mergedDependencies(readJson('package.json'), 'package.json'),
};
const packages = workspaceDirs('pnpm-workspace.yaml').map(readPackage);
const violations = checkLayers(config, root, packages);

if (violations.length > 0) {
  for (const violation of violations)
    console.error(`layers: ${violation.kind}: ${violation.message}`);
  process.exitCode = 1;
} else {
  console.log(`layers: ${String(packages.length)} packages, no violations`);
}
