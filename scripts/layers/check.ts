// Pure layer-rule check (ADR-0006). No I/O: the caller reads the files.

export interface LayerSpec {
  /** Package names in this layer. A trailing `*` matches a prefix. */
  readonly packages: readonly string[];
  /** Layers this layer may depend on, or `*` for every layer. */
  readonly mayDependOn: readonly string[] | '*';
}

export interface LayersConfig {
  readonly layers: Readonly<Record<string, LayerSpec>>;
}

export interface WorkspacePackage {
  /** Directory relative to the repository root, with `/` separators. */
  readonly dir: string;
  readonly name: string;
  /** All dependency kinds merged: name → version spec. */
  readonly dependencies: Readonly<Record<string, string>>;
  /** Project reference targets, relative to the repository root. */
  readonly references: readonly string[];
}

export interface RootManifest {
  /** All dependency kinds merged: name → version spec. */
  readonly dependencies: Readonly<Record<string, string>>;
}

export type ViolationKind =
  | 'unknown-layer'
  | 'unassigned-package'
  | 'ambiguous-package'
  | 'forbidden-dependency'
  | 'non-workspace-protocol'
  | 'missing-reference'
  | 'extra-reference'
  | 'root-depends-on-workspace';

export interface Violation {
  readonly kind: ViolationKind;
  readonly subject: string;
  readonly message: string;
}

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

function layersOf(config: LayersConfig, name: string): string[] {
  return Object.entries(config.layers)
    .filter(([, spec]) => spec.packages.some((pattern) => matches(pattern, name)))
    .map(([layer]) => layer);
}

export function checkLayers(
  config: LayersConfig,
  root: RootManifest,
  packages: readonly WorkspacePackage[],
): Violation[] {
  const violations: Violation[] = [];

  for (const [layer, spec] of Object.entries(config.layers)) {
    if (spec.mayDependOn === '*') continue;
    for (const target of spec.mayDependOn) {
      if (!(target in config.layers)) {
        violations.push({
          kind: 'unknown-layer',
          subject: layer,
          message: `layer "${layer}" may depend on "${target}", which is not a layer`,
        });
      }
    }
  }

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const layerByName = new Map<string, string>();
  for (const pkg of packages) {
    const layers = layersOf(config, pkg.name);
    const [only] = layers;
    if (only === undefined) {
      violations.push({
        kind: 'unassigned-package',
        subject: pkg.name,
        message: `${pkg.name} (${pkg.dir}) belongs to no layer; add it to layers.json`,
      });
    } else if (layers.length > 1) {
      violations.push({
        kind: 'ambiguous-package',
        subject: pkg.name,
        message: `${pkg.name} matches several layers: ${layers.join(', ')}`,
      });
    } else {
      layerByName.set(pkg.name, only);
    }
  }

  for (const pkg of packages) {
    const layer = layerByName.get(pkg.name);
    const spec = layer === undefined ? undefined : config.layers[layer];
    const expectedReferences = new Set<string>();

    for (const [dep, version] of Object.entries(pkg.dependencies)) {
      const target = byName.get(dep);
      if (target === undefined) continue;
      expectedReferences.add(target.dir);

      if (!version.startsWith('workspace:')) {
        violations.push({
          kind: 'non-workspace-protocol',
          subject: pkg.name,
          message: `${pkg.name} depends on ${dep} with "${version}"; use the workspace: protocol`,
        });
      }

      const targetLayer = layerByName.get(dep);
      if (spec === undefined || targetLayer === undefined || spec.mayDependOn === '*') continue;
      if (!spec.mayDependOn.includes(targetLayer)) {
        violations.push({
          kind: 'forbidden-dependency',
          subject: pkg.name,
          message: `${pkg.name} (layer "${layer ?? '?'}") may not depend on ${dep} (layer "${targetLayer}")`,
        });
      }
    }

    const actualReferences = new Set(pkg.references);
    for (const dir of expectedReferences) {
      if (!actualReferences.has(dir)) {
        violations.push({
          kind: 'missing-reference',
          subject: pkg.name,
          message: `${pkg.dir}/tsconfig.json lacks a project reference to ${dir}`,
        });
      }
    }
    for (const dir of actualReferences) {
      if (!expectedReferences.has(dir)) {
        violations.push({
          kind: 'extra-reference',
          subject: pkg.name,
          message: `${pkg.dir}/tsconfig.json references ${dir}, which is not a workspace dependency`,
        });
      }
    }
  }

  for (const dep of Object.keys(root.dependencies)) {
    if (byName.has(dep)) {
      violations.push({
        kind: 'root-depends-on-workspace',
        subject: dep,
        message: `the root package.json depends on workspace package ${dep}; this would make it visible to every package`,
      });
    }
  }

  return violations;
}
