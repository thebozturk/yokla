// Pure check of what a packed package holds (ADR-0034). No I/O: the caller
// lists the tarball and reads the package.json inside it.

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
  | 'unsupported-entry';

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

export function checkPacked(pkg: PackedPackage): Problem[] {
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
