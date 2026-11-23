# yokla from code

The `yokla` package is the command line and a library. Its library API
gives the steps of `yokla run`, `yokla gate`, `yokla compare` and
`yokla report` as typed functions, for a test runner, a script or a service
of your own ([ADR-0093](../adr/0093-a-library-api.md)). The command line is
built on the same functions, so a function and its command give the same
result.

```sh
npm install --save-dev yokla
```

It needs Node.js 24 or later, and ES modules.

## An example

This program runs the project in its working directory, writes the results
and a JUnit report, and exits with the gate's code, as `yokla run` and
`yokla gate` would. It is `packages/cli/examples/run-and-gate.ts` in the
repository, and `pnpm pack-check` runs it from the installed package. Node.js
runs it as it is: `node run-and-gate.ts`.

```ts
// Runs the yokla project in the current directory through the library API,
// writes its results and a JUnit report, and exits with the gate's code, as
// yokla run and yokla gate would. Run it with `node run-and-gate.ts` where
// yokla.profile.yaml is.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  ConfigError,
  gate,
  junitReport,
  loadProject,
  LoadError,
  readBaseline,
  ResultsError,
  run,
  terminalReport,
} from 'yokla';

const EXIT_CODES = { pass: 0, broken: 1, unjudgeable: 2 } as const;

try {
  const project = await loadProject();
  const { results } = await run(project);

  mkdirSync('runs', { recursive: true });
  const path = `runs/${results.run.id}.json`;
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync('runs/junit.xml', junitReport(results));
  const summary = terminalReport(results);
  for (const line of summary.out) console.log(line);
  for (const line of summary.err) console.error(line);
  console.log(`results: ${path}`);

  const baseline = existsSync('yokla.baseline.json')
    ? readBaseline('yokla.baseline.json')
    : undefined;
  const outcome = gate(results, { config: project.config, baseline });
  console.log(`gate: ${outcome.verdict}`);
  for (const breach of outcome.breaches) console.log(`  ${breach.message}`);
  for (const problem of outcome.problems) console.error(`  ${problem}`);
  process.exitCode = EXIT_CODES[outcome.verdict];
} catch (error) {
  if (error instanceof LoadError || error instanceof ResultsError || error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
```

## The functions

| Function | What it does | The command |
|---|---|---|
| `loadProject(options?)` | Reads the profile, the cases and the configuration, as `yokla run` finds them, and loads the check modules the configuration names. Async; gives a `Project`. | `run` |
| `projectFrom(options)` | The same from objects. Async; gives a `Project`. | |
| `run(project, options?)` | Runs the project's cases against its target. Async; gives `{ results, cassette? }`. | `run` |
| `gate(results, { config?, baseline? })` | Judges a run: its verdict (`pass`, `broken` or `unjudgeable`), breaches, problems and notices. | `gate` |
| `compare(runs, { config?, baseline? })` | Sets two runs or more side by side, each gated, with each case's failing findings per run: a `yokla.comparison/v1` object. | `compare` |
| `terminalReport(results)` | The summary `yokla run` prints: `{ out, err }`, lines for standard output and standard error. | `run`, `report` |
| `junitReport(results)`, `htmlReport(results)` | The JUnit XML and the static HTML page, as text. | `run`, `report` |
| `comparisonReport(comparison)` | The lines `yokla compare` prints. | `compare` |
| `comparisonHtml(comparison, runs)` | The comparison page, from the comparison and the runs' results in the same order ([ADR-0095](../adr/0095-two-runs-side-by-side.md)). | `compare` |
| `markdownReport(results, outcome?)` | The Markdown summary; with the gate's outcome, its verdict first ([ADR-0094](../adr/0094-a-github-action.md)). | `report`, `gate` |
| `readResults(path)`, `readBaseline(path)`, `loadConfig(path)`, `readCassette(path)` | Read and validate one file. `readBaseline` takes a results file too. | `gate`, `compare`, `report`, `run` |
| `main(argv, io)` | The command line itself, given its arguments and an `{ out, err }` output; gives the exit code. | all |
| `version()`, `schemas`, `jsonSchemas()` | yokla's version, the Zod schemas of the profile and the case files, and every file's JSON Schema. | `schema` |

The types they take and give are exported too: `Project`, `RunOptions`,
`RunOutcome`, `Results`, `GateOutcome`, `Comparison`, `Baseline`,
`YoklaConfig`, `Profile`, `Case`, `Cassette` and the rest. Import them from
`yokla`, never from an `@yokla/*` package.

`init`, `analyze`, `generate`, `baseline`, `proxy`, `plan`, `shrink`,
`explore` and `mcp` are command-line only. Run them with `main`, or as
commands.

