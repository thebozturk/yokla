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
| `--rate-limit` | | `on` | `off` disables the rate limiter. |

demo-shop binds to `127.0.0.1` only.

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
        "attributes": {}
      }
    ],
    "metadata": { "route": "product-search", "language": "en" }
  }
}
```

- **`stockQuantity`.** `null` means the stock is unknown, not zero.
- **Routes.** `metadata.route` is one of `product-search`, `policy`,
  `follow-up-cheapest`, `refusal` and `fallback`.
- **Response cache.** The first turn of a session is cached by message. Send
  `x-cache-bypass: 1` to skip the cache. The `x-cache` response header reports
  `miss`, `hit` or `bypass`.
- **Rate limit.** Each client address gets a burst of 3 requests per second
  and 120 per minute. Excess requests get `429` with `Retry-After`.
- **Errors and health.** Invalid requests get `400`, bodies over 64 KiB get
  `413`, and `GET /healthz` returns `200`.

## Behaviour without defects

- **Products.** It lists up to three of the cheapest products of the requested
  type.
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

| Defect | What goes wrong | Detected by (v0.1 check) |
|---|---|---|
| `fabricated-price` | The first listed product is shown 10% cheaper than its catalog price. | `price-grounded` |
| `unknown-stock-claim` | Products with unknown stock are said to be in stock. | `stock-claim` |
| `invented-return-policy` | Return questions get a 30-day free-return policy. The FAQ says 14 days. | `policy-claim` |
| `filter-ignored` | Filters are dropped silently. The answer still says they were applied. | `filter-honoured-or-disclosed` |
| `over-refusal` | Answerable camping-stove questions are refused. | `over-refusal` |
| `duplicate-products` | The first product appears twice. | `no-duplicates` |
| `absence-substitution` | For an absent type, another type is presented as that type. | `absence-correct` |

`src/assistant.test.ts` holds a fixed set of probe questions. For each defect,
it asserts that the defect changes exactly the listed probes and nothing else.

## Data

- **`data/catalog.jsonl`:** 41 synthetic products in 9 types, priced in TRY.
  Stock is known for some products, zero for some and unknown (`null`) for
  others.
- **`data/faq.jsonl`:** the return policy in Turkish and English.

The data is synthetic and was made for this example.
