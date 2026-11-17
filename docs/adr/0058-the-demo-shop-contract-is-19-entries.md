# 0058. The demo-shop's contract is 19 entries

Status: Proposed · Date: 2026-11-17

## Context

ADR-0057's end-to-end test expects the proposal to gain the demo-shop's
contract as 20 entries: 50 of 69 without a model, recall 72.5 %, and 57 of
69 with the fake provider's model step, recall 82.6 %.

The count was wrong. The hand-written contract is 19 entries: its `at` and
18 leaves of its schema. Run on the demo-shop, the proposal gains all 19,
with nothing different and nothing new: 49 of 69 without a model, and 56 of
69 with the model step.

## Decision

- **The end-to-end test expects 19 contract entries:** 49 of 69 without a
  model, precision 100 %, recall 71.0 %; with the fake provider's model
  step, 56 of 69, recall 81.2 %. This amends ADR-0057.
- **Nothing else changes.**

## Consequences

- **Recall rises by 27.5 points on the demo-shop without a model,** from
  43.5 % to 71.0 %, not 29.0.

## Alternatives considered

- **Keeping the numbers in the test and the design only.** The accepted
  ADR's decision would then state an expectation the test doesn't hold.
  Rejected.
