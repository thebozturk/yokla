# 0007. yokla owns its results schema; other tools are reached by mapping

Status: Accepted · Date: 2026-11-09

## Context

yokla writes one results file per run (design §16). Reports and the gate read
it, and so do baseline comparisons. Design §18 promises import from and export
to other evaluation tools. Open question 3 in design §22 asks whether the
results file should extend another tool's results format or only map to it.

Other tools' results formats are built around their own concepts:
- **Their rows are different.** A typical row is one prompt × test × provider,
  with a boolean verdict, a score and free-form metadata.
- **Many embed the tool's own configuration.** That configuration often
  includes prompts and providers, which yokla doesn't have.
- **They change with the tool's releases.** Some have no runtime schema.
- **Several yokla concepts have no native place:**
  - aggregation per dimension,
  - `unmeasured`, `fixture-missing`, `known-gap` and `gap-closed`,
  - how many samples a check applied to,
  - the profile hash, snapshot provenance and correlation mode.

## Decision

- **yokla defines its own results schema, `results.v1`.** The Zod schema in
  `core` is the source of truth, and the JSON Schema is generated from it
  (ADR-0006). Every results file carries `schema: "yokla.results/v1"`.
- **Versioning.**
  - Within v1, changes only add optional fields.
  - Any other change is a new major version, `v2`.
  - Readers reject a major version they don't know.
- **Statuses, dimensions and check applicability are first-class fields.**
  The gate reads only `results.v1`.
- **Other tools are reached only through mapping.** Each tool gets its own
  `interop-<tool>` package (v0.5).
  - **Export.** It writes the other tool's format. The mapping is lossy: what
    the tool can't express goes into a yokla-specific metadata field. A
    documented table lists every field.
  - **Import.** Each of the other tool's results becomes a sample, and each
    assertion becomes a finding. Imported cases carry `source: import`.
- **Mapping tests use fixtures written from the other tool's published
  format.** yokla never runs another tool to produce them.

## Consequences

- **Other tools' releases don't change yokla's results contract.** No other
  tool's release cadence forces a change to `results.v1`.
- **Another tool can't open a yokla results file directly.** The user runs the
  export first.
- **Each mapping must be maintained** as the other format evolves. A mapping
  lives in one package with its own tests and doesn't touch `core`.
- **`results.v1` stays free of `any`.** ADR-0002's rule holds.

## Alternatives considered

- **Make yokla's results valid files of another tool's format, with a yokla
  extension field.** The other tool could open them directly, but this has
  costs:
  - yokla's core contract would depend on a third-party format.
  - First-class statuses would live in free-form metadata, where the gate
    would have to read them.
  - Loosely typed fields would conflict with ADR-0002.

  Rejected.
- **No interoperability.** Rejected: principle P8.
