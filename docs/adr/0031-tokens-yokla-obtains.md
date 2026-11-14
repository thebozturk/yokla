# 0031. Authentication: tokens yokla obtains and refreshes

Status: Proposed · Date: 2026-11-15

## Context

A target that needs a credential gets it today from the environment: a
profile writes `authorization: 'Bearer {{env.TOKEN}}'`. That works for an
API key, or a token the user fetched before the run. It doesn't work when:

- **the token is short-lived.** OAuth 2.0 access tokens often last minutes. A
  run with several samples outlasts them, and its later turns fail with 401.
- **a token endpoint issues it.** A service account gets its token by client
  credentials (RFC 6749 §4.4), with a secret it never sends to the target.
- **the target's own login issues it,** in the answer to a login request.

`session.open` (ADR-0016) can't stand in:

- it runs once per sample, so every sample would fetch a token;
- it can't fetch a new one during a sample;
- what it carries is a value of the conversation, not a secret.

Design §15 keeps secrets in the environment and out of results. A token yokla
obtains is a secret too.

v0.3 plans authentication, "OAuth2 and the like".

## Decision

### Where the token comes from

`target.auth` says how yokla gets a token, in one of two ways.

- **OAuth 2.0 client credentials,** as RFC 6749 §4.4 defines them:

  ```yaml
  target:
    auth:
      kind: oauth2-client-credentials
      tokenUrl: https://auth.example.com/oauth/token
      clientId: '{{env.CHAT_CLIENT_ID}}'
      clientSecret: '{{env.CHAT_CLIENT_SECRET}}'
      scope: chat
      params: { audience: https://chat.example.com }
  ```

  - yokla posts a form with `grant_type=client_credentials`, the `scope` and
    any `params`.
  - The client authenticates with HTTP Basic, or with `clientAuth: body` in
    the form.
  - yokla reads `access_token`, and `expires_in` when given.
- **A token request the profile describes,** for a login of the target's own:

  ```yaml
  target:
    auth:
      kind: request
      request:
        url: https://chat.example.com/api/login
        body: { username: '{{env.CHAT_USER}}', password: '{{env.CHAT_PASSWORD}}' }
      token: $.data.jwt
      expiresIn: $.data.ttlSeconds
  ```

  - The request has the shape of `session.open`'s, and takes only
    `{{env.*}}` placeholders.
  - `token` is where the answer holds the token, and `expiresIn`, optional,
    its lifetime in seconds.

### Where the token goes

- **The profile says where:** `{{auth.token}}` in the target's request (url,
  headers or body), in `session.open`, or in a WebSocket's url and headers.
  For example, `authorization: 'Bearer {{auth.token}}'`.
- **yokla adds no header of its own.** Targets differ in the header, its
  prefix, or a query parameter (P9).
- **A mismatch refuses the profile:** an `auth` whose token no request uses,
  or `{{auth.token}}` without an `auth`.

### When it is fetched

- **Once, before the first request of the run.** If that fails, the run stops
  before any case, with exit code `2`.
- **Again before it expires.** A token is replaced when less of its lifetime
  remains than `auth.refreshBeforeMs` (30000 ms by default), or than half its
  lifetime, whichever is less. A token without a lifetime is used until the
  target refuses it.
- **Again after a 401.** When the target answers 401, or refuses a WebSocket
  handshake with it, yokla fetches a new token and sends the request once
  more. A second 401 is the turn's error.
- **One fetch at a time.** Requests that need a token wait for the fetch in
  progress, whatever the concurrency.
- **A failed fetch says why:** the status, and the `error` and
  `error_description` an OAuth server gives. A failed fetch after the run has
  started makes the turns that needed the token errors.

### Keeping it secret

- **Every value of `auth` is a secret:** the token, and every environment
  value the auth section uses.
  - None is written to results, reports or issues. Any text yokla writes that
    holds one shows `***` instead.
  - The token answer is never stored.
- **The client secret comes from the environment.** `clientSecret` must be a
  single `{{env.NAME}}` placeholder.
- **Credentials never travel in clear text over a network.** `tokenUrl`, and
  a token request's url, must use HTTPS, except to a loopback host.
- **The token endpoint is reached for the token alone.** The HTTP client
  allows its origin for the token request, and for nothing else (ADR-0003).

### What the results get

`run.auth` says how the run was authenticated, with no secret in it:

- the kind;
- how many tokens were fetched;
- how many requests were sent again after a 401.

### The demo-shop

- **`--auth` turns on bearer tokens.**
  - Without a valid token, the chat and the WebSocket answer 401.
  - `POST /v1/oauth/token` issues tokens by client credentials.
  - `POST /v1/login` issues them for a username and password, in its own
    answer shape.
  - `--token-ttl-ms` sets their lifetime, and `--token-uses` how many requests
    one serves before it is refused.
- **The test.** The end-to-end test runs the acceptance cases with each kind.
  - A lifetime shorter than the run makes yokla refresh.
  - A limit on uses makes the target refuse a token mid-run, so the 401 path
    runs.
  - Every case still passes, and `run.auth` counts the fetches and the
    retries.
  - No token and no secret appears in the results, the HTML or JUnit report,
    or the output.

## Consequences

- **A target behind client credentials or a login can be tested** in a run of
  any length.
- **One line more in the profile:** where the token goes. Nothing is guessed.
- **yokla holds more secrets in memory,** and masks them in all it writes.
- **A token request goes to a host other than the target.** It is in the
  profile, where a person reviews it.
- **`yokla init` can't probe a target behind a login yet.** A later change can
  let it take an `auth` section.

## Alternatives considered

- **A token per sample through `session.open`.** It multiplies the token
  requests, can't refresh during a sample, and carries a secret as a value of
  the conversation. Rejected.
- **An `Authorization` header added by yokla.** It hides where the token goes,
  and targets differ. Rejected (P9).
- **A token from a local command,** such as a cloud CLI that prints one. A
  run can take it from the environment today. Fetching anew would mean
  running the command again, which a later ADR can add when a target needs
  it. Deferred.
- **Flows where a person logs in,** such as authorization code or device
  code. They don't fit an unattended run; the person passes the token in the
  environment. Rejected.
- **Cookies a login sets, client certificates, and signed requests** such as
  AWS SigV4. Deferred until a target needs them.
- **Several identities,** such as two customers for authorization tests.
  Deferred to the red team (v0.5).
- **An OAuth library.** The two flows are small, and a library adds
  supply-chain surface. Rejected.
