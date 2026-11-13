# Architecture decision records

Each ADR records one decision: its context, the decision itself, its
consequences and the alternatives that were considered. ADRs are never edited
to say something new. To change a decision, write a new ADR that supersedes the
old one.

**Statuses:**
- `Proposed`: written, not yet accepted.
- `Accepted`: in force.
- `Superseded by NNNN`: replaced by a later ADR.
- `Amended by NNNN`: a later ADR replaces part of it; the rest stands.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-license-apache-2.md) | Apache-2.0 licence | Accepted |
| [0002](0002-typescript-node.md) | TypeScript on Node.js; targets are tested over HTTP | Accepted |
| [0003](0003-zero-egress-by-default.md) | Zero data egress by default | Accepted |
| [0004](0004-expectations-from-claims-and-data.md) | Expectations come from claims and data, not the implementation | Accepted |
| [0005](0005-deterministic-checks-first.md) | Deterministic checks first; the LLM judge is calibrated and non-gating | Accepted |
| [0006](0006-tooling-and-repository-layout.md) | Tooling and repository layout | Accepted; amended by 0008 |
| [0007](0007-results-schema-and-interop.md) | yokla owns its results schema; other tools are reached by mapping | Accepted |
| [0008](0008-schema-files-in-cli.md) | Generated JSON Schemas live where packs are assembled | Accepted |
| [0009](0009-observation-from-target-logs.md) | Observing the target through its own logs | Accepted |
| [0010](0010-gate-thresholds-and-baseline.md) | The gate: thresholds per suite, a baseline, and three exit codes | Accepted; amended by 0011 |
| [0011](0011-baseline-file-and-case-definitions.md) | The baseline file, and cases compared only while their definition holds | Accepted |
| [0012](0012-model-proxy-process-routing-and-records.md) | The model proxy: a standalone process, routing, records and correlation | Accepted |
| [0013](0013-fault-plans.md) | Fault plans: provider faults per turn, injected by the model proxy | Accepted; amended by 0017 |
| [0014](0014-budgets-and-plan.md) | Budgets: cost and latency thresholds, unmeasured thresholds, plan and cap | Accepted |
| [0015](0015-prompt-inspection.md) | Prompt inspection: what the proxy captures, what is stored, and four checks | Accepted |
| [0016](0016-streaming-targets-sessions-and-calls-after-the-answer.md) | Streaming targets, session setup, and model calls after the answer | Accepted |
| [0017](0017-fault-jitter-seed.md) | Fault jitter seeded by case, sample and turn | Accepted |
| [0018](0018-init-and-starter-cases.md) | yokla init: a profile from one message, and starter cases | Accepted; amended by 0019 |
| [0019](0019-edge-case-turns-judged-on-handling.md) | An edge-case turn is judged on whether the target handled it | Accepted |
| [0020](0020-richer-evidence-mapping.md) | Richer evidence mapping: several paths, availability, price sources, component text | Accepted |

## Template

```markdown
# NNNN. Title

Status: Proposed · Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
```
