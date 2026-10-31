// Offline mock self-test for the gateway consumption side of dsh-harness-codex
// (task-3). Uses a fake llmBase service plus the mock app-server in
// test/bin/mock-codex; no live dsh or gateway plugin is needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CodexAdapter, Config, apply } from "../lib/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-harness-codex-test-"));
const adapters = [];

const fakeGateway = ({ api = "openai-responses", baseUrl = "http://127.0.0.1:3080/v1", token, harnesses } = {}) => ({
  harnesses: harnesses ?? new Map(),
  registerHarness(spec) { this.harnesses.set(spec.id, spec); return () => this.harnesses.delete(spec.id); },
  targets: async () => [
    { id: "deepseek-official/deepseek-chat", name: "DeepSeek Chat", provider: "deepseek-official", modelId: "deepseek-chat", description: "mirrored" },
    { id: "acme/auto_model/example-max", name: "example-max", provider: "acme", modelId: "auto_model/example-max" },
  ],
  resolve: async (qualifiedId) => ({ provider: "deepseek-official", model: "deepseek-chat", api, qualifiedId }),
  localEndpoint: () => ({ baseUrl, ...(token ? { token } : {}) }),
});

const fakeLlm = {
  resolveModelInfo: async (provider, model) => ({
    provider,
    id: model,
    name: `info:${provider}/${model}`,
    reasoning: { efforts: [{ id: "medium", name: "medium" }] },
  }),
};

const makeAdapter = (options) => {
  const adapter = new CodexAdapter({
    command: path.join(import.meta.dirname, "bin", "mock-codex"),
    logger: { info() {}, warn() {} },
    // The adapter resolves the gateway lazily (production passes
    // () => ctx.llmBase); tests pass the fake object through the same
    // getter shape.
    ...options,
    gateway: () => options.gateway,
  });
  adapters.push(adapter);
  return adapter;
};

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

const readLog = (logPath) =>
  fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

const titleOptions = (model, gatewayApi) => ({
  purpose: "session-title",
  sessionId: null,
  model,
  system: "You title conversations.",
  messages: [{ role: "user", content: [{ type: "text", text: "title this chat" }] }],
  signal: undefined,
  gatewayApi,
});

