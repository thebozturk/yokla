# demo-shop

A small outdoor-gear shop assistant with seeded defects. yokla tests itself
against it (design §19).
- **The model.** demo-shop uses a deterministic, rule-based stand-in for an
  LLM. Runs make no model calls, cost nothing and give the same answer every
  time.
- **Languages.** It answers in Turkish and English.
- **Dependencies.** None beyond Node.js.

demo-shop doesn't import yokla, and yokla doesn't import demo-shop. yokla
tests it over HTTP, like any other target.

## Run

```sh
pnpm --filter yokla-demo-shop start                          # http://127.0.0.1:3000, no defect
pnpm --filter yokla-demo-shop start --port 0 --defect fabricated-price
pnpm --filter yokla-demo-shop start --list-defects
```

| Option | Environment | Default | Meaning |
|---|---|---|---|
| `--port` | `PORT` | `3000` | `0` picks a free port; the startup line prints the URL. |
| `--defect` | `DEMO_SHOP_DEFECT` | `none` | The one seeded defect to turn on. |
| `--list-defects` | | | Print the defects and exit. |
| `--rate-limit` | | `on` | `off` disables the rate limiter. |
| `--model-url` | `DEMO_SHOP_MODEL_URL` | in process | An OpenAI-compatible base URL for the model calls. |
| `--model-stream` | | off | Ask the model for event streams, with usage in the last chunk. |
| `--model-timeout-ms` | | `3000` | How long a model call may take before the demo-shop falls back. |
| `--model-canary` | | none | A canary to plant in every system prompt, for leak tests. |
| `--model-summary` | | off | Summarise each answer with a model call shortly after it went out, never awaited. |
| | `DEMO_SHOP_MODEL_KEY` | `demo-key` | The key sent with the model calls. |

The options from `--model-stream` down take effect only with `--model-url`:
the model in process has no system prompt, no timeout and no summary call.
demo-shop binds to `127.0.0.1` only.

### The model over HTTP

By default the model runs in process. With `--model-url`, the model calls of a
turn go to an OpenAI-compatible chat completions endpoint, so a model proxy
can sit in between (ADR-0012). A turn makes two calls, interpret and write,
and a third with `--model-summary`.

- **The fake provider** answers those calls the way the model in process
  would, so the answers stay the same. It counts one token per started four
  bytes, and it keeps its own usage records: the provider's side that the
  proxy's measurements are reconciled with. It costs nothing and contacts
  nothing. Its `--key` (default `demo-key`) must equal the demo-shop's
  `DEMO_SHOP_MODEL_KEY`; otherwise it answers `401`.
- **Defects.** Model defects (`fabricated-price`, `unknown-stock-claim`,
  `invented-return-policy`, `absence-substitution`, `over-refusal`) then belong
  to the provider: start it with `--defect`. Given to the demo-shop with
  `--model-url` set, they have no effect. The app's own defects stay with the
  demo-shop.
- **Trace.** The demo-shop passes an incoming `x-yokla-trace` header on to
  every model call of the turn, the one-line change `header` correlation needs.
- **Resilience.** The model client retries once after a `429` or `503`,
  honouring `Retry-After` up to 2 seconds. It gives up after
  `--model-timeout-ms`. It refuses empty output, an error status and an
  interpretation that isn't valid JSON. When the model fails, the demo-shop
  answers from a template on the `fallback` route, with no products. That
  answer is never cached. `cases-resilience/` holds the six cases that inject
  the faults (ADR-0013).
- **Prompts.** Each system prompt names the job on its first line, then the
  instructions, then the `--model-canary` if one is set. The products found
  and the user's message go into the user message, never the system message,
  and only the products the answer shows. Phone numbers and e-mail addresses
  in the user's message are masked before any model call. A guard refuses
  model output that repeats the system prompt; the demo-shop then falls back.
  The fake provider, like a model that gives in to an extraction request,
  repeats its system prompt when asked for its instructions.
  `cases-inspection/` holds the six cases for the inspection checks
  (ADR-0015).

```sh
mkdir -p runs
node examples/demo-shop/src/provider-main.ts --port 0 --usage-log runs/provider-usage.jsonl
pnpm --filter yokla-demo-shop start --port 0 --model-url http://127.0.0.1:<port>/v1
```

The `--usage-log` directory must exist: the provider appends to the file but
doesn't create its directory.

### Run the proxy cases by hand

The resilience and inspection cases need the model proxy between the
demo-shop and the fake provider. `packages/cli/src/proxy.e2e.test.ts` runs
them in CI, a demo-shop per defect. To run them yourself:

