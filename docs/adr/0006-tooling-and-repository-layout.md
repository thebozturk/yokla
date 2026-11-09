# 0006. Tooling and repository layout

Status: Accepted · Date: 2026-11-09

## Context

Scaffolding v0.1 (design §20) needs these decisions:
- the workspace layout,
- the compiler version,
- a test runner,
- lint and formatting,
- a way to enforce the layer rules of design §6 from the first commit,
- a schema library,
- a config format.

The last two are open questions 1 and 2 in design §22.

The state of the TypeScript toolchain on 2026-11-09 shapes the lint decision:
- **TypeScript 7.0**, the native Go port, has been generally available since
  2026-07-08 (7.0.2), and 7.1 is in beta. TypeScript 7.0 has no JavaScript
  compiler API.
- **typescript-eslint** 8.72.1 requires `typescript >=4.8.4 <6.1.0`. Its
  TypeScript 7 support is in progress and targets 7.1, with no date
  ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).
- **tsgolint v7** powers oxlint's type-aware mode. It is stable and built on
  TypeScript 7. It implements 59 of typescript-eslint's 61 type-aware rules,
  including every rule needed to enforce ADR-0002's ban on `any`:
  - the `no-unsafe-*` family,
  - `no-floating-promises`,
  - `no-misused-promises`,
  - `switch-exhaustiveness-check`.

## Decision

### Compiler, lint and formatting

- **TypeScript 7** (`typescript@^7.0.2`) compiles and type-checks, with `tsc -b`.
- **oxlint in type-aware mode** (`oxlint` with `oxlint-tsgolint`) lints.
- **Prettier 3** formats.

### Workspace

- yokla is a plain **pnpm workspace** with **TypeScript project references**.
  There is no task runner: `pnpm -r` runs scripts in dependency order, and
  `tsc -b` orders incremental builds.
- A package is created when the version that needs it starts. v0.1 creates:
  - `packages/core`, `packages/runtime`, `packages/report`, `packages/cli`,
  - `packs/ecommerce`, `packs/lang-tr`, `packs/lang-en`,
  - `examples/demo-shop`.
- **npm names:**
  - Packages are scoped: `@yokla/core`, `@yokla/runtime`, `@yokla/report`,
    `@yokla/pack-ecommerce`, `@yokla/pack-lang-tr` and `@yokla/pack-lang-en`.
    Later packages use the same scope.
  - The CLI is published as `yokla`.
  - Third-party packs keep the `yokla-pack-*` convention (design §17).
- Each package compiles `src/` to `dist/`. Only the entry points listed in its
  `exports` field are public. Tests run against the sources and need no build.
- **Compiler options**, on top of `strict`:
  - `noUncheckedIndexedAccess`,
  - `exactOptionalPropertyTypes`,
  - `noImplicitOverride`,
  - `verbatimModuleSyntax`,
  - `erasableSyntaxOnly`,
  - `module: nodenext`.
