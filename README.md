# yokla

> *yokla* (Turkish): to probe, to check by touch, as in *nabzını yoklamak*,
> "to take someone's pulse".

**Status: v0.3 (reach and conversations), on npm as
[`yokla`](https://www.npmjs.com/package/yokla).**

yokla is an open-source tool for testing conversational AI assistants end to
end: answer quality, factual safety, red teaming, robustness, performance and
cost, resilience and regression gates, in one run.

## What v0.3 does

- **Tests your assistant over HTTP.** A profile (`yokla.profile.yaml`) maps the
  request, the response, sessions, rate limits and cache control. Answers may
  be JSON or streamed as events, and a session may be opened before the first
  turn. A target can talk over a WebSocket too (ADR-0024), and yokla can get
  and refresh the token a target needs, by OAuth 2.0 client credentials or by
  its login, keeping it out of everything it writes (ADR-0031). Cases
  (`cases/*.yaml`) hold the turns and their expectations.
  Nothing about a particular assistant is built in: what a target needs is
  configuration.
- **Sees your assistant's model calls.** Point the app's OpenAI-compatible or
  Anthropic client at `yokla proxy`, or its Gemini client, on AI Studio or
  Vertex AI (ADR-0032). Each turn then shows its model calls,
  tokens, cost and latency, including calls the app makes after answering.
  The cost reconciles with the provider's own records. An app whose client can't be pointed at the proxy can show its model calls as
  OpenTelemetry spans instead (ADR-0029).
- **Breaks the provider on purpose.** A turn can declare provider faults:
  errors, rate limits, slow or stalled calls, and malformed or empty
  answers. yokla judges how the assistant answers under them.
- **Inspects the prompts sent to the model.** Checks catch a leaked system
  prompt, retrieved content in the system message, personal data that should
  never reach the model, and prompts over budget. Results keep only message
  sizes unless the profile asks for more.
- **Holds any assistant to your own rules.** An answer can be held to regular expressions, a response to a JSON Schema, and an
  answer close to, or away from, reference answers. A rule only your team
  knows can be a check of your own, a small module the configuration names
  (ADR-0030).
- **Checks the tools your assistant calls.** The proxy reads the tool calls each model call asks for. A case can say which tools
  must and must not be called, with what arguments, in what order and how
  often (ADR-0025).
- **Plays a customer with a goal.** A case can give a persona and a goal instead of fixed turns. A model of your choice, local or
  hosted, plays the customer, the deterministic checks judge every answer,
  and the goal counts as reached only when the answer shows it, such as a
  product in the cart. Replies are cached, so a rerun repeats the
  conversation (ADR-0028).
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
  - An offline HTML report that shows each answer next to its findings
    (ADR-0023).
  - `yokla gate` checks thresholds per suite and regressions against a
    baseline.
  - The baseline is small enough to commit.
- **Leads from a finding to its fix.** A failing finding that names a value
  says where the value first appears: in what the model was sent, in what it
  answered, or only in the app's answer (ADR-0033). `yokla shrink` cuts a
  failing case down to the fewest turns that still fail (ADR-0035), and
  `yokla run --stop-early` stops a case's samples once its failure is settled
  (ADR-0038).
- **Sends no data anywhere.** There is no telemetry. yokla's clients contact
  only the target. The model proxy listens on `127.0.0.1` only and forwards
  the app's own calls to the upstreams the profile names. An egress test in
  CI holds yokla to that.

## Quick start

With Node.js 24 or later:

```sh
npx yokla init --url http://127.0.0.1:3000/v1/chat   # a profile and starter cases
npx yokla proxy --profile yokla.profile.yaml   # optional: when the profile has a modelProxy
npx yokla run --profile yokla.profile.yaml --cases cases --junit runs/junit.xml
npx yokla report --results runs/<run id>.json
npx yokla gate --results runs/<run id>.json
npx yokla baseline --results runs/<run id>.json
```

- `yokla init --url <url>` writes a first profile and starter cases from one
  message to your assistant (ADR-0018). Read both, and approve the cases you
  agree with. The guide starts with it.
- From a checkout of this repository, `pnpm install` and then `pnpm yokla`
  runs the CLI from source.
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
