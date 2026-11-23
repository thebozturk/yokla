# 0093. A library API (E1)

Status: Accepted · Date: 2026-11-23

## Context

ADR-0092 makes a library API the first item of v0.6: the `yokla` package
exports the CLI's steps as typed functions, which print nothing and never
end the process, and the CLI is built on them. Its exit criteria: a script
runs the demo-shop's suites through the API and gates them, with the
statuses `yokla run` and `yokla gate` give, and `pnpm pack-check` runs it
from the installed tarball.

What exists:

- **The `yokla` package exports** `main` (the command line, given its
  arguments and an output), `version`, `schemas` and `jsonSchemas`. Nothing
  else.
- **Loading lives inside the CLI, unexported.** `load.ts` reads and
  validates the profile, the cases, the configuration, results and
  baselines; `prepare.ts` refuses a profile with unapproved entries
  (ADR-0047), finds the default files, loads the check modules the
  configuration names (ADR-0030) and fills the runner's options; the MCP
  server (ADR-0041) calls the same two files.
- **The runner needs what the CLI prepares.** `@yokla/runtime`'s `runSuite`
  is exported, but it takes some twenty options: the packs, the languages,
  the checks and their policies, the check modules' hashes, yokla's version.
  A caller would have to rebuild `prepare.ts`.
- **The other layers are quiet already.** `core`, `runtime` and `report`
  print nothing and read neither the environment nor the working directory.
  The CLI reads both, prints, and turns outcomes into exit codes.
- **The one public API so far is the user-check contract** (ADR-0030,
  `api: 1`), which changes only by an ADR.

## Decision

### The API is the `yokla` package's exports

- **One package to install,** the one that holds the command line:
  `import { loadProject, run, gate } from 'yokla'`.
- **Only these exports are promised.** The `@yokla/*` packages are yokla's
  parts. Their exports serve each other and may change in any release. The
  user-check contract stays as ADR-0030 says.
- **The types travel with it.** The API exports the types its functions
  take and return, so a caller imports nothing from `@yokla/*`.

### The functions

| Export | What it does | The commands built on it |
|---|---|---|
| `loadProject(options?)` | reads a run's files as `yokla run` does, with its defaults relative to `options.cwd` (the process's by default): the profile `yokla.profile.yaml`, the cases `cases` next to it, the configuration `yokla.config.yaml` when present. It refuses unapproved profile entries (ADR-0047) and loads the check modules the configuration names (ADR-0030). Async; returns a `Project` | `run`, `mcp` |
| `projectFrom(options)` | the same from objects: a profile, cases and a configuration as a person writes them, validated by the same schemas, with `dir` for the files they name (schema files, check modules, data files) and for the model caches. The profile's hash is that of its JSON. Async; returns a `Project` | |
| `run(project, options?)` | runs the project's cases. Its options are `yokla run`'s flags as typed values (below). Async; returns `{ results, cassette? }`: `results.v1`, and the cassette when one was recorded | `run`, `mcp` |
| `gate(results, { config?, baseline? })` | judges a run as `yokla gate` does; returns the gate's outcome: its verdict, breaches, problems and notices | `gate` |
| `compare(runs, { config?, baseline? })` | sets runs side by side, each gated, as `yokla compare` does; returns `yokla.comparison/v1` | `compare` |
| `terminalReport(results)`, `junitReport(results)`, `htmlReport(results)`, `comparisonReport(comparison)` | the reports as text: lines for the terminal, JUnit XML, the static HTML page, the comparison's lines | `run`, `report`, `compare` |
| `readResults(path)`, `readBaseline(path)`, `loadConfig(path)`, `readCassette(path)` | read and validate one file | `gate`, `compare`, `report`, `run` |
| `LoadError`, `ResultsError`, `ConfigError` | the errors the functions throw | all |
| `main`, `version`, `schemas`, `jsonSchemas` | as today | |

`run`'s options:

- **Which cases and how:** `tags`, `samples`, `stopEarly`, `concurrency`.
- **Where to:** `targetUrl`, `proxyUrl`.
- **What it may spend:** `maxCostUsd`.
- **Cassettes:** `record`, or `replay` with a cassette and `loose`
  (ADR-0040).
- **What the run changes:** `swaps` (ADR-0042), `reversals` (ADR-0043),
  `transforms` (ADR-0045), `strategy` (ADR-0084), `attacker` with its
  bounds (ADR-0087, ADR-0088).
- **Caches:** `fresh`, for the customer, the attacker and the judge.
- **The environment:** `env`, for `{{env.NAME}}` and the model keys, by
  default the process's.
- **What the CLI prints, as a callback:** `onTransformPlan`, what the
  model's transforms will take before any is asked (ADR-0059).

Each option takes the value its flag parses to, and is checked as the flag
is: a bound out of range, or `record` with `replay`, is a `LoadError`.

