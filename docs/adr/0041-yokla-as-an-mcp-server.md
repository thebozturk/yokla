# 0041. yokla as an MCP server for coding agents

Status: Accepted · Date: 2026-11-15

## Context

The debugging track (design §20) gives a team four answers about a failure:

- where its value arose (D1, ADR-0033);
- the smallest conversation that shows it (D2, ADR-0035, ADR-0036);
- a verdict reached in fewer samples (D3, ADR-0038);
- a run that repeats with the answers it got (D4, ADR-0040).

More and more of the fixing is done by coding agents. An agent that changes
an assistant's prompt, retrieval or post-processing needs the same answers,
and needs them as tools: run the cases, read why one failed, cut it down,
and check that a change fixed it without breaking its neighbours. Today the
agent would have to run the CLI in a shell and read JSON results files of
several megabytes.

The Model Context Protocol (MCP) is how coding agents call tools. A local
MCP server is a process the agent starts and talks to over stdin and
stdout, in JSON-RPC 2.0 messages, one per line. The part a tool server needs
is small:

- `initialize`, where the client and the server agree on a protocol version
  and the server says it has tools;
- `tools/list`, each tool with a name, a description and JSON Schemas of its
  input and output;
- `tools/call`, which answers with text and structured content, or with an
  error the agent can read.

Design §20 plans this as D5: "a local MCP server over stdio: run a case,
explain a finding (D1), shrink it (D2), verify a fix against the shrunk case
and its neighbours; no egress beyond the run's own". Its exit criterion: "an
agent, given only the MCP tools, finds and verifies the fix of a seeded
demo-shop defect".

## Decision

### The command

```sh
yokla mcp --profile yokla.profile.yaml --cases cases --max-cost 2 \
  [--config yokla.config.yaml] [--target-url <url>] [--proxy-url <url>] [--out runs] \
  [--replay <cassette> [--replay-loose]]
```

- **A CLI command, `yokla mcp`.** It runs until its client closes stdin.
  The protocol code lives in `packages/cli`, which may depend on every
  package and on which nothing depends (design §6).
- **The person decides what it can reach.** The profile, the case paths, the
  configuration and the target and proxy urls are given when the server
  starts. No tool takes a path, a url or a profile: an agent can choose
  which cases to run, never which target or which files to read.
- **Each tool call loads them again,** as a CLI command would. A case file
  that a shrink wrote, or one the agent edited, counts at the next call.
- **One call at a time.** A model proxy holds one recording at a time
  (ADR-0012), so calls are answered in the order they arrive.
- **stdout carries protocol messages only.** What the CLI would print goes
  to stderr.

### The protocol

- **Written here, with no dependency.** JSON-RPC 2.0 over stdio, one message
  per line: `initialize`, `notifications/initialized`, `ping`, `tools/list`
  and `tools/call`. Other requests get JSON-RPC's "method not found".
- **The protocol version.** The server answers with the version the client
  asked for when it knows it, and otherwise with the latest it knows.
- **Tool schemas come from Zod,** as the file schemas do (ADR-0006). Each
  tool declares an input and an output schema, and answers with structured
  content and the same content as JSON text, for clients that read only
  text.
- **A tool's failure is a result, not a protocol error.** A case id that
  doesn't exist, a run the budget can't pay for, or a target that doesn't
  answer comes back with `isError: true` and a message the agent can act
  on. Malformed requests get JSON-RPC errors.

### The tools

| Tool | Does | Costs |
|---|---|---|
| `list_cases` | Lists the cases: id, suite, title, language, turns and review status. | nothing |
| `run_cases` | Runs the cases named, or every case, with `samples` and `stopEarly` if given, as `yokla run` does. Returns the run id, the statuses, and each case that didn't pass with its failing findings: check, dimension, message, subject and origin. | model calls |
| `explain_finding` | Reads one case of a run's results: for each turn, the user's message, the answer's text, route and status, the failing findings with their origin, and the turn's model calls by model, tokens, cost and fault. | nothing |
| `shrink_case` | Shrinks a failing case of a run, as `yokla shrink` does, with `check`, `samples`, `reproduce`, `maxRuns` and `words`. Returns the shrunk case's id and file, the turns kept, or that the failure was flaky or didn't reproduce. | model calls |
| `verify_fix` | Runs a failing case of a run again, with its shrunk case `<id>-min` when the cases hold one, and the other cases of its suite. Returns `fixed` when the target failure is gone, and lists every case that passed in that run and no longer passes. | model calls |

- **Results are files, answers are summaries.** Every run writes its results
  file under `--out`, as `yokla run` does, and a tool returns its run id.
  Tools return what an agent needs to act, not the whole file: the HTML
  report and the results stay where a person can read them.
- **Text is bounded.** An answer's text in a tool result is cut at 4,000
  characters, and says so. Findings and origins are never cut.
