const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { desktopBackendEnvironment } = require("./backend-environment.cjs");

/** Optional host lifecycle; Hermes's agent, tools and provider remain external. */
async function startManagedHermes(paths, source = process.env, options = {}) {
  const idle = { env: {}, stop: async () => {} };
  // An explicitly supplied server is owned by its operator, never by this host.
  if (source.COWORK_HERMES_URL?.trim()) return idle;
  let config;
  try {
    config = JSON.parse(await fs.readFile(path.join(paths.userData, "hermes-runtime.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return idle;
    throw new Error("Hermes 启动配置无法读取，请检查 hermes-runtime.json");
  }
  if (config?.enabled === false) return idle;
  if (
    config?.enabled !== true ||
    ![config.executable, config.home].every(
      (value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0")
    )
  )
    throw new Error("Hermes 启动配置需要 enabled: true 和 executable、home 绝对路径");
  await fs.access(config.executable, require("node:fs").constants.X_OK);
  await fs.access(path.join(config.home, "config.yaml"));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const key = randomBytes(32).toString("hex");
  const url = `http://127.0.0.1:${port}`;
  const log = await fs.open(path.join(paths.logs, "hermes.log"), "a", 0o600);
  let child;
  try {
    child = spawn(config.executable, ["gateway", "run"], {
      cwd: config.home,
      env: {
        ...desktopBackendEnvironment(source),
        HERMES_HOME: config.home,
        API_SERVER_ENABLED: "true",
        API_SERVER_HOST: "127.0.0.1",
        API_SERVER_PORT: String(port),
        API_SERVER_KEY: key,
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["ignore", log.fd, log.fd]
    });
  } finally {
    await log.close();
  }
  let failure;
  child.once("error", () => {
    failure = new Error("Hermes 进程无法启动，请查看 hermes.log");
  });
  const closed = new Promise((done) => child.once("close", done));
  let stopping;
  const stop = () =>
    (stopping ||= (async () => {
      if (child.exitCode !== null || child.signalCode !== null || failure) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    })());
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 45_000);
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Hermes 在启动期间退出，请查看 hermes.log");
      try {
        const response = await fetch(`${url}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` },
          redirect: "error",
          signal: AbortSignal.timeout(1_000)
        });
        const body = await response.json();
        if (response.ok && Array.isArray(body.data))
          return { child, env: { COWORK_HERMES_URL: url, COWORK_HERMES_API_KEY: key }, stop };
      } catch {
        // Only our fresh random credential can make a listener ready.
      }
      await delay(150);
    }
    throw new Error("Hermes 服务启动超时，请查看 hermes.log");
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = { startManagedHermes };
