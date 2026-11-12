# The model proxy

`yokla proxy` sits between your app and its model provider (ADR-0012). With it,
each turn shows the model calls it caused, their tokens, cost and latency,
and the prompts they sent. yokla can also make the provider fail on purpose
during a turn.

The proxy speaks the OpenAI-compatible APIs (chat completions, the Responses
API, embeddings) and the Anthropic Messages API, as JSON or event streams.
The app must let you set its provider base URL. For a target whose calls the
proxy can't see, read its logs instead (`target.observe.logs` in the
[profile](profile.md)).

## Set it up

1. **Declare the upstreams in the profile.**

   ```yaml
   modelProxy:
     port: 8787
     correlation: serial
     upstreams:
       - id: openai
         kind: openai-compatible
         upstream: https://api.openai.com/v1
         appBaseUrlEnv: OPENAI_BASE_URL
       - id: anthropic
         kind: anthropic
         upstream: https://api.anthropic.com
         appBaseUrlEnv: ANTHROPIC_BASE_URL
   ```

2. **Start the proxy** in its own terminal. It prints the local address of
   each upstream and the app setting to point at it:

   ```sh
   pnpm yokla proxy --profile yokla.profile.yaml --records runs/calls.jsonl
   ```

3. **Start the app** with its base URL pointed at the proxy, for example
   `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic`. The app keeps its own
   API key: the proxy passes the app's headers on and never records them.

4. **Run the cases** as usual. Before any request, `yokla run` checks that the
   proxy answers and routes every upstream the profile declares. Otherwise it
   stops with exit code `2`. The run opens a recording on the proxy, and
   closes it at the end, even when the run fails.

Outside a recording the proxy only forwards; it records nothing.

## Tie calls to turns

| `correlation` | How | Use it when |
|---|---|---|
| `serial` (default) | yokla sends one request at a time and marks each turn on the proxy. A call belongs to the turn in flight when it started. | The app can't pass a header on to its provider calls. Needs `--concurrency 1`. |
| `header` | yokla sends `x-yokla-trace` with every request, and the app forwards it to its provider calls. | The app can forward the header. Works in parallel runs. |

A call tied to no turn is counted as unattributed, never dropped. A call that
a `session.open` request causes stays unattributed in serial mode.

### Calls after the answer

Many apps call their model after they answer, for example to update a memory
or a summary. In serial mode yokla waits after each answer until the target
goes quiet: no call in flight, and none for `modelProxy.settle.quietMs`
(default 250). Such a call then counts for the turn that caused it. Every
recording also settles before it closes, so the last turn's calls are kept.
A target that never goes quiet within `maxWaitMs` (default 10000) leaves an
issue on the turn, and the run goes on.

## Prices and cost

`yokla.config.yaml` gives prices per upstream id and per model, in USD per
million tokens:

```yaml
version: 1
prices:
  anthropic:
    claude-haiku-5-5: { input: 0.10, output: 0.50, cachedInput: 0.01, cacheWrite: 0.125 }
```

- **The model name is the provider's.** It is the name in the provider's
  answer, or in the request when the answer gives none. A gateway may use its
  own names, such as `anthropic/claude-haiku-5.5`.
- **Cache prices default to the input price,** so cost is never understated.
- **Input tokens include cache reads and writes.** For Anthropic, the
  provider counts them apart, and yokla adds them to the input.
- **Unpriced or unmeasured calls cost null.** That holds for a call whose
  model has no price, or whose tokens the provider didn't report. A turn with
  such a call costs null too; a turn without calls costs 0.

Results carry each turn's calls and cost, and the run's totals. The terminal
summary prints the totals and how many calls had no value for each token kind.

### Reconcile with the provider

To trust the numbers, compare one run with the provider's own usage records:

- **Use a key for the test alone,** so the provider's usage page shows only
  the run.
- **Compare call for call.** Check the call count, then input, cached and
  output tokens, then the cost. The `--records` file holds every recorded
  call, without keys.
- **Mind the time zone.** Usage pages often show UTC.

## Budgets and the cost cap

ADR-0014 covers three ways to keep cost in bounds:

- **Per turn:** `budget: { costUsd, modelCalls }` in a turn's `expect`, judged
  by `cost-budget`.
- **Per suite:** `costPerTurnUsd` and `costUsd` gate thresholds (see the
  [CLI](cli.md#gate-thresholds)).
- **Per run:** `yokla run --max-cost <usd>` starts no new sample once the
  recorded cost reaches the cap. The results are then partial, and the gate
  can't judge them. A call without a cost makes the cap unenforceable, so the
  run stops there too.

`yokla plan` estimates a run's cost from an earlier run before you spend
anything:

```sh
pnpm yokla plan --cases cases --calibration runs/<run id>.json --samples 3
```

It prices each case from its own earlier turns when its definition is
unchanged, otherwise from the mean turn. It prints an upper bound, the
estimate times `plan.upperBoundFactor` (2 by default). Without a usable
calibration, it gives no figure and exits with `2`.

## Provider faults

A turn's `faults` make the provider fail during that turn only: an error
status, latency, a timeout, malformed JSON, empty content, a cut stream or
invalid tool-call arguments. See [cases](cases.md#provider-faults).

## Prompt inspection

While a recording is open, the proxy captures the messages each call sends
(ADR-0015). `modelProxy.prompts.store` decides what the results and the
`--records` file keep:

| `store` | Kept per message |
|---|---|
| `sizes` (default) | Role and length. |
| `hashed` | Plus a SHA-256 of the text. |
| `redacted` | Plus the text, with each match of `prompts.redact` replaced by `[redacted]`, and no hash. |
| `full` | Plus the hash and the text. |

The inspection checks read the captured text in memory, whatever is stored:

- **`modelProxy.inspect.canary`** enables `prompt-leak`. Put a unique string
  in the app's system prompt, and give the same string here.
- **`modelProxy.inspect.untrusted`** names evidence fields that hold retrieved
  content, such as product names. `untrusted-in-system` then checks that none
  of it is in a system message.
- **A turn's `notSentToModel`** lists seeded values that `pii-in-prompt`
  checks against every message.
- **A turn's `budget.inputTokens`** caps each call's input, judged by
  `prompt-budget`.

See [checks](checks.md#prompt-inspection-adr-0015).

## Privacy

The proxy listens on `127.0.0.1` only. It forwards each call to the upstream
the profile names, and nowhere else. A path under `/_yokla/` is never
forwarded. Records never hold a credential or another header. Prompt text
leaves memory only as `prompts.store` allows.
