# 0057. The response contract from a contract file, verified against the answers

Status: Proposed · Date: 2026-11-17

## Context

The analyzer's proposal misses the response contract (ADR-0047, ADR-0049):
on the demo-shop, `target.response.schema` is 20 of the 69 entries the
hand-written profile holds, the most of anything it misses. ADR-0049 left it
out of the model step: a model words a schema its own way, and a schema read
from code types would make the code define an expectation (ADR-0004). It
left the contract to "contract files, in a later ADR".

A contract file is a claim the target's team publishes: an OpenAPI document
or a JSON Schema. The inventory already finds them, as kind `contract`, by
their `openapi`, `swagger` or `$schema` key. And the analyzer has what can
check one: the probes' answers (ADR-0047), the very documents the contract
describes.

## Decision

### Where the contract comes from

- **The inventory's `contract` files,** JSON or YAML:
  - **an OpenAPI 3 document:** the operation the target's request calls.
    Its path is the request url's, after any path a `servers` url holds, and
    a `{parameter}` matches one segment. Its method is the request's, POST
    by default. Its response is the lowest 2xx status it gives, else `2XX`,
    else `default`, as `application/json` or another `+json` type.
  - **a JSON Schema document:** the whole of it.
- **Swagger 2 is left out.** Its shape differs, and newer tooling writes
  OpenAPI 3.
- **No model and no cost.** It is part of the deterministic step, before the
  model step (ADR-0049).

### Made into what yokla checks

- **References stay inside the schema** (ADR-0030). The OpenAPI components
  a schema refers to go into its `$defs`, and each `$ref` is rewritten to
  point there; a JSON Schema keeps its own.
- **OpenAPI 3.0's dialect is translated:** `nullable: true` adds `null` to
  the type, and `example` and `x-` extensions are dropped. Each dropped
  keyword is listed in the report.
- **A schema core can't check is not proposed.** Its problems, as
  `json-schema` reports them, go to the report.

### Where it applies

- **At the answer.** `at` is the deepest object path that the probed text
  path and every probed evidence path share, such as `$.data` for
  `$.data.answer` and `$.data.products[*]`, where the schema describes an
  object along that path. The schema proposed is the part that describes
  it, with the `$defs` it refers to. Without such a path, `at` is `$` and the
  schema is the whole response's.

### Verified, before it is proposed

- **Every probe answer must match it.** Each answer the probes got, read as
  `yokla run` reads it, is checked against the schema at `at` with core's
  `json-schema` check. One violation and the contract is not proposed: a
  contract the target doesn't keep would fail every run.
- **The report lists each violation** by its path and keyword, never the
  answer's values, so a person can fix the contract or the target.
- **The answers are kept in memory only** for this check; nothing of them
  is written.

### What is proposed

- **One contract:** the first that is verified, the OpenAPI operations
  before the JSON Schema documents, each kind by path.
- **The entry** is `target.response.schema`, `{ at, schema }`, inline, with
  provenance source `contract` and, as evidence, the file and what in it was
  read, such as `openapi.json: POST /v1/chat 200 application/json`.
- **The report gains `contracts`,** additively: each contract file read,
  with the operation, `at`, and whether it was proposed, matched no
  operation, couldn't be checked or was violated, with why.

### The demo-shop

- **It gains `openapi.json`,** describing `POST /v1/chat`: its 200 answer is
  `{ data: ChatAnswer }`, and `ChatAnswer` is what the hand-written
  profile's contract states.
- **The end-to-end test, at no model cost:**
  - the proposal gains the contract, its 20 entries all the hand-written
    profile's: 50 of 69 without a model, precision 100 %, recall 72.5 %;
    with the fake provider's model step, 57 of 69, recall 82.6 %;
  - on a copy whose contract requires a field the answers lack, the
    contract is not proposed, and the report names the violation by path;
  - nothing is contacted but the shop, and the fake provider for the model
    step.

### Layers

- **`core`:** reading an OpenAPI operation and a JSON Schema into a schema
  core checks, the `$defs`, the translation and `at`. All pure.
- **`@yokla/analyzer`:** reading the contract files, keeping the probes'
  answers, the verification and the report.

## Consequences

- **The contract a target publishes becomes its proposed contract,** but
  only where its answers keep it: a stale contract is named, not proposed.
- **Recall rises by the contract** on a target that publishes one. On the
  demo-shop, from 43.5 % to 72.5 % without a model.
- **A contract is only as wide as the probes.** Three answers can't show a
  field that is required but absent from answers the probes never reach. A
  person approves the entry, and every run checks it.
- **analysis.v1 gains `contracts`,** additively.

## Alternatives considered

- **Proposing the contract unverified.** A contract can be stale, or
  describe another version of the API; every run would then fail on it.
  Rejected: the probes' answers decide.
- **Pointing at the file with `schemaFile`.** A whole OpenAPI document isn't
  a schema, and the measure compares the schema's entries. Rejected: the
  schema is proposed inline.
- **Inferring the contract from the answers.** Three answers show values,
  not what the target promises, and the expectation would come from the
  target's behaviour. Rejected.
- **Swagger 2.** Left out, as above.
