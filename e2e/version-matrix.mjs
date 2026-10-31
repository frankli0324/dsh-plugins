#!/usr/bin/env node
// Version test matrix: run the harness packages' unit tests (mock CLIs, no
// network) against a grid of @deepseek-ai peer versions. Versions are swapped
// in-place in the repo root node_modules via `npm install --no-save` and the
// baseline is restored afterwards (also on crash, via process exit hooks).
//
// Axes — the version families the host pins together (see npm view):
//   @deepseek-ai/dsh-llm     0.2.1-rc.2 (peer min) · 0.2.1-rc.4 (host) · 0.2.2-alpha.2 (latest)
//   @deepseek-ai/cordis      4.0.1 · 4.0.5 (host) · 4.0.6-alpha.1 (latest)
//   @deepseek-ai/schemastery 3.18.1 · 3.18.5 (host) · 3.18.6-alpha.1 (latest)
//
// Usage: node e2e/version-matrix.mjs [--quick]   --quick: corners + center (9 cells) instead of the full 27
//        node e2e/version-matrix.mjs --axis dsh-llm=0.2.1-rc.2,0.2.2-alpha.2   override one axis
// Writes e2e/report/version-matrix.md and exits non-zero on any failing cell.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AXES = {
  "dsh-llm": ["0.2.1-rc.2", "0.2.1-rc.4", "0.2.2-alpha.2"],
  cordis: ["4.0.1", "4.0.5", "4.0.6-alpha.1"],
  schemastery: ["3.18.1", "3.18.5", "3.18.6-alpha.1"],
};
const FULL_NAMES = { "dsh-llm": "@deepseek-ai/dsh-llm", cordis: "@deepseek-ai/cordis", schemastery: "@deepseek-ai/schemastery" };
const TEST_TARGETS = [
  "packages/dsh-harness-base/test",
  "packages/dsh-harness-claude/test",
  "packages/dsh-harness-codex/test",
];

const args = process.argv.slice(2);
const quick = args.includes("--quick");

// Parse --axis overrides before building the grid.
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--axis") {
    const [axis, values] = args[i + 1].split("=");
    if (!AXES[axis]) throw new Error(`unknown axis "${axis}"; known: ${Object.keys(AXES).join(", ")}`);
    AXES[axis] = values.split(",");
  }
}

const baseline = {};
for (const [axis, pkg] of Object.entries(FULL_NAMES)) {
  baseline[axis] = JSON.parse(await readFile(path.join(repoRoot, "node_modules", pkg, "package.json"))).version;
}
console.log(`baseline: ${JSON.stringify(baseline)}`);

let restoreNeeded = false;
const restore = () => {
  if (!restoreNeeded) return;
  restoreNeeded = false;
  install(Object.entries(baseline));
};
process.on("exit", restore);
process.on("SIGINT", () => process.exit(130));
process.on("uncaughtException", (e) => {
  console.error(e);
  process.exit(1);
});

function install(entries) {
  const specs = entries.map(([axis, version]) => `${FULL_NAMES[axis]}@${version}`);
  console.log(`  npm install --no-save ${specs.join(" ")}`);
  // The grid deliberately mixes versions that declare conflicting peer ranges
  // (e.g. dsh-llm 0.2.1-rc.2 wants cordis ~4.0.5, the grid also tries 4.0.1)
  // — whether older peers actually break at runtime is what the matrix tests.
  execFileSync("npm", ["install", "--no-save", "--silent", "--legacy-peer-deps", ...specs], { cwd: repoRoot, stdio: "inherit" });
}

function runTests() {
  const started = Date.now();
  try {
    execFileSync("node", ["--test", ...TEST_TARGETS], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const failed = [...out.matchAll(/ℹ fail (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    return { ok: false, ms: Date.now() - started, failed: failed || "?", tail: out.slice(-3000) };
  }
}

function cells() {
  const combos = [];
  for (const llm of AXES["dsh-llm"]) {
    for (const cordis of AXES.cordis) {
      for (const schemastery of AXES.schemastery) {
        combos.push({ "dsh-llm": llm, cordis, schemastery });
      }
    }
  }
  if (!quick) return combos;
  // Corners + center: every axis at min/host/latest, no mid-mixing.
  const corners = combos.filter(
    (c) => Object.keys(c).every((axis) => [AXES[axis][0], AXES[axis][2]].includes(c[axis])),
  );
  const center = Object.fromEntries(Object.keys(AXES).map((axis) => [axis, AXES[axis][1]]));
  return [...corners, center];
}

const grid = cells();
console.log(`${grid.length} cells\n`);
const rows = [];
let current = { ...baseline };
for (const cell of grid) {
  if (Object.keys(cell).some((axis) => current[axis] !== cell[axis])) {
    install(Object.entries(cell)); // full triple: a partial install would leak the previous cell's versions
    current = { ...cell };
    restoreNeeded = true;
  }
  const label = Object.entries(cell).map(([axis, v]) => `${axis}=${v}`).join(" ");
  const result = runTests();
  rows.push({ cell, ...result });
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${label}  (${(result.ms / 1000).toFixed(1)}s${result.ok ? "" : `, ${result.failed} failed`})`);
  if (!result.ok) console.error(result.tail);
}
restore();

// Report: one row per cell; dsh-llm varies slowest so same-cordis cells group.
const lines = [
  `# Version test matrix (${new Date().toISOString()})`,
  "",
  `Baseline: cordis ${baseline.cordis} · schemastery ${baseline.schemastery} · dsh-llm ${baseline["dsh-llm"]}. Tests: harness-base + harness-claude + harness-codex unit suites (mock CLIs).`,
  "",
  "| dsh-llm | cordis | schemastery | result | time |",
  "|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.cell["dsh-llm"]} | ${r.cell.cordis} | ${r.cell.schemastery} | ${r.ok ? "pass" : `FAIL (${r.failed})`} | ${(r.ms / 1000).toFixed(1)}s |`,
  ),
  "",
];
const reportDir = path.join(repoRoot, "e2e", "report");
await mkdir(reportDir, { recursive: true });
const reportPath = path.join(reportDir, "version-matrix.md");
await writeFile(reportPath, lines.join("\n"));
const failures = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failures}/${rows.length} cells pass; report: ${path.relative(repoRoot, reportPath)}`);
process.exitCode = failures > 0 ? 1 : 0;
