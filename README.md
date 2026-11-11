# yokla

> *yokla* (Turkish): to probe, to check by touch, as in *nabzını yoklamak*,
> "to take someone's pulse".

**Status: v0.1 (core). The repository is private and nothing is published
yet.**

yokla is an open-source tool for testing conversational AI assistants end to
end: answer quality, factual safety, red teaming, robustness, performance and
cost, resilience and regression gates, in one run.

## What v0.1 does

- **Tests your assistant over HTTP.** A profile (`yokla.profile.yaml`) maps the
  request, the response, sessions, rate limits and cache control. Cases
  (`cases/*.yaml`) hold the turns and their expectations. Nothing about a
  particular assistant is built in: what a target needs is configuration.
- **Grounds expectations in your data.** The e-commerce pack joins the returned
  products to your catalog snapshot. It checks prices, stock claims, policy
  claims, filters, product types, duplicates, absent types and over-refusal.
  The checks are deterministic: no model is called to judge an answer.
- **Treats Turkish and English as first-class.** Money, durations and refusal
  wording are read per language.
- **Reads the target's own logs** for model calls, cost and the path that
  answered, when it writes one structured line per request.
- **Reports and gates.**
  - A terminal summary and JUnit XML for CI.
  - `yokla gate` checks thresholds per suite and regressions against a
    baseline.
  - The baseline is small enough to commit.
- **Sends no data anywhere.** There is no telemetry. The HTTP client contacts
  only the target, and an egress test in CI holds yokla to that.

## Quick start

From a checkout of this repository, with Node.js 24 or later and pnpm:

```sh
pnpm install
pnpm yokla run --profile yokla.profile.yaml --cases cases --junit runs/junit.xml
pnpm yokla report --results runs/<run id>.json
pnpm yokla gate --results runs/<run id>.json
pnpm yokla baseline --results runs/<run id>.json
```

- `run` exits with `0`, or with `2` for a configuration problem or a case that
  couldn't be measured.
- `gate` exits with `0` passed, `1` broken, or `2` when the run can't be
  judged.
- `yokla schema <profile|cases|config|results|baseline>` prints the JSON Schema
  for editors.

[`examples/demo-shop`](examples/demo-shop/README.md) is a reference target with
seeded defects. Its README walks through a full run.

## Planned

- **v0.2:** a model proxy that measures model calls, tokens, cost and latency,
  injects provider faults, and inspects the prompts sent to the model; targets
  that stream their answers.
- **v0.3:** a first run in five minutes (`yokla init` writes a profile from
  one message to your assistant, with starter cases that suit any assistant),
  an HTML report, and publishing to npm; more ways to reach a target and see
  its model calls (WebSocket, Gemini, OpenTelemetry), tool-call checks, and a
  simulated customer that shops with a goal.
- **v0.4:** an analyzer that reads your code, API contract, prompts, data
  schema and docs, and writes a profile for you to review.
- **v0.5:** red teaming with local attack generation, mapped to OWASP, GDPR
  and KVKK, and the EU AI Act.
- **v0.6:** import and export for other evaluation tools, and a GitHub
  Action.

Read the design: [`docs/design.md`](docs/design.md) · Decisions:
[`docs/adr/`](docs/adr/README.md) · Changes: [`CHANGELOG.md`](CHANGELOG.md)

## License

[Apache-2.0](LICENSE)
