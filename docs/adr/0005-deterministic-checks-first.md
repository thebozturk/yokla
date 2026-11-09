# 0005. Deterministic checks first; the LLM judge is calibrated and non-gating

Status: Accepted · Date: 2026-11-09

## Context

Most LLM evaluation relies on LLM-as-judge rubrics. Judges are expensive,
non-deterministic and can be gamed, and they fail silently when their own
behaviour drifts. For the facts that matter most in commerce (price, stock,
discounts, shipping, returns, warranty), a rule over the structured evidence is
both cheaper and more reliable than a model's opinion.

## Decision

- A dimension that a rule can check over evidence, data or proxy records is
  checked deterministically. Examples: price matches the authoritative price,
  no availability claim when stock is unknown, policy claims need a source,
  canary-based injection detection, system-prompt n-gram leakage, seeded-PII
  leakage.
- The LLM judge is used only for dimensions with no deterministic check
  (helpfulness, tone, faithfulness of free text).
- **Calibration.** Every run that uses the judge includes a calibration set of
  seeded cases. If any of them is misjudged, the judge's scores for that run are
  discarded and reported as `unmeasured`.
- **Not gating by default.** Judge-based dimensions don't gate unless the user
  opts in per dimension.
- **The judge model must differ from the target's model,** and the user
  chooses it (ADR-0003).

## Consequences

- Packs carry much of the value: money parsing, policy-claim patterns,
  refusal lexicons. They need careful, narrow detectors with unit and mutation
  tests (design §10).
- Some quality dimensions are reported but not enforced until the user trusts
  the judge on their data.
- Runs are cheaper and reproducible. Most gates involve no model call besides
  the target's own.

## Alternatives considered

- **Judge everything with a strong model.** Rejected: cost, non-determinism, and
  a failure mode (judge drift) that is invisible without calibration.
- **Deterministic checks only.** Rejected: tone and helpfulness matter, and
  rules can't measure them well.
