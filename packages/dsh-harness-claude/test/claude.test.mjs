// Offline tests for the dsh-harness-claude harness adapter (v0.3.0 rewrite).
// Uses the mock CLI in test/bin/mock-claude plus a fake llmBase/llm — no live
// dsh, gateway plugin, or claude binary involved. Each case maps to one known
// lesson from DESIGN.md; scenario switches run sequentially (the mock reads
// process.env at spawn time).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ClaudeAdapter, Config, apply, name, inject } from "../lib/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-harness-claude-test-"));
const MOCK = path.join(import.meta.dirname, "bin", "mock-claude");
const adapters = [];

const fakeGateway = (state) => ({
  resolve: async (qualifiedId) => ({ provider: "deepseek-official", model: "deepseek-chat", api: "anthropic-messages", qualifiedId }),
  localEndpoint: () => ({ baseUrl: state.baseUrl, ...(state.token ? { token: state.token } : {}) }),
});

const fakeLlm = {
  resolveModelInfo: async (provider, model) => ({
    provider,
    id: model,
    name: `info:${provider}/${model}`,
    reasoning: { efforts: [{ id: "high", name: "high" }] },
  }),
};

function makeAdapter({ gatewayState = { baseUrl: "http://127.0.0.1:3080/v1", token: "tok-123" }, scenario = "direct", log = `${tmp}/log-${Math.random().toString(36).slice(2)}.jsonl` } = {}) {
  process.env.DSH_MOCK_CLAUDE_LOG = log;
  process.env.DSH_MOCK_CLAUDE_SCENARIO = scenario;
  const adapter = new ClaudeAdapter({
    command: MOCK,
    model: "",
    logger: { info() {}, warn() {} },
    sessionCwd: () => tmp,
    toolExecutor: async () => ({ content: [{ type: "text", text: "executed" }], isError: false }),
    gateway: () => fakeGateway(gatewayState),
    llm: fakeLlm,
  });
  adapters.push(adapter);
  return { adapter, log, gatewayState };
}

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

const readLog = (log) => fs.existsSync(log)
  ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

const spawns = (log) => readLog(log).filter((entry) => entry.spawn);
const stdins = (log) => readLog(log).filter((entry) => entry.stdin).map((entry) => JSON.parse(entry.stdin));

const userOptions = (overrides = {}) => ({
  sessionId: "s1",
  model: "deepseek-official/deepseek-chat",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  ...overrides,
});

