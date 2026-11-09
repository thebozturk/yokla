# Architecture decision records

Each ADR records one decision: its context, the decision itself, its
consequences and the alternatives that were considered. ADRs are never edited
to say something new. To change a decision, write a new ADR that supersedes the
old one.

**Statuses:**
- `Proposed`: written, not yet accepted.
- `Accepted`: in force.
- `Superseded by NNNN`: replaced by a later ADR.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-license-apache-2.md) | Apache-2.0 licence | Accepted |
| [0002](0002-typescript-node.md) | TypeScript on Node.js; targets are tested over HTTP | Accepted |
| [0003](0003-zero-egress-by-default.md) | Zero data egress by default | Accepted |
| [0004](0004-expectations-from-claims-and-data.md) | Expectations come from claims and data, not the implementation | Accepted |
| [0005](0005-deterministic-checks-first.md) | Deterministic checks first; the LLM judge is calibrated and non-gating | Accepted |

## Template

```markdown
# NNNN. Title

Status: Proposed · Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
```
