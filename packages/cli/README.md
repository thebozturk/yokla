# yokla

> *yokla* (Turkish): to probe, to check by touch.

The command line of yokla, which tests conversational AI assistants end to end:
answer quality, factual safety, robustness, performance and cost, resilience
and regression gates, in one run. It tests your assistant over HTTP or a
WebSocket, with a profile and cases written in YAML or JSON. Nothing about a
particular assistant is built in, and no data leaves your machine.

Node.js 24 or later.

```sh
npx yokla init --url http://127.0.0.1:3000/v1/chat   # a profile and starter cases
npx yokla run --profile yokla.profile.yaml --cases cases
npx yokla report --results runs/<run id>.json
npx yokla gate --results runs/<run id>.json
```

- `init` writes `yokla.profile.yaml` and `cases/starter.yaml` from one message
  to your assistant. Read both, and approve the cases you agree with.
- `run` exits with `0`, or with `2` for a configuration problem or a case that
  couldn't be measured.
- `gate` exits with `0` passed, `1` broken, or `2` when the run can't be
  judged.
- `proxy`, `plan` and `baseline` see the model calls, estimate a run's cost and
  keep a baseline; `yokla <command> --help` describes each.
- `yokla schema <profile|cases|config|results|baseline>` prints a JSON Schema
  for editors. The schemas are also in this package, under `schemas/`.

The guide in the yokla repository (`docs/guide/`) documents the profile, the
cases, the checks and every command.

## License

Apache-2.0