let failures = 0;
before(() => {
  process.env.DSH_CLAUDE_STARTUP_TIMEOUT_MS = "10000";
  // Isolate the per-spawn CLAUDE_CONFIG_DIR (it derives from DSH_HOME).
  process.env.DSH_HOME = tmp;
});
after(() => {
  for (const adapter of adapters) {
    adapter.disposeAssets();
  }
  delete process.env.DSH_MOCK_CLAUDE_LOG;
  delete process.env.DSH_MOCK_CLAUDE_SCENARIO;
  delete process.env.DSH_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("module shape", () => {
  it("exports the adapter identity (selection/dispatch live in harness-base)", () => {
    assert.equal(name, "harness-claude");
    assert.deepEqual(inject, ["llm", "tools", "sessions", "llmBase"]);
    const config = Config({});
    assert.equal(volatile(config.command), "claude");
    assert.equal(volatile(config.model), "");
    assert.equal(config.permissionMode, "bypassPermissions");
    // Harness selection state is NOT part of this plugin's config.
    assert.equal(config.harness, undefined);
    assert.equal(config.harnessBySession, undefined);
  });
});

function volatile(value) {
  return typeof value?.get === "function" ? value.get() : value;
}

describe("spawn argv/env", () => {
  it("passes the qualified model id, relay origin env, and no --resume on first turn", async () => {
    const { adapter, log } = makeAdapter();
    const chunks = await collect(adapter.stream(userOptions()));
    assert.ok(chunks.some((c) => c.type === "finish" && c.reason.kind === "stop"));
    const [spawn] = spawns(log);
    const at = (name) => {
      const index = spawn.argv.indexOf(name);
      return index >= 0 ? spawn.argv[index + 1] : undefined;
    };
    assert.equal(at("--model"), "deepseek-official/deepseek-chat");
    assert.equal(at("--permission-mode"), "bypassPermissions");
    assert.equal(at("--resume"), undefined);
    assert.equal(spawn.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3080");
    assert.equal(spawn.env.ANTHROPIC_AUTH_TOKEN, "tok-123");
    assert.equal(spawn.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    // The model and relay identity ride the isolated CLAUDE_CONFIG_DIR's
    // settings.json — the user-level settings cannot override them there.
    assert.equal(spawn.env.CLAUDE_CONFIG_DIR?.includes("claude-config/session-s1"), true);
    assert.equal(fs.existsSync(path.join(spawn.env.CLAUDE_CONFIG_DIR, "settings.json")), true);
    const written = JSON.parse(fs.readFileSync(path.join(spawn.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    assert.equal(written.model, "deepseek-official/deepseek-chat");
    assert.equal(written.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3080");
    // macOS /var → /private/var symlink: compare real paths.
    assert.equal(fs.realpathSync(spawn.cwd), fs.realpathSync(tmp));
  });

  it("loopback bind (no token) sends the login-flow-blocking placeholder", async () => {
    const { adapter, log } = makeAdapter({ gatewayState: { baseUrl: "http://127.0.0.1:3080/v1", token: undefined } });
    await collect(adapter.stream(userOptions()));
    assert.equal(spawns(log)[0].env.ANTHROPIC_AUTH_TOKEN, "dsh-local");
  });
});

describe("direct answer stream", () => {
  it("streams text, usage, and a resumable anchor", async () => {
    const { adapter } = makeAdapter();
    const chunks = await collect(adapter.stream(userOptions()));
    const kinds = chunks.map((c) => c.type);
    assert.ok(kinds.includes("block-start") && kinds.includes("text-delta") && kinds.includes("block-end"));
    const finish = chunks.find((c) => c.type === "finish");
    assert.equal(finish.reason.kind, "stop");
    assert.equal(finish.replayState.claudeSessionId, "mock-session-1");
    assert.ok(chunks.some((c) => c.type === "usage" && c.usage.inputTokens === 10));
    // Claim released: no tool calls.
    assert.equal(adapter.activeSessions.size, 0);
    assert.equal(adapter.claudeTurns.size, 0);
  });
});

describe("image turn input", () => {
  it("sends dsh base64 image blocks as anthropic base64-source images", async () => {
    const { adapter, log } = makeAdapter();
    const chunks = await collect(adapter.stream(userOptions({
      messages: [{ role: "user", content: [
        { type: "text", text: "看这张图" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
      ] }],
    })));
    assert.ok(chunks.some((c) => c.type === "finish" && c.reason.kind === "stop"));
    const userMsg = stdins(log).find((m) => m.type === "user");
    const [text, image] = userMsg.message.content;
    assert.deepEqual(text, { type: "text", text: "看这张图" });
    assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" } });
  });

  it("fails the turn when an image block has neither data nor url", async () => {
    const { adapter } = makeAdapter();
    await assert.rejects(
      () => collect(adapter.stream(userOptions({
        messages: [{ role: "user", content: [{ type: "image" }] }],
      }))),
      /image block without data or url/,
    );
    // The failed turn must not leave the session claimed: a leaked claim
    // keeps the display receipt stubs shadowing native tools after a
    // harness switch back to dsh (session 851e3948 turns 9-11: every native
    // bash call answered "No result found" from the dead receipt map).
    assert.equal(adapter.claudeTurns.size, 0);
    assert.equal(adapter.activeSessions.size, 0);
  });
});

describe("tool-round split (chunk-log + cursor)", () => {
  it("pause finish at the tool result, continuation drains the final answer", async () => {
    const { adapter } = makeAdapter({ scenario: "tool" });
    const signal = new AbortController().signal;
    const first = await collect(adapter.stream(userOptions({ signal })));
    // Step 1: tool-call block + pause finish; the receipt result is stashed.
    const toolStart = first.find((c) => c.type === "block-start" && c.blockType === "tool-call");
    assert.ok(toolStart);
    const delta = first.find((c) => c.type === "tool-call-delta");
    assert.equal(delta.name, "bash");
    const blockEnd = first.find((c) => c.type === "block-end" && c.block.type === "tool-call");
    assert.equal(blockEnd.block.id, "call_1");
    assert.equal(blockEnd.block.arguments, JSON.stringify({ command: "ls", description: "列出当前目录" }));
    const pause = first.at(-1);
    assert.equal(pause.type, "finish");
    assert.equal(pause.reason.kind, "stop");
    assert.equal(pause.replayState.claudeSessionId, "mock-session-1");
    assert.equal(adapter.receiptResults.get("call_1").content[0].text, "file-a\nfile-b");
    // Turn state survives for the continuation step; claim held.
    assert.equal(adapter.claudeTurns.size, 1);
    assert.equal(adapter.activeSessions.size, 1);

    // Step 2 (same dsh phase signal): the final answer streams live.
    const second = await collect(adapter.stream(userOptions({ signal })));
    const textDelta = second.find((c) => c.type === "text-delta");
    assert.equal(textDelta.text, "final answer");
    const finish = second.find((c) => c.type === "finish");
    assert.equal(finish.reason.kind, "stop");
    assert.equal(finish.replayState.claudeSessionId, "mock-session-1");
    assert.equal(adapter.claudeTurns.size, 0);
    assert.equal(adapter.activeSessions.size, 0);
  });
});

describe("abort", () => {
  it("sends control_request interrupt, ends aborted with an anchor, next turn answers", async () => {
    const { adapter, log } = makeAdapter({ scenario: "abort" });
    const controller = new AbortController();
    const stream = adapter.stream(userOptions({ signal: controller.signal }));
    const chunks = [];
    const draining = (async () => { for await (const chunk of stream) chunks.push(chunk); })();
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await draining;
    const finish = chunks.find((c) => c.type === "finish");
    assert.equal(finish.reason.kind, "aborted");
    assert.equal(finish.replayState.claudeSessionId, "mock-session-1");
    const interrupt = stdins(log).find((m) => m.type === "control_request");
    assert.equal(interrupt.request.subtype, "interrupt");
    assert.equal(adapter.claudeTurns.size, 0);

    // The codex stuck-turn regression, claude edition: the next message on
    // the same session answers normally (no dead queue drain).
    const second = await collect(adapter.stream(userOptions({ messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "x" }], source: { replayState: { claudeSessionId: "mock-session-1" } } },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ] })));
    assert.equal(second.find((c) => c.type === "finish").reason.kind, "stop");
  });
});

describe("claim lifecycle (harness-switch incident)", () => {
  it("retires the turn state when the dsh loop closes the generator between steps", async () => {
    const { adapter } = makeAdapter({ scenario: "tool" });
    const reader = adapter.stream(userOptions())[Symbol.asyncIterator]();
    // Drain step 1 to its pause finish, then close the generator the way an
    // aborted dsh turn does instead of calling stream() again.
    while (true) {
      const { value, done } = await reader.next();
      if (done) break;
      if (value.type === "finish") break;
    }
    assert.equal(adapter.claudeTurns.size, 1);
    assert.equal(adapter.activeSessions.size, 1);
    await reader.return();
    assert.equal(adapter.claudeTurns.size, 0);
    assert.equal(adapter.activeSessions.size, 0);
  });

  it("releases the claim when an aborted turn is abandoned without draining", async () => {
    const { adapter } = makeAdapter({ scenario: "abort" });
    const controller = new AbortController();
    const reader = adapter.stream(userOptions({ signal: controller.signal }))[Symbol.asyncIterator]();
    const pending = reader.next();
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const { value } = await pending;
    assert.equal(value.type, "finish");
    assert.equal(value.reason.kind, "aborted");
    // The aborted CLI result destroyed the state + claim with the dsh turn
    // gone, even though the finish was never drained past this point.
    assert.equal(adapter.claudeTurns.size, 0);
    assert.equal(adapter.activeSessions.size, 0);
    await reader.return();
  });
});

describe("resume", () => {
  it("respawns with --resume after the process died", async () => {
    const { adapter, log } = makeAdapter({ scenario: "die-later" });
    await collect(adapter.stream(userOptions()));
    // The mock exits ~20ms after the first result; let it die so the next
    // turn must respawn.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const history = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "answer 1" }], source: { replayState: { claudeSessionId: "mock-session-1" } } },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ];
    await collect(adapter.stream(userOptions({ messages: history })));
    const second = spawns(log)[1];
    const at = (name) => {
      const index = second.argv.indexOf(name);
      return index >= 0 ? second.argv[index + 1] : undefined;
    };
    assert.equal(at("--resume"), "mock-session-1");
  });

  it("fails when history has claude turns but no anchor", async () => {
    const { adapter } = makeAdapter();
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream(userOptions({ sessionId: "s-no-anchor", messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "x" }], source: { provider: "claude" } },
          { role: "user", content: [{ type: "text", text: "next" }] },
        ] }))) { /* drain until the expected rejection */ }
      },
      (error) => error.code === "INVALID_REQUEST",
    );
  });

  it("fails the turn when the resume itself fails (no silent new conversation)", async () => {
    const { adapter } = makeAdapter({ scenario: "resume-fail" });
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream(userOptions({ messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "x" }], source: { replayState: { claudeSessionId: "gone-session" } } },
          { role: "user", content: [{ type: "text", text: "next" }] },
        ] }))) { /* drain until the expected rejection */ }
      },
      (error) => error.code === "TRANSPORT" && error.message.includes("resume gone-session"),
    );
    // Spawn failure releases the claim too (same leak class as the failed
    // image turn below).
    assert.equal(adapter.claudeTurns.size, 0);
    assert.equal(adapter.activeSessions.size, 0);
  });
});

