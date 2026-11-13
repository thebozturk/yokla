# 0024. WebSocket targets

Status: Accepted · Date: 2026-11-14

## Context

yokla reaches a target over HTTP: a JSON body, or an event stream
(ADR-0016). Many chat assistants talk over a WebSocket instead. The client
opens one connection, sends each user message as a message, and the server
answers with a series of messages: text pieces, tool results, an end of
turn. Design §11 plans WebSocket targets for v0.3.

What carries over from HTTP and what doesn't:

- **The answer already has a model.** ADR-0016 turns a stream of events
  into one document that the profile's paths read. A WebSocket answer is
  the same kind of stream, with one event per message.
- **The connection outlives a turn.** Over HTTP, a response ends the
  answer. Over a WebSocket nothing ends but the connection, so the end of
  an answer must be declared.
- **There is no status per answer.** The connection opens with `101
  Switching Protocols`, and later messages have no status. Node.js doesn't
  report the HTTP status of a refused handshake either.
- **Headers go once.** They are sent when the connection opens, not with
  each message.
- **Node.js 24 and later have a WebSocket client built in.** A local probe
  on Node.js 26 showed that it sends handshake headers and reports close
  codes. CI checks the same on Node.js 24.

## Decision

### The profile

```yaml
target:
  adapter: websocket
  request:
    url: wss://chat.example.com/ws?session={{session}}
    headers: { authorization: 'Bearer {{env.CHAT_TOKEN}}' }
    protocols: [chat.v1]          # optional subprotocols
    body: { type: user_message, text: '{{message}}', id: '{{requestId}}' }
    timeoutMs: 30000
  response:
    stream:
      event: $.type
      text: { event: text_delta, from: $.text }
      done: turn_complete
      error: { event: error, from: $.message }
    text: $.text
    evidence: { ... }
```

- **`adapter: websocket`** selects it. `http` stays the default.
- **The request.**
  - `url` is `ws://` or `wss://`. It and `headers` may use `{{env.NAME}}`,
    `{{session}}` and the values `session.open` carries. They are sent once,
    when the connection opens.
  - `body` is the message sent for each turn. JSON is sent as one text
    message. It takes the same placeholders as an HTTP body.
  - `{{requestId}}` in the body gives each turn a unique id. The turn records
    it for log correlation (ADR-0009).
  - `timeoutMs` bounds opening the connection, and each answer from its
    message to its `done` event.
- **The answer** is read as ADR-0016 reads a stream.
  - Each message is one event, and its data is the parsed JSON, or the text
    when it isn't JSON. A binary message is read as UTF-8 text.
  - An event's name is at `stream.event`. Without it, every event is named
    `message`.
  - `stream.format` doesn't apply.
  - `stream.done` is required, since nothing else ends an answer. An answer
    given in one message names that message's event, such as `done:
    message`.
  - The document `{text, events, all, last}` and every path that reads it
    work as before.

### A conversation is one connection

- **Lifetime.** A sample opens one connection after its cache bypass and
  `session.open`, and before its first turn. It closes the connection, with
  code 1000, after its last turn.
- **Carried values.** Values that `session.carry` reads from an answer reach
  the next turn's message. The URL and headers were already sent.
- **Messages outside a turn.** Messages that arrive while no turn waits
  belong to no turn.
  - Before the first message, such as a greeting, they are left unread.
  - After an answer's `done` event, the next turn notes how many arrived, as
    an issue. Late messages may mean the profile's `done` comes too early.
- **One connection only.** It is opened only to the target's origin, as the
  HTTP client is (ADR-0003). A path in `session.open` resolves against that
  origin, with `ws` read as `http` and `wss` as `https`.

### Failures

- **The connection doesn't open.** The sample's first turn is an error, as
  with a failed session setup. It names the reason Node.js gives. That
  reason doesn't include a refused handshake's status.
- **The answer doesn't complete.** The answer is incomplete, as ADR-0016
  defines it, when:
  - the connection closes before `done`; the error names the close code and
    reason;
  - the `error` event arrives;
  - `timeoutMs` runs out.
  Later turns of the sample don't run, as with any turn error. Under faults
  the failure is a finding (ADR-0013). On an edge-case turn it is judged
  (ADR-0019).
- **The size limit** applies to each answer, all its messages counted.

### Status and the checks

- **A WebSocket turn records the status `101`,** the status its connection
  opened with. results.v1 doesn't change.
- **A complete answer, not a 2xx status.** Wherever yokla asks for a 2xx
  answer, it asks a WebSocket turn for a complete one: an answer that ended
  with `done`.
  - That covers the runner, `status-allowed` and the fault checks.
  - An `error` event isn't a handled answer, as it isn't over SSE
    (ADR-0019).
  - `allowStatus` can't name one, since a WebSocket answer has no status
    to allow.

### What a WebSocket target doesn't support yet

- **`header` correlation.** It needs a header on every turn, and the
  connection sends headers once. The profile is rejected with it. `serial`
  correlation works as it does over HTTP.
- **Waiting out rate limits.** A message gets no 429. `limits` still paces
  the messages, and `retryAfter` doesn't apply.
- **`yokla init`.** It needs to find the end of an answer without a declared
  `done` event. It refuses a `ws://` or `wss://` url and points to the
  guide.

### Tests

- **The runtime** gets a WebSocket client on Node.js's built-in one. A small
  test server checks the client against it:
  - handshake headers and subprotocols;
  - a refused origin;
  - an answer in many messages and in one;
  - a close mid-answer, an `error` event and a timeout;
  - messages between turns;
  - the size limit.
- **The demo-shop** answers on a WebSocket path too, with the events its
  stream sends. Its server is written for it and has no dependency.
- **The acceptance run passes over WebSocket** as it does over HTTP, and a
  seeded defect is caught the same way.
- **The egress guard** covers the client: it connects through `net.Socket`.

## Consequences

- **Profiles describe WebSocket assistants without code.** The paths, checks
  and reports stay as they are.
- **No new dependency.** The client is Node.js's own. The servers for the
  tests and the demo-shop are small and written here.
- **A refused connection says less than a refused request.** Node.js doesn't
  report the handshake's status, so the error can't say whether it was a
  401 or a 404.
- **Results read `101` for every WebSocket turn.** The guide says what it
  means.
- **The trade-offs of one connection per conversation.**
  - It matches a chat session.
  - A target that closes the connection after each answer stops the sample
    after its first turn.
  - Such a target needs a connection per turn. That is left for a target
    that needs it.

## Alternatives considered

- **A WebSocket library.** Node.js 24 and later has a client built in, and
  it sends handshake headers. A dependency would add supply-chain surface
  for nothing. Rejected. If CI shows that Node.js 24's client can't send
  them, a new ADR decides.
- **A connection per turn.** Many servers keep the conversation's state on
  the connection, so a new one per turn would lose it. Deferred as an option
  until a target needs it.
- **Ending an answer after a quiet period** instead of a declared `done`.
  It would cut off a slow answer and make a fast one wait. Rejected.
- **Recording `200` for a complete answer.** The results would show an HTTP
  status nobody sent. Rejected: `101` is the status the connection got.
- **Counting the `error` event as an allowed status on edge-case turns.**
  Over SSE it isn't one (ADR-0019), and the two transports should judge
  alike. Rejected.
- **`yokla init` for WebSocket now.** Without a declared `done`, it would
  have to guess where an answer ends. Deferred.
