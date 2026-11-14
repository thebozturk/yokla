# 0034. Publishing to npm

Status: Accepted · Date: 2026-11-15

## Context

v0.3 plans publishing to npm, so a team can run yokla with `npx yokla` and
build on its packages.

The workspace already builds as packages would ship:

- each package has `exports`, `files` and its own `dist`;
- the CLI's `bin` is `yokla`.

Every package is `private: true`, and nothing tests what a published package
would hold.

Publishing makes the code public, so it waits on decisions that are the
maintainer's:

- **making the repository public;**
- **cleaning its history** of other tools' names first (CLAUDE.md);
- **holding the names on npm:** `yokla`, and the `@yokla` scope.

## Decision

### What is published

- **Eight packages, one version.**
  - The CLI is `yokla`.
  - The others are `@yokla/core`, `@yokla/runtime`, `@yokla/proxy`,
    `@yokla/report`, `@yokla/pack-ecommerce`, `@yokla/pack-lang-tr` and
    `@yokla/pack-lang-en`.
  - They are released together, with one version: 0.3.0 for v0.3.
  - A dependency between them is that exact version; pnpm writes it in place
    of `workspace:*`.
- **What a package holds:**
  - `dist`, with its type declarations;
  - its `src` without tests, so source and declaration maps lead somewhere;
  - a short README and the licence;
  - for the CLI, its JSON Schemas.
- **Nothing else.** Not tests, the demo-shop, the docs or the workspace's
  configuration.
- **Not published:** the demo-shop and the scripts.

### A check before anything is public

- **`pnpm pack-check`, run in CI.** It packs every package into a temporary
  folder, then reads each tarball:
  - it holds `dist`, the README and the licence, and no test file;
  - its `package.json` has no `workspace:` dependency;
  - its `exports` and `bin` point to files it holds.
- **A smoke test from the tarballs.** It installs them into an empty project,
  with only their outside dependencies taken from the registry. There, it
  runs:
  - `yokla --version`;
  - `yokla schema results`;
  - `yokla run` of a starter case against the demo-shop.

  It shows the published shape works, without publishing anything.

### How a release is published, once it may be

- **From CI, never from a laptop.** A release workflow runs on a `v*` tag:
  `pnpm check`, then `pnpm pack-check`, then
  `pnpm -r publish --access public --provenance`.
- **No long-lived token.** npm's trusted publishing, from the repository's
  workflow, with a provenance statement for each package.
- **The version and the changelog** come from the tag, and one release entry
  names what the version adds.

### What waits for the maintainer

The packages stay `private: true`, and the release workflow publishes nothing,
until the maintainer:

1. **decides** to make the repository public;
2. **cleans the history** of other tools' names, with the force push that
   takes;
3. **holds** `yokla` and the `@yokla` scope on npm, and turns on trusted
   publishing for the repository;
4. **asks** for the release.

Removing `private` is then that release's last change.

## Consequences

- **`npx yokla` works once the release is out,** with every package at one
  version.
- **Third-party packs and the library API** (v0.6) can depend on
  `@yokla/core`.
- **The published shape is tested from now on,** so a broken package shows in
  CI and not after a release.
- **v0.3 ships only when the maintainer makes the code public.** Until then,
  every other v0.3 criterion holds on the main branch.

## Alternatives considered

- **One bundled package.** It is simpler to install. But packs and the
  library API need `@yokla/core` as a package of its own. Rejected.
- **Unscoped names,** such as `yokla-core`. Anyone could take a name next to
  ours. A scope can't be squatted. Rejected.
- **Publishing from a maintainer's machine.** It needs a token on that machine,
  and it gives no provenance. Rejected.
- **Independent versions per package.** They need a way to say which versions
  go together, and the packages change together. Rejected for now.
