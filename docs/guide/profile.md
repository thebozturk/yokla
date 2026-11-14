# The profile

The profile, `yokla.profile.yaml`, describes one target: how to reach it, where
its answer is, and what yokla may compare the answer with. Everything a
particular assistant needs is set here, never in yokla's code. The
[JSON Schema](../../packages/cli/schemas/profile.v1.schema.json) gives every
field with its description. `yokla schema profile` prints it for an editor:

```yaml
# yaml-language-server: $schema=<path to>/profile.v1.schema.json
version: 1
```

Problems are reported as `file:line:column`, before any request is sent.

## Paths

Two kinds of path appear in a profile:

- **JSONPath, from the response root.** Fields such as `response.text` and
  `evidence.<name>.items` use JSONPath. yokla supports a subset: `$`, `.name`,
  `['name']`, `[n]` and `[*]`. `[*]` selects every element of an array or
  every member of an object. There are no filters, unions or recursive
  descent.
- **Field paths, inside an item.** Fields such as `evidence.<name>.fields`
  use dotted names, such as `price.amount`.

## `target.request`

This section is for an HTTP target, `adapter: http`, the default. A WebSocket
target has its own request (see [WebSocket targets](#websocket-targets)).

| Field | Meaning |
|---|---|
| `url` | The chat endpoint. `--target-url` overrides it for one run. |
| `method` | `POST` (default), `PUT` or `PATCH`. |
| `headers` | Request headers. |
| `body` | A JSON body. |
| `timeoutMs` | How long a turn may take, default 30000. For a streamed answer this covers the whole stream. |
| `requestId.header` | Send a unique id per request in this header. Log observation and header correlation use it. |

Strings in `url`, `headers` and `body` may contain placeholders:

| Placeholder | Value |
|---|---|
| `{{message}}` | The user's message of the turn. |
| `{{session}}` | A new session id per sample, when `session.mode` is `client`. |
| `{{requestId}}` | The request id, when `requestId` is set. |
| `{{carry.NAME}}` | A value carried from an earlier answer or from `session.open`. |
| `{{env.NAME}}` | An environment variable. Secrets belong here, never in the file. |
| `{{auth.token}}` | The token `target.auth` gets (below). Never left out: a request without its token would only be refused. |

A string that is only a placeholder keeps the value's type. If that value
doesn't exist yet, such as a carried value on the first turn, the field or
header is left out. Inside a longer string, a missing value is an error.

A case turn can add headers or body fields for that turn only (see
[cases](cases.md)).

## `target.response`

| Field | Meaning |
|---|---|
| `text` | Where the answer text is. Required. One path reads its first match; a list of paths reads every string at each, joined in order with a blank line, for answers given as cards or other components (ADR-0020). Join only text that stands on its own: a component's title, a plan's steps, a guide's sections. Leave out a line that belongs to one item without naming it, such as a card's reason or a comparison's pros and cons: joined, it reads as being about every product (ADR-0021). |
| `route` | Where the target says which path answered, if it does. `route-expected` needs it. |
| `id` | Where the target's own request id is. Log observation can correlate by it. |
| `clarification.routes` | Routes that mean the target asked a clarifying question. Product expectations then don't apply to that turn. |
| `evidence` | The structured items the answer is based on, such as products (below). |
| `stream` | Read the answer as an event stream (below). |
| `schema` | The contract of every usable answer: `{ at, schema }` or `{ at, schemaFile }`, a JSON Schema that every value `at` selects must match, judged by `json-schema` (below). |

### Evidence

Evidence is what the target returned besides its text, such as the products it
shows. Checks compare the answer with it.

```yaml
evidence:
  products:                       # the e-commerce checks read this collection
    items: $.data.products[*]
    fields:
      id: id
      name: name
      category: category
      price: { from: [price.sale, price.list], as: number }
      currency: price.currency
      stock: stockQuantity        # null means unknown, not zero
```

- **`items`** is one JSONPath to the items, or a list of them, read in order,
  such as a card's products and a comparison's. An item with an `id` an
  earlier path returned is left out, so a product shown twice in one answer
  counts once; within one path a repeated item stays (ADR-0020).
- **`fields`** maps each evidence field, in camelCase, to a field path in the
  item. A field may give several paths, tried in order until one is not null,
  and a conversion `as: string | number | boolean`. A value that can't be
  converted is read as null and reported.
- **The e-commerce checks** read the `products` collection and its `id`,
  `name`, `price`, `currency`, `stock`, `inStock` and `category` fields.
  `stock` is a quantity; `inStock` is availability as a boolean, for targets
  that give no quantity. Filter attributes may name any other field. When the
  profile has a catalog, an item's missing `price`, `currency`, `stock`,
  `inStock` and type are completed from it by `id`.

### The response contract

`schema` holds every usable answer to a JSON Schema (ADR-0030):

```yaml
target:
  response:
    schema:
      at: $.data
      schema:
        type: object
        required: [answer, metadata]
        properties:
          metadata:
            type: object
            required: [route, language]
            properties: { language: { enum: [tr, en] } }
```

- **`at`** is a path in the response document: the JSON body, or the document
  a stream or a WebSocket becomes. It is `$` by default. A path that selects
  nothing fails.
- **The schema** is inline, or a JSON or YAML file as `schemaFile`, relative
  to the profile.
- **yokla checks a subset of JSON Schema 2020-12** itself:
  - `type`, `enum`, `const`, `allOf`, `anyOf`, `oneOf` and `not`;
  - for objects, `properties`, `required`, `additionalProperties`,
    `minProperties` and `maxProperties`;
  - for arrays, `items`, `prefixItems`, `minItems`, `maxItems` and
    `uniqueItems`;
  - for strings, `minLength`, `maxLength`, `pattern`, and `format` for
    `date-time`, `date`, `time`, `email`, `uri` and `uuid`;
  - for numbers, `minimum`, `maximum`, `exclusiveMinimum`,
    `exclusiveMaximum` and `multipleOf`;
  - `$ref` inside the schema, and `$defs`;
  - annotations such as `title` and `description`, which it ignores.
- **Any other keyword, another format, or a `$ref` outside the schema** refuses
  the profile, with the keyword and where it is. A `$ref` is never fetched.

### Streamed answers

A target that answers with server-sent events or newline-delimited JSON
declares `response.stream` (ADR-0016):

```yaml
response:
  stream:
    format: sse                    # sse | ndjson
    text: { event: text_delta, from: $.text }
    done: turn_complete            # without it, the answer is incomplete
    error: { event: error, from: $.message }
  text: $.text
  evidence:
    products:
      items: $.all.ui[*].payload.items[*].product
      fields: { id: product_id, name: title, price: price }
```

yokla turns the stream into one document, and the other response paths read
that document:

- **`text`:** the text pieces, joined in order.
- **`events`:** every event, in order.
- **`all.NAME`:** the data of every event with that name.
- **`last.NAME`:** the data of the last event with that name.

An event's name is its SSE `event` field. `stream.event` names a path in the
data to use instead. An event with neither is named `message`. A declared
`done` event that never came, or an `error` event, makes the answer
incomplete and the turn an error. Under injected faults it is a finding. The
results record `firstTextMs`, the time to the first text piece. Latency stays
the time to the full answer.

## WebSocket targets

A target that talks over a WebSocket sets `adapter: websocket` (ADR-0024):

```yaml
target:
  name: my-assistant
  adapter: websocket
  request:
    url: wss://chat.example.com/ws?session={{session}}
    headers: { authorization: 'Bearer {{env.CHAT_TOKEN}}' }
    protocols: [chat.v1]           # optional subprotocols
    body: { type: user_message, text: '{{message}}', id: '{{requestId}}' }
    timeoutMs: 30000
  response:
    stream:
      event: $.type
      text: { event: text_delta, from: $.text }
      done: turn_complete          # required
      error: { event: error, from: $.message }
    text: $.text
    route: $.last.turn_complete.route
```

**The connection.**
- A sample opens one connection, after its cache bypass and `session.open`,
  and closes it with code 1000 after its last turn.
- `url` (`ws://` or `wss://`) and `headers` are sent once, when it opens.
  - They can use `{{env.NAME}}`, `{{session}}` and the values `session.open`
    carries.
  - They can't use `{{message}}`, `{{requestId}}` or values carried from an
    answer, which change per turn.
- The cache bypass header and the client identity go with the handshake.
- yokla connects only to the target's origin. A `session.open` path resolves
  against it, with `ws` read as `http` and `wss` as `https`.

**Each turn.**
- `body` is the message sent for the turn, as JSON text. A case turn can add
  body fields, but not headers.
- `{{requestId}}` in the body gives the turn a unique id. The turn records it,
  and log observation can correlate by it.
- Values `session.carry` reads from an answer reach the next message.

**The answer.**
- Each message is one event. Its data is the parsed JSON, or the text when it
  isn't JSON. A binary message is read as UTF-8 text.
- `stream.event` is where an event's name is in its data. Without it, every
  event is named `message`. There is no `stream.format`.
- `stream.done` is required, since nothing else ends an answer. For an answer
  in one message, name that message's event, such as `done: message`.
- The document `{text, events, all, last}` is built as for a streamed answer,
  and the other response paths read it.
- `timeoutMs` bounds opening the connection, and each answer up to its done
  event.

**An incomplete answer.** The turn is an error, and the sample's later turns
don't run, when:
- the connection closes before `done`; the error gives the close code and
  reason;
- the `error` event arrives;
- `timeoutMs` runs out.

Under injected faults it is a finding instead. On an edge-case turn,
`status-allowed` judges it.

**Status.** A WebSocket turn records the status `101`, the status its
connection opened with. Wherever yokla asks for a 2xx answer, it asks a
WebSocket turn for a complete one. An `error` event is not a handled answer,
as over SSE, and `allowStatus` can't name one.

**Messages outside a turn.**
- A greeting before the first message is left unread.
- Messages that arrive after an answer's `done` event, before the next message
  goes, become an issue of the next turn. Late messages may mean that `done`
  comes too early.
- A message that arrives after the next message went is read as part of the
  next answer.

**Not available yet.**
- **The model proxy's `header` correlation.** The connection sends headers
  once, so the profile is refused with it. Use `serial`.
- **Waiting out rate limits.** A message gets no `429`.
  - `limits` paces the messages. Set it below the target's own limit, since
    a rate-limit `error` event fails the turn.
  - `retryAfter` doesn't apply.
- **`yokla init`.** Write the profile by hand.

## `target.auth`

When the target needs a token that a token endpoint or a login issues, yokla
gets it for the run (ADR-0031). The profile says where it goes, with
`{{auth.token}}`:

```yaml
target:
  request:
    url: https://chat.example.com/v1/chat
    headers: { authorization: 'Bearer {{auth.token}}' }
    body: { message: '{{message}}' }
  auth:
    kind: oauth2-client-credentials
    tokenUrl: https://auth.example.com/oauth/token
    clientId: '{{env.CHAT_CLIENT_ID}}'
    clientSecret: '{{env.CHAT_CLIENT_SECRET}}'
    scope: chat
    params: { audience: https://chat.example.com }
```

| Field | Meaning |
|---|---|
| `kind` | `oauth2-client-credentials`, as RFC 6749 §4.4 defines it, or `request`, a token request the profile describes. |
| `tokenUrl` | For OAuth: the token endpoint. |
| `clientId` | For OAuth: the client id, written or `{{env.NAME}}`. |
| `clientSecret` | For OAuth: a single `{{env.NAME}}` placeholder. A secret written in the file refuses the profile. |
| `clientAuth` | For OAuth: `basic` (default), HTTP Basic; or `body`, the id and secret in the form. |
| `scope`, `params` | For OAuth: the scope, and further form fields such as `audience`. |
| `request` | For `request`: the token request, in the form of `session.open`'s, with an absolute url. |
| `token`, `expiresIn` | For `request`: where its answer holds the token, and its lifetime in seconds. |
| `refreshBeforeMs` | A new token is fetched when less than this of its lifetime remains, or less than half of it. Default 30000. |
| `timeoutMs` | For OAuth: how long the token request may take. Default 10000. |

A login of the target's own:

```yaml
  auth:
    kind: request
    request:
      url: https://chat.example.com/api/login
      body: { username: '{{env.CHAT_USER}}', password: '{{env.CHAT_PASSWORD}}' }
    token: $.data.jwt
    expiresIn: $.data.ttlSeconds
```

- **When yokla fetches a token.**
  - Once, before the first request of the run. If that fails, the run stops
    before any case, with exit code `2`, and says why: the status, and the
    `error` and `error_description` an OAuth server gives.
  - Again before the token expires, when its lifetime is known.
  - Again after the target answers `401`, or refuses a WebSocket handshake.
    The request is sent once more with the new token; a second refusal is
    the turn's error.
  - Once at a time: requests that need a token at the same moment wait for
    the same fetch.
- **Where it can go.** In the target's request, `session.open`, and a
  WebSocket's url, headers and messages. yokla adds no header of its own.
  An `auth` whose token no request uses, or `{{auth.token}}` without an
  `auth`, refuses the profile.
- **Keeping it secret.**
  - The token, and every environment value `auth` uses, show as `***` in
    everything yokla writes: the results, the reports and the errors. That
    holds even when the target echoes one in its answer.
  - The token urls must use HTTPS, except to a loopback host.
  - The token endpoint is the only host its request may reach.
  - `auth` takes `{{env.NAME}}` placeholders only.
- **What the results say.** `run.auth` holds the kind, the tokens fetched,
  and the requests sent again after a `401`.

## `target.session`

| Field | Meaning |
|---|---|
| `mode` | `client` (default): yokla sends a new `{{session}}` id per sample. `none`: no session id. |
| `carry` | Values read from each answer and sent with the next turn as `{{carry.NAME}}`, such as a conversation id the server issues. Each is `{ name, from }`, with `from` a JSONPath. |
| `open` | A request sent once per sample, before the first turn (below). |

`session.open` is for targets that issue their own sessions:

```yaml
session:
  mode: none
  open:
    request: { url: /api/session, body: {} }
    carry: [{ name: sessionId, from: $.session_id }]
```

- Its `url` may be a path, resolved against the target url. A full url on
  another origin also works, and yokla then contacts that origin too.
- It is sent after the cache bypass, with the same cache bypass and client
  identity headers. `{{message}}` and carried values can't be used in it.
- Its `carry` values are available to every turn of the sample, in the body or
  the headers.
- If it fails, answers without JSON, or carries nothing for a name, the first
  turn is an error and no turn is sent.

## `target.limits`

| Field | Meaning |
|---|---|
| `burstPerSecond`, `perMinute`, `perHour` | A token bucket over all requests of the run, or all messages to a WebSocket target. |
| `retryAfter.headers` | Headers that say how long to wait after a `429`, default `retry-after`. A trailing `*` matches a prefix. |
| `retryAfter.unit` | `seconds` (default) or `milliseconds`. |
| `retryAfter.maxWaitMs` | The longest wait yokla accepts, default 60000. A longer wait, or a sixth `429` in a row, makes the turn an error. |
| `clientIdentity` | Opt-in, for targets that limit per address: send a rotating TEST-NET address (RFC 5737) in this header, per `case` or per `sample`. |

## `target.cacheBypass`

Every sample is cold: it bypasses the target's response cache, so an answer
is never a cached copy of an earlier sample.

- `{ kind: header, name, value }` sends a header, with `value` defaulting to
  `"1"`.
- `{ kind: command, run: [...] }` runs a local command before each sample, such
  as one that clears a cache. It is an argument list and never runs in a
  shell.
- `{ kind: none }` is the default.

## `target.observe.logs`

For a target whose model calls the proxy can't see, yokla can read the
target's own structured logs once after the run (ADR-0009):

```yaml
observe:
  logs:
    source: { kind: command, run: [docker, compose, logs, --since, '{{startedAt}}', backend] }
    contains: '[Telemetry]'
    correlate: { by: request-id, field: requestId }
    fields:
      costUsd: { from: cost.total }
      modelCalls: { from: calls, reduce: count }
      route: path
```

- **`source`:** a `file` path, or a `command` whose arguments may contain
  `{{startedAt}}`, the run's start time in ISO 8601.
- **Which lines:** each line is read as JSON, and text before the first `{`
  is ignored. `contains` keeps only lines whose text contains a string.
  `match` keeps only lines where each path has a given value.
- **Correlation:** `correlate.by` ties a line to a turn by `request-id` (the
  id yokla sent), `target-id` (`response.id`) or `order`.
- **`fields`:** maps names to paths in the line, with a `reduce` of `first`
  (default), `sum`, `count`, `any` or `all`.

Results keep only the mapped fields, labelled as reported by the target.

## Languages, domain and capabilities

- **`languages`:** the languages the target speaks, `tr` and `en`. Each case
  names one.
- **`domain`:** the domain pack, `ecommerce`.
- **`capabilities`:** what the target claims to do, each with an `id` and
  optional `description` and `provenance` (where the claim comes from, and
  whether a person approved it, ADR-0004). They document the target; no check
  reads them yet.
- **`refusal.canonical`:** per language, the target's own refusal sentences.
  The refusal checks recognise them besides the language pack's wording.

## `everyAnswer`

Rules every turn with a usable answer is held to, in every case, judged by
`answer-text` (ADR-0030). Only rules an answer must not break belong here:

```yaml
everyAnswer:
  notMatches: ['\{\{\s*\w+\s*\}\}', '\b(?:undefined|NaN|null)\b']
  notContains: [stack trace]
```

- **`notContains`:** phrases no answer may contain, after the language pack's
  folding.
- **`notMatches`:** regular expressions no answer may match, as it came, in
  the form `answer.notMatches` takes.

## `modelProxy`

Present when the app's model calls go through `yokla proxy`, or when its
OpenTelemetry spans show them (see the [model proxy guide](model-proxy.md)).
It needs an upstream, or `spans`.

| Field | Meaning |
|---|---|
| `port` | The proxy's port on `127.0.0.1`, default 8787. |
| `upstreams[]` | Each with `id`, `kind` (`openai-compatible`, `anthropic` or `gemini`, ADR-0032), `upstream` (the real provider base URL) and optionally `appBaseUrlEnv` (the app setting to point at the proxy, for people to read). The app reaches an upstream at `http://127.0.0.1:<port>/<id>`. May be empty when `spans` show the calls. |
| `correlation` | `serial` (default): one request in flight. `header`: the app forwards `x-yokla-trace` to its provider calls. |
| `settle` | After each answer in serial mode, and before the run ends, wait until the target's model calls stop: none in flight, and none for `quietMs` (default 250). Give up after `maxWaitMs` (default 10000). |
| `spans` | Read the model calls from the app's OpenTelemetry spans, tied to turns by a `traceparent` header per turn (ADR-0029). At the run's end, wait until no span has come for `quietMs` (default 6000); give up after `maxWaitMs` (default 20000). HTTP targets only. See [the model proxy guide](model-proxy.md#model-calls-from-opentelemetry-spans). |
| `prompts.store` | What the results keep of each prompt: `sizes` (default), `hashed`, `redacted` or `full`. |
| `prompts.redact` | Regular expressions whose matches `redacted` replaces. |
| `inspect.canary` | A string the app's system prompt contains, for `prompt-leak`. |
| `inspect.untrusted` | Evidence fields that hold retrieved content, per collection, such as `{ products: [name] }`, for `untrusted-in-system`. |
| `toolResults` | Per tool, evidence collections in the results the model saw, in the form of `response.evidence` (ADR-0026). See [the model proxy guide](model-proxy.md#tool-results-the-model-saw). |

## `ecommerce`

The e-commerce pack's data (see [checks](checks.md) for how each check uses
it).

| Field | Meaning |
|---|---|
| `neverFabricate` | The fact kinds the target must never invent: `price`, `stock`, `discount`, `shipping`, `returns` and `warranty`, all by default. Today `policy-claim` reads it, for `shipping`, `returns` and `warranty`: once the profile lists policies, a topic in this list without a policy entry can back no claim. |
| `policies.<topic>` | The source for a policy topic: `{ source: none }` (any concrete claim is a finding), `{ source: faq, path, topic? }` (JSON Lines rows with `topic`, `lang` and `answer`) or `{ source: text, text }`. |
| `catalog` | A JSON Lines snapshot of the catalog: `{ kind: file, path, fields: { id, type, price, currency?, stock?, inStock? } }`. Evidence items are completed from it by id. A `null` stock means unknown. |
| `typeSeparator` | Separates the levels of a product type, such as `/` in `outdoor/camping/tent`. Without it, types match only exactly. |
| `campaigns` | Amounts an answer may show besides product prices, each with `id`, `amount` and `currency`. |
| `priceSources` | Further amounts an answer may quote (ADR-0020): `{ evidence, fields }`, the amount fields of an evidence collection of the conversation, such as an order card's; or `{ file, paths }`, a JSON or JSON Lines snapshot, such as an order history, and the JSONPaths of its amounts. They ground amounts but don't make `price-grounded` apply. An amount anywhere in a file grounds a quote, whoever's order it was. |

Paths in the profile are relative to the profile file.