describe("gateway consumption (task-3)", () => {
  before(() => {
    fs.chmodSync(path.join(import.meta.dirname, "bin", "mock-codex"), 0o755);
  });

  it("listModels advertises nothing; the codex provider is addressed by qualified ids only", async () => {
    const adapter = makeAdapter({ gateway: fakeGateway(), llm: fakeLlm });
    assert.deepEqual(await adapter.listModels("codex"), []);
    assert.equal(adapter.providerInfo("codex").name, "Codex");
  });

  it("resolveModel forwards to the source provider's resolveModelInfo", async () => {
    const adapter = makeAdapter({ gateway: fakeGateway(), llm: fakeLlm });
    const info = await adapter.resolveModel("codex", "deepseek-official/deepseek-chat");
    assert.equal(info.provider, "codex");
    assert.equal(info.id, "deepseek-official/deepseek-chat");
    assert.equal(info.name, "info:deepseek-official/deepseek-chat");
    assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ["medium"]);
  });

  it("title thread: qualified model + relay base_url passed as a spawn param", async () => {
    const sock = path.join(tmp, "t-title.sock");
    const logPath = path.join(tmp, "t-title.jsonl");
    process.env.MOCK_LOG = logPath;
    const adapter = makeAdapter({
      socketPath: sock,
      gateway: fakeGateway({ token: "tok-1" }),
      llm: fakeLlm,
    });
    const chunks = await collect(adapter.stream(titleOptions("deepseek-official/deepseek-chat")));
    assert.equal(chunks.find((c) => c.type === "text-delta")?.text, "Hello from mock");
    assert.equal(chunks.at(-1).type, "finish");

    const log = readLog(logPath);
    const spawn = log.find((r) => r.type === "spawn");
    // Root-level -c overrides define the gateway relay provider and disable
    // OpenAI-specific remote compaction; a remote-bind gateway adds the
    // env_key pointing codex at the token env var; the socket rides on
    // --listen.
    assert.deepEqual(spawn.argv, [
      "-c",
      'model_provider="dsh-codex-relay"',
      "-c",
      'model_providers.dsh-codex-relay.name="DSH Codex Relay"',
      "-c",
      'model_providers.dsh-codex-relay.base_url="http://127.0.0.1:3080/v1"',
      "-c",
      'model_providers.dsh-codex-relay.wire_api="responses"',
      "-c",
      'model_providers.dsh-codex-relay.capabilities.remote_compaction="unsupported"',
      "-c",
      'model_providers.dsh-codex-relay.env_key="DSH_HARNESS_RELAY_TOKEN"',
      "app-server",
      "--listen",
      `unix://${sock}`,
    ]);
    // The token value rides in the listener env (never argv): codex sends it
    // as the relay bearer credential on non-loopback binds.
    assert.equal(spawn.env.DSH_HARNESS_RELAY_TOKEN, "tok-1");
    const start = log.find((r) => r.type === "request" && r.method === "thread/start");
    assert.equal(start.params.model, "deepseek-official/deepseek-chat");
    assert.equal("modelProvider" in start.params, false);
    assert.equal(start.params.ephemeral, true);
    const inject = log.find((r) => r.type === "request" && r.method === "thread/inject_items");
    assert.equal(inject.params.items[0].role, "system");
  });

  it("title thread: non-responses targets still route — the gateway relays verbatim", async () => {
    const sock = path.join(tmp, "t-completions.sock");
    const logPath = path.join(tmp, "t-completions.jsonl");
    process.env.MOCK_LOG = logPath;
    const adapter = makeAdapter({
      socketPath: sock,
      gateway: fakeGateway({ api: "openai-completions" }),
      llm: fakeLlm,
    });
    // No protocol gate: the qualified id rides as-is with the single relay
    // pseudo provider; wire compatibility is the upstream endpoint's concern.
    const chunks = await collect(adapter.stream(titleOptions("pipo/glm-5.3")));
    assert.equal(chunks.find((c) => c.type === "text-delta")?.text, "Hello from mock");
    const start = readLog(logPath).find((r) => r.type === "request" && r.method === "thread/start");
    assert.equal(start.params.model, "pipo/glm-5.3");
    assert.equal("modelProvider" in start.params, false);
  });

  it("session thread: model overrides reach thread/start and thread/resume", async () => {
    const sock = path.join(tmp, "t-session.sock");
    const logPath = path.join(tmp, "t-session.jsonl");
    process.env.MOCK_LOG = logPath;
    const gateway = fakeGateway({ api: "openai-responses" });
    const adapter = makeAdapter({ socketPath: sock, gateway, llm: fakeLlm });
    const options = {
      sessionId: "sess-1",
      model: "deepseek-official/deepseek-chat",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    };
    const chunks = await collect(adapter.stream(options));
    assert.equal(chunks.find((c) => c.type === "text-delta")?.text, "Hello from mock");
    const finish = chunks.at(-1);
    assert.equal(finish.reason.kind, "stop");
    assert.equal(finish.replayState.codexThreadId, "t-mock-1");
    let log = readLog(logPath);
    const start = log.find((r) => r.type === "request" && r.method === "thread/start");
    assert.equal("modelProvider" in start.params, false);
    assert.equal(start.params.ephemeral, false);
    assert.equal(start.params.threadSource, "dsh:sess-1");
    // Second turn on the same session resumes the stored thread.
    await collect(adapter.stream(options));
    log = readLog(logPath);
    const resume = log.filter((r) => r.type === "request" && r.method === "thread/resume").at(-1);
    assert.equal(resume.params.threadId, "t-mock-1");
    assert.equal("modelProvider" in resume.params, false);
    const spawn = log.find((r) => r.type === "spawn");
    // Loopback gateway (no token): no env_key override, no token env var.
    assert.deepEqual(spawn.argv, [
      "-c",
      'model_provider="dsh-codex-relay"',
      "-c",
      'model_providers.dsh-codex-relay.name="DSH Codex Relay"',
      "-c",
      'model_providers.dsh-codex-relay.base_url="http://127.0.0.1:3080/v1"',
      "-c",
      'model_providers.dsh-codex-relay.wire_api="responses"',
      "-c",
      'model_providers.dsh-codex-relay.capabilities.remote_compaction="unsupported"',
      "app-server",
      "--listen",
      `unix://${sock}`,
    ]);
    assert.equal("DSH_HARNESS_RELAY_TOKEN" in spawn.env, false);
  });

  it("image blocks cross into turn/start as inline data URLs; empty images fail the turn", async () => {
    const sock = path.join(tmp, "t-image.sock");
    const logPath = path.join(tmp, "t-image.jsonl");
    process.env.MOCK_LOG = logPath;
    const adapter = makeAdapter({ socketPath: sock, gateway: fakeGateway(), llm: fakeLlm });
    const chunks = await collect(adapter.stream({
      sessionId: "sess-image",
      model: "deepseek-official/deepseek-chat",
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
      ] }],
      tools: [],
    }));
    assert.equal(chunks.find((c) => c.type === "text-delta")?.text, "Hello from mock");
    const turnStart = readLog(logPath).find((r) => r.type === "request" && r.method === "turn/start");
    assert.deepEqual(turnStart.params.input, [
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "data:image/jpeg;base64,aGVsbG8=" },
    ]);

    // An image block carrying neither data nor url cannot be represented —
    // failing the turn beats silently answering without the image.
    await assert.rejects(
      () => collect(adapter.stream({
        sessionId: "sess-image-bad",
        model: "deepseek-official/deepseek-chat",
        messages: [{ role: "user", content: [{ type: "image" }] }],
        tools: [],
      })),
      /image block without data or url/,
    );
  });

  it("tool-call left open by a missing item/completed closes with its wire shape", async () => {
    const sock = path.join(tmp, "t-unfinished-tool.sock");
    const logPath = path.join(tmp, "t-unfinished-tool.jsonl");
    process.env.MOCK_LOG = logPath;
    process.env.MOCK_SCENARIO = "unfinished-command";
    const adapter = makeAdapter({ socketPath: sock, gateway: fakeGateway(), llm: fakeLlm });
    let chunks;
    try {
      chunks = await collect(adapter.stream({
        sessionId: "sess-unfinished-tool",
        model: "deepseek-official/deepseek-chat",
        messages: [{ role: "user", content: [{ type: "text", text: "run it" }] }],
        tools: [],
      }));
    } finally {
      delete process.env.MOCK_SCENARIO;
    }

    const blockEnd = chunks.find((chunk) => chunk.type === "block-end");
    assert.deepEqual(Object.keys(blockEnd.block).sort(), ["arguments", "id", "name", "type"]);
    assert.equal(blockEnd.block.type, "tool-call");
    assert.equal(blockEnd.block.id, "c1");
    assert.equal(blockEnd.block.name, "bash");
    assert.equal(typeof blockEnd.block.arguments, "string");
  });

  it("spawn key includes gateway baseUrl and token: either change respawns the listener", async () => {
    const sock = path.join(tmp, "t-respawn.sock");
    const logPath = path.join(tmp, "t-respawn.jsonl");
    process.env.MOCK_LOG = logPath;
    const gateway = fakeGateway({ token: "tok-1" });
    const adapter = makeAdapter({ socketPath: sock, gateway, llm: fakeLlm });
    await adapter.server.ensure();
    // Token-only rotation (gateway re-activation) must respawn too: the old
    // listener env carries a frozen stale token.
    gateway.localEndpoint = () => ({ baseUrl: "http://127.0.0.1:3080/v1", token: "tok-2" });
    adapter.server.destroy();
    await adapter.server.ensure();
    // Port change on top.
    gateway.localEndpoint = () => ({ baseUrl: "http://127.0.0.1:3999/v1", token: "tok-2" });
    adapter.server.destroy();
    const result = await adapter.server.ensure();
    assert.equal(result.userAgent, "mock-codex/0.0.1");
    const spawns = readLog(logPath).filter((r) => r.type === "spawn");
    assert.equal(spawns.length, 3);
    // The -c overrides carry the relay settings; a baseUrl change respawns
    // with the new value, a token-only change keeps the same argv shape and
    // refreshes the token env value.
    assert.deepEqual(spawns[0].argv[5], 'model_providers.dsh-codex-relay.base_url="http://127.0.0.1:3080/v1"');
    assert.deepEqual(spawns[1].argv[5], 'model_providers.dsh-codex-relay.base_url="http://127.0.0.1:3080/v1"');
    assert.deepEqual(spawns[2].argv[5], 'model_providers.dsh-codex-relay.base_url="http://127.0.0.1:3999/v1"');
    assert.equal(spawns[0].env.DSH_HARNESS_RELAY_TOKEN, "tok-1");
    assert.equal(spawns[1].env.DSH_HARNESS_RELAY_TOKEN, "tok-2");
  });

  it("codexHome config feeds CODEX_HOME, derives the socket, and respawns on change", async () => {
    const homeA = path.join(tmp, "cx-home-a");
    const homeB = path.join(tmp, "cx-home-b");
    const logPath = path.join(tmp, "t-codex-home.jsonl");
    process.env.MOCK_LOG = logPath;
    const adapter = makeAdapter({
      codexHome: homeA,
      gateway: fakeGateway(),
      llm: fakeLlm,
    });
    await adapter.server.ensure();
    let spawns = readLog(logPath).filter((r) => r.type === "spawn");
    assert.equal(spawns.length, 1);
    // CODEX_HOME reaches the spawned codex itself; the control socket
    // derives from the configured home (the adapter pre-creates the dir).
    assert.equal(spawns[0].env.CODEX_HOME, homeA);
    assert.equal(
      spawns[0].argv.at(-1),
      `unix://${path.join(homeA, "app-server-control", "mock-codex.sock")}`,
    );
    // Changing codexHome respawns with the new env and derived socket.
    adapter.server.codexHome = homeB;
    adapter.server.destroy();
    await adapter.server.ensure();
    spawns = readLog(logPath).filter((r) => r.type === "spawn");
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].env.CODEX_HOME, homeB);
    assert.equal(
      spawns[1].argv.at(-1),
      `unix://${path.join(homeB, "app-server-control", "mock-codex.sock")}`,
    );
  });

  it("harness registration: the identity lands on the llmBase service (selection/dispatch live there)", () => {
    const harnesses = new Map();
    let adapter;
    const ctx = {
      fiber: { id: "fiber" },
      logger: { info() {}, warn() {} },
      sessions: { get: () => null },
      tools: { execute: async () => ({}) },
      effect(factory) { return factory(); },
      llmBase: fakeGateway({ harnesses }),
      llm: {
        registerAdapter(_providers, registered) { adapter = registered; },
        registerConfigurableProviders() {},
        registerModelDiscovery() {},
      },
      on() {},
    };
    apply(ctx, Config({ command: "mock-codex" }));
    assert.deepEqual([...harnesses.keys()], ["codex"]);
    assert.equal(harnesses.get("codex").displayName, "Codex");
    assert.ok(harnesses.get("codex").icon.startsWith("<svg") && harnesses.get("codex").icon.includes("currentColor"), "codex icon is the inline OpenAI blossom mark");
    assert.equal(typeof harnesses.get("codex").prompt, "string");
    void adapter;
  });

  it("harness-switch turn points codex at the dsh rollout; fresh and resumed turns do not", async () => {
    const sock = path.join(tmp, "t-rollout-pointer.sock");
    const logPath = path.join(tmp, "t-rollout-pointer.jsonl");
    process.env.MOCK_LOG = logPath;
    const rolloutPath = path.join(tmp, "session-logs", "proj", "sess-switch", "session.v4.jsonl.zstd");
    const asked = [];
    const adapter = makeAdapter({
      socketPath: sock,
      gateway: fakeGateway(),
      llm: fakeLlm,
      sessionRollout: async (sessionId) => {
        asked.push(sessionId);
        return sessionId === "sess-switch" ? rolloutPath : null;
      },
    });
    const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
    const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

    // Turn 1 — the switch itself: fresh codex thread for a session whose
    // history came from another harness. The pointer rides ahead of the
    // user's message as the first turn/start input item.
    const switchMessages = [user("first question"), assistant("prior harness answer"), user("now what?")];
    await collect(adapter.stream({ sessionId: "sess-switch", model: "deepseek-official/deepseek-chat", messages: switchMessages, tools: [] }));
    let log = readLog(logPath);
    const switchStart = log.find((r) => r.type === "request" && r.method === "turn/start");
    assert.equal(switchStart.params.input.length, 2);
    assert.match(switchStart.params.input[0].text, /^\[dsh\] The turns of this conversation/);
    assert.ok(switchStart.params.input[0].text.includes(rolloutPath));
    assert.equal(switchStart.params.input[1].text, "now what?");

    // Turn 2 — thread/resume restored codex's own context: no pointer.
    await collect(adapter.stream({
      sessionId: "sess-switch",
      model: "deepseek-official/deepseek-chat",
      messages: [...switchMessages, assistant("Hello from mock"), user("again")],
      tools: [],
    }));
    log = readLog(logPath);
    const resumeIdx = log.findIndex((r) => r.type === "request" && r.method === "thread/resume");
    assert.ok(resumeIdx >= 0, "second turn resumes the stored thread");
    const resumedStart = log.slice(resumeIdx).find((r) => r.type === "request" && r.method === "turn/start");
    assert.equal(resumedStart.params.input.some((item) => item.text?.startsWith("[dsh]")), false);

    // Brand-new conversation on the same adapter: nothing to point at.
    await collect(adapter.stream({ sessionId: "sess-fresh", model: "deepseek-official/deepseek-chat", messages: [user("hello")] }));
    log = readLog(logPath);
    const freshStarts = log.filter((r) => r.type === "request" && r.method === "turn/start");
    assert.equal(freshStarts.at(-1).params.input.some((item) => item.text?.startsWith("[dsh]")), false);
    assert.deepEqual(asked, ["sess-switch"]);
  });

  it("interrupted codex turn does not wedge the session: the next message starts a fresh codex turn", async () => {
    // Production wedge (2026-10-28): the user aborted a codex turn mid-exec;
    // the codex turn reported interrupted, but the adapter's split-turn state
    // never reached a terminal finish. The NEXT message in the same session
    // drained an empty segment forever — zero output until manual abort.
    const sock = path.join(tmp, "t-interrupt-wedge.sock");
    const logPath = path.join(tmp, "t-interrupt-wedge.jsonl");
    process.env.MOCK_LOG = logPath;
    process.env.MOCK_SCENARIO = "interrupt-mid-turn";
    const adapter = makeAdapter({ socketPath: sock, gateway: fakeGateway(), llm: fakeLlm });
    try {
      const options = (signal) => ({
        sessionId: "sess-wedge",
        model: "deepseek-official/deepseek-chat",
        messages: [{ role: "user", content: [{ type: "text", text: "测试切换" }] }],
        tools: [],
        signal,
      });

      // dsh turn 1: consume the first tool segment (finish #1), then continue
      // into the long in-flight command and abort mid-stream, exactly like
      // the agent loop unwinds the generator when the phase signal dies.
      const firstFinish = await (async () => {
        for await (const chunk of adapter.stream(options())) {
          if (chunk.type === "finish") return chunk;
        }
      })();
      assert.equal(firstFinish.reason.kind, "stop");

      const abort = new AbortController();
      const continuation = adapter.stream(options(abort.signal));
      const iterator = continuation[Symbol.asyncIterator]();
      await iterator.next(); // the in-flight command's block-start
      abort.abort();
      await iterator.return().catch(() => {});

      // dsh turn 2 (fresh phase signal): must terminate promptly with a real
      // answer from a fresh codex turn — never hang, never replay the dead
      // turn's buffered abort finish.
      const turn2 = await Promise.race([
        (async () => {
          const chunks = [];
          for await (const chunk of adapter.stream(options())) chunks.push(chunk);
          return chunks;
        })(),
        new Promise((resolve) => setTimeout(() => resolve("HUNG"), 5000)),
      ]);
      assert.notEqual(turn2, "HUNG", "next message after an interrupted codex turn must not hang");
      const deltas = turn2.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
      assert.equal(deltas, "recovered");
      assert.equal(turn2.at(-1).reason.kind, "stop");

      // The recovery used a fresh codex turn on the same thread.
      const log = readLog(logPath);
      const starts = log.filter((r) => r.type === "request" && r.method === "turn/start");
      assert.ok(starts.length >= 2, "recovery starts a fresh codex turn");
      const interrupts = log.filter((r) => r.type === "request" && r.method === "turn/interrupt");
      assert.ok(interrupts.length >= 1, "stale codex turn is interrupted on retirement");
    } finally {
      delete process.env.MOCK_SCENARIO;
    }
  });
});

after(() => {
  for (const adapter of adapters) adapter.server.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});