- **Supply chain:**
  - `packageManager` pins the pnpm version.
  - Dependency install scripts stay blocked (pnpm's default). They run only
    for packages allowed by name.
  - `minimumReleaseAge` is 7 days.

### Tests

- **Vitest 5** runs the tests, with one project per package. Coverage uses the
  V8 provider.
- The mutation tests of design §10 mutate inputs, for example the price in an
  answer, not code. A small in-repo helper writes them and asserts that each
  mutation was applied. v0.1 uses no code-mutation tool such as Stryker.
- **fast-check** writes property tests where round trips matter: money
  parsing and formatting, and case and diacritic folding.

### Layer enforcement

Three mechanisms enforce the layer rules. All of them run in `pnpm lint` and
in CI.

1. **A manifest check.** `layers.json` mirrors the layer table of design §6 and
   is the single source for tooling. `scripts/check-layers.ts` fails when:
   - a package depends on a `@yokla/*` package that its layer may not use,
   - a package's project `references` don't match its `@yokla/*` dependencies,
   - the root `package.json` depends on a workspace package,
   - `examples/demo-shop` depends on any `@yokla/*` package. The demo-shop is the
     system under test. If it imported yokla, the self-test would be circular.

   pnpm doesn't hoist workspace packages, so neither `tsc` nor Node.js can
   resolve a `@yokla/*` package that isn't declared. The declared dependencies
   are therefore the real import graph.
2. **No deep imports.** The `exports` field exposes only public entry points.
3. **Lint rules on code** (`no-restricted-imports`, `no-restricted-globals`):
   - `core` and `packs/*` are pure. They use no Node.js built-in modules, no
     `fetch` and no `process`.
   - Only `runtime` may access the network, and later also `proxy`. This covers
     `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`,
     `node:dgram`, `node:dns`, `undici`, `fetch` and `WebSocket`. Every code
     path that can reach the network lives in these packages. This backs the
     egress guarantee of ADR-0003 in the source code, not only in the egress
     test.

### Schemas

- **Zod 4** schemas in `core` are the single source of truth for the profile,
  case, config and results formats. TypeScript types come from `z.infer`.
- **JSON Schema files** (draft 2020-12):
  - `z.toJSONSchema` generates them.
  - They are committed and shipped in `@yokla/core`.
  - CI fails when the committed files drift from the source.
  - Editors use them for completion and validation.
- Persisted schemas use no transforms or preprocessing, so they convert to JSON
  Schema exactly.
- Objects are strict. An unknown key, usually a typo, is an error, not silently
  ignored.
- Domain packs add their profile fields by extending the core schema
  (design §17).

### Config format

- **People write YAML 1.2:** `yokla.profile.yaml`, `yokla.config.yaml` and
  `cases/*.yaml`. yokla also accepts `.yml` and JSON. Results are JSON.
- **The `yaml` package parses them with the YAML 1.2 core schema**, so `no`,
  `on` and `y` stay strings (YAML 1.1 turns them into booleans). The parser
  also:
  - treats duplicate keys as errors,
  - caps alias expansion,
  - disables custom tags.
- Validation errors point to `file:line:column`. yokla maps the schema error
  path to the position of the YAML node.
- Every file carries a `version` field.
- Secrets are never written in these files. They are referenced from the
  environment (design §15). The reference syntax is defined with the profile
  schema.

## Consequences

- **The TypeScript JavaScript API is unavailable.** No tool that depends on it
  (typescript-eslint, ts-morph, API Extractor) can be used until TypeScript 7
  provides one.
- **The type-aware lint setup is unproven on this workspace.** oxlint's
  type-aware mode has been stable only since mid-2026, and its documentation
  doesn't state whether it supports project references. The scaffolding step
  checks this first. If oxlint can't check the workspace, a new ADR moves to
  TypeScript 6.0 with ESLint and typescript-eslint. The source code stays the
  same, because every compiler option above also exists in TypeScript 6.0.
- **Security fixes in dependencies arrive later.** The 7-day minimum release
  age delays them. An urgent fix can be exempted by name with
  `minimumReleaseAgeExclude`.
- **Pack authors write Zod schemas.** Consumers of JSON Schema get generated
  files.
- **A task runner can be added later.** Turborepo, for example, would not
  change the layout.

## Alternatives considered

### Compiler and lint

- **TypeScript 6.0 with ESLint and typescript-eslint.** This is the most
  mature setup. But 6.0 is the last JavaScript-based release, a bridge to 7, so
  starting on it would commit the project to a migration. It is kept as the
  fallback.
- **TypeScript 7 for compiling and TypeScript 6 for typescript-eslint.** Two
  compilers whose type results can differ. Rejected.
- **Biome.** It lints and formats with one fast tool. But its type-aware rules
  rely on its own type inference, not on the TypeScript checker. Rejected for
  linting.

### Workspace

- **Turborepo, Nx.** Caching and task graphs don't pay off at this size, and Nx
  brings its own set of concepts. Rejected for now.

### Tests

- **`node:test`.** It adds no dependency. But its runner for multiple
  packages, its coverage and its ergonomics are weaker. Rejected.
- **Jest.** Its ESM support still relies on Node.js's experimental VM modules.
  Rejected.

### Layer enforcement

- **dependency-cruiser.** It repeats what pnpm isolation and the manifest
  check already give, in another rule language. Rejected.
- **eslint-plugin-boundaries.** It needs ESLint. Rejected.

### Schemas

- **TypeBox.** It is JSON Schema native and a strong runner-up. But its error
  messages are rawer, and pack authors know it less well. Rejected.
- **Valibot.** Its small bundle size doesn't matter for a CLI. Rejected.
- **Ajv with hand-written JSON Schema.** This makes two sources of truth.
  Rejected.

### Config format

- **TypeScript or JavaScript config files.** They execute code. That conflicts
  with ADR-0002, where users don't write TypeScript. Running a config from a
  pull request in CI is also a security risk. Rejected.
- **TOML.** It is awkward for nested lists, such as the turns of a case.
  Rejected.
- **JSON only.** It has no comments, and multi-line text is awkward. Rejected as
  the authoring format, but accepted as input.
