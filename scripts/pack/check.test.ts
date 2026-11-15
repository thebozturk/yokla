import { describe, expect, it } from 'vitest';
import {
  checkPacked,
  checkRelease,
  exportTargets,
  isTestFile,
  publishOrder,
  repositoryUrl,
  type PackedPackage,
  type ProblemKind,
} from './check.ts';

const REPO = 'git+https://github.com/owner/repo.git';

/** A package shaped like the CLI, which satisfies every rule. */
function clean(): PackedPackage {
  return {
    files: [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/bin.js',
      'src/index.ts',
      'src/bin.ts',
      'schemas/results.v1.schema.json',
    ],
    manifest: {
      name: 'yokla',
      version: '0.3.0',
      exports: {
        '.': {
          '@yokla/source': './src/index.ts',
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
        './internal/*': null,
      },
      bin: { yokla: './dist/bin.js' },
      files: ['dist', '!dist/**/*.test.*', 'src', '!src/**/*.test.*', 'schemas'],
      dependencies: { '@yokla/core': '0.3.0', zod: '^4.6.7' },
      repository: { type: 'git', url: REPO, directory: 'packages/cli' },
    },
  };
}

function withFiles(change: (files: string[]) => string[]): PackedPackage {
  const base = clean();
  const files = change([...base.files]);
  expect(files).not.toEqual(base.files);
  return { ...base, files };
}

function withManifest(change: (manifest: Record<string, unknown>) => void): PackedPackage {
  const base = clean();
  const manifest = structuredClone(base.manifest) as Record<string, unknown>;
  change(manifest);
  expect(manifest).not.toEqual(base.manifest);
  return { ...base, manifest };
}

function kinds(pkg: PackedPackage): ProblemKind[] {
  return checkPacked(pkg, REPO).map((problem) => problem.kind);
}

function subjects(pkg: PackedPackage): string[] {
  return checkPacked(pkg, REPO).map((problem) => problem.subject);
}

describe('checkPacked', () => {
  it('finds nothing in a package that holds what it should', () => {
    expect(checkPacked(clean(), REPO)).toEqual([]);
  });

  it.each(['package.json', 'README.md', 'LICENSE'])('requires %s', (file) => {
    const pkg = withFiles((files) => files.filter((path) => path !== file));
    expect(checkPacked(pkg, REPO)).toContainEqual(
      expect.objectContaining({ kind: 'missing-file', subject: file }),
    );
  });

  it('requires a file under dist', () => {
    const pkg = withFiles((files) => files.filter((path) => !path.startsWith('dist/')));
    expect(checkPacked(pkg, REPO)).toContainEqual(
      expect.objectContaining({ kind: 'missing-file', subject: 'dist/' }),
    );
  });

  it('does not take a file named like a folder for the folder', () => {
    const pkg = withFiles((files) => [
      ...files.filter((path) => !path.startsWith('dist/')),
      'dist',
    ]);
    expect(subjects(pkg)).toContain('dist/');
  });

  it('reports each test file', () => {
    const pkg = withFiles((files) => [
      ...files,
      'dist/run.test.js',
      'src/run.test.ts',
      'src/__snapshots__/report.html',
    ]);
    expect(checkPacked(pkg, REPO).filter((problem) => problem.kind === 'test-file')).toEqual([
      expect.objectContaining({ subject: 'dist/run.test.js' }),
      expect.objectContaining({ subject: 'src/run.test.ts' }),
      expect.objectContaining({ subject: 'src/__snapshots__/report.html' }),
    ]);
  });

  it.each(['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'])(
    'reports a workspace: spec left in %s',
    (field) => {
      const pkg = withManifest((manifest) => {
        manifest[field] = { '@yokla/runtime': 'workspace:*' };
      });
      expect(checkPacked(pkg, REPO)).toEqual([
        expect.objectContaining({ kind: 'workspace-dependency', subject: '@yokla/runtime' }),
      ]);
      expect(checkPacked(pkg, REPO)[0]?.message).toContain(`${field}.@yokla/runtime`);
    },
  );

  it('accepts other specs, and ignores a field that is not an object and a spec that is not a string', () => {
    const pkg = withManifest((manifest) => {
      manifest['dependencies'] = { a: '1.0.0', b: 'npm:c@^2', d: 'file:workspace:x' };
      manifest['peerDependencies'] = ['workspace:*'];
      manifest['optionalDependencies'] = { e: ['workspace:*'] };
    });
    expect(checkPacked(pkg, REPO)).toEqual([]);
  });

  it('reports an exports target the package does not hold', () => {
    const pkg = withFiles((files) => files.filter((path) => path !== 'dist/index.d.ts'));
    expect(checkPacked(pkg, REPO)).toEqual([
      expect.objectContaining({ kind: 'missing-target', subject: './dist/index.d.ts' }),
    ]);
  });

  it('reports a source export when src is left out', () => {
    const pkg = withFiles((files) => files.filter((path) => path !== 'src/index.ts'));
    expect(subjects(pkg)).toEqual(['./src/index.ts']);
  });

  it('reports a bin target the package does not hold, as a record or a string', () => {
    const missing = withFiles((files) => files.filter((path) => path !== 'dist/bin.js'));
    expect(checkPacked(missing, REPO)).toEqual([
      expect.objectContaining({ kind: 'missing-target', subject: './dist/bin.js' }),
    ]);
    expect(checkPacked(missing, REPO)[0]?.message).toMatch(/^bin points to/);

    const asString = withManifest((manifest) => {
      manifest['bin'] = './dist/cli.js';
    });
    expect(subjects(asString)).toEqual(['./dist/cli.js']);
  });

  it('ignores a bin entry that is not a path', () => {
    const pkg = withManifest((manifest) => {
      manifest['bin'] = { yokla: './dist/bin.js', other: 7 };
    });
    expect(checkPacked(pkg, REPO)).toEqual([]);
  });

  it('reads a target without a leading ./', () => {
    const pkg = withManifest((manifest) => {
      manifest['bin'] = { yokla: 'dist/bin.js' };
    });
    expect(checkPacked(pkg, REPO)).toEqual([]);
  });

  it('reports a pattern target instead of passing it', () => {
    const pkg = withManifest((manifest) => {
      manifest['exports'] = { './*': './dist/*.js' };
    });
    expect(checkPacked(pkg, REPO)).toEqual([
      expect.objectContaining({ kind: 'unsupported-entry', subject: './dist/*.js' }),
    ]);
  });

  it('reports a files entry that matches nothing', () => {
    const pkg = withFiles((files) => files.filter((path) => !path.startsWith('schemas/')));
    expect(checkPacked(pkg, REPO)).toEqual([
      expect.objectContaining({ kind: 'unmatched-files-entry', subject: 'schemas' }),
    ]);
  });

  it('matches a files entry that names a file', () => {
    const pkg = withManifest((manifest) => {
      manifest['files'] = ['dist', 'src', 'schemas', 'README.md'];
    });
    expect(checkPacked(pkg, REPO)).toEqual([]);
  });

  it('does not take a name that starts like the entry for the entry', () => {
    const pkg = withFiles((files) => [
      ...files.filter((path) => !path.startsWith('schemas/')),
      'schemas-old/a.json',
    ]);
    expect(subjects(pkg)).toEqual(['schemas']);
  });

  it('reports a pattern files entry, and skips negations and non-strings', () => {
    const pkg = withManifest((manifest) => {
      manifest['files'] = ['dist', 'src', 'schemas', 'dist/*.js', '!nothing', 7];
    });
    expect(checkPacked(pkg, REPO)).toEqual([
      expect.objectContaining({ kind: 'unsupported-entry', subject: 'dist/*.js' }),
    ]);
  });

  it('ignores a files field that is not a list', () => {
    const pkg = withManifest((manifest) => {
      manifest['files'] = 'nothing';
    });
    expect(checkPacked(pkg, REPO)).toEqual([]);
  });

  it('reports every problem, not only the first', () => {
    const pkg: PackedPackage = {
      files: ['package.json', 'dist/x.test.js'],
      manifest: { dependencies: { a: 'workspace:^' }, bin: './dist/bin.js', files: ['src'] },
    };
    expect(kinds(pkg)).toEqual([
      'missing-file',
      'missing-file',
      'test-file',
      'workspace-dependency',
      'wrong-repository',
      'missing-target',
      'unmatched-files-entry',
    ]);
  });
});

describe('the repository', () => {
  it('reports a package that names another repository', () => {
    const pkg = withManifest((manifest) => {
      manifest['repository'] = { type: 'git', url: 'git+https://github.com/other/repo.git' };
    });
    expect(checkPacked(pkg, REPO)).toEqual([
      expect.objectContaining({
        kind: 'wrong-repository',
        subject: 'git+https://github.com/other/repo.git',
      }),
    ]);
  });

  it('reports a package that names none', () => {
    const pkg = withManifest((manifest) => {
      delete manifest['repository'];
    });
    expect(checkPacked(pkg, REPO)).toEqual([
      expect.objectContaining({ kind: 'wrong-repository', subject: '(none)' }),
    ]);
    expect(checkPacked(pkg, REPO)[0]?.message).toBe(`repository is missing, not "${REPO}"`);
  });

  it('reads the repository as a string or as { url }', () => {
    expect(repositoryUrl(REPO)).toBe(REPO);
    expect(repositoryUrl({ url: REPO })).toBe(REPO);
    expect(repositoryUrl({ url: 7 })).toBeUndefined();
    expect(repositoryUrl(undefined)).toBeUndefined();
    const asString = withManifest((manifest) => {
      manifest['repository'] = REPO;
    });
    expect(checkPacked(asString, REPO)).toEqual([]);
  });
});

function at(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: `p-${version}`, version, ...extra };
}