1. **Copy the profile** next to the original, so its `./data/` paths still
   resolve, for example as `examples/demo-shop/yokla.proxy.profile.yaml`, and
   add a model proxy that points at the fake provider:

   ```yaml
   modelProxy:
     upstreams:
       - { id: fake, kind: openai-compatible, upstream: 'http://127.0.0.1:<provider port>/v1' }
     inspect:                         # only for cases-inspection/
       canary: DEMO-CANARY-7F3A
       untrusted: { products: [name] }
   ```

2. **Start the three processes,** each in its own terminal:

   ```sh
   node examples/demo-shop/src/provider-main.ts --port 0
   pnpm yokla proxy --profile examples/demo-shop/yokla.proxy.profile.yaml
   pnpm --filter yokla-demo-shop start --port 0 --model-url http://127.0.0.1:8787/fake \
     --model-timeout-ms 300                                # for cases-resilience/
   ```

   For `cases-inspection/`, start the demo-shop with
   `--model-canary DEMO-CANARY-7F3A` instead of `--model-timeout-ms 300`. The
   resilience case `provider-stalls` expects an answer within one second, so it
   needs the shorter model timeout. Without the canary in the demo-shop, a run
   with `inspect.canary` in the profile notes that the canary reached no system
   prompt.

3. **Run the cases:**

   ```sh
   pnpm yokla run --profile examples/demo-shop/yokla.proxy.profile.yaml \
     --cases examples/demo-shop/cases-resilience --target-url http://127.0.0.1:<port>/v1/chat
   ```

Add `--defect <name>` to the demo-shop to see a defect caught.

### Test it with yokla

Start the demo-shop on a free port, then run the 18 acceptance cases in
`cases/` against it. The demo-shop is a target like any other: yokla reaches
it over HTTP and imports nothing from it.

```sh
pnpm --filter yokla-demo-shop start --port 0       # prints the url
pnpm yokla run --profile examples/demo-shop/yokla.profile.yaml \
  --target-url http://127.0.0.1:<port>/v1/chat
```

`packages/cli/src/demo-shop.e2e.test.ts` does the same in CI.

- **JUnit XML.** `--junit <file>` also writes a JUnit XML report for CI.
- **HTML.** `--html <file>` also writes an offline HTML report with every
  answer and finding (ADR-0023).
- **Earlier runs.** `pnpm yokla report --results runs/<run id>.json` prints the
  summary of a results file and can write the same reports.
- **Gate.** `pnpm yokla gate --results <file> [--baseline <file>]` exits with
  `0` passed, `1` broken or `2` when the run can't be judged (ADR-0010).
- **Baseline.** `pnpm yokla baseline --results <file>` accepts a run as
  `yokla.baseline.json` and prints what changed since the last one (ADR-0011).

[`docs/guide/cli.md`](../../docs/guide/cli.md) lists every option.

## API

`POST /v1/chat` with `{"message": string, "sessionId": string}` returns:

```json
{
  "data": {
    "answer": "Here are our headlamps:\n- Headlamp 200 lm: TRY 349.90 (in stock)\n...",
    "products": [
      {
        "id": "HLP-001",
        "name": "Headlamp 200 lm",
        "category": "outdoor/lighting/headlamp",
        "price": { "amount": 349.9, "currency": "TRY" },
        "stockQuantity": 40,
        "available": true,
        "attributes": {}
      }
    ],
    "metadata": { "route": "product-search", "language": "en" }
  }
}
```

- **`stockQuantity`.** `null` means the stock is unknown, not zero.
- **`available`.** The same stock as a boolean, as shops without quantities
  give it; `null` when the stock is unknown. yokla's evidence end-to-end test
  reads stock through it (ADR-0020).
- **Routes.** `metadata.route` is one of `product-search`, `policy`,
  `follow-up-cheapest`, `refusal` and `fallback`. `fallback` answers a model
  failure, a message the shop doesn't understand, such as a greeting, and a
  "cheaper" follow-up with no earlier products.
- **Response cache.** The first turn of a session is cached by message. Send
  `x-cache-bypass: 1` to skip reading the cache. The `x-cache` response header
  reports `miss`, `hit` or `bypass`.
- **Rate limit.** Each client address gets a burst of 3 requests per second
  and 120 per minute, `POST /v1/sessions` included. Excess requests get `429`
  with `Retry-After`.