A `Project` is a plain object: the profile, the cases, the configuration,
their directory, the profile's hash, the case paths and the loaded check
modules. A run of some of its cases passes the tags, or a project with
fewer cases: `run({ ...project, cases })`.

### What the functions never do

- **They print nothing and never end the process.** A problem is a thrown
  error. A case in `error` or `fixture-missing` is in the results, not
  thrown: `yokla run`'s exit code 2 for it is the command's reading.
- **They write no file but a run's model caches,** under `yokla-data/` next
  to the profile, as `yokla run` keeps them. The caller writes the results
  and the reports.
- **They read the environment only as `run`'s default `env`,** and the
  working directory only as `loadProject`'s default `cwd`.

### The errors

- **`LoadError`:** a file or an object doesn't load or validate, or an
  option is wrong. `yokla run` exits with 2 for it.
- **`ResultsError`:** a results or baseline file can't be read.
- **`ConfigError`:** the configuration doesn't let the run start, such as a
  model transform without `models.transform`.
- **Anything else is a bug,** in yokla or in a user's check module.

### The CLI is built on it

- **`run`, `gate`, `compare` and `report`** parse their flags, find their
  default files, call the functions, print, and choose their exit codes.
- **The MCP server calls the same functions.** There is no second path
  from files to results.
- **`explore` and `shrink` load as `loadProject` does,** and build the
  runner's options as `run` does, through the same internal functions. They
  run candidates of their own, so they call the runner themselves, as the
  MCP server's `shrink_case` does.
- **The other commands stay command-line only:** `init`, `analyze`,
  `generate`, `baseline`, `proxy`, `plan`, `shrink`, `explore` and `mcp`.
  Each can join the API by its own ADR.

### How the API changes

- **A test lists the exported names** a program imports at run time. The
  types are exported beside them, in the same file. Any change to either
  shows in review.
- **Adding** a function or an option is a feature, with its own ADR, as
  every feature is.
- **Removing or changing one incompatibly** needs an ADR too. Before 1.0 it
  ships only in a minor version, and the CHANGELOG lists it under its own
  heading. A patch version never does. From 1.0, semantic versioning holds.

### The guide and the example

- **A new guide page, `docs/guide/api.md`,** documents each function, its
  options and its errors.
- **Its example is a file in the repository,**
  `packages/cli/examples/run-and-gate.ts`: it loads the project in the
  directory it runs in, runs it, gates it, writes the results and a JUnit
  report, and exits with the gate's code. It is type-checked with the
  repository and isn't published. The guide shows that file, and a test
  keeps the two the same.
- **The root README** gains a short section on using yokla from code.

### Exit criteria

- **An end-to-end test** runs the demo-shop's suites through the API and
  through `yokla run`, and gates each run: every case has the same status in
  both, and the gate gives the same verdict.
- **`pnpm pack-check` runs the example** from the installed package against
  the demo-shop's starter cases, and checks that it wrote a results file the
  gate can judge.

## Consequences

- **The CLI's loading code moves behind the API.** `load.ts`, `prepare.ts`
  and `checks.ts` become the API's internals. The commands keep only their
  flags, their defaults, their printing and their exit codes.
- **No new package,** so no name to reserve (ADR-0071).
- **Importing `yokla` loads the whole CLI's code,** the analyzer and the
  proxy included, though nothing starts until a function is called.
- **A run can't be cancelled from code yet.** It stops at its cost cap, as
  on the command line.
- **E4's assertion function will be built on this API** (ADR-0092).
- **Check modules still come from files,** as the configuration names them,
  so the results keep each module's hash (ADR-0030).

## Alternatives considered

- **A package of its own,** such as `@yokla/api`. It would hold everything
  the CLI holds but the flags, under a second name to install and to
  reserve. Rejected: the CLI becomes a thin shell over its own package's
  API.
- **Promising `@yokla/runtime`'s `runSuite`.** A caller would rebuild the
  CLI's preparation, and runtime's internals would freeze. Rejected.
- **Promising every `@yokla/*` export.** Every internal change would become
  a breaking one. Rejected: one package, one list of names.
- **Running the CLI in a child process and reading its JSON.** It needs no
  new code, but gives no types and turns every problem into text on
  standard error. Rejected for a library. The GitHub Action (E2) does run
  the CLI, as a pipeline step should.
- **Files only, no objects.** A caller that builds cases in code would write
  them to temporary files first. Rejected: ADR-0092 asks for both.
- **User checks as objects in code,** not modules the configuration names.
  The results would lose each check's hash. Rejected for now.
- **No incompatible change before 1.0.** v0.6's later items extend the
  comparison and the reports, and may need to change their shapes. Rejected:
  an ADR and a minor version are enough before 1.0.
