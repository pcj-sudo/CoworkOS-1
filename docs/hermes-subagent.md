# Hermes subagent

Hermes runs outside CoworkOS. The [adapter](../src/runtime/subagent-backends/hermes.ts) talks to its native API Server: one `POST /v1/runs`, followed by status polling until a report or a stated limitation is available. Hermes executes its own tools, skills and memory. CoworkOS does not embed its source or pass Main's model key to it.

## Install and connect

A reproducible independent installation used for validation is Hermes Agent 0.19.0 on Python 3.14, with its messaging dependency `aiohttp==3.14.1`. For example, using an existing `uv` installation:

```sh
uv tool install --python 3.14 'hermes-agent==0.19.0' --with 'aiohttp==3.14.1'
hermes setup
```

Configure Hermes's model/provider and native tools through Hermes. The setup wizard and optional non-Python tool dependencies belong to that installation; CoworkOS does not import another client's credentials or automatically run installation scripts. The [official installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation) offers other installation methods.

### Desktop-managed local service

The desktop can start an independently installed Hermes; external installation does not require manual startup on every use. After configuring Hermes's own model/provider, create `hermes-runtime.json` in the CoworkOS user-data directory:

```json
{
  "enabled": true,
  "executable": "/absolute/path/to/hermes",
  "home": "/absolute/path/to/dedicated/hermes-home"
}
```

`home` must contain Hermes's native `config.yaml` and should be dedicated to this service. Provider credentials stay in Hermes's configuration, not this launch reference. On desktop startup the [host lifecycle](../desktop/hermes-runtime.cjs) checks the executable/config, starts `hermes gateway run`, binds its API to loopback on a random port with a fresh key, and waits for authenticated API readiness before registering the backend for Main. This check does not establish model/provider readiness. The desktop stops the owned service on normal quit or update. Backend/model-setting restarts reuse the service and its native skills/memory directory. A launch failure shows an error and leaves the rest of CoworkOS usable; details are in `logs/hermes.log`.

No launch file means no managed service; `enabled: false` disables it. This configuration works when opening the App from Finder, without shell exports. There is no install/settings button or general lifecycle framework in this implementation. Detection currently checks explicitly configured paths rather than searching all local installations. A crashed Hermes service is not automatically restarted.

### Connect an existing service (all hosts)

Alternatively, enable its API Server following [Hermes's API documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server): set `API_SERVER_ENABLED=true` and a strong `API_SERVER_KEY` in Hermes's own environment, then run `hermes gateway run`. The default listener is `http://127.0.0.1:8642`. This mode leaves startup and shutdown to the service operator.

In the environment used to launch CoworkOS CLI, Web or desktop from a terminal, configure:

```sh
export COWORK_HERMES_URL=http://127.0.0.1:8642
# Supply COWORK_HERMES_API_KEY from your shell's secret facility.
# It must match Hermes's API_SERVER_KEY, not a model provider key.
```

An explicit URL takes precedence over desktop-managed startup; CoworkOS never stops that external service. Without a URL or an enabled desktop launch configuration, the backend is disabled. A URL without a key is a configuration error. Use the API root without `/v1`; profile prefixes such as `/p/<profile>` may be part of the root. Credentials must not be placed in the URL. Requests do not follow redirects. This environment-based mode requires the desktop's launch environment to be configured when opening from Finder.

Main can discover and call the installed backend through the same tools in all hosts:

```json
{}
```

Call the above with `list_subagent_backends`, then:

```json
{
  "backendId": "hermes",
  "task": "Inspect the explicitly authorized project using your native tools. Return findings, evidence and any output file locations.",
  "mode": "async"
}
```

`sync` waits in the call; `async` returns a call ID and delivers the eventual report through the usual Main Inbox. Main judges acceptance from the report and evidence. Native file permissions and paths come from Hermes configuration. Neither a successful HTTP response nor Hermes's final text by itself proves a generated file is correct.

## Supported scope

- Required: text task submission, waiting for the report, attributable completion/failure/unknown, native run reference and persistence in CoworkOS.
- Available observations: polled native status and `last_event` changes, native run/session identifiers and the final report. When the host supplies the optional observation callback, a single authenticated Runs SSE subscription also records tool names, native previews, completion/failure and durations in the existing member trajectory. Status polling remains authoritative for the final report. Missing/failed SSE falls back to polling without resubmitting work; the stream is closed when observation ends. Hermes 0.19 supplies no per-call tool ID or full tool output here: local timeline IDs pair same-name tools in observed order, and the UI discloses missing native output. This is partial observability, not a full transcript or verified business acceptance. Text/reasoning deltas are not imported.
- Team identification: the existing member name remains stable; the member list, galaxy and trace header additionally show the backend type (Hermes, Pi or a configured backend name) and a local type mark. Native task/session IDs and observation limits are expandable in the trace header. Historical calls lacking a backend ID are treated as the original Pi runtime.
- Optional readiness: authenticated `GET /v1/models`. This proves API access, not model/provider readiness.
- Not implemented: CoworkOS resource/attachment grants, file upload/download or artifact promotion, native workspace assignment, follow-up/peer messaging, approval/clarification replies, cancel and reconnect/resume. These are not required by the [minimal contract](subagent-backends.md).

A native approval/clarification wait returns `unknown` with a reference and explanation for Main; no answer or approval is invented. The native run may remain waiting. Main can arrange a native action or ask the user for a decision. An unknown/interrupted run, malformed response, communication failure or observation expiry also returns `unknown`. Observation expiry does not stop native work. No path retries task creation, even though a stable `Idempotency-Key` is sent: older Hermes versions, including the validated 0.19.0 release, do not guarantee Runs creation deduplication. Coordinator never automatically replays external work after losing its owner.

The adapter's default observation limit and request/poll settings are constructor options for embedding hosts; environment-based registration uses the defaults. Desktop service startup is separate from the minimal backend contract and does not change `run` or require other external agents to support process management.

## Verification

```sh
npm run build:cli
node --test test/subagent-backend.test.js test/hermes-backend.test.js
node --test test/hermes-events.test.js test/agent-room.test.js
npx playwright test e2e/hermes-observability.spec.js --workers=1
node --test test/desktop-hermes-runtime.test.js test/desktop-backend.test.js
COWORK_TEST_HERMES_PYTHON=/path/to/independent/hermes-venv/bin/python \
  node --test test/hermes-native.test.js
npm run verify
```

[Protocol regressions](../test/hermes-backend.test.js) cover completion, failure, malformed responses, identity mismatch, approval waits, observation expiry and no resubmission. The opt-in [native test](../test/hermes-native.test.js) starts the installed Hermes API adapter and actual `AIAgent`, supplies a local deterministic model, verifies a file written by Hermes's native `write_file`, and checks both Main/Pi sync and async routing. It does not replace Hermes's agent or tool implementation. Without the explicit Python path this test is skipped; protocol fixtures alone do not establish native-runtime compatibility.

This verification uses a local model fixture. A paid/provider-backed model run, native desktop UI, and a clean-machine installation are separate checks. Running the product requires a working provider configured in Hermes and Main's own provider configured in CoworkOS.
