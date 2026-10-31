// Reproductions for "bash 总是没有结果" (bash receipts come back "No result
// found"). Three independent mechanisms, all against the current lib/index.js:
//
// 1. Receipt-interceptor leak: stream() claims the session in
//    activeCodexSessions before any await; when the codex turn then fails to
//    start (or is abandoned between steps — harness switch, step error), the
//    claim is never released. Every later NATIVE bash execution in that
//    session is intercepted as a codex receipt, the scope-registered stub
//    shadows the real bash tool, and the stub finds nothing:
//    "No result found for <callId>" until dsh restarts.
// 2. Parallel commands: codex items settle independently; the segment freezes
//    at the FIRST tool completion, so the still-open earlier tool's receipt
//    executes with no stashed result. Its late item/completed then emits a
//    block-end for an already-finished segment index.
// 3. Stale-generation stubs: after a plugin reload the new adapter instance
//    cannot reach the old instance's stubs — re-registering throws
//    "already registered in this scope" and the drop path holds no disposers,
//    so the session keeps answering from the dead receipt map. The generation
//    check replaces the stale stub; the turn/start listener retires stubs of
//    unclaimed sessions before the next dsh turn assembles its tool list.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { apply } from "../lib/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-harness-codex-repro-"));

// Minimal plugin host: captures waterfall handlers and emulates the scoped
// tool registry so a scope-local registration shadows the "global" tool —
// the same shadowing dsh-tools performs.
function makeCtx(config, { gatewayService } = {}) {
  const handlers = {};
  let adapter;
  const agents = new Map();
  const globalTools = new Map([["bash", {
    execute: async () => ({ content: [{ type: "text", text: "REAL_BASH_OUTPUT" }], isError: false }),
  }]]);
  const ctx = {
    fiber: { id: "fiber" },
    logger: { info() {}, warn() {} },
    sessions: { get: () => null },
    tools: { execute: async () => ({}) },
    systemPrompt: { section() { return () => {}; } },
    effect(factory) { return factory(); },
    llmBase: gatewayService ?? { localEndpoint: () => ({ baseUrl: "http://127.0.0.1:3080/v1" }), registerHarness() { return () => {}; } },
    llm: {
      registerAdapter(_providers, registered) { adapter = registered; },
      registerConfigurableProviders() {},
      registerModelDiscovery() {},
      stream() {},
    },
    on(name, handler) { handlers[name] = handler; },
    get(name) { return name === "agents" ? { get: (id) => agents.get(id) } : undefined; },
  };
  apply(ctx, config);
  // Emulate the dispatch: resolve the tool by name through the scope layer
  // the interceptor registered into, then run it with the exec's callId.
  const dispatch = async (exec) => {
    const scopeTools = exec.agent?.ctx?.tools;
    const tool = scopeTools?.get?.(exec.name) ?? globalTools.get(exec.name);
    if (!tool) return { content: [{ type: "text", text: ` ToolNotFound: ${exec.name}` }], isError: true };
    return tool.execute(exec.arguments ?? {}, { callId: exec.callId });
  };
  return { ctx, handlers, dispatch, adapter, agents };
}

const gatewayService = (baseUrl) => ({ localEndpoint: () => ({ baseUrl }), registerHarness() { return () => {}; } });

const nativeBashExec = (sessionId, callId, agent = makeAgent(sessionId)) => ({
  name: "bash",
  callId,
  arguments: { command: "echo native", description: "native call" },
  agent,
});

const makeAgent = (sessionId) => ({
  session: { id: sessionId },
  // Scope registry the interceptor registers receipt stubs into. register()
  // returns the exact disposer that unregisters the tool, and refuses
  // duplicate names — the same contract dsh-tools enforces per scope.
  ctx: {
    tools: (() => {
      const map = new Map();
      return {
        register: (def) => {
          if (map.has(def.name)) throw new Error(`tool "${def.name}" is already registered in this scope`);
          map.set(def.name, def);
          return () => map.delete(def.name);
        },
        get: (name) => map.get(name),
        has: (name) => map.has(name),
      };
    })(),
  },
});

