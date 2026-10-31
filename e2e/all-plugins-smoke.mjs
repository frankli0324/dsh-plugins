#!/usr/bin/env node
// All-plugins compatibility smoke against the dsh binary on PATH (rc.5).
// Isolated DSH_HOME: one web profile linking EVERY package in packages/,
// base bundles first, then each plugin (patch rows merged in list order).
// Verifies: --dump-config composes, web boots with no activation failure,
// kick's HTTP route answers, harness-base settings RPC answers.
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = [
  "dsh-mobile-ui",
  "dsh-free-web-search",
  "dsh-harness-suite",
  "dsh-kick",
  "dsh-rename",
  "dsh-session-drag",
  "dsh-tool-guard",
];
const BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...PLUGINS];

const home = await mkdtemp(path.join(tmpdir(), "dsh-plugins-smoke-"));
const profileDir = path.join(home, "profiles", "all-plugins");
await mkdir(path.join(profileDir, "node_modules"), { recursive: true });
await writeFile(
  path.join(profileDir, "package.json"),
  JSON.stringify(
    {
      name: "dsh-profile-all-plugins",
      private: true,
      dependencies: Object.fromEntries(PLUGINS.map((p) => [p, `link:${repoRoot}/node_modules/${p}`])),
      dsh: { profile: { bundles: BUNDLES } },
    },
    null,
    2,
  ),
);
for (const p of PLUGINS) {
  const target = path.join(repoRoot, "packages", p.replace("@local/", ""));
  if (!existsSync(target)) throw new Error(`missing package dir: ${target}`);
  const dest = path.join(profileDir, "node_modules", p);
  await mkdir(path.dirname(dest), { recursive: true });
  await symlink(target, dest);
}
// Mirror the real home's shared profiles tree: bundle imports of host
// packages (@deepseek-ai/*) resolve through <home>/profiles/node_modules.
await symlink(path.join(process.env.HOME, ".dsh", "profiles", "node_modules"), path.join(home, "profiles", "node_modules"));
// Minimal credentials so the credentials service activates like in e2e.
await writeFile(path.join(home, ".credentials.yaml"), "version: 1\nrefs: {}\n", { mode: 0o600 });

const bin = process.env.DSH_BIN ?? "dsh";
const run = (args, timeoutMs = 120000) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, DSH_HOME: home }, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });

let failed = false;

// 1. Composed config: every plugin's patch rows must merge without error.
const dump = await run(["--profile", "all-plugins", "--dump-config"]);
const dumpOk = dump.code === 0;
if (!dumpOk) failed = true;
console.log(`${dumpOk ? "PASS" : "FAIL"} dump-config (exit ${dump.code})`);
for (const row of ["web-search-free", "harness-base", "harness-claude", "harness-codex", "harness-switch", "kick", "dsh-rename", "dsh-session-drag", "dsh-mobile-ui", "tool-guard"]) {
  const present = dump.out.includes(row);
  if (!present) failed = true;
  console.log(`${present ? "PASS" : "FAIL"} patch row "${row}" present in composed config`);
}
for (const row of ["session-title-llm", "ui-layout"]) {
  const block = dump.out.split(/^# == /m).find((b) => b.includes(`id: ${row}\n`)) ?? dump.out;
  const ok = new RegExp(`- id: ${row}\\n[\\s\\S]*?\\n  disabled: true`).test(block);
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} built-in row "${row}" disabled`);
}
if (!dumpOk) console.error(dump.err.slice(-3000));

// 2. Real boot: web announces, no activation failures in stderr.
const child = spawn(bin, ["--profile", "all-plugins", "--port", "0", "--host", "127.0.0.1", "--no-open"], {
  env: { ...process.env, DSH_HOME: home },
  cwd: home,
  stdio: ["ignore", "pipe", "pipe"],
});
let bootErr = "";
child.stderr.on("data", (d) => (bootErr += d));
const announced = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no announce in 60s")), 60000);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    const m = buf.match(/dsh web: (\S+)/);
    if (m) { clearTimeout(timer); resolve(new URL(m[1])); }
  });
  child.on("close", (code) => { clearTimeout(timer); reject(new Error(`dsh exited ${code}\n${bootErr.slice(-2000)}`)); });
});
console.log(`PASS boot: ${announced.origin}`);
const res = await fetch(`${announced.origin}/connect?token=${announced.searchParams.get("token")}`, { redirect: "manual" });
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

// 3. kick route mounted and answering under rc.5.
const kick = await fetch(`${announced.origin}/api/kick?sessionId=smoke`, { headers: { Cookie: cookie } });
const kickBody = await kick.json();
const kickOk = kick.status === 200 && kickBody.armed === false && Array.isArray(kickBody.items);
if (!kickOk) failed = true;
console.log(`${kickOk ? "PASS" : "FAIL"} GET /api/kick → ${kick.status} ${JSON.stringify(kickBody)}`);

// 4. harness-base settings namespace reachable (suite mounted).
const rpc = await fetch(`${announced.origin}/api/settings/update`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({
    type: "client-request",
    rpcId: `smoke-${randomUUID()}`,
    method: "settings/update",
    payload: { args: { ns: "harness-base", patch: { harnesses: { smoke: "Smoke" } } } },
  }),
});
const rpcBody = await rpc.json();
const rpcOk = rpcBody.type === "server-response" && rpcBody.result?.ok;
if (!rpcOk) failed = true;
console.log(`${rpcOk ? "PASS" : "FAIL"} settings/update harness-base → ${JSON.stringify(rpcBody.result ?? rpcBody).slice(0, 200)}`);

const badErr = bootErr
  .split("\n")
  .filter((l) => /did not activate|skipping profile bundle|StartupError/.test(l));
if (badErr.length > 0) {
  failed = true;
  console.log("FAIL activation errors:\n" + badErr.join("\n"));
} else {
  console.log("PASS no plugin activation errors on stderr");
}
child.kill("SIGTERM");
await new Promise((r) => child.on("close", r));
console.log(`\nDSH_HOME kept for inspection: ${home}`);
process.exitCode = failed ? 1 : 0;
