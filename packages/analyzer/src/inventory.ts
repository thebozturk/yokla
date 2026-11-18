// The inventory (ADR-0047): the target's repository listed and sorted into
// kinds, deterministically and without a model. yokla's own files are left
// out, so the analyzer never reads the profile it is measured against.

import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { namesJsonSchemaDialect, type InventoryKind } from '@yokla/core';
import { parse } from 'yaml';

export interface InventoryFile {
  /** Its path in the repository, with "/" between folders. */
  readonly path: string;
  readonly kind: InventoryKind;
  readonly bytes: number;
}

export interface Inventory {
  readonly files: readonly InventoryFile[];
  /** Files left out: binary, too large, or yokla's own. */
  readonly skipped: number;
  /** The listing stopped at the file cap. */
  readonly capped: boolean;
}

/** Larger files are left out. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Folders of version control, dependencies and build output, and yokla's own. */
const SKIPPED_FOLDERS = new Set([
  'node_modules',
  'vendor',
  'venv',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  'target',
  'runs',
  'yokla-data',
]);

/** yokla's own files: a profile, a configuration or a baseline. */
const YOKLA_FILE = /^yokla\.(?:profile(?:\.[\w-]+)*|config|baseline)\.(?:ya?ml|json)$/u;

/** Environment files that may hold secrets; their examples are listed. */
const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?$/u;

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.rs',
  '.swift',
  '.scala',
]);

const MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'build.gradle',
  'gemfile',
  'composer.json',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc']);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a file looks binary: a zero byte in its first 8 KiB. */
function isBinary(path: string): boolean {
  const buffer = Buffer.alloc(8192);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** A YAML or JSON file's top level, or undefined when it can't be read as one. */
function topLevel(path: string): unknown {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** A yokla case file: its top level holds `version` and `cases`. */
function isCaseFile(top: unknown): boolean {
  return isObject(top) && 'version' in top && 'cases' in top;
}

function kindOf(path: string, folders: readonly string[], top: unknown): InventoryKind {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  if (/^\.env\.(?:example|sample|template)$/u.test(name) || name.endsWith('.env.example')) {
    return 'env-example';
  }
  if (MANIFESTS.has(name) || /^requirements.*\.txt$/u.test(name)) return 'manifest';
  if (name.includes('prompt') || folders.includes('prompts')) return 'prompt';
  if (name.startsWith('readme') || DOC_EXTENSIONS.has(extension) || folders.includes('docs')) {
    return 'doc';
  }
  // A file that names the schema it follows is not a schema (ADR-0066).
  if (isObject(top) && ('openapi' in top || 'swagger' in top || namesJsonSchemaDialect(top))) {
    return 'contract';
  }
  if (extension === '.jsonl' || extension === '.csv') return 'data';
  if (extension === '.json' && Array.isArray(top) && top.length > 0 && top.every(isObject)) {
    return 'data';
  }
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  return 'other';
}

const STRUCTURED = new Set(['.json', '.yaml', '.yml']);

/**
 * The repository's files, sorted by path, each with its kind and size. Stops
 * at `maxFiles`. Hidden folders, links, and the folders of dependencies,
 * builds and yokla's runs are not entered.
 */
export function inventory(dir: string, maxFiles: number): Inventory {
  const files: InventoryFile[] = [];
  let skipped = 0;
  let capped = false;
  const walk = (folder: string): void => {
    const entries = readdirSync(folder, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (capped) return;
      const path = join(folder, entry.name);
      // A link is neither a folder nor a file here: it is never followed.
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)) walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      // Never opened: it may hold secrets.
      if (ENV_FILE.test(entry.name)) {
        skipped += 1;
        continue;
      }
      const bytes = lstatSync(path).size;
      const extension = extname(entry.name).toLowerCase();
      const top = STRUCTURED.has(extension) && bytes <= MAX_FILE_BYTES ? topLevel(path) : undefined;
      if (
        YOKLA_FILE.test(entry.name) ||
        isCaseFile(top) ||
        bytes > MAX_FILE_BYTES ||
        (bytes > 0 && isBinary(path))
      ) {
        skipped += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        capped = true;
        return;
      }
      const inRepo = relative(dir, path).split(sep);
      files.push({ path: inRepo.join('/'), kind: kindOf(path, inRepo.slice(0, -1), top), bytes });
    }
  };
  walk(dir);
  return { files, skipped, capped };
}