describe("bash receipt regressions", () => {
  const created = [];
  before(() => {
    fs.chmodSync(path.join(import.meta.dirname, "bin", "mock-codex"), 0o755);
  });
  after(() => {
    for (const adapter of created) adapter.server.dispose();
  });

  it("leaked session claim shadows the native bash tool with the receipt stub", async () => {
    // The plugin's adapter with a codex command that cannot start: stream()
    // claims the session, thread/start fails, the claim is never released.
    const { handlers, dispatch, adapter } = makeCtx({
      command: path.join(import.meta.dirname, "bin", "no-such-codex"),
      socketPath: path.join(tmp, "dead.sock"),
    }, { gatewayService: gatewayService("http://127.0.0.1:1/v1") });
    created.push(adapter);
    await assert.rejects(
      () => adapter.stream({
        sessionId: "sess-leak",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
      }).next(),
    );
    assert.equal(adapter.activeCodexSessions.has("sess-leak"), true, "claim leaked");

    // The interceptor gate passes for the claimed session; ensureReceiptTool
    // registers the stub into the agent scope, shadowing the real bash tool.
    const exec = nativeBashExec("sess-leak", "call_native_1");
    const result = await handlers["tools/execute"](exec, () => dispatch(exec));
    assert.equal(
      result.content[0].text,
      "No result found for call_native_1",
      "native bash was shadowed by the receipt stub",
    );
    assert.equal(exec.agent.ctx.tools.has("bash"), true, "receipt stub registered over bash");
  });

  it("interceptor passes non-codex sessions through to the real tool", async () => {
    const { handlers, dispatch, adapter } = makeCtx({ command: "unused" });
    created.push(adapter);
    const exec = nativeBashExec("sess-clean", "call_native_2");
    const result = await handlers["tools/execute"](exec, () => dispatch(exec));
    assert.equal(result.content[0].text, "REAL_BASH_OUTPUT");
  });

  it("released claim drops the receipt stubs: native bash works again after a codex turn", async () => {
    // Observed 2026-10-28 (session-ee27753c): a codex turn registered the bash
    // receipt stub into the session's agent scope; the turn ended and released
    // the claim, but the scoped stub kept shadowing the global tool — every
    // later native bash in the switched-back session answered "No result
    // found" until dsh restarted. Releasing the claim must also retire the
    // stubs (lazily, on the first exec that finds no claim).
    const { handlers, dispatch, adapter } = makeCtx({ command: "unused" });
    created.push(adapter);
    const agent = makeAgent("sess-back");
    adapter.activeCodexSessions.add("sess-back");
    const codexExec = nativeBashExec("sess-back", "call_rcpt_1", agent);
    await handlers["tools/execute"](codexExec, () => dispatch(codexExec));
    assert.equal(agent.ctx.tools.has("bash"), true, "receipt stub registered while claimed");

    adapter.activeCodexSessions.delete("sess-back");

    const exec = nativeBashExec("sess-back", "call_native_3", agent);
    const result = await handlers["tools/execute"](exec, () => dispatch(exec));
    assert.equal(result.content[0].text, "REAL_BASH_OUTPUT", "native bash reachable after the claim is released");
    assert.equal(agent.ctx.tools.has("bash"), false, "receipt stub unregistered after the release");

    // A later codex turn re-registers on demand.
    adapter.activeCodexSessions.add("sess-back");
    const codexExec2 = nativeBashExec("sess-back", "call_rcpt_2", agent);
    await handlers["tools/execute"](codexExec2, () => dispatch(codexExec2));
    assert.equal(agent.ctx.tools.has("bash"), true, "receipt stub re-registered for the new codex turn");
  });

  it("turn/start on an unclaimed session retires the stubs before the next dsh turn assembles", async () => {
    // The tools/execute drop only runs AFTER a model call — too late for the
    // tool-schema list of the first post-switch turn. turn/start session
    // events fire synchronously BEFORE systemPrompt.assemble, so retiring
    // there gives DeepSeek the real tool list on that turn.
    const { handlers, dispatch, adapter, agents } = makeCtx({ command: "unused" });
    created.push(adapter);
    const agent = makeAgent("sess-turn");
    agents.set("sess-turn", agent);
    adapter.activeCodexSessions.add("sess-turn");
    const codexExec = nativeBashExec("sess-turn", "call_rcpt_3", agent);
    await handlers["tools/execute"](codexExec, () => dispatch(codexExec));
    assert.equal(agent.ctx.tools.has("bash"), true, "receipt stub registered while claimed");

    adapter.activeCodexSessions.delete("sess-turn");
    await handlers["session/event"]({ id: "sess-turn" }, { type: "turn/start", data: { turn: 1 } });
    assert.equal(agent.ctx.tools.has("bash"), false, "stubs retired at turn/start of the unclaimed session");

    // Claimed sessions keep their stubs across their own turn/start.
    adapter.activeCodexSessions.add("sess-turn");
    await handlers["session/event"]({ id: "sess-turn" }, { type: "turn/start", data: { turn: 2 } });
    adapter.receiptResults.set("call_rcpt_4", {
      content: [{ type: "text", text: "RECEIPT_4" }],
      isError: false,
    });
    const codexExec2 = nativeBashExec("sess-turn", "call_rcpt_4", agent);
    const claimed = await handlers["tools/execute"](codexExec2, () => dispatch(codexExec2));
    assert.equal(claimed.content[0].text, "RECEIPT_4", "claimed session keeps its receipt registration");
  });

  it("plugin reload replaces a dead adapter's stubs instead of answering from the dead map", async () => {
    // Without the generation check the reloaded instance cannot replace the
    // old stub (register throws "already registered in this scope", swallowed)
    // and cannot drop it either (its tracking holds no disposers) — every
    // receipt answers "No result found" from the dead map forever.
    const first = makeCtx({ command: "unused" });
    created.push(first.adapter);
    const agent = makeAgent("sess-reload");
    first.agents.set("sess-reload", agent);
    first.adapter.activeCodexSessions.add("sess-reload");
    first.adapter.receiptResults.set("call_rcpt_5", {
      content: [{ type: "text", text: "DEAD_INSTANCE_WOULD_LOSE_THIS" }],
      isError: false,
    });
    const codexExec = nativeBashExec("sess-reload", "call_rcpt_5", agent);
    await first.handlers["tools/execute"](codexExec, () => first.dispatch(codexExec));
    assert.equal(agent.ctx.tools.has("bash"), true, "first instance registered the stub");

    // Reload: a fresh plugin fiber re-applies over the same live agent scope.
    const second = makeCtx({ command: "unused" });
    created.push(second.adapter);
    second.agents.set("sess-reload", agent);
    second.adapter.activeCodexSessions.add("sess-reload");
    second.adapter.receiptResults.set("call_rcpt_6", {
      content: [{ type: "text", text: "LIVE_RECEIPT" }],
      isError: false,
    });
    const codexExec2 = nativeBashExec("sess-reload", "call_rcpt_6", agent);
    const result = await second.handlers["tools/execute"](codexExec2, () => second.dispatch(codexExec2));
    assert.equal(result.content[0].text, "LIVE_RECEIPT", "the reloaded adapter's stub answered, not the dead one");
    assert.equal(agent.ctx.tools.has("bash"), true, "the live stub is registered in the scope");
  });

  it("parallel commands: the first completion freezes the segment and strands the other receipt", async () => {
    process.env.MOCK_SCENARIO = "parallel-commands";
    const sock = path.join(tmp, "parallel.sock");
    process.env.MOCK_LOG = path.join(tmp, "parallel.jsonl");
    const { adapter } = makeCtx({
      command: path.join(import.meta.dirname, "bin", "mock-codex"),
      socketPath: sock,
    }, { gatewayService: gatewayService("http://127.0.0.1:3080/v1") });
    created.push(adapter);
    const options = {
      sessionId: "sess-par",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    };

    // Step 1: segment 0 carries both tool blocks and freezes at c2's completion.
    const first = [];
    for await (const chunk of adapter.stream(options)) {
      first.push(chunk);
      // dsh executes receipts as soon as the tool block closes, BEFORE the
      // codex turn settles the other command.
      if (chunk.type === "tool-call-delta" && chunk.id === "c1") {
        const c1 = adapter.receiptResults.get("c1");
        assert.equal(c1, undefined, "c1's receipt fires before its item completes");
      }
    }
    const toolBlocks = first.filter((c) => c.type === "tool-call-delta").map((c) => c.id);
    assert.deepEqual(toolBlocks, ["c1", "c2"]);
    assert.equal(adapter.receiptResults.has("c1"), false, "c1 result still missing after the step");

    // Step 2: c1's late completion emits a block-end for segment-0 index 0
    // into segment 1 — a close with no open block in this step.
    const second = [];
    for await (const chunk of adapter.stream(options)) second.push(chunk);
    const starts = second.filter((c) => c.type === "block-start").map((c) => c.index);
    const ends = second.filter((c) => c.type === "block-end").map((c) => c.index);
    assert.ok(
      ends.some((index) => !starts.includes(index)),
      `dangling block-end without block-start (starts=${JSON.stringify(starts)}, ends=${JSON.stringify(ends)})`,
    );
  });
});
