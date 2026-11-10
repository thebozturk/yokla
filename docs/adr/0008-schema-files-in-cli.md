# 0008. Generated JSON Schemas live where packs are assembled

Status: Accepted · Date: 2026-11-10

## Context

ADR-0006 says that the JSON Schema files generated from the Zod schemas are
"committed and shipped in `@yokla/core`". But the profile and case schemas
depend on the loaded packs:
- a domain pack adds its profile section and its expectation keys,
- language packs decide which language codes are valid.

`core` can't import packs (design §6), so it can't produce these schemas.

## Decision

- **The JSON Schema files are generated in the CLI package**, `yokla`, which
  assembles the first-party packs. They live in `packages/cli/schemas/` and
  ship with the `yokla` npm package.
- **`results.v1` is generated in the same place**, although it doesn't depend
  on packs. Every schema file then has one home.
- **A test compares the generated schemas with the committed files.** CI fails
  when they drift. `pnpm test -u` regenerates them.
- This ADR replaces only the sentence in ADR-0006 about where the files ship.
  The rest of ADR-0006 stands.

## Consequences

- **Editors and other tools take the schemas from the `yokla` package.**
- **A third-party pack changes the profile schema.** A user who loads one gets
  an accurate schema from the CLI command that prints it, not from the
  committed files. That command comes with the CLI.

## Alternatives considered

- **Ship base schemas in `core`, with pack sections left open.** The schemas
  would accept any pack section without checking it, so editors couldn't
  catch typos inside them. Rejected.
- **Generate the schemas from a repository script.** The root package may not
  depend on workspace packages (layer rule), so the script would bypass the
  packages' public entry points. Rejected.
