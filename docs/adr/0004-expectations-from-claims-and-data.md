# 0004. Expectations come from claims and data, not the implementation

Status: Accepted · Date: 2026-11-09

## Context

yokla analyzes the target project and generates scenarios. The easy path is to
read the code and write down what it does. But a test whose expectation comes
from the implementation encodes the implementation's bugs as correct
behaviour, and then defends them. Research on LLM-generated tests reports the
same failure: assertions inferred from the current code reproduce existing
defects.

## Decision

- **Expectations come from claims and data.** Claims are what the system says
  it does: docs, prompts, API contract, stated policies. Data is the target's
  own data, for example the catalog snapshot. Code answers only
  *measurability* questions: where the price field is, how to bypass the
  cache, which provider the app uses.
- When a behaviour is defined only by code, the profile records it as
  `claim: implicit`. It becomes an expectation only after a person approves it.
- Every profile entry and generated case carries `source`, `evidence` and
  `status` (`proposed | approved | rejected`). Only approved cases gate.
- Data-grounded cases record the data facts they depend on. When the data
  changes, they become `fixture-missing` instead of failing.

## Consequences

- yokla needs a review step (`yokla profile review`, case approval). Fully
  unattended generation can explore, but it can't gate.
- Some useful expectations need a person to approve them. This is an accepted
  cost.
- Exit criteria for the analyzer are measured against a hand-written profile
  (design §20).

## Alternatives considered

- **Derive expectations from code and accept the risk.** Rejected: the tool
  would certify existing bugs.
- **Only black-box probing of the live target.** Rejected as
  the primary mode, because free-text purpose descriptions can't produce
  computed expectations. It is kept as the fallback when no repository is
  available.
