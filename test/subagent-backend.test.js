import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { readSubagentProgress } from "../dist/src/runtime/progress.js";
import { readAgentTrajectory } from "../dist/src/runtime/agent-trajectory.js";

async function fixture(t, backend) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cowork-backend-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const input = {
    workspaceRoot,
    taskId: "task",
    runId: "run",
    agentId: "child",
    callId: "call",
    task: "Verify the native task",
    mode: "async",
    backendId: "native"
  };
  return {
    input,
    runtime: new CoordinatorRuntime({ backends: [backend] }),
    scheduler: new DurableScheduler(join(workspaceRoot, "task/runs/run/queue.json")),
    inbox: new InboxStore(join(workspaceRoot, "task/runs/run/agents/main/inbox-store.json"))
  };
}

test("minimal run-only backend executes without Main credentials, reports native artifacts and delivers once", async (t) => {
  let runs = 0;
  const f = await fixture(t, {
    id: "native",
    name: "Native",
    async run(task, context) {
      runs++;
      assert.deepEqual(Object.keys(task).sort(), ["callId", "task"]);
      assert.equal(context.askMain, undefined);
      await context.onReference({ runId: "native-7" });
      await context.onProgress("Native tool completed");
      await context.onObservation({
        id: "native-tool-1",
        kind: "tool",
        title: "read_file",
        text: "report.txt",
        status: "running"
      });
      await context.onObservation({
        id: "native-tool-1",
        kind: "tool",
        title: "read_file",
        text: "",
        status: "completed",
        result: "Native reports completion"
      });
      return {
        status: "completed",
        summary: "Native evidence verified",
        artifacts: [{ name: "report", kind: "reference", location: "native-7/report" }],
        nativeRef: { runId: "native-7" }
      };
    }
  });
  assert.deepEqual(
    f.runtime.listBackends().map((x) => x.id),
    ["pi", "native"]
  );
  const result = await f.runtime.dispatch(f.input);
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.backendResult.nativeRef.runId, "native-7");
  const progress = (await readSubagentProgress(f.input)).agents[0];
  assert.equal(progress.backendId, "native");
  assert.equal(progress.backendName, "Native");
  assert.equal(progress.nativeRef.runId, "native-7");
  assert.equal(progress.backendStatus, "completed");
  assert.equal(progress.lastTool, "read_file");
  const trace = await readAgentTrajectory(join(f.input.workspaceRoot, "task", result.diagnostics.tracePath));
  const tool = trace.entries.find((entry) => entry.kind === "tool");
  assert.equal(tool.title, "read_file");
  assert.equal(tool.text, "report.txt");
  assert.equal(tool.status, "completed");
  assert.ok(trace.entries.some((entry) => entry.title === "原生智能体结果"));
  assert.equal(result.artifacts.length, 0, "native references are not automatically accepted Task artifacts");
  assert.match(result.response, /native-7\/report/);
  const callback = (await f.inbox.list("main"))[0];
  assert.equal(callback.payload.backendResult.status, "completed");
  assert.match(
    (await f.runtime.waitForSubagents({ ...f.input, timeoutMs: 0 })).calls[0].response,
    /Native evidence/
  );
  const saved = JSON.parse(
    await readFile(join(f.input.workspaceRoot, "task", result.diagnostics.resultPath), "utf8")
  );
  assert.equal(saved.status, "completed");
  await assert.rejects(f.runtime.dispatch(f.input), /unable to lease/);
  assert.equal(runs, 1);
  assert.equal((await f.inbox.list("main")).length, 1);
});

for (const status of ["failed", "unknown", "invalid", "throw"]) {
  test(`native ${status} never becomes success or a scheduled retry`, async (t) => {
    let runs = 0;
    const f = await fixture(t, {
      id: "native",
      name: "Native",
      async run() {
        runs++;
        if (status === "throw") throw new Error("Transport lost after submission");
        return { status, summary: "Known evidence" };
      }
    });
    const result = await f.runtime.dispatch({ ...f.input, maxAttempts: 10 });
    assert.equal(result.status, "failed");
    assert.equal(result.backendResult.status, ["failed", "unknown"].includes(status) ? status : "unknown");
    assert.equal((await f.scheduler.list())[0].status, "failed");
    await f.runtime.recoverRun({ ...f.input, baseUrl: "", apiKey: "" });
    assert.equal(runs, 1);
  });
}

test("restart reconciles an expired external lease as unknown without calling run again", async (t) => {
  let runs = 0;
  const f = await fixture(t, {
    id: "native",
    name: "Native",
    async run() {
      runs++;
      return { status: "completed", summary: "must not replay" };
    }
  });
  await f.scheduler.enqueue({
    stepId: "call",
    taskId: "task",
    runId: "run",
    agentId: "child",
    importance: "normal",
    payload: { task: f.input.task, backendId: "native" },
    maxAttempts: 1
  });
  await f.scheduler.claim("dead-owner", -1, "call");
  const recovered = await new CoordinatorRuntime().recoverRun({ ...f.input, baseUrl: "", apiKey: "" });
  assert.equal(runs, 0);
  assert.equal(recovered[0].backendResult.status, "unknown");
  assert.equal((await f.scheduler.list())[0].status, "failed");
  assert.equal((await f.inbox.list("main"))[0].payload.backendResult.status, "unknown");
});

test("external controls reject unsupported behavior while a native run is in flight", async (t) => {
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    id: "native",
    name: "Native",
    async run() {
      started();
      await gate;
      return { status: "completed", summary: "done" };
    }
  });
  const dispatch = f.runtime.dispatch(f.input);
  t.after(async () => {
    release();
    await dispatch;
  });
  await running;
  await assert.rejects(f.runtime.cancelSubagent(f.input), /does not support cancellation/);
  await assert.rejects(
    f.runtime.sendMessage({ ...f.input, message: "new task" }),
    /does not support follow-up/
  );
  assert.equal((await f.scheduler.list())[0].status, "leased");
  await assert.rejects(
    f.runtime.dispatch({ ...f.input, callId: "grant", capabilityGrants: [{}] }),
    /do not inherit/
  );
  release();
  await dispatch;
});
