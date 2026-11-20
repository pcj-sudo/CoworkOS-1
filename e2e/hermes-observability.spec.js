import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("Hermes team type and live native tools survive result delivery and page reload", async ({ page }) => {
  test.setTimeout(90_000);
  let finish,
    started = false,
    completed = false,
    posts = 0;
  const finished = new Promise((done) => {
    finish = () => {
      completed = true;
      done();
    };
  });
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    else if (req.method === "POST") {
      posts++;
      started = true;
      res.writeHead(202);
      res.end(JSON.stringify({ run_id: "native-browser-1" }));
    } else if (req.url.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (value) =>
        res.write(
          `data: ${JSON.stringify({ run_id: "native-browser-1", timestamp: Date.now() / 1000, ...value })}\n\n`
        );
      event({ event: "tool.started", tool: "read_file", preview: "/demo/company-rules.md" });
      await finished;
      event({ event: "tool.completed", tool: "read_file", duration: 0.4, error: false });
      res.end();
    } else
      res.end(
        JSON.stringify({
          run_id: "native-browser-1",
          session_id: "native-session-1",
          status: completed ? "completed" : "running",
          output: completed ? "Hermes 文件核对完成" : undefined
        })
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const provider = await modelProtocolFixture("openai-completions", (body) => {
    if (JSON.stringify(body.messages).includes("Hermes 文件核对完成"))
      return { text: "Hermes 可观测性验收完成" };
    return {
      name: "call_subagent",
      arguments: { backendId: "hermes", task: "用自己的工具核对文件并返回结果", mode: "sync" }
    };
  });
  const dashboard = await startDashboard({
    modelEndpoint: provider.baseUrl,
    env: {
      COWORK_HERMES_URL: `http://127.0.0.1:${server.address().port}`,
      COWORK_HERMES_API_KEY: "browser-fixture-only"
    }
  });
  try {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await page.locator("#appearance-select").selectOption("light");
    await page.locator("#profile-close").click();
    await page.locator("#composer-input").fill("请交给 Hermes 核对文件");
    await page.locator("#composer-input").press("Enter");
    await expect.poll(() => started).toBe(true);
    await page.getByRole("button", { name: "切换任务面板", exact: true }).click();
    const chip = page.locator(".member-chip").filter({ hasText: "Hermes" });
    await expect(chip).toHaveCount(1);
    await expect(chip.locator(".agent-backend-icon")).toHaveText("H");
    await expect(page.locator(".galaxy-star-satellite .star-backend")).toHaveText("HHermes");
    await expect(page.locator(".galaxy-star-satellite .star-backend")).toHaveCSS("color", "rgb(89, 97, 109)");
    await chip.click();
    await expect(page.locator("#trace-identity .trace-title small")).toHaveText("Hermes");
    await expect(page.locator("#agent-trajectory")).toContainText("读取文件");
    await expect(page.locator("#agent-trajectory")).toContainText("/demo/company-rules.md");
    const reference = page.locator('#trace-identity details[data-native-detail="reference"]');
    await reference.locator("summary").click();
    await page.locator("#agent-focus").scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("hermes-running-light.png"), fullPage: true });
    finish();
    await expect(page.locator("#conversation")).toContainText("Hermes 可观测性验收完成", { timeout: 45000 });
    await expect(page.locator("#agent-trajectory")).toContainText("原生智能体结果");
    await expect(page.locator("#agent-trajectory")).toContainText("Hermes 文件核对完成");
    await expect(reference).toHaveAttribute("open", "");
    await page.reload();
    await page.getByRole("button", { name: "切换任务面板", exact: true }).click();
    await page.locator(".member-chip").filter({ hasText: "Hermes" }).click();
    await expect(page.locator("#agent-trajectory")).toContainText("读取文件");
    await expect(page.locator("#trace-identity")).toContainText("原生结果：已完成");
    await page.locator("#trace-identity summary").filter({ hasText: "原生执行标识" }).click();
    await expect(page.locator("#trace-identity")).toContainText("native-browser-1");
    await page.locator("#user-menu-button").click();
    await page.locator("#appearance-select").selectOption("dark");
    await page.locator("#profile-close").click();
    await page.locator("#agent-focus").scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("hermes-completed-dark.png"), fullPage: true });
    expect(posts).toBe(1);
  } finally {
    finish();
    await dashboard.stop();
    await provider.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