- **Prompts stay as the profile stores them** (ADR-0015). A tool returns a
  model call's messages and answer text only as far as `prompts.store`
  keeps them in the results, so `sizes` gives sizes.
- **`verify_fix` compares with the run it is given,** case by case, as the
  gate compares with a baseline (ADR-0011): a case that passed there and
  doesn't now is a regression. A case whose definition changed since is
  reported as changed, not compared.

### Cost

- **A session cap is required** when the session can spend: when the
  profile has a model proxy with upstreams, or spans, or the configuration
  has yokla's own models (ADR-0028). Without `--max-cost`, `yokla mcp`
  refuses to start.
- **The cap is the session's.** It covers every run of every tool call,
  counted as `--max-cost` counts within a run (ADR-0014, ADR-0028). Each
  run gets what is left as its own cap.
- **Every paid tool says what it spent,** and what is left.
- **Once the cap is reached,** the paid tools answer with an error that says
  so, and `list_cases` and `explain_finding` keep working. A person raises
  the cap by starting the server again.
- **Without a model proxy,** the target's cost can't be counted. The server
  starts, and every paid tool's result says that the target's cost is
  unknown, as `yokla run` does (ADR-0028).
- **A cassette runs at no model cost.** `--replay <cassette>` given at start
  replays every run of the session (ADR-0040). A change in the app's
  prompts then diverges, as a replay says.

### Egress and data

- **No egress beyond the run's own.** The server talks to its client over
  stdio, and contacts only what `yokla run` would contact (ADR-0003). It
  listens on no port.
- **The agent's model sees the target's data.** Tool results hold the
  target's answers, which the agent may send to a hosted model. That is the
  person's choice, as a hosted customer model is (ADR-0028), and the guide
  says so plainly.

### The demo-shop and CI

- **A scripted client in CI, at no cost.** An end-to-end test starts
  `yokla mcp` as a child process and drives it over stdio, as an agent
  would, against a demo-shop with the model over HTTP behind the proxy and
  the fake provider:
  - it lists the cases and runs them against a shop with
    `price-rewritten` (ADR-0033);
  - it reads a failing case with `explain_finding`, whose origin points to
    the app;
  - it shrinks it;
  - it "fixes" the shop by restarting it on the same port without the
    defect;
  - `verify_fix` reports the failure fixed and no regression.
  - With the defect left in, `verify_fix` reports it not fixed; with a
    second defect added, it names the regression.
  - The test also checks the session cap, a refusal at the cap, the
    protocol's errors, and that stdout holds nothing but protocol messages,
    behind the network guard.
- **One run with a real coding agent, by hand.** The maintainer gives a
  coding agent only these tools and a demo-shop with a seeded defect, and
  asks it to find and fix it. The outcome is recorded in design §20 and the
  demo-shop README, not in this ADR. It runs once, on the maintainer's
  approval of its cost.

## Consequences

- **An agent debugs with yokla's verdicts,** not by reading results files:
  where a value arose, the smallest failing case, and whether a fix holds.
- **The person keeps control of what is tested and what is spent.** The
  target, the files and the cap are fixed when the server starts.
- **A small protocol implementation to maintain.** A new MCP revision that
  changes the tools messages needs a change here. Only the tools part of
  the protocol is implemented: no resources, prompts, sampling or
  notifications of change.
- **Target data reaches the agent's model,** as the guide says, and only as
  far as the results keep it.
- **The exit criterion's agent is a script in CI.** The real agent's run is
  manual and recorded once.

## Alternatives considered

- **The official MCP SDK.** It follows protocol changes for us, but adds
  supply-chain surface and its own version of Zod, for the four methods a
  tool server needs. Rejected, as libraries were for WebSockets
  (ADR-0024), spans (ADR-0029), JSON Schema (ADR-0030) and OAuth
  (ADR-0031).
- **A package of its own, `@yokla/mcp`.** The tools are the CLI's commands
  with another front, and need every package the CLI assembles. A package
  would depend on everything as the CLI does. Rejected for now; the library
  API (v0.6) can expose the same operations.
- **The HTTP transport of MCP.** It needs a port, and a coding agent starts
  local tool servers over stdio. Rejected: no listening port.
- **Tools that take a profile, a path or a url.** An agent could point yokla
  at any target or read any file. Rejected: the person fixes them at start.
- **A cap per tool call.** An agent in a loop would spend without bound.
  Rejected for one cap per session.
- **Only zero-cost targets.** It would keep the server off real targets,
  where a coding agent is most useful. Rejected; a cassette serves zero-cost
  sessions.
- **A model-driven agent in CI.** Every CI run would cost money, and its
  path would vary from run to run. Rejected for a scripted client and one
  manual run.
- **Returning whole results files.** They run to megabytes and hold the
  prompts as stored. Rejected for summaries and a run id.