## Loading a project

`loadProject` takes where the files are; each default is `yokla run`'s:

| Option | Default | Meaning |
|---|---|---|
| `profile` | `yokla.profile.yaml` | The profile. |
| `cases` | `cases`, next to the profile | Case files or directories. |
| `config` | `yokla.config.yaml`, when present | The configuration: thresholds, models, prices and check modules. |
| `cwd` | the process's working directory | What relative paths and the defaults are relative to. |

`projectFrom` takes a profile, cases and a configuration as a person writes
them, the same shapes as the files, and validates them with the same
schemas:

| Option | Meaning |
|---|---|
| `profile` | The profile, as an object. |
| `cases` | The cases, as an array of objects: what a case file holds under `cases`. |
| `config` | The configuration, as an object; optional. |
| `dir` | What the files they name are relative to: schema files, check modules and data files. The model caches are kept under `yokla-data/` there. |

A project's profile hash is its file's SHA-256, or the SHA-256 of the
profile's JSON when it came as an object. Either function refuses a profile
with an entry no person approved
([ADR-0047](../adr/0047-the-analyzer-deterministic-first.md)).

A `Project` holds `profile`, `cases`, `config`, `dir`, `profileSha256`,
`casePaths` and the loaded check modules. To run some of the cases, pass
the tags, or a project with fewer cases: `run({ ...project, cases })`.

## Running

`run`'s options are `yokla run`'s flags as typed values, checked as the
flags are:

| Option | The flag | Meaning |
|---|---|---|
| `tags` | `--tag` | Only the cases with any of these tags. |
| `samples` | `--samples` | Samples per case when the case doesn't say. |
| `stopEarly` | `--stop-early` | Stop a case's samples once its failure is settled. |
| `concurrency` | `--concurrency` | Cases run in parallel. |
| `targetUrl` | `--target-url` | The target's url, instead of the profile's request url. |
| `proxyUrl` | `--proxy-url` | The model proxy, instead of `127.0.0.1` on `modelProxy.port`. |
| `maxCostUsd` | `--max-cost` | Stop starting samples once the model cost reaches this. |
| `record` | `--record` | Record the model calls; the cassette comes back with the results. |
| `replay` | `--replay`, `--replay-loose` | `{ cassette, sha256, loose? }`, as `readCassette` gives it, with `loose` added. |
| `swaps` | `--swap-model` | `{ upstream, asked, model, to? }` each. |
| `reversals` | `--reverse-items` | `{ tool, at }` each. |
| `transforms` | `--transform` | `no-diacritics`, `typos` and the rest. |
| `strategy` | `--strategy` | One strategy, or two in layers: `['base64', 'roleplay']`. |
| `attacker` | `--attacker` and its bounds | `{ strategy: 'escalation', limit? }` (turns, default 5); `best-of-n` or `iterative` with `limit` (attempts, default 4); `{ strategy: 'tree', branches?, depth? }` (default 3 and 2); `{ strategy: 'translate' }`. |
| `fresh` | `--fresh-customer`, `--fresh-attacker`, `--fresh-judge` | `{ customer?, attacker?, judge? }`: ask these models anew. |
| `env` | | For `{{env.NAME}}` and the model keys; the process's environment by default. |
| `onTransformPlan` | | Called with what the model's transforms will take, before any is asked. `yokla run` prints it. |

A case that ended in `error` or `fixture-missing` is in the results, not
thrown. `yokla run` exits with 2 for it; a program decides for itself.

## Errors

| Error | When |
|---|---|
| `LoadError` | A file or an object doesn't load or validate, or an option is wrong. `yokla run` exits with 2 for it. |
| `ResultsError` | A results or baseline file can't be read. |
| `ConfigError` | The configuration doesn't let the run start, such as a model transform without `models.transform`. |

Anything else is a bug, in yokla or in one of your check modules.

## What the functions never do

- **They print nothing and never end the process.** A problem is a thrown
  error.
- **They write no file but a run's model caches,** under `yokla-data/` next
  to the profile, as `yokla run` keeps them. Your program writes the
  results and the reports.
- **They read the environment only as `run`'s default `env`,** and the
  working directory only as `loadProject`'s default `cwd`.

## How the API changes

The API is the `yokla` package's exports, and nothing else. The `@yokla/*`
packages are yokla's parts: their exports may change in any release.

- **Adding** a function or an option comes with its own ADR, as every
  feature does.
- **Removing or changing one incompatibly** needs an ADR too. Before 1.0 it
  ships only in a minor version, and the changelog says so under its own
  heading. A patch version never does. From 1.0, semantic versioning holds.