describe('checkRelease', () => {
  it('finds nothing when every package is at the tag and none is private', () => {
    expect(checkRelease([at('0.3.0'), at('0.3.0')], 'v0.3.0')).toEqual([]);
  });

  it('reports a package at another version', () => {
    expect(checkRelease([at('0.3.0'), at('0.2.0')], 'v0.3.0')).toEqual([
      expect.objectContaining({ kind: 'wrong-version', subject: 'p-0.2.0' }),
    ]);
  });

  it.each(['V0.3.0', '0.3.0'])('reports every package when the tag %s has no leading v', (tag) => {
    expect(checkRelease([at('0.3.0'), at('.3.0')], tag)).toHaveLength(2);
  });

  it('says which version and which tag', () => {
    expect(checkRelease([at('0.3.0')], '0.3.0')).toEqual([
      expect.objectContaining({
        kind: 'wrong-version',
        message: 'p-0.3.0 is at 0.3.0, and the tag is 0.3.0',
      }),
    ]);
  });

  it.each([true, false])('reports a package that still sets private: %s', (value) => {
    expect(checkRelease([at('0.3.0', { private: value })], 'v0.3.0')).toEqual([
      expect.objectContaining({ kind: 'private', subject: 'p-0.3.0' }),
    ]);
  });
});

