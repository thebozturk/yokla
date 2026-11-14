# 0037. The first publish of the npm names

Status: Proposed · Date: 2026-11-15

## Context

ADR-0034 publishes every release from CI with npm's trusted publishing:

- **no long-lived token;**
- **never from a laptop.**

Since then, three things are known:

- **The repository is public,** and its history is clean of other tools'
  names.
- **The maintainer holds the `@yokla` scope** on npm.
- **A trusted publisher needs a package that already exists.** npm can attach
  one only to a package that is on the registry. Its `npm trust` command lists
  that as a prerequisite. None of the eight names is published yet, so the
  first version can't come through trusted publishing.

Two more facts about trusted publishing shape the release:

- **A new trusted publisher expires** if it hasn't published within two days.
- **Only the npm CLI** documents the exchange of the workflow's identity for a
  publish.

## Decision

### Reserve each name once, with a placeholder

- **The maintainer's machine publishes version 0.0.0 of each of the eight
  names, once.** The publish uses the maintainer's own npm login, with
  two-factor authentication. No token is created or stored.
- **A placeholder holds no code.** It holds only:
  - a `package.json` with the name, `0.0.0`, the licence and the repository;
  - a README that says the name is reserved for yokla and that the first
    release is 0.3.0;
  - the licence.

  It has no `bin`, no `exports` and no dependencies.
- **Each placeholder is deprecated** right after it is published. The message
  points to the first release.
- **This is the only publish that doesn't come from CI.**

### Then trusted publishing, as ADR-0034 says

- **Each package gets one trusted publisher,** set with `npm trust github`:
  - the repository `thebozturk/yokla`;
  - the workflow `release.yml`;
  - the environment `npm`;
  - `--allow-publish`.
- **Then tokens are refused:** each package requires two-factor
  authentication and disallows tokens.
- **The `npm` environment on GitHub needs the maintainer's approval,** so no
  release publishes without them.
- **The trusted publishers are set only when the release is ready to be
  tagged,** so the two-day window can't expire.

### The release publishes the tarballs pack-check checked

- **The release workflow runs on a `v*` tag,** in the `npm` environment. Its
  steps are:
  - `pnpm check`;
  - `pnpm pack-check`, with the tarballs kept;
  - `npm publish` of each tarball, with `id-token: write`.
- **What is published is what was checked:** the same tarballs.
- **npm's own CLI exchanges the workflow's identity,** and the provenance
  statement comes with it.
- **Order:** `@yokla/core` first, the CLI last, so no package is published
  before what it depends on.
- **`repository` field:** each package gains one, which trusted publishing
  matches against the workflow.
- **pack-check also checks that field:** it points to this repository.

This replaces ADR-0034's `pnpm -r publish --access public --provenance`. The
rest of ADR-0034 stands.

## Consequences

- **The names are held from the first step on.** Nobody else can publish
  under `yokla` while the release is prepared.
- **Every real version comes from CI, with provenance.** 0.0.0 is the only
  exception. It holds no code, and it is deprecated.
- **No token exists at any point.** The only credential outside CI is the
  maintainer's own login, used once.
- **Until 0.3.0 is out, `npx yokla` finds a placeholder.** It has no command,
  and the deprecation message says so.

## Alternatives considered

- **A short-lived granular token for the first release from CI.** It keeps
  every publish in CI. But for a day a token exists that can publish all eight
  packages, kept as a repository secret. Rejected: the placeholder needs no
  token at all.
- **Publishing 0.3.0 itself from the maintainer's machine.** It reserves the
  names and releases at once. But the first real version would come without
  provenance, from a machine CI never checked. Rejected.
- **`pnpm -r publish` under trusted publishing.** pnpm's documentation
  doesn't describe the identity exchange. Publishing the checked tarballs
  with npm avoids depending on it. Rejected for now.
