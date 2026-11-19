import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { startManagedHermes } = createRequire(import.meta.url)("../desktop/hermes-runtime.cjs");

async function fixture(t, code) {
  const root = await mkdtemp(join(tmpdir(), "cowork-hermes-host-"));
  const paths = { userData: root, logs: join(root, "logs") };
  await mkdir(paths.logs);
  await writeFile(join(root, "config.yaml"), "{}");
  const executable = join(root, "hermes-fixture");
  await writeFile(executable, `#!${process.execPath}\n${code}`, { mode: 0o700 });
  await writeFile(
    join(root, "hermes-runtime.json"),
    JSON.stringify({ enabled: true, executable, home: root })
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, paths, source: { PATH: process.env.PATH } };
}

test("unconfigured Hermes is optional and explicit external URLs are never owned", async () => {
  const idle = await startManagedHermes({ userData: join(tmpdir(), "absent-hermes-host") }, {});
  assert.deepEqual(idle.env, {});
  await idle.stop();
  const external = await startManagedHermes({}, { COWORK_HERMES_URL: "http://127.0.0.1:8642" });
  assert.deepEqual(external.env, {});
  await external.stop();
});

test(
  "desktop starts an authenticated loopback Hermes and stops only its owned process",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(
      t,
      `
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
writeFileSync('launch.json', JSON.stringify({args:process.argv.slice(2),home:process.env.HERMES_HOME,host:process.env.API_SERVER_HOST}));
const server = createServer((req,res) => {
  if (req.headers.authorization !== 'Bearer '+process.env.API_SERVER_KEY) { res.writeHead(401); res.end('{}'); return; }
  res.end(JSON.stringify({data:[{id:'fixture'}]}));
});
server.listen(Number(process.env.API_SERVER_PORT), process.env.API_SERVER_HOST);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`
    );
    const runtime = await startManagedHermes(f.paths, f.source);
    t.after(() => runtime.stop());
    assert.match(runtime.env.COWORK_HERMES_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(runtime.env.COWORK_HERMES_URL + "/v1/models")).status, 401);
    const launch = JSON.parse(await readFile(join(f.root, "launch.json"), "utf8"));
    assert.deepEqual(launch, { args: ["gateway", "run"], home: f.root, host: "127.0.0.1" });
    await runtime.stop();
    await runtime.stop();
    await assert.rejects(fetch(runtime.env.COWORK_HERMES_URL + "/v1/models"));
  }
);

test(
  "invalid config and native startup failure do not leave an owned process",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, "process.exit(12);\n");
    await assert.rejects(startManagedHermes(f.paths, f.source), /启动期间退出/);
    await writeFile(
      join(f.root, "hermes-runtime.json"),
      '{"enabled":true,"executable":"relative","home":"relative"}'
    );
    await assert.rejects(startManagedHermes(f.paths, f.source), /绝对路径/);
  }
);

test(
  "startup timeout tears down a process whose API never becomes ready",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(
      t,
      "require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(()=>{}, 1000);\n"
    );
    await assert.rejects(startManagedHermes(f.paths, f.source, { timeoutMs: 500 }), /启动超时/);
    const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
);