describe("spawn-identity changes", () => {
  it("model switch respawns and resumes", async () => {
    const { adapter, log } = makeAdapter();
    await collect(adapter.stream(userOptions()));
    await collect(adapter.stream(userOptions({ model: "acme/auto_model/example-auto", messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "answer 1" }], source: { replayState: { claudeSessionId: "mock-session-1" } } },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] })));
    const second = spawns(log)[1];
    const at = (name) => {
      const index = second.argv.indexOf(name);
      return index >= 0 ? second.argv[index + 1] : undefined;
    };
    assert.equal(at("--model"), "acme/auto_model/example-auto");
    assert.equal(at("--resume"), "mock-session-1");
  });

  it("endpoint change voids the live process and the next turn resumes", async () => {
    const { adapter, log, gatewayState } = makeAdapter();
    await collect(adapter.stream(userOptions()));
    gatewayState.token = "rotated-token";
    await collect(adapter.stream(userOptions({ messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "answer 1" }], source: { replayState: { claudeSessionId: "mock-session-1" } } },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] })));
    const second = spawns(log)[1];
    const at = (name) => {
      const index = second.argv.indexOf(name);
      return index >= 0 ? second.argv[index + 1] : undefined;
    };
    assert.equal(at("--resume"), "mock-session-1");
    assert.equal(second.env.ANTHROPIC_AUTH_TOKEN, "rotated-token");
  });
});

