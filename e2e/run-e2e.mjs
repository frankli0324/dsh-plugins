#!/usr/bin/env node
// Harness e2e cases against a real dsh + real claude CLI, driven through one
// long-lived web server (RPC + settings hot-switch + on-disk log polling).
//
// Cases (each maps to a known lesson; see packages/dsh-harness-claude/DESIGN.md 十、):
//   direct-answer   harness=claude turn answers, claude CLI side effects exist
//   tool-round      a bash receipt round completes through the relay
//   interrupt       cancel mid-long-command, then the same session answers again (wedge regression)
//   harness-switch  claude -> dsh -> claude on one session; the claude leg resumes (no fresh CLI session)
//
// Usage: node e2e/run-e2e.mjs [--keep]          run all cases, then drop the instance
//        node e2e/run-e2e.mjs --only <name>     run one case
// Exits non-zero if any case fails. `--keep` prints and keeps DSH_HOME for debugging.
import { DshInstance, answerText, lastSeq } from "./lib/instance.mjs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const results = [];
const case_ = (name, fn) => results.push({ name, fn });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = (tag) => `E2E_${tag}_${Date.now().toString(36)}`;

/** Assert the turn finished and its answer contains the expected marker. */
function expectAnswer(turn, expected, label) {
  const reason = turn.end.data.turn?.reason;
  if (reason?.kind === "error") {
    throw new Error(`${label}: turn errored — ${JSON.stringify(reason).slice(0, 400)}`);
  }
  // Text deltas land in attempts that precede turn/end; search everything.
  const all = answerText(turn.events);
  if (!all.includes(expected)) {
    throw new Error(`${label}: answer missing "${expected}"\nanswer: ${all.slice(-1500)}`);
  }
}

// --- cases -------------------------------------------------------------------

case_("direct-answer", async (inst) => {
  const answer = marker("CLAUDE");
  await inst.setRouting({ harness: "claude" });
  const sessionId = await inst.createSession();
  const afterSeq = lastSeq(await inst.events(sessionId));
  await inst.prompt(sessionId, `只回复:${answer}`);
  const turn = await inst.waitTurn(sessionId, { afterSeq });
  expectAnswer(turn, answer, "direct-answer");
  const entries = await readdir(inst.claudeConfigDir()).catch(() => []);
  if (entries.length === 0) {
    throw new Error("direct-answer: claude config dir was never created — turn did not route through the claude adapter");
  }
});

case_("tool-round", async (inst) => {
  const answer = marker("TOOL");
  await inst.setRouting({ harness: "claude" });
  const sessionId = await inst.createSession();
  const afterSeq = lastSeq(await inst.events(sessionId));
  await inst.prompt(sessionId, `用 bash 执行 echo E2E_TOOL_OK,然后只回复:${answer}`);
  const turn = await inst.waitTurn(sessionId, { afterSeq });
  expectAnswer(turn, answer, "tool-round");
  // The bash receipt is a tool/result event, not assistant text — assert on
  // the tool stream itself.
  const receipt = turn.events.some(
    (e) =>
      e.type === "tool/result" &&
      (e.data.message?.content ?? []).some((b) => b?.type === "text" && b.text.includes("E2E_TOOL_OK")),
  );
  if (!receipt) {
    throw new Error(`tool-round: no tool/result carrying the bash output\nevents: ${JSON.stringify(turn.events.map((e) => e.type))}`);
  }
});

