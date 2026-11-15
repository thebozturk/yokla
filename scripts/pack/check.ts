// Pure checks of what a packed package holds (ADR-0034), of a release's
// versions, and of the order to publish in (ADR-0037). No I/O: the caller lists
// the tarball and reads the package.json inside it.

export interface PackedPackage {
  /** Paths inside the tarball, relative to its `package/` folder. */
  readonly files: readonly string[];
  /** The package.json inside the tarball. */
  readonly manifest: Readonly<Record<string, unknown>>;
}

export type ProblemKind =
  | 'missing-file'
  | 'test-file'
  | 'workspace-dependency'
  | 'missing-target'
  | 'unmatched-files-entry'
  | 'unsupported-entry'
  | 'wrong-repository'
  | 'wrong-version'
  | 'private';

export interface Problem {
  readonly kind: ProblemKind;
  readonly subject: string;
  readonly message: string;
}

/** Files every published package holds; `dist/` is a folder with at least one file. */
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dist/'] as const;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A test file: a path with `.test.` in it, or anything under `__snapshots__`. */
export function isTestFile(path: string): boolean {
  return path.includes('.test.') || path.split('/').includes('__snapshots__');
}

function holds(files: ReadonlySet<string>, required: string): boolean {
  if (!required.endsWith('/')) return files.has(required);
  return [...files].some((file) => file.startsWith(required));
}

/** The string targets of `exports`, in order; `null` targets exclude a path and are skipped. */
export function exportTargets(exports: unknown): string[] {
  if (typeof exports === 'string') return [exports];
  if (Array.isArray(exports)) return exports.flatMap(exportTargets);
  if (isRecord(exports)) return Object.values(exports).flatMap(exportTargets);
  return [];
}

function binTargets(bin: unknown): string[] {
  if (typeof bin === 'string') return [bin];
  if (isRecord(bin)) return Object.values(bin).filter((value) => typeof value === 'string');
  return [];
}

function targetProblem(files: ReadonlySet<string>, field: string, target: string): Problem[] {
  if (target.includes('*')) {
    return [
      {
        kind: 'unsupported-entry',
        subject: target,
        message: `${field} target "${target}" is a pattern, which pack-check doesn't resolve`,
      },
    ];
  }
  const path = target.startsWith('./') ? target.slice(2) : target;
  if (files.has(path)) return [];
  return [
    {
      kind: 'missing-target',
      subject: target,
      message: `${field} points to "${target}", which the package doesn't hold`,
    },
  ];
}

/** The repository URL a manifest names, as a string or as `{ url }`. */
export function repositoryUrl(repository: unknown): string | undefined {
  if (typeof repository === 'string') return repository;
  if (isRecord(repository) && typeof repository['url'] === 'string') return repository['url'];
  return undefined;
}

/** Checks a packed package; `repository` is the URL trusted publishing matches it against. */
export function checkPacked(pkg: PackedPackage, repository: string): Problem[] {
  const problems: Problem[] = [];
  const files = new Set(pkg.files);
  const { manifest } = pkg;

  for (const required of REQUIRED) {
    if (!holds(files, required)) {
      problems.push({
        kind: 'missing-file',
        subject: required,
        message: `the package holds no ${required}`,
      });
    }
  }

  for (const file of pkg.files) {
    if (isTestFile(file)) {
      problems.push({ kind: 'test-file', subject: file, message: `${file} is a test file` });
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        problems.push({
          kind: 'workspace-dependency',
          subject: name,
          message: `${field}.${name} is still "${spec}"`,
        });
      }
    }
  }

  const url = repositoryUrl(manifest['repository']);
  if (url !== repository) {
    problems.push({
      kind: 'wrong-repository',
      subject: url ?? '(none)',
      message: `repository is ${url === undefined ? 'missing' : `"${url}"`}, not "${repository}"`,
    });
  }

  for (const target of exportTargets(manifest['exports'])) {
    problems.push(...targetProblem(files, 'exports', target));
  }
  for (const target of binTargets(manifest['bin'])) {
    problems.push(...targetProblem(files, 'bin', target));
  }

  const entries = manifest['files'];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.startsWith('!')) continue;
      if (entry.includes('*')) {
        problems.push({
          kind: 'unsupported-entry',
          subject: entry,
          message: `files entry "${entry}" is a pattern, which pack-check doesn't resolve`,
        });
      } else if (!holds(files, entry) && !holds(files, `${entry}/`)) {
        problems.push({
          kind: 'unmatched-files-entry',
          subject: entry,
          message: `files entry "${entry}" matches nothing in the package`,
        });
      }
    }
  }

  return problems;
}

/** Checks the manifests of a release tagged `tag`: each at the tag's version, none private. */
export function checkRelease(
  manifests: readonly Readonly<Record<string, unknown>>[],
  tag: string,
): Problem[] {
  const problems: Problem[] = [];
  const version = tag.startsWith('v') ? tag.slice(1) : undefined;
  for (const manifest of manifests) {
    const name = String(manifest['name']);
    if (manifest['version'] !== version) {
      problems.push({
        kind: 'wrong-version',
        subject: name,
        message: `${name} is at ${String(manifest['version'])}, and the tag is ${tag}`,
      });
    }
    if (manifest['private'] !== undefined) {
      problems.push({
        kind: 'private',
        subject: name,
        message: `${name} still has "private": ${JSON.stringify(manifest['private'])}`,
      });
    }
  }
  return problems;
}

export interface Publishable {
  readonly name: string;
  /** Every dependency kind merged: name → version spec. */
  readonly dependencies: Readonly<Record<string, string>>;
}

/**
 * The order to publish in: each package after the packages of the release it
 * depends on, otherwise by name. A cycle can't be published one by one.
 */
export function publishOrder(packages: readonly Publishable[]): string[] {
  const remaining = new Map(packages.map((p) => [p.name, Object.keys(p.dependencies)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.every((d) => !remaining.has(d)))
      .map(([name]) => name)
      .toSorted();
    const next = ready[0];
    if (next === undefined) {
      throw new Error(`the packages depend on each other: ${[...remaining.keys()].join(', ')}`);
    }
    order.push(next);
    remaining.delete(next);
  }
  return order;
}
