import { describe, expect, it } from 'vitest';
import {
  checkLayers,
  type LayersConfig,
  type RootManifest,
  type ViolationKind,
  type WorkspacePackage,
} from './check.ts';

interface Fixture {
  readonly config: LayersConfig;
  readonly root: RootManifest;
  readonly packages: readonly WorkspacePackage[];
}

const ws = 'workspace:*';

function pkg(
  dir: string,
  name: string,
  deps: Record<string, string> = {},
  references: string[] = [],
): WorkspacePackage {
  return { dir, name, dependencies: deps, references };
}

/** The v0.1 workspace, which satisfies every rule. */
function clean(): Fixture {
  return {
    config: {
      layers: {
        core: { packages: ['@yokla/core'], mayDependOn: [] },
        packs: { packages: ['@yokla/pack-*'], mayDependOn: ['core'] },
        runtime: { packages: ['@yokla/runtime'], mayDependOn: ['core'] },
        report: { packages: ['@yokla/report'], mayDependOn: ['core'] },
        cli: { packages: ['yokla'], mayDependOn: '*' },
        examples: { packages: ['yokla-demo-shop'], mayDependOn: [] },
      },
    },
    root: { dependencies: { typescript: '^7.0.2' } },
    packages: [
      pkg('packages/core', '@yokla/core', { zod: '^4.6.0' }),
      pkg('packages/runtime', '@yokla/runtime', { '@yokla/core': ws }, ['packages/core']),
      pkg('packages/report', '@yokla/report', { '@yokla/core': ws }, ['packages/core']),
      pkg('packs/ecommerce', '@yokla/pack-ecommerce', { '@yokla/core': ws }, ['packages/core']),
      pkg('packs/lang-tr', '@yokla/pack-lang-tr', { '@yokla/core': ws }, ['packages/core']),
      pkg(
        'packages/cli',
        'yokla',
        {
          '@yokla/core': ws,
          '@yokla/runtime': ws,
          '@yokla/report': ws,
          '@yokla/pack-ecommerce': ws,
        },
        ['packages/core', 'packages/runtime', 'packages/report', 'packs/ecommerce'],
      ),
      pkg('examples/demo-shop', 'yokla-demo-shop'),
    ],
  };
}

function run(fixture: Fixture) {
  return checkLayers(fixture.config, fixture.root, fixture.packages);
}

/** Applies a change to a fresh clean fixture and asserts the change took effect. */
function mutate(change: (fixture: Fixture) => Fixture): Fixture {
  const mutated = change(clean());
  expect(JSON.stringify(mutated), 'the mutation must change the fixture').not.toBe(
    JSON.stringify(clean()),
  );
  return mutated;
}

function updatePackage(
  fixture: Fixture,
  name: string,
  change: (p: WorkspacePackage) => WorkspacePackage,
): Fixture {
  expect(
    fixture.packages.some((p) => p.name === name),
    `fixture has ${name}`,
  ).toBe(true);
  return { ...fixture, packages: fixture.packages.map((p) => (p.name === name ? change(p) : p)) };
}

function addDependency(fixture: Fixture, from: string, to: string, toDir: string): Fixture {
  return updatePackage(fixture, from, (p) => ({
    ...p,
    dependencies: { ...p.dependencies, [to]: ws },
    references: [...p.references, toDir],
  }));
}

function kinds(fixture: Fixture): ViolationKind[] {
  return run(fixture).map((v) => v.kind);
}

describe('checkLayers', () => {
  it('accepts the clean v0.1 workspace', () => {
    expect(run(clean())).toEqual([]);
  });

  it('ignores dependencies that are not workspace packages', () => {
    const fixture = clean();
    expect(fixture.packages.find((p) => p.name === '@yokla/core')?.dependencies).toHaveProperty(
      'zod',
    );
    expect(run(fixture)).toEqual([]);
  });

  it('rejects a dependency the layer does not allow (report → runtime)', () => {
    const fixture = mutate((f) =>
      addDependency(f, '@yokla/report', '@yokla/runtime', 'packages/runtime'),
    );
    expect(kinds(fixture)).toEqual(['forbidden-dependency']);
  });

  it('rejects a dependency between packs', () => {
    const fixture = mutate((f) =>
      addDependency(f, '@yokla/pack-ecommerce', '@yokla/pack-lang-tr', 'packs/lang-tr'),
    );
    expect(kinds(fixture)).toEqual(['forbidden-dependency']);
  });

  it('rejects any dependency on the cli', () => {
    const fixture = mutate((f) => addDependency(f, '@yokla/core', 'yokla', 'packages/cli'));
    expect(kinds(fixture)).toEqual(['forbidden-dependency']);
  });

  it('rejects demo-shop depending on yokla', () => {
    const fixture = mutate((f) =>
      addDependency(f, 'yokla-demo-shop', '@yokla/core', 'packages/core'),
    );
    expect(kinds(fixture)).toEqual(['forbidden-dependency']);
  });

  it('rejects a package that belongs to no layer', () => {
    const fixture = mutate((f) => ({
      ...f,
      packages: [...f.packages, pkg('packages/extra', '@yokla/extra')],
    }));
    expect(kinds(fixture)).toEqual(['unassigned-package']);
  });

  it('rejects a package that matches several layers', () => {
    const fixture = mutate((f) => ({
      ...f,
      config: {
        layers: { ...f.config.layers, more: { packages: ['@yokla/core'], mayDependOn: [] } },
      },
    }));
    expect(kinds(fixture)).toEqual(['ambiguous-package']);
  });

  it('rejects a layer rule that names an unknown layer', () => {
    const fixture = mutate((f) => ({
      ...f,
      config: {
        layers: {
          ...f.config.layers,
          report: { packages: ['@yokla/report'], mayDependOn: ['core', 'nope'] },
        },
      },
    }));
    expect(kinds(fixture)).toEqual(['unknown-layer']);
  });

  it('rejects an internal dependency without the workspace: protocol', () => {
    const fixture = mutate((f) =>
      updatePackage(f, '@yokla/runtime', (p) => ({
        ...p,
        dependencies: { '@yokla/core': '^0.0.0' },
      })),
    );
    expect(kinds(fixture)).toEqual(['non-workspace-protocol']);
  });

  it('rejects a workspace dependency without a project reference', () => {
    const fixture = mutate((f) =>
      updatePackage(f, '@yokla/runtime', (p) => ({ ...p, references: [] })),
    );
    expect(kinds(fixture)).toEqual(['missing-reference']);
  });

  it('rejects a project reference without a workspace dependency', () => {
    const fixture = mutate((f) =>
      updatePackage(f, '@yokla/report', (p) => ({
        ...p,
        references: [...p.references, 'packages/runtime'],
      })),
    );
    expect(kinds(fixture)).toEqual(['extra-reference']);
  });

  it('rejects a root manifest that depends on a workspace package', () => {
    const fixture = mutate((f) => ({
      ...f,
      root: { dependencies: { ...f.root.dependencies, '@yokla/core': ws } },
    }));
    expect(kinds(fixture)).toEqual(['root-depends-on-workspace']);
  });
});
