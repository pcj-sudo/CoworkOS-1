import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { HermesBackend } from "../dist/src/runtime/subagent-backends/hermes.js";

async function fixture(t, stream) {
  const requests = [];
  let streamed = false;
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    for await (const _ of req) {
      /* drain request */
    }
    if (req.method === "POST") {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ run_id: "native-1" }));
    } else if (req.url.endsWith("/events")) {
      await stream(req, res);
      streamed = true;
    } else {
      res.end(
        JSON.stringify({
          run_id: "native-1",
          status: streamed ? "completed" : "running",
          output: streamed ? "Verified native report" : undefined
        })
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return {
    requests,
    backend: new HermesBackend({
      url: `http://127.0.0.1:${server.address().port}`,
      apiKey: "private-key",
      pollMs: 15,
      observationTimeoutMs: 2000
    })
  };
}
const task = { callId: "call-1", task: "Use your native tools" };

test("Hermes observes authenticated native tools across fragmented CRLF frames and retains polling authority", async (t) => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (value) =>
      `data: ${JSON.stringify({ run_id: "native-1", timestamp: 1700000000, ...value })}\r\n\r\n`;
    const raw =
      event({ event: "tool.started", tool: "read_file", preview: "报告.txt private-key" }) +
      event({ event: "tool.completed", tool: "read_file", duration: 0.1, error: false }) +
      event({ event: "tool.started", tool: "write_file", run_id: "other-run" }) +
      event({ event: "run.completed", output: "SSE must not decide business completion" });
    const bytes = Buffer.from(raw);
    for (let i = 0; i < bytes.length; i += 7) {
      res.write(bytes.subarray(i, i + 7));
      await delay(1);
    }
    res.end();
  });
  const entries = [];
  const result = await f.backend.run(task, {
    onObservation: (entry) => {
      entries.push(entry);
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Verified native report");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, entries[1].id);
  assert.equal(entries[0].text, "报告.txt [redacted]");
  assert.equal(entries[1].status, "completed");
  assert.match(entries[1].result, /does not provide the tool output/);
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  assert.ok(f.requests.every((r) => r.auth === "Bearer private-key"));
});

test("missing native event support falls back to polling without replaying a task", async (t) => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  const progress = [];
  const result = await f.backend.run(task, {
    onObservation: () => {},
    onProgress: (m) => {
      progress.push(m);
    }
  });
  assert.equal(result.status, "completed");
  assert.ok(progress.some((m) => m.includes("stream unavailable")));
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
});

test("terminal polling aborts a stalled observation stream and never stops native work", async (t) => {
  let ended = false;
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.on("close", () => {
      ended = true;
    });
  });
  const result = await f.backend.run(task, { onObservation: () => {} });
  assert.equal(result.status, "completed");
  await delay(30);
  assert.equal(ended, true);
  assert.ok(!f.requests.some((r) => r.path.endsWith("/stop")));
});
