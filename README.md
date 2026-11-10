# yokla

> *yokla* (Turkish): to probe, to check by touch, as in *nabzını yoklamak*,
> "to take someone's pulse".

**Status: early development (v0.1 in progress). Nothing is published yet.**

yokla is an open-source tool for testing conversational AI assistants end to
end: answer quality, factual safety, red teaming, robustness, performance and
cost, resilience and regression gates, in one run.

- **Reads your project.** It reads the code, API contract, prompts, data schema
  and docs, and writes a system profile that you review.
- **Grounds scenarios in your data.** Expected behaviour is computed from the
  data, not guessed.
- **Uses deterministic checks first.** A price in the answer must equal the
  price of a product the assistant returned. An LLM judge is the calibrated
  fallback.
- **Includes a model proxy.** It measures real model calls, tokens, cost and
  latency, injects provider faults, and inspects prompts.
- **Treats Turkish and English as first-class.** E-commerce is the first domain
  pack.
- **Sends no data anywhere by default.** There is no telemetry and no remote
  service.

Read the design: [`docs/design.md`](docs/design.md) · Decisions:
[`docs/adr/`](docs/adr/README.md)

## License

[Apache-2.0](LICENSE)
