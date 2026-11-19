# 0071. A new package reserved before it ships, and a release that resumes

Status: Accepted · Date: 2026-11-19 · Amends 0037

## Context

The v0.4.0 release (ADR-0070) failed halfway.

- **The release workflow published seven packages,** in dependency order,
  with provenance: `@yokla/core` to `@yokla/runtime`.
- **The eighth, `@yokla/analyzer`, got a 404.** It was added after 0.3.0
  (ADR-0047) and had never been published. Trusted publishing can't make a
  package's first version, which is why ADR-0037 reserved each name with a
  placeholder published from the maintainer's machine. That was done once,
  for the eight packages of the time. Nothing checked it for the ninth.
- **The CLI, `yokla`, was never published,** since it comes last. `npx
  yokla` still installs 0.3.0.
- **The workflow can't finish what it started.** Run again, it would try
  to publish `@yokla/core@0.4.0` again, which npm refuses, and stop there.

## Decision

### A package not on npm stops the release before the tag

- **`pnpm pack-check --release` checks that each published package's name
  is on the registry.** A name that isn't stops it, and the message names
  ADR-0037's steps: a placeholder published once from the maintainer's
  machine, deprecated, then a trusted publisher and two-factor
  authentication.
- **It runs before the tag,** as the release procedure already runs
  pack-check (ADR-0034), so a new package is found while nothing is
  published yet.

### The release workflow skips a version already published

- **Before each `npm publish`,** the workflow asks the registry for that
  name and version.
  - **Not there:** it publishes, as now.
  - **There, with the same tarball integrity:** it skips it and says so.
    That is what a resumed release finds.
  - **There, with another integrity:** it stops. Something else was
    published under that version, and nothing should paper over it.
- **A failed release can then be run again** from its tag, once its cause
  is fixed, and publishes only what is missing.

### v0.4 is finished as 0.4.1

- **The workflow at the v0.4.0 tag can't resume,** since it predates this
  ADR. v0.4 is released again as 0.4.1, every package, after
  `@yokla/analyzer` is reserved.
- **0.4.0 stays as it is:** seven packages without the CLI that uses them.
  Its changelog entry says so.

## Consequences

- **A new package is found before a release starts,** not halfway through
  it.
- **A release that stops halfway can be finished** by running it again.
- **pack-check needs the registry for one more question,** which it
  already does to install the outside dependencies.
- **ADR-0037's placeholder step** applies to every new package, not only to
  the first eight.

## Alternatives considered

- **Publish the missing packages from the maintainer's machine.** That
  breaks ADR-0034's rule that every real version comes from CI with
  provenance. Rejected.
- **Unpublish the seven packages and run 0.4.0 again.** npm doesn't allow a
  version number to be reused once unpublished. Rejected.
- **Skip any version already published, without comparing.** A different
  tarball under the same version would go unnoticed. Rejected.
