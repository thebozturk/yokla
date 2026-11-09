# 0003. Zero data egress by default

Status: Accepted · Date: 2026-11-09

## Context

yokla reads source code, prompts and business data, and records what the target
sends to its model provider. Users in regulated environments (KVKK, GDPR,
PCI DSS) can't let any of that leave the machine without an explicit decision.

Tools in this space often fall back to a vendor-operated service for
generation or grading when no local model is configured. Their telemetry
opt-outs don't always stop every event. Opt-out is hard to get right. yokla treats it as a product
feature instead.

## Decision

- yokla has **no telemetry**. If telemetry is ever added, it is opt-in, off by
  default, and documented field by field.
- yokla contacts **only** these hosts:
  - the target URLs from the profile,
  - the model proxy's configured upstreams,
  - the model providers the user configures for yokla's own analysis,
    generation, attacks and judging.
- There is no yokla-operated remote service, and no fallback to one.
- An **egress test** in CI runs the full demo-shop suite behind a network guard
  and fails if any other host is contacted.

## Consequences

- Attack generation and judging always use a model the user chooses, local or
  remote. Some attack strategies that other tools run on hosted fine-tuned
  models will be weaker or missing. This is an accepted trade-off.
- The egress test is part of the release gate, not a promise in a README.
- Version checks, if ever added, follow the same opt-in rule.

## Alternatives considered

- **On by default with an opt-out.** This is the industry norm. Rejected: it
  makes yokla unusable in the environments it targets until someone audits it.
- **An optional hosted generation service.** Not rejected forever, but it would
  only ever be a separate, explicit, opt-in configuration, and is out of scope
  for v1.
