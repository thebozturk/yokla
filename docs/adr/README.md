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
| [0020](0020-richer-evidence-mapping.md) | Richer evidence mapping: several paths, availability, price sources, component text | Accepted; amended by 0021 |
| [0021](0021-price-times-quantity-and-item-text.md) | A price times a stated quantity, and text that belongs to one item | Accepted |
| [0022](0022-totals-of-the-answers-own-amounts.md) | A total of the answer's own amounts | Accepted |
| [0023](0023-static-html-report.md) | A static HTML report | Accepted |
| [0024](0024-websocket-targets.md) | WebSocket targets | Accepted |
| [0025](0025-tool-calls.md) | Tool calls: what the proxy reads, and the checks on them | Accepted |
| [0026](0026-evidence-from-tool-results.md) | Evidence from the tool results the model saw | Accepted |
| [0027](0027-a-product-named-by-the-start-of-its-name.md) | A product named by the start of its name | Accepted |
| [0028](0028-the-simulated-customer.md) | The simulated customer, and yokla's own model calls | Accepted |
| [0029](0029-model-calls-from-opentelemetry-spans.md) | Model calls read from OpenTelemetry spans | Accepted |
| [0030](0030-generic-checks.md) | Generic checks: patterns, JSON Schema, similarity, and checks the user writes | Accepted |
| [0031](0031-tokens-yokla-obtains.md) | Authentication: tokens yokla obtains and refreshes | Accepted |
| [0032](0032-gemini.md) | Gemini: the model proxy and yokla's own calls | Accepted |
| [0033](0033-where-a-failure-arose.md) | Where a failure arose: the origin of the value a finding names | Accepted |
| [0034](0034-publishing-to-npm.md) | Publishing to npm | Accepted |
| [0035](0035-the-smallest-failing-conversation.md) | The smallest failing conversation: yokla shrink | Accepted; amended by 0036 |
| [0036](0036-shrink-keeps-whole-messages-by-default.md) | yokla shrink keeps whole messages by default | Accepted |
| [0037](0037-the-first-publish-of-the-npm-names.md) | The first publish of the npm names | Accepted |
| [0038](0038-stopping-once-a-failure-is-settled.md) | Stopping a case's samples once its failure is settled | Accepted; amended by 0039 |
| [0039](0039-a-majority-failure-in-the-demo-shop.md) | A majority-of-N failure in the demo-shop | Accepted |
| [0040](0040-recorded-model-calls-replayed.md) | Recorded model calls, replayed | Accepted |
| [0041](0041-yokla-as-an-mcp-server.md) | yokla as an MCP server for coding agents | Accepted |
| [0042](0042-comparing-models-through-the-proxy.md) | Comparing models through the proxy | Accepted; amended by 0043, 0045 |
| [0043](0043-tool-results-changed-by-the-proxy.md) | Tool results changed by the proxy | Accepted |
| [0044](0044-a-search-for-untried-paths.md) | A search for untried paths | Accepted |
| [0045](0045-robustness-transforms-of-a-cases-messages.md) | Robustness transforms of a case's messages | Accepted |
| [0047](0047-the-analyzer-deterministic-first.md) | The analyzer, deterministic first: inventory, data and probes | Proposed |

## Template

```markdown
# NNNN. Title

Status: Proposed · Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
```