describe('publishOrder', () => {
  it('puts each package after the ones it depends on, otherwise by name', () => {
    expect(
      publishOrder([
        { name: 'yokla', dependencies: { '@yokla/runtime': '0.3.0', '@yokla/core': '0.3.0' } },
        { name: '@yokla/runtime', dependencies: { '@yokla/core': '0.3.0', zod: '^4' } },
        { name: '@yokla/pack-tr', dependencies: { '@yokla/core': '0.3.0' } },
        { name: '@yokla/core', dependencies: { zod: '^4', yaml: '^2' } },
      ]),
    ).toEqual(['@yokla/core', '@yokla/pack-tr', '@yokla/runtime', 'yokla']);
  });

  it('orders by name when nothing depends on anything', () => {
    expect(
      publishOrder([
        { name: 'c', dependencies: {} },
        { name: 'a', dependencies: {} },
        { name: 'b', dependencies: {} },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('refuses a cycle', () => {
    expect(() =>
      publishOrder([
        { name: 'a', dependencies: { b: '1' } },
        { name: 'b', dependencies: { a: '1' } },
        { name: 'c', dependencies: {} },
      ]),
    ).toThrow('the packages depend on each other: a, b');
  });
});

describe('isTestFile', () => {
  it.each([
    'src/run.test.ts',
    'dist/run.test.js',
    'dist/run.test.d.ts.map',
    'src/__snapshots__/report.html',
    'run.test.ts',
  ])('takes %s for a test file', (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    'src/run.ts',
    'src/testing.ts',
    'src/testing/ws-server.ts',
    'dist/test-net.js',
    'src/test.ts',
    'src/latest.ts',
    'src/contest/index.ts',
    'src/snapshots/a.ts',
  ])('does not take %s for a test file', (path) => {
    expect(isTestFile(path)).toBe(false);
  });
});

describe('exportTargets', () => {
  it('collects strings from strings, arrays and nested conditions, in order', () => {
    expect(
      exportTargets({
        '.': { types: './a.d.ts', default: ['./a.js', { node: './b.js' }] },
        './x': './x.js',
        './y': null,
        './z': 3,
      }),
    ).toEqual(['./a.d.ts', './a.js', './b.js', './x.js']);
  });

  it('finds nothing in an absent field', () => {
    expect(exportTargets(undefined)).toEqual([]);
  });
});
