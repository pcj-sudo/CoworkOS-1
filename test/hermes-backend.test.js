import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { HermesBackend } from "../dist/src/runtime/subagent-backends/hermes.js";
import { configuredSubagentBackends } from "../dist/src/runtime/subagent-backends/configured.js";

async function fixture(t, handle, options = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry = {
      path: req.url,
      method: req.method,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined
    };
    requests.push(entry);
    const reply = await handle(entry, requests);
    res.writeHead(reply.code ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    url,
    backend: new HermesBackend({
      url,
      apiKey: "server-only-key",
      pollMs: 1,
      observationTimeoutMs: 2000,
      ...options
    })
  };
}
const task = { callId: "cowork-call-1", task: "Research with your native tools" };
const accepted = { code: 202, body: { run_id: "native-1", status: "started" } };

test("Hermes submits once, waits past acceptance, retains native identity and emits available progress", async (t) => {
  const f = await fixture(t, (r, all) =>
    r.method === "POST"
      ? accepted
      : {
          body:
            all.length === 2
              ? { run_id: "native-1", status: "running", last_event: "tool.started" }
              : {
                  run_id: "native-1",
                  session_id: "session-9",
                  status: "completed",
                  output: "Evidence and native paths"
                }
        }
  );
  const refs = [],
    progress = [];
  const result = await f.backend.run(
    { ...task, context: "Main context" },
    {
      onReference: (r) => {
        refs.push({ ...r });
      },
      onProgress: (m) => {
        progress.push(m);
      }
    }
  );
  assert.equal(result.status, "completed");
  assert.equal(result.nativeRef.sessionId, "session-9");
  assert.equal(refs[0].runId, "native-1");
  assert.match(progress[0], /running: tool.started/);
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  assert.deepEqual(Object.keys(f.requests[0].body), ["input"]);
  assert.match(f.requests[0].body.input, /Main context/);
  assert.equal(f.requests[0].headers.authorization, "Bearer server-only-key");
  assert.equal(f.requests[0].headers["idempotency-key"], task.callId);
  assert.equal(f.requests[1].path, "/v1/runs/native-1");
});

for (const [status, output, expected] of [
  ["completed", "", "failed"],
  ["failed", "partial", "failed"],
  ["cancelled", "", "failed"],
  ["interrupted", "partial", "unknown"],
  ["unknown", "", "unknown"],
  ["waiting_for_approval", "", "unknown"],
  ["waiting_for_clarification", "", "unknown"],
  ["new-native-state", "", "unknown"]
])
  test(`Hermes ${status} maps honestly to ${expected}`, async (t) => {
    const f = await fixture(t, (r) =>
      r.method === "POST"
        ? accepted
        : { body: { run_id: "native-1", status, output, error: "secret: server-only-key" } }
    );
    const result = await f.backend.run(task);
    assert.equal(result.status, expected);
    assert.equal(result.nativeRef.runId, "native-1");
    assert.ok(!result.summary.includes("server-only-key"));
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  });

for (const code of [401, 500])
  test(`Hermes POST HTTP ${code} is never automatically retried`, async (t) => {
    const f = await fixture(t, () => ({ code, body: { error: "private server diagnostic" } }));
    const result = await f.backend.run(task);
    assert.equal(result.status, code === 401 ? "failed" : "unknown");
    assert.equal(f.requests.length, 1);
    assert.ok(!result.summary.includes("private server diagnostic"));
  });

for (const bad of ["json", "identity", "http"])
  test(`invalid ${bad} status preserves the native reference without resubmission`, async (t) => {
    const f = await fixture(t, (r) =>
      r.method === "POST"
        ? accepted
        : bad === "json"
          ? { raw: "invalid json" }
          : bad === "http"
            ? { code: 404, body: {} }
            : { body: { run_id: "another-run", status: "completed", output: "wrong task" } }
    );
    const result = await f.backend.run(task);
    assert.equal(result.status, "unknown");
    assert.equal(result.nativeRef.runId, "native-1");
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  });

test("observation expiry does not claim cancellation or call the stop endpoint", async (t) => {
  const f = await fixture(
    t,
    (r) => (r.method === "POST" ? accepted : { body: { run_id: "native-1", status: "running" } }),
    { observationTimeoutMs: 50 }
  );
  const result = await f.backend.run(task);
  assert.equal(result.status, "unknown");
  assert.match(result.summary, /not cancelled or resubmitted/);
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
});

test("redirects cannot forward the Hermes credential to a different server", async (t) => {
  const f = await fixture(t, () => ({
    code: 307,
    body: {},
    headers: { location: "http://127.0.0.1:1/stolen" }
  }));
  assert.equal((await f.backend.run(task)).status, "unknown");
  assert.equal(f.requests.length, 1);
});

test("readiness checks authenticate and unsupported inputs fail before native submission", async (t) => {
  const f = await fixture(t, () => ({ code: 401, body: {} }));
  assert.equal((await f.backend.check()).ready, false);
  assert.equal(f.requests[0].path, "/v1/models");
  assert.equal((await f.backend.run({ ...task, workingDirectory: "/unused" })).status, "failed");
  assert.equal(f.requests.length, 1);
});

test("Hermes configuration is explicit and never imports native credentials automatically", () => {
  assert.deepEqual(configuredSubagentBackends({}), []);
  assert.throws(
    () => configuredSubagentBackends({ COWORK_HERMES_URL: "http://127.0.0.1:8642" }),
    /key is required/
  );
  const [backend] = configuredSubagentBackends({
    COWORK_HERMES_URL: "http://127.0.0.1:8642",
    COWORK_HERMES_API_KEY: "fixture"
  });
  assert.equal(backend.id, "hermes");
  assert.throws(
    () => new HermesBackend({ url: "https://user:pass@example.com", apiKey: "fixture" }),
    /without credentials/
  );
});