case_("interrupt", async (inst) => {
  await inst.setRouting({ harness: "claude" });
  const sessionId = await inst.createSession();
  const afterSeq = lastSeq(await inst.events(sessionId));
  await inst.prompt(sessionId, "运行 ping -c 60 127.0.0.1 然后汇总");
  // Wait until the turn reaches tool execution, then cancel it.
  const deadline = Date.now() + 90000;
  for (;;) {
    const events = await inst.events(sessionId);
    if (events.some((e) => e.type === "tool/call" && e.seq > afterSeq)) break;
    if (Date.now() > deadline) throw new Error("interrupt: no tool/call within 90s — turn never reached tool execution");
    if (events.some((e) => e.type === "turn/end" && e.seq > afterSeq)) throw new Error("interrupt: turn ended before cancel");
    await sleep(500);
  }
  const started = Date.now();
  await inst.cancel(sessionId);
  const turn = await inst.waitTurn(sessionId, { afterSeq, timeoutMs: 90000 });
  const cancelMs = Date.now() - started;
  if (cancelMs > 90000) throw new Error(`interrupt: turn took ${cancelMs}ms to end after cancel`);
  if (turn.end.data.turn?.reason?.kind === "stop") {
    throw new Error("interrupt: turn completed normally instead of being cancelled");
  }
  // The codex-wedge regression: the same session must answer the next prompt promptly.
  const recoverSeq = lastSeq(turn.events);
  const started2 = Date.now();
  await inst.prompt(sessionId, "只回复:INTERRUPT_RECOVERED");
  const turn2 = await inst.waitTurn(sessionId, { afterSeq: recoverSeq, timeoutMs: 120000 });
  expectAnswer(turn2, "INTERRUPT_RECOVERED", `interrupt: next message after abort (${((Date.now() - started2) / 1000).toFixed(1)}s)`);
});

case_("harness-switch", async (inst) => {
  const claudeAnswer = marker("CLAUDE");
  const dshAnswer = marker("DSH");
  const claudeAgain = marker("CLAUDE2");
  await inst.setRouting({ harness: "claude" });
  const sessionId = await inst.createSession();
  // Leg 1: claude harness — pins the session's claude CLI session.
  let afterSeq = lastSeq(await inst.events(sessionId));
  await inst.prompt(sessionId, `只回复:${claudeAnswer}`);
  expectAnswer(await inst.waitTurn(sessionId, { afterSeq }), claudeAnswer, "harness-switch leg 1 (claude)");
  const transcriptsAfterClaude = await inst.claudeTranscripts();
  if (transcriptsAfterClaude.size === 0) throw new Error("harness-switch: no claude transcripts after claude leg");
  // Leg 2: explicit per-session override back to dsh's own loop.
  await inst.setRouting({ harnessBySession: { [sessionId]: "" } });
  afterSeq = lastSeq(await inst.events(sessionId));
  await inst.prompt(sessionId, `只回复:${dshAnswer}`);
  const turn2 = await inst.waitTurn(sessionId, { afterSeq });
  expectAnswer(turn2, dshAnswer, "harness-switch leg 2 (dsh)");
  const transcriptsAfterDsh = await inst.claudeTranscripts();
  for (const [file, size] of transcriptsAfterDsh) {
    if ((transcriptsAfterClaude.get(file) ?? 0) !== size) {
      throw new Error("harness-switch: dsh leg wrote claude transcript — routing leaked");
    }
  }
  // Leg 3: back to claude — must resume the existing CLI session, not spawn a new one.
  await inst.setRouting({ harnessBySession: { [sessionId]: "claude" } });
  afterSeq = lastSeq(turn2.events);
  await inst.prompt(sessionId, `只回复:${claudeAgain}`);
  const turn3 = await inst.waitTurn(sessionId, { afterSeq });
  expectAnswer(turn3, claudeAgain, "harness-switch leg 3 (claude again)");
  const transcriptsAfterResume = await inst.claudeTranscripts();
  const grew = [...transcriptsAfterResume].some(([file, size]) => size > (transcriptsAfterDsh.get(file) ?? 0));
  if (!grew) throw new Error("harness-switch: claude transcript did not grow on leg 3 — resume did not happen");
});

// --- runner ------------------------------------------------------------------

const inst = await DshInstance.create(repoRoot);
try {
  const cases = only ? results.filter((c) => c.name === only) : results;
  if (cases.length === 0) {
    console.error(`no case named ${only}; known: ${results.map((c) => c.name).join(", ")}`);
    process.exitCode = 1;
  }
  for (const { name, fn } of cases) {
    const started = Date.now();
    try {
      await fn(inst);
      console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)  [DSH_HOME=${inst.home}]`);
    } catch (error) {
      process.exitCode = 1;
      console.log(`FAIL ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)  [DSH_HOME=${inst.home}]`);
      console.error(String(error.stack ?? error));
    }
  }
} finally {
  if (keep) {
    console.log(`kept instance for debugging: ${inst.home}`);
    // The spawned dsh web child (still running for inspection) holds the
    // event loop open — without a hard exit the runner never terminates.
    process.exit(process.exitCode ?? 0);
  } else {
    await inst.dispose();
  }
}