- **Errors and health.** Invalid requests get `400`: `message` must be a
  non-empty string of at most 2000 characters, and `sessionId` at most 128.
  Bodies over 64 KiB get `413`, unknown paths `404`, and a method other than
  `POST` `405`. `GET /healthz` returns `200`.
- **Streamed answers.** With `accept: text/event-stream`, the answer comes as
  server-sent events: `products` with the products, `delta` events with the
  text in pieces, then `done` with the metadata.
- **Sessions the shop issues.** `POST /v1/sessions` returns `201` with
  `{"data": {"sessionId": string}}`. A chat that sends it in `x-session-id`
  uses it over any `sessionId` in the body.
- **Chat over a WebSocket.** `/v1/ws` takes the same JSON message as
  `POST /v1/chat`, one per turn, and answers with the events of the stream,
  one message each, named by `type`: `products`, `delta` and `done`.
  - A `session` in the url, as in `/v1/ws?session=abc`, holds for every
    message.
  - An invalid message or a rate limit comes back as
    `{"type": "error", "error": ..., "detail": ...}`, and the connection stays
    open.
  - `x-cache-bypass` goes with the handshake.
  - The acceptance end-to-end test also runs over it (ADR-0024).

The proxy end-to-end test (`packages/cli/src/proxy.e2e.test.ts`) tests the
demo-shop this way too: with a session it issues, answers as events and a
summary call after each answer (ADR-0016).

## Behaviour without defects

- **Products.** It lists up to three of the cheapest products of the requested
  type. A follow-up with only filters, such as "only black ones", refines the
  previous search, and "the cheaper one" picks the cheapest product shown.
- **Prices.** Every price is shown exactly as in the catalog.
- **Stock.** It says "in stock" or "out of stock" only when the stock is known.
  Otherwise it says the stock isn't confirmed.
- **Filters.** It applies price, size, colour and gender filters. When nothing
  matches, it says so and shows the type without the filters.
- **Absent types.** For a type the catalog doesn't carry (sleeping pads,
  hammocks, gaiters), it says the type is absent. It offers another type only
  as a different product.
- **Returns.** It answers return questions from `data/faq.jsonl`.
- **Shipping and warranty.** The shop has no source for these, so it says it
  can't verify them.
- **Out-of-scope questions.** It refuses them, for example investment or
  medical questions.

## Defects

| Defect | What goes wrong | Detected by |
|---|---|---|
| `fabricated-price` | The first listed product is shown 10% cheaper than its catalog price. | `price-grounded` |
| `unknown-stock-claim` | Products with unknown stock are said to be in stock. | `stock-claim` |
| `invented-return-policy` | Return questions get a 30-day free-return policy. The FAQ says 14 days. | `policy-claim` |
| `filter-ignored` | Filters are dropped silently. The answer still says they were applied. | `filter-honoured-or-disclosed` |
| `over-refusal` | Answerable camping-stove questions are refused. | `over-refusal` |
| `duplicate-products` | The first product appears twice. | `no-duplicates` |
| `absence-substitution` | For an absent type, another type is presented as that type. | `absence-correct` |
| `type-padding` | A short result is filled up with other types that satisfy the filters, under the requested type's heading. | `type-matched-or-disclosed` |
| `no-model-fallback` | With the model over HTTP, a model failure becomes a `500` instead of a fallback answer. | `graceful-under-fault` (v0.2) |
| `no-model-timeout` | With the model over HTTP, a stalled model stalls the answer. | `answered-within-deadline` (v0.2) |
| `unchecked-model-output` | With the model over HTTP, empty model output reaches the user. | `route-expected` (v0.2) |
| `products-in-system` | With the model over HTTP, the products found are put into the system message. | `untrusted-in-system` (v0.2) |
| `prompt-bloat` | With the model over HTTP, the whole catalog goes with every answer to write. | `prompt-budget` (v0.2) |
| `unmasked-pii` | Phone numbers and e-mail addresses in the user's message reach the model unmasked. | `pii-in-prompt` (v0.2) |
| `no-leak-guard` | With the model over HTTP, an answer that repeats the system prompt reaches the user. | `prompt-leak` (v0.2) |

`src/assistant.test.ts` holds a fixed set of probe questions. For each defect,
it asserts that the defect changes exactly the listed probes and nothing else.

## Data

- **`data/catalog.jsonl`:** 41 synthetic products in 9 types, priced in TRY.
  Stock is known for some products, zero for some and unknown (`null`) for
  others.
- **`data/faq.jsonl`:** the return policy in Turkish and English.

The data is synthetic and was made for this example.
