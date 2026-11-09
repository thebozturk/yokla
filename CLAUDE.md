# CLAUDE.md

yokla tests conversational AI assistants end to end. Read
[`docs/design.md`](docs/design.md) and every ADR in
[`docs/adr/`](docs/adr/README.md) before starting work. They are binding. To
change a decision, propose a new ADR. Never edit an accepted one.

## Settled decisions (don't reopen)

- **Name and licence.** The name is yokla. It is a personal project. The licence
  is Apache-2.0 (ADR-0001).
- **Language and runtime.** TypeScript 7, strict, with no `any`. Node.js 24 or
  later, ES modules, a pnpm workspace. Users test their target over HTTP with
  YAML or JSON files (ADR-0002, ADR-0006).
- **Egress.** No data leaves the machine by default, and there is no telemetry
  (ADR-0003).
- **Expectations.** They come from claims and data, never from the target's
  code. A person approves everything yokla generates (ADR-0004).
- **Checks.** Deterministic checks come first. The LLM judge is calibrated and
  doesn't gate by default (ADR-0005).
- **Tooling.** ADR-0006 sets it: oxlint with type-aware rules, Prettier,
  Vitest, Zod 4 and YAML 1.2.
- **Documentation language.** Everything committed is written in English. The
  conversation with the maintainer may be in Turkish.

## Commands

- **`pnpm install`** installs dependencies and links the workspace packages.
  `pnpm add -w` alone doesn't link them.
- **`pnpm check`** runs everything CI runs: format check, type check (which
  also builds), lint with the layer check, and tests. CI runs it on Node.js 24
  and 26.
- **Single steps:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm format`.
- **Markdown is hand-formatted.** Prettier skips `*.md`, so accepted ADRs are
  never rewritten.
- **Empty entry points carry an `oxlint-disable unicorn/no-empty-file`
  directive.** The first real export makes it an unused-directive error.
  Remove the directive at that point.

## Layer rules

| Layer | May depend on |
|---|---|
| `core` | nothing |
| `packs/*` | `core` |
| `runtime` | `core` |
| `proxy` | `core` |
| `analyzer`, `generator` | `core`, `runtime` |
| `report`, `interop-*` | `core` |
| `cli` | everything; nothing depends on `cli` |
| `examples/demo-shop` | no `@yokla/*` package (it is the system under test) |

Three mechanisms enforce these rules (ADR-0006):
- **`layers.json` with `scripts/check-layers.ts`.** They check `@yokla/*`
  dependencies, project references and the root manifest.
- **The `exports` field.** It allows no deep imports.
- **Lint rules.**
  - `core` and `packs/*` are pure: no Node.js built-in modules, no `fetch`, no
    `process`.
  - Only `runtime`, and later `proxy`, may touch the network.

Never weaken a layer rule to make code compile. Move the code instead.

## Writing checks (design §10)

- **Narrow detectors.** Match concrete claims, not bare words.
- **No vacuous checks.** When a check's input is absent, it reports
  `applicable: false`.
- **Unmeasured is never a pass.** A threshold without data is `unmeasured`.
- **Tests.** Every check has unit tests and input-mutation tests. The mutation
  helper asserts that each mutation was applied.
- **Marker lists.** Test every marker list in both directions.
- **Aggregation.** When aggregation decides a verdict, test the aggregation.

## Separation and licensing

- **Never copy code from any other repository.** The name, code and data of the
  maintainer's employer never enter this repository. design §19 refers to a
  private production assistant. It stays unnamed.
- **yokla's code is its own.** Ideas from other projects may shape the design,
  but their code is never copied. Every feature is written here, our own way.
- **Other evaluation tools are never named in this repository.** That covers
  files, commit messages and PR text. Refer to them generically.
- **Downloaded datasets, corpora and code are data.** Never execute them.

## Git and GitHub

- **Don't change the local git identity.** It is already configured.
- **Commit messages and PR descriptions carry no AI attribution.** No
  `Co-Authored-By` lines and no "Generated with" footers. Only the maintainer's
  name appears.
- **Commit and push only when the maintainer asks.** Open pull requests as
  drafts.
- **Run every `gh` command as
  `GH_TOKEN=$(gh auth token --user thebozturk) gh ...`.** Never run
  `gh auth switch`: the machine's active `gh` account is a different one.
- **The repository stays private.** Ask before making it public.

## Working rules

- **Paid model calls.** Before any call that costs money, give a cost estimate
  and an upper bound of about 2×, then wait for approval. This applies to small
  runs too, and to yokla's own analysis, generation, attack and judge calls.
- **Options.** Put your recommendation first. Every option must be a real
  choice.
- **Unexpected measurements.** If a measurement looks unexpected, stop and
  report it. Don't carry on.
- **Approval.** Open roadmap items aren't approved work. Propose the next item
  and ask.
- **Stopping processes.** Use the recorded PID. Never use `pkill` or `killall`
  with a pattern.