describe("applyConfig volatile unwrap", () => {
  it("unwraps volatile refs so plain values land on the adapter", () => {
    const { adapter } = makeAdapter();
    adapter.applyConfig({
      command: { get: () => MOCK },
      model: { get: () => "fallback-model" },
      effort: { get: () => "high" },
      permissionMode: "bypassPermissions",
      exposeTools: { get: () => ["web_search"] },
    });
    assert.equal(adapter.model, "fallback-model");
    assert.equal(adapter.effort, "high");
    assert.deepEqual([...adapter.exposeTools], ["web_search"]);
  });
});

describe("title turns", () => {
  it("run one-shot ephemeral: no --resume, disallowed write tools", async () => {
    const { adapter, log } = makeAdapter();
    const chunks = await collect(adapter.stream({
      purpose: "session-title",
      sessionId: null,
      model: "deepseek-official/deepseek-chat",
      system: "You title conversations.",
      messages: [{ role: "user", content: [{ type: "text", text: "title this chat" }] }],
    }));
    const finish = chunks.find((c) => c.type === "finish");
    assert.equal(finish.reason.kind, "stop");
    const [spawn] = spawns(log);
    assert.equal(spawn.argv.includes("--resume"), false);
    assert.equal(spawn.argv.includes("--no-session-persistence"), true);
    assert.equal(spawn.argv.includes("--disallowedTools"), true);
    assert.equal(adapter.pendingReplay.size, 0);
  });
});

describe("harness model surface", () => {
  it("advertises no models and resolves qualified ids through the gateway", async () => {
    const { adapter } = makeAdapter();
    assert.deepEqual(await adapter.listModels("claude"), []);
    const info = await adapter.resolveModel("claude", "deepseek-official/deepseek-chat");
    assert.equal(info.provider, "claude");
    assert.equal(info.id, "deepseek-official/deepseek-chat");
    assert.equal(info.name, "info:deepseek-official/deepseek-chat");
    assert.equal(info.reasoning.efforts[0].id, "high");
  });

  it("providerInfo renders the harness display name", () => {
    const { adapter } = makeAdapter();
    assert.deepEqual(adapter.providerInfo("claude"), { id: "claude", name: "Claude" });
  });
});

describe("plugin wiring", () => {
  it("apply() registers the adapter, provider row, and the harness identity on harness-base", () => {
    const harnesses = new Map();
    let adapterRef;
    const ctx = {
      fiber: { id: "fiber" },
      logger: { info() {}, warn() {} },
      sessions: { get: () => null },
      tools: { execute: async () => ({}) },
      effect(factory) { return factory(); },
      llmBase: { ...fakeGateway({ baseUrl: "http://127.0.0.1:3080/v1" }), harnesses, registerHarness(spec) { harnesses.set(spec.id, spec); return () => harnesses.delete(spec.id); } },
      llm: {
        registerAdapter(_providers, registered) { adapterRef = registered; },
        registerConfigurableProviders() {},
        registerModelDiscovery() {},
        stream() {},
      },
      on() {},
    };
    apply(ctx, Config({ command: MOCK }));
    assert.deepEqual([...harnesses.keys()], ["claude"]);
    assert.equal(harnesses.get("claude").displayName, "Claude");
    assert.ok(harnesses.get("claude").icon.startsWith("<svg") && harnesses.get("claude").icon.includes("#D97757"), "claude icon is the inline starburst mark in the brand coral");
    assert.equal(harnesses.get("claude").prompt, "You are running on the Claude harness.");
    assert.equal(typeof adapterRef, "object");
  });
});
