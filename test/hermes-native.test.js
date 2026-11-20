import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HermesBackend } from "../dist/src/runtime/subagent-backends/hermes.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { readAgentTrajectory } from "../dist/src/runtime/agent-trajectory.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

test(
  "installed Hermes runs its native write_file and returns evidence through Coordinator",
  {
    skip:
      !process.env.COWORK_TEST_HERMES_PYTHON &&
      "Set COWORK_TEST_HERMES_PYTHON to an independently installed Hermes Python",
    timeout: 90_000
  },
  async (t) => {
    const fixtureParent = resolve(".tmp");
    await mkdir(fixtureParent, { recursive: true });
    const root = await mkdtemp(join(fixtureParent, "cowork-hermes-native-"));
    let child;
    let logs = "";
    const requests = [];
    const mainSteps = {};
    const output = join(root, "native-output.txt");
    const provider = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [{ id: "hermes-fixture" }] }));
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const main = body.tools?.some((tool) => tool.function?.name === "call_subagent");
      if (main) {
        const step = (mainSteps[body.model] = (mainSteps[body.model] ?? 0) + 1);
        const mode = body.model.endsWith("async") ? "async" : "sync";
        const reply =
          step === 1
            ? { name: "list_subagent_backends", arguments: {} }
            : step === 2
              ? {
                  name: "call_subagent",
                  arguments: {
                    backendId: "hermes",
                    mode,
                    task: `Write ${output} and report the native tool evidence.`
                  }
                }
              : step === 3 && mode === "async"
                ? { name: "wait_for_subagents", arguments: { timeoutMs: 10000 } }
                : { text: "Main received the Hermes evidence." };
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(protocolStream("openai-completions", reply));
      }
      const wrote = body.messages?.some((message) => message.role === "tool");
      const reply = wrote
        ? { text: `Native file verified: ${output}` }
        : { name: "write_file", arguments: { path: output, content: "Hermes native tool executed\n" } };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(protocolStream("openai-completions", reply));
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: "hermes-fixture",
          choices: [
            {
              index: 0,
              message: reply.name
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "native-write",
                        type: "function",
                        function: { name: reply.name, arguments: JSON.stringify(reply.arguments) }
                      }
                    ]
                  }
                : { role: "assistant", content: reply.text },
              finish_reason: reply.name ? "tool_calls" : "stop"
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
      );
    });
    t.after(async () => {
      if (child && child.exitCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        const hardStop = setTimeout(() => child.kill("SIGKILL"), 5000);
        await ended;
        clearTimeout(hardStop);
      }
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      if (t.passed === false) console.error(logs.slice(-12000));
      await rm(root, { recursive: true, force: true });
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const portProbe = createServer();
    portProbe.listen(0, "127.0.0.1");
    await once(portProbe, "listening");
    const port = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    const home = join(root, "hermes-home");
    await mkdir(home);
    await writeFile(
      join(home, "config.yaml"),
      JSON.stringify({
        model: {
          default: "hermes-fixture",
          provider: "custom",
          base_url: `http://127.0.0.1:${provider.address().port}/v1`,
          api_key: "fixture-model-key",
          api_mode: "chat_completions"
        },
        terminal: { backend: "local", cwd: root },
        agent: { max_turns: 5, max_retries: 0 },
        platform_toolsets: { api_server: ["file"] },
        memory: { memory_enabled: false, user_profile_enabled: false }
      })
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(HERMES|OPENAI|ANTHROPIC|OPENROUTER|API_SERVER|COWORK|ATRIA)_/.test(key)
      )
    );
    Object.assign(env, {
      HERMES_HOME: home,
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: "fixture-server-key",
      PYTHONUNBUFFERED: "1"
    });
    child = spawn(process.env.COWORK_TEST_HERMES_PYTHON, [resolve("test/fixtures/hermes-api-server.py")], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (b) => {
      logs += b;
    });
    child.stderr.on("data", (b) => {
      logs += b;
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (!logs.includes("HERMES_FIXTURE_READY") && Date.now() < deadline && child.exitCode === null)
      await delay(50);
    assert.match(logs, /HERMES_FIXTURE_READY/, logs);
    const backend = new HermesBackend({
      url,
      apiKey: "fixture-server-key",
      pollMs: 25,
      observationTimeoutMs: 30_000
    });
    assert.equal((await backend.check()).ready, true);
    const coordinator = new CoordinatorRuntime({ backends: [backend] });
    const result = await coordinator.dispatch({
      workspaceRoot: join(root, "cowork"),
      taskId: "task",
      runId: "run",
      callId: "native-call",
      agentId: "native-child",
      backendId: "hermes",
      task: `Write ${output} and report the native tool result.`,
      mode: "async"
    });
    assert.equal(result.status, "succeeded", `${result.response}\n${logs}`);
    assert.equal(
      await readFile(output, "utf8").catch(() =>
        assert.fail(
          `${logs}\n${JSON.stringify(requests.map((body) => ({ tools: body.tools?.map((t) => t.function?.name), receipts: body.messages?.filter((m) => m.role === "tool") })))}`
        )
      ),
      "Hermes native tool executed\n"
    );
    assert.ok(
      requests.some((body) => body.tools?.some((tool) => tool.function?.name === "write_file")),
      "the model received Hermes's native file tool"
    );
    assert.ok(
      requests.some((body) => body.messages?.some((message) => message.role === "tool")),
      "Hermes executed a tool and sent its receipt to the model"
    );
    assert.match(result.response, /Native file verified/);
    const trajectory = await readAgentTrajectory(join(root, "cowork/task", result.diagnostics.tracePath));
    assert.ok(
      trajectory.entries.some(
        (entry) => entry.kind === "tool" && entry.title === "write_file" && entry.status === "completed"
      ),
      `Installed Hermes should emit native tool lifecycle: ${JSON.stringify(trajectory)}`
    );
    const callbacks = await new InboxStore(
      join(root, "cowork/task/runs/run/agents/main/inbox-store.json")
    ).list("main");
    assert.equal(callbacks[0].payload.backendResult.nativeRef.runId, result.backendResult.nativeRef.runId);
    // Exercise the actual product Main/Pi tool registration and native selector in both modes.
    for (const mode of ["sync", "async"]) {
      const mainRoot = join(root, `main-${mode}`);
      const agentDir = join(mainRoot, "pi-agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(mainRoot, "config.json"), "{}");
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
      );
      const model = `main-hermes-${mode}`;
      const mainChild = spawn(
        process.execPath,
        [
          resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
          "--extension",
          resolve(".pi/extensions/cowork.ts"),
          "--append-system-prompt",
          resolve(".pi/prompts/cowork-main.md"),
          "--provider",
          "cowork-glm",
          "--model",
          model,
          "--thinking",
          "off",
          "--print",
          "--mode",
          "json",
          "--session-dir",
          join(mainRoot, "sessions"),
          "--no-skills",
          "Discover Hermes and delegate the native file task."
        ],
        {
          cwd: mainRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...env,
            NODE_OPTIONS: "",
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            COWORK_CONFIG: join(mainRoot, "config.json"),
            COWORK_WORKSPACE: mainRoot,
            COWORK_TASK_ID: "main-task",
            COWORK_RUN_ID: "main-run",
            COWORK_HARNESS_ROOT: join(root, "empty-harness"),
            COWORK_API_BASE: `http://127.0.0.1:${provider.address().port}/v1`,
            COWORK_API_KEY: "main-fixture-key",
            COWORK_MODEL: model,
            COWORK_MODEL_API: "openai-completions",
            COWORK_HERMES_URL: url,
            COWORK_HERMES_API_KEY: "fixture-server-key",
            COWORK_MAIN_TIMEOUT_MS: "20000",
            COWORK_MAIN_MAX_TURNS: "8",
            COWORK_WEB_TOOLS: "0",
            COWORK_DISABLE_WATCH_SUPERVISOR: "1",
            COWORK_SUPPORTS_IMAGES: "0",
            COWORK_SUPPORTS_REASONING_EFFORT: "0"
          }
        }
      );
      let mainOutput = "",
        mainErrors = "";
      mainChild.stdout.on("data", (b) => {
        mainOutput += b;
      });
      mainChild.stderr.on("data", (b) => {
        mainErrors += b;
      });
      const end = once(mainChild, "close");
      const kill = setTimeout(() => mainChild.kill("SIGKILL"), 25000);
      const [code] = await end;
      clearTimeout(kill);
      assert.equal(code, 0, mainErrors);
      assert.match(mainOutput, /Native file verified/, `${mode}: ${mainOutput}\n${mainErrors}`);
      assert.match(mainOutput, /Hermes Agent/, "Main discovered the configured backend");
      const queue = JSON.parse(await readFile(join(mainRoot, "main-task/runs/main-run/queue.json"), "utf8"));
      assert.equal(queue.length, 1);
      assert.equal(queue[0].payload.backendId, "hermes");
      assert.equal(queue[0].status, "completed");
      assert.equal(queue[0].attempts, 1);
    }
    t.diagnostic(
      "Real installed Hermes API + AIAgent + native write_file + Coordinator Inbox passed; model was a local deterministic fixture."
    );
  }
);
