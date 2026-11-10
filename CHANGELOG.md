# Changelog

Notable changes per version. Versions follow the roadmap in
[design §20](docs/design.md#20-roadmap); a version ships when its exit criteria
hold.

## 0.1.0 — 2026-11-10

The core: test an assistant over HTTP with a hand-written profile, and judge
its answers deterministically against your data.

**Exit criteria.**
- **Every demo-shop defect is detected.** The demo-shop has eight seeded
  defects. Each is caught by exactly its own check on exactly the expected
  cases, and the defect-free run passes every case. CI runs this matrix on
  Node.js 24 and 26.
- **A real assistant was tested with a hand-written profile.** It is a private
  production e-commerce assistant, tested both without and with model calls.

### Added

- **Schemas.**
  - `profile.v1`, `cases.v1`, `config.v1`, `results.v1` and
    `baseline.v1` are defined in Zod, and their JSON Schemas are generated
    (`yokla schema <name>`).
  - Config files are YAML 1.2, and problems are reported as `file:line:column`.
- **HTTP adapter.**
  - Request templates and a response mapping, with evidence fields, fallbacks
    and conversions.
  - A request id header, and server-issued ids carried between turns.
  - Client sessions.
- **Runner.**
  - A token bucket per second, minute and hour, and `429` handling with
    `Retry-After` and tiered headers in seconds or milliseconds.
  - An optional TEST-NET client identity per case.
  - A cache bypass by header or by a local command (an argument list, never a
    shell).
  - Samples and concurrency.
  - Clarifying questions are recognised by route.
- **Observation from the target's logs (ADR-0009).**
  - Reads a log file or a local command once after the run.
  - Ties each turn to its line by request id, target id or order.
  - Totals the mapped fields. A sum with an unmeasured value is null, not a
    smaller number.
- **Checks.** Deterministic, with `applicable: false` when their input is
  absent.
  - Core: route, answer text, evidence counts.
  - E-commerce:
    - prices,
    - stock claims,
    - policy claims against their sources,
    - over-refusal and refusal correctness,
    - filter honesty,
    - product types,
    - duplicates,
    - absent types,
    - deflection (advisory).
- **Language packs.** Turkish and English: folding, money, durations, and
  refusal, inability, absence, alternative, free and deflection wording.
- **Aggregation.**
  - Policies per dimension: worst of N, majority of N, advisory.
  - Wilson intervals and unstable cases.
  - `unmeasured` never counts as a pass.
- **Reports.** A terminal summary and JUnit XML, from the results file alone
  (`yokla report`, `yokla run --junit`). They never contain the target's
  answers.
- **Gate (ADR-0010, ADR-0011).**
  - `yokla gate` checks thresholds per suite from `yokla.config.yaml`, and
    regressions against a baseline.
  - It exits with `0` passed, `1` broken, or `2` when the run can't be judged.
  - `yokla baseline` writes `yokla.baseline.json`, which can be committed, and
    shows what changed.
  - A case is compared with the baseline only while its definition holds.
- **demo-shop.** A reference target with eight seeded defects and the
  acceptance cases.
- **Egress test (ADR-0003).** The demo-shop suite, the gate and the baseline
  run behind a network guard that allows only the demo-shops. The guard has
  its own tests.
