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
| [0007](0007-results-schema-and-interop.md) | yokla owns its results schema; other tools are reached by mapping | Accepted; amended by 0092 |
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
| [0028](0028-the-simulated-customer.md) | The simulated customer, and yokla's own model calls | Accepted; amended by 0099, 0105 |
| [0029](0029-model-calls-from-opentelemetry-spans.md) | Model calls read from OpenTelemetry spans | Accepted |
| [0030](0030-generic-checks.md) | Generic checks: patterns, JSON Schema, similarity, and checks the user writes | Accepted |
| [0031](0031-tokens-yokla-obtains.md) | Authentication: tokens yokla obtains and refreshes | Accepted |
| [0032](0032-gemini.md) | Gemini: the model proxy and yokla's own calls | Accepted |
| [0033](0033-where-a-failure-arose.md) | Where a failure arose: the origin of the value a finding names | Accepted |
| [0034](0034-publishing-to-npm.md) | Publishing to npm | Accepted; amended by 0047 |
| [0035](0035-the-smallest-failing-conversation.md) | The smallest failing conversation: yokla shrink | Accepted; amended by 0036 |
| [0036](0036-shrink-keeps-whole-messages-by-default.md) | yokla shrink keeps whole messages by default | Accepted |
| [0037](0037-the-first-publish-of-the-npm-names.md) | The first publish of the npm names | Accepted; amended by 0071 |
| [0038](0038-stopping-once-a-failure-is-settled.md) | Stopping a case's samples once its failure is settled | Accepted; amended by 0039 |
| [0039](0039-a-majority-failure-in-the-demo-shop.md) | A majority-of-N failure in the demo-shop | Accepted |
| [0040](0040-recorded-model-calls-replayed.md) | Recorded model calls, replayed | Accepted |
| [0041](0041-yokla-as-an-mcp-server.md) | yokla as an MCP server for coding agents | Accepted |
| [0042](0042-comparing-models-through-the-proxy.md) | Comparing models through the proxy | Accepted; amended by 0043, 0045 |
| [0043](0043-tool-results-changed-by-the-proxy.md) | Tool results changed by the proxy | Accepted |
| [0044](0044-a-search-for-untried-paths.md) | A search for untried paths | Accepted; amended by 0046 |
| [0045](0045-robustness-transforms-of-a-cases-messages.md) | Robustness transforms of a case's messages | Accepted; amended by 0106, 0107 |
| [0046](0046-intents-that-state-what-they-ask.md) | Intents that state what they ask, across the catalog's types | Accepted; amended by 0048 |
| [0047](0047-the-analyzer-deterministic-first.md) | The analyzer, deterministic first: inventory, data and probes | Accepted; amended by 0066, 0067, 0068 |
| [0048](0048-intents-ask-as-a-shopper-names-things.md) | Intents ask as a shopper names things | Accepted; amended by 0050, 0052 |
| [0049](0049-the-analyzer-reads-code-and-docs.md) | The analyzer reads code and docs: values a model finds, verified in their source | Accepted; amended by 0051, 0072, 0074 |
| [0050](0050-a-type-asked-by-its-catalog-label.md) | A type asked by its catalog label | Accepted |
| [0051](0051-replies-the-analyzer-could-not-read.md) | Replies the analyzer couldn't read, and tokens counted as code takes them | Accepted |
| [0052](0052-the-currency-code-turn-where-a-dropped-bound-shows.md) | The currency-code turn where a dropped bound shows | Accepted |
| [0053](0053-cases-the-data-no-longer-holds.md) | Cases the data no longer holds: fixture-missing | Accepted; amended by 0054, 0055 |
| [0054](0054-an-absent-type-found-at-any-level.md) | An absent type is found at any level of a catalog type | Accepted |
| [0055](0055-cases-generated-from-the-catalog.md) | Cases generated from the catalog: yokla generate | Accepted; amended by 0056 |
| [0056](0056-type-padding-shows-in-a-short-result.md) | Type padding shows in a short result, not an empty band | Accepted |
| [0057](0057-the-response-contract-from-a-contract-file.md) | The response contract from a contract file, verified against the answers | Accepted; amended by 0058 |
| [0058](0058-the-demo-shop-contract-is-19-entries.md) | The demo-shop's contract is 19 entries | Accepted |
| [0059](0059-paraphrase-and-code-switching-by-a-model.md) | Paraphrase and code-switching, written by a model | Accepted; amended by 0060, 0099 |
| [0060](0060-a-rewrite-adds-nothing-and-keeps-its-language.md) | A rewrite adds nothing, and keeps its language | Accepted |
| [0061](0061-negated-stock-wording-and-products-only-named.md) | Negated stock wording, and products the answer only names | Accepted |
| [0062](0062-generated-cases-name-products-in-stock.md) | Generated cases name products in stock | Accepted |
| [0063](0063-a-generated-name-names-one-product.md) | A generated name names one product, and "cheaper" has an answer | Accepted; amended by 0064 |
| [0064](0064-a-cheaper-follow-up-says-cheaper-than-what.md) | A cheaper follow-up says cheaper than what | Accepted |
| [0065](0065-data-from-outside-the-repository.md) | Data from outside the repository, and a comparison without the contract | Accepted; amended by 0066 |
| [0066](0066-a-large-catalog-read-whole.md) | A large catalog read whole, and a contract that is a schema | Accepted |
| [0067](0067-an-evidence-field-read-as-a-number-or-from-a-fallback.md) | An evidence field read as a number, or from a fallback | Accepted |
| [0068](0068-an-evidence-field-left-undecided-names-its-candidates.md) | An evidence field left undecided names its candidates | Accepted |
| [0069](0069-the-model-proxy-reads-an-ai-sdk-gateway.md) | The model proxy reads an AI SDK gateway | Accepted |
| [0070](0070-v0-4-ships-with-one-criterion-partly-met.md) | v0.4 ships with one exit criterion partly met | Accepted |
| [0071](0071-a-new-package-reserved-before-it-ships-and-a-release-that-resumes.md) | A new package reserved before it ships, and a release that resumes | Accepted |
| [0072](0072-the-model-step-reads-the-likely-files-first.md) | The model step reads the likely files first, and answers at length | Accepted; amended by 0073, 0099 |
| [0073](0073-marked-files-smallest-first.md) | Marked files go smallest first | Accepted |
| [0074](0074-a-number-written-with-digit-separators.md) | A number written with digit separators | Accepted |
| [0075](0075-a-turn-says-what-kind-of-request-it-is.md) | A turn says what kind of request it is | Accepted |
| [0076](0076-a-case-carries-a-weight.md) | A case carries a weight | Accepted |
| [0077](0077-tags-group-the-summary-and-select-a-run.md) | Tags group the summary and select a run | Accepted |
| [0078](0078-a-cached-reply-needs-no-key.md) | A cached reply needs no key | Accepted |
| [0079](0079-the-red-team-track.md) | The red-team track: v0.5 in seven items | Accepted; amended by 0081 |
| [0080](0080-attack-cases-from-templates.md) | Attack cases from templates (R1) | Accepted |
| [0081](0081-the-red-team-track-widened.md) | The red-team track, widened | Accepted |
| [0082](0082-more-attack-kinds-from-templates.md) | More attack kinds from templates (R1b) | Accepted |
| [0083](0083-leakage-and-another-customers-data.md) | Leakage and another customer's data (R2) | Accepted |
| [0084](0084-encoding-and-wrapping-strategies.md) | Encoding and wrapping strategies (R3) | Accepted |
| [0085](0085-injection-through-tools-and-memory.md) | Injection through tools and memory (R4) | Accepted |
| [0086](0086-agency-and-authority.md) | Agency and authority (R4b) | Accepted |
| [0087](0087-an-attacker-model.md) | An attacker model (R5) | Accepted; amended by 0099, 0101, 0102, 0104 |
| [0088](0088-more-attacker-strategies.md) | More attacker strategies (R5b) | Accepted; amended by 0101, 0102, 0104 |
| [0089](0089-findings-mapped-to-frameworks.md) | Findings mapped to frameworks (R6) | Accepted |
| [0090](0090-a-calibrated-judge.md) | A calibrated judge (R7) | Accepted; amended by 0099 |
| [0091](0091-more-judge-dimensions.md) | More judge dimensions (R7b) | Accepted; amended by 0100 |
| [0092](0092-the-ecosystem-track.md) | The ecosystem track: v0.6 in six items | Accepted |
| [0093](0093-a-library-api.md) | A library API (E1) | Accepted |
| [0094](0094-a-github-action.md) | A GitHub Action and CI recipes (E2) | Accepted |
| [0095](0095-two-runs-side-by-side.md) | Two runs side by side (E3) | Accepted |
| [0096](0096-export.md) | Export (E4) | Accepted |
| [0097](0097-import.md) | Import (E5) | Accepted |
| [0098](0098-a-documentation-site.md) | A documentation site (E6) | Accepted |
| [0099](0099-replies-cut-at-maxtokens-in-every-role.md) | Replies cut at maxTokens, in every role of yokla's own models | Accepted |
| [0100](0100-judged-defects-answer-in-words-of-their-own.md) | The demo-shop's judged defects answer in words of their own | Accepted |
| [0101](0101-an-attacker-reply-that-is-not-the-attack.md) | An attacker's reply that isn't the attack | Accepted; amended by 0104 |
| [0102](0102-the-demo-shop-reads-an-instruction-as-a-model-words-it.md) | The demo-shop reads an instruction as a model words it | Accepted; amended by 0103 |
| [0103](0103-the-demo-shop-reads-an-instruction-that-points-back-to-its-code.md) | The demo-shop reads an instruction that points back to its code | Accepted |
| [0104](0104-the-attackers-prompt-is-written-in-english.md) | The attacker's prompt is written in English | Accepted |
| [0105](0105-the-demo-shop-adds-to-the-cart-only-when-asked-to.md) | The demo-shop adds to the cart only when asked to | Accepted |
| [0106](0106-the-demo-shop-reads-a-typo-not-another-word.md) | The demo-shop reads a typo, not another word | Accepted; amended by 0107 |
| [0107](0107-the-demo-shop-reads-a-word-in-its-own-language.md) | The demo-shop reads a word in its own language | Accepted |
| [0108](0108-the-demo-shop-reads-a-short-english-word-not-the-start-of-another.md) | The demo-shop reads a short English word, not the start of another | Proposed |

## Template

```markdown
# NNNN. Title

Status: Proposed · Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
```
