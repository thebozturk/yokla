# yokla

> *yokla* (Turkish): to probe, to check by touch, as in *nabzını yoklamak*,
> "to take someone's pulse".

**Status: v0.2 (model proxy). The repository is private and nothing is
published yet.**

yokla is an open-source tool for testing conversational AI assistants end to
end: answer quality, factual safety, red teaming, robustness, performance and
cost, resilience and regression gates, in one run.

## What v0.2 does

- **Tests your assistant over HTTP.** A profile (`yokla.profile.yaml`) maps the
  request, the response, sessions, rate limits and cache control. Answers may
  be JSON or streamed as events, and a session may be opened before the first
  turn. On the main branch, a target can talk over a WebSocket too
  (ADR-0024). Cases (`cases/*.yaml`) hold the turns and their expectations.
  Nothing about a particular assistant is built in: what a target needs is
  configuration.
- **Sees your assistant's model calls.** Point the app's OpenAI-compatible or
  Anthropic client at `yokla proxy`. Each turn then shows its model calls,
  tokens, cost and latency, including calls the app makes after answering.
  The cost reconciles with the provider's own records.
- **Breaks the provider on purpose.** A turn can declare provider faults:
  errors, rate limits, slow or stalled calls, and malformed or empty
  answers. yokla judges how the assistant answers under them.
- **Inspects the prompts sent to the model.** Checks catch a leaked system
  prompt, retrieved content in the system message, personal data that should
  never reach the model, and prompts over budget. Results keep only message
  sizes unless the profile asks for more.
- **Budgets cost and latency.** Per turn and per suite; `yokla plan`
  estimates a run's cost before it runs, and `--max-cost` caps it.
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
  - On the main branch, an offline HTML report that shows each answer next to
    its findings (ADR-0023).
  - `yokla gate` checks thresholds per suite and regressions against a
    baseline.
  - The baseline is small enough to commit.
- **Sends no data anywhere.** There is no telemetry. yokla's clients contact
  only the target. The model proxy listens on `127.0.0.1` only and forwards
  the app's own calls to the upstreams the profile names. An egress test in
  CI holds yokla to that.

## Quick start

From a checkout of this repository, with Node.js 24 or later and pnpm:

```sh
pnpm install
pnpm yokla proxy --profile yokla.profile.yaml   # optional: when the profile has a modelProxy
pnpm yokla run --profile yokla.profile.yaml --cases cases --junit runs/junit.xml
pnpm yokla report --results runs/<run id>.json
pnpm yokla gate --results runs/<run id>.json
pnpm yokla baseline --results runs/<run id>.json
```

- On the main branch, `yokla init --url <url>` writes a first profile and
  starter cases from one message to your assistant (ADR-0018); the guide
  starts with it.
- `run` exits with `0`, or with `2` for a configuration problem or a case that
  couldn't be measured.
- `gate` exits with `0` passed, `1` broken, or `2` when the run can't be
  judged.
- `yokla proxy` runs in its own terminal until stopped. Start it before the
  app, and point the app's model client at the address it prints.
- `yokla plan --cases cases --calibration runs/<run id>.json` estimates what
  a run would cost from an earlier one.
- `yokla schema <profile|cases|config|results|baseline>` prints the JSON Schema
  for editors.

[The guide](docs/guide/README.md) walks through a first run against your own
assistant, and documents the profile, cases, checks, the model proxy and every
command. [`examples/demo-shop`](examples/demo-shop/README.md) is a reference
target with seeded defects. Its README walks through a full run.

## Planned

- **v0.3:** a first run in five minutes (`yokla init` writes a profile from
  one message to your assistant, with starter cases that suit any assistant),
  an HTML report (done on the main branch), and publishing to npm; more ways
  to reach a target and see its model calls (WebSocket, done on the main
  branch; Gemini, OpenTelemetry), tool-call checks, and a simulated customer
  that shops with a goal.
- **v0.4:** an analyzer that reads your code, API contract, prompts, data
  schema and docs, and writes a profile for you to review.
- **v0.5:** red teaming with local attack generation, mapped to OWASP, GDPR
  and KVKK, and the EU AI Act.
- **v0.6:** import and export for other evaluation tools, and a GitHub
  Action.

Read the guide: [`docs/guide/`](docs/guide/README.md) · The design:
[`docs/design.md`](docs/design.md) · Decisions:
[`docs/adr/`](docs/adr/README.md) · Changes: [`CHANGELOG.md`](CHANGELOG.md)

## License

[Apache-2.0](LICENSE)
