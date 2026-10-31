// dsh-harness-base 离线冒烟测试：mock cordis ctx（llm/settings/credentials）+
// 真实 @deepseek-ai/* 包 + 真实 node http 上下游，驱动 apply、targets()/resolve()
// 契约与 /v1 relay 透传语义。
import { mkdirSync, symlinkSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const PKG_SRC = process.env.DSH_PKGS ?? `${homedir()}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const DSH_NM = `${homedir()}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`;

// 在测试目录搭 node_modules/@deepseek-ai 符号链接，让插件的裸导入可解析。
// dsh-session 必须链接运行中 dsh 的那份拷贝（生产用 file: link 同语义）。
const TMP = mkdtempSync(`${tmpdir()}/dsh-harness-base-test-`);
mkdirSync(`${TMP}/node_modules/@deepseek-ai`, { recursive: true });
for (const pkg of ["cordis", "cosmokit", "schemastery", "dsh-llm", "dsh-credentials", "dsh-brand", "dsh-host-webserver", "dsh-session"]) {
  const link = `${TMP}/node_modules/@deepseek-ai/${pkg}`;
  if (!existsSync(link)) symlinkSync(`${PKG_SRC}/${pkg}`, link);
}
if (!existsSync(`${TMP}/node_modules/zod`)) symlinkSync(`${DSH_NM}/zod`, `${TMP}/node_modules/zod`);
// 插件从自身路径解析裸导入 → 需要在插件目录临时放 node_modules；测试后删除。
const pluginNm = fileURLToPath(new URL("../node_modules", import.meta.url));
const cleanup = () => { try { rmSync(pluginNm, { recursive: true, force: true }); } catch {} };
try { rmSync(pluginNm, { recursive: true, force: true }); } catch {}
symlinkSync(`${TMP}/node_modules`, pluginNm);
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const { name, inject, Config, apply, LlmBase } = await import(pathToFileURL(PLUGIN).href);

let failures = 0;
function check(ok, label, detail = "") {
  if (ok) console.log(`  ok  ${label}`);
  else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// ── mock 设施 ────────────────────────────────────────────────────────────────

// llm 注册表：providers → models（静态目录），resolveModelInfo 回 reasoning。
function makeLlm(spec, failProvider) {
  return {
    listProviders: () => Object.keys(spec).map((id) => ({ id, name: id })),
    listModels: async (provider) => {
      if (provider === failProvider) throw new Error(`provider "${provider}" is down`);
      return (spec[provider] ?? []).map((model) => ({ provider, id: model.id, name: model.name }));
    },
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      ...(model.includes("think") ? { reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" } } : {}),
    }),
  };
}

function makeCtx({ llmSpec = {}, failProvider, services = {}, host = "127.0.0.1" } = {}) {
  const state = { effects: [], listeners: {}, services: {}, logs: { info: [], warn: [] }, settingsRows: [] };
  const ctx = {
    fiber: { id: "test-fiber" },
    logger: { info: (m) => state.logs.info.push(m), warn: (m) => state.logs.warn.push(m) },
    on: (event, handler) => { (state.listeners[event] ??= []).push(handler); return () => {}; },
    effect: (execute, label) => { state.effects.push({ label, disposer: execute() }); },
    reflect: { provide: (serviceName, instance) => { state.services[serviceName] = instance; } },
    get: (serviceName) => state.services[serviceName],
    webServer: {
      host,
      registered: [],
      register(route) { ctx.webServer.registered.push(route); return () => {}; },
      getOrigin: () => `http://${host}:3080`,
    },
    credentials: { resolve: async (ref) => ({ value: `key-for-${String(ref)}` }) },
    systemPrompt: { sections: [], section(spec) { ctx.systemPrompt.sections.push(spec); return () => {}; } },
    llm: makeLlm(llmSpec, failProvider),
  };
  if (state.services.settings === undefined) {
    state.services.settings = {
      describe: () => state.settingsRows,
      mutate: async (ns, ops) => {
        let row = state.settingsRows.find((r) => r.ns === ns);
        if (!row) { row = { ns, value: {} }; state.settingsRows.push(row); }
        for (const op of ops) {
          if (op.op !== "set") continue;
          let cursor = row.value;
          for (const key of op.path.slice(0, -1)) cursor = cursor[key] ??= {};
          cursor[op.path.at(-1)] = op.value;
        }
      },
    };
  }
  if (state.services.sessions === undefined) {
    // Real Session objects (host's dsh-session copy), so the plugin's
    // appendPluginRecord calls run the real private append path.
    const store = new Map();
    state.sessionsStore = store;
    state.services.sessions = { get: (id) => store.get(id) };
  }
  if (state.services.sessionProjections === undefined) {
    // Mini registry: lazily folds the registered definitions over each live
    // session's real log — the same read shape as sessionProjections.stateOf.
    const defs = new Map();
    state.services.sessionProjections = {
      register(definition) { defs.set(definition.key, definition); return () => defs.delete(definition.key); },
      stateOf(session, key) {
        const def = defs.get(key);
        if (def === undefined) return undefined;
        const cells = (state.projectionCells ??= new WeakMap());
        let perSession = cells.get(session);
        if (perSession === undefined) { perSession = {}; cells.set(session, perSession); }
        let cell = perSession[key];
        if (cell === undefined) { cell = { state: def.init(session.header, 0), seq: -1 }; perSession[key] = cell; }
        for (const event of session.snapshotEvents()) {
          if (event.seq <= cell.seq) continue;
          cell.state = def.apply(cell.state, event);
          cell.seq = event.seq;
        }
        return cell.state;
      },
    };
  }
  if (state.services.sessionPersistence === undefined) {
    // In-memory jsonl-shaped backend: only what the migration uses
    // (open("write") lease, read, append, flush, close).
    const stored = (state.storedSessions ??= new Map());
    const owners = new Set();
    state.services.sessionPersistence = {
      async open(id, access) {
        if (access !== "write") throw new Error("read handles unused in tests");
        if (owners.has(id)) throw Object.assign(new Error(`session "${id}" already owned`), { name: "SessionAlreadyOwnedError" });
        if (!stored.has(id)) throw Object.assign(new Error(`session "${id}" not found`), { name: "SessionPersistenceNotFoundError" });
        owners.add(id);
        const log = stored.get(id);
        return {
          id,
          access,
          async read() { return { eventState: "shared", events: [...log] }; },
          async append(events) {
            for (const event of events) {
              if (event.seq !== log.length) throw new Error(`non-contiguous seq ${event.seq} over ${log.length}`);
              log.push(structuredClone(event));
            }
          },
          async flush() {},
          async close() { owners.delete(id); },
        };
      },
    };
  }
  for (const [serviceName, instance] of Object.entries(services)) state.services[serviceName] = instance;
  // Real cordis ctx exposes services as direct properties too (the base reads
  // ctx.settings inside the service, ctx.get("settings") in apply).
  ctx.settings = state.services.settings;
  ctx.sessions = state.services.sessions;
  ctx.sessionProjections = state.services.sessionProjections;
  ctx.sessionPersistence = state.services.sessionPersistence;
  state.ctx = ctx;
  return state;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

// ── 1. 模块形状 ──────────────────────────────────────────────────────────────

console.log("1. module shape");
check(name === "harness-base", "name");
check(Array.isArray(inject) && ["webServer", "llm", "credentials", "settings", "sessions", "sessionProjections", "sessionPersistence"].every((s) => inject.includes(s)), "inject", JSON.stringify(inject));
check(Config != null, "Config schema present");
check(typeof apply === "function", "apply exported");

// ── 2. targets()：路由表 ∩ 注册表，失败隔离，非 passthrough 路由排除 ────────

console.log("2. targets() mirror");
const upstreamFixture = await listen(async (req, res) => { res.writeHead(200); res.end("{}"); });
const upstreamBase = `http://127.0.0.1:${upstreamFixture.port}`;
const state2 = makeCtx({
  llmSpec: {
    "pipo-devllm": [{ id: "GLM-5.3-Flash", name: "GLM-5.3-Flash" }],
    "ark": [{ id: "deepseek-v4-1-flash-261017", name: "DeepSeek V4.1 Flash (Ark)" }, { id: "deepseek-v4-think", name: "Think" }],
    "codex": [{ id: "pipo-devllm/GLM-5.3-Flash", name: "mirrored" }],
    "deepseek-official": [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    "deepseek-account": [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    "badroute": [{ id: "m", name: "m" }],
  },
  failProvider: "badroute",
  services: {
    settings: {
      describe: () => [
        { ns: "llm-pi-ai", value: { providers: {
          "pipo-devllm": { api: "openai-completions", baseURL: `${upstreamBase}/v1`, apiKeyEnv: "PIPO_KEY", models: [{ id: "GLM-5.3-Flash", name: "GLM-5.3-Flash" }] },
          "ark": { api: "openai-responses", baseURL: `${upstreamBase}/v3`, headers: { Authorization: "Bearer ark-inline" }, models: [{ id: "deepseek-v4-1-flash-261017", name: "Ark" }, { id: "deepseek-v4-think", name: "Think" }] },
          "badroute": { api: "openai-responses", baseURL: `${upstreamBase}/v1`, models: [{ id: "m", name: "m" }] },
        } } },
        { ns: "llm-deepseek-api-key", value: { baseURL: `${upstreamBase}/anthropic`, apiKeyEnv: "DEEPSEEK_API_KEY" } },
        { ns: "llm-deepseek-account", value: { baseURL: `${upstreamBase}/anthropic-account` } },
      ],
    },
  },
});
apply(state2.ctx, Config({}));
const base = state2.services.llmBase;
const targets = await base.targets();
const targetIds = targets.map((t) => t.id).sort();
check(targetIds.includes("pipo-devllm/GLM-5.3-Flash"), "pi-ai profile mirrored with qualified id", JSON.stringify(targetIds));
check(targetIds.includes("ark/deepseek-v4-1-flash-261017") && targetIds.includes("ark/deepseek-v4-think"), "ark models mirrored");
check(targets.find((t) => t.id === "ark/deepseek-v4-think")?.reasoning?.defaultEffort === "high", "reasoning metadata passthrough");
check(targetIds.includes("deepseek-official/deepseek-chat"), "deepseek built-in route mirrored");
check(!targetIds.some((id) => id.startsWith("codex/")), "non-passthrough adapter route (codex mirror) excluded", JSON.stringify(targetIds));
check(!targetIds.some((id) => id.startsWith("badroute/")), "failed provider group skipped");
check(state2.logs.warn.some((line) => line.includes("badroute")), "provider failure logged");
check(state2.ctx.webServer.registered.length === 1 && state2.ctx.webServer.registered[0].path === "/v1", "route registered");

// ── 3. resolve()：编解码 + 路由表 + 明确报错 ────────────────────────────────

console.log("3. resolve()");
const arkTarget = await base.resolve("ark/deepseek-v4-1-flash-261017");
check(arkTarget.provider === "ark" && arkTarget.model === "deepseek-v4-1-flash-261017" && arkTarget.api === "openai-responses" && arkTarget.baseURL === `${upstreamBase}/v3`, "qualified id decodes to route facts", JSON.stringify(arkTarget));
check(arkTarget.headers?.Authorization === "Bearer ark-inline" && arkTarget.credentialRef === undefined, "inline headers carried, no credentialRef");
const pipoTarget = await base.resolve("pipo-devllm/GLM-5.3-Flash");
check(pipoTarget.api === "openai-completions" && pipoTarget.credentialRef === "PIPO_KEY" && pipoTarget.auth === "credential", "completions target reported as-is");
const officialTarget = await base.resolve("deepseek-official/deepseek-chat");
check(officialTarget.api === "anthropic-messages" && officialTarget.auth === "x-api-key" && officialTarget.credentialRef === "DEEPSEEK_API_KEY" && officialTarget.baseURL === `${upstreamBase}/anthropic`, "deepseek-official built-in route", JSON.stringify(officialTarget));
const accountTarget = await base.resolve("deepseek-account/deepseek-chat");
check(accountTarget.auth === "account-token" && accountTarget.credentialRef === undefined && accountTarget.baseURL === `${upstreamBase}/anthropic-account`, "deepseek-account built-in route");
let err = null;
try { await base.resolve("nosuch/model"); } catch (error) { err = error; }
check(err?.message.includes('unknown provider prefix "nosuch"'), "unknown prefix error", String(err));
err = null;
try { await base.resolve("ark/no-such-model"); } catch (error) { err = error; }
check(err?.message.includes('serves no model "no-such-model"'), "unknown model error", String(err));
err = null;
try { await base.resolve("bare-model"); } catch (error) { err = error; }
check(err !== null && err.message.includes("qualified"), "prefix-less id rejected");
check(targetIds.length === 5, "mirror lists exactly the servable models", JSON.stringify(targetIds));
check(base.localEndpoint().baseUrl === "http://127.0.0.1:3080/v1" && base.localEndpoint().token === undefined, "loopback localEndpoint: origin-derived baseUrl, no token", JSON.stringify(base.localEndpoint()));

// ── 4. relay：qualified model 改写 + auth 形态 + SSE/错误透传 ───────────────

console.log("4. relay");
const upstreamHits = [];
let gateWait = null;
let gateRelease = null;
function armGate() {
  gateWait = new Promise((r) => { gateRelease = r; });
}
const upstream = await listen(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const hit = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), aborted: false };
  res.on("close", () => { hit.aborted = true; });
  upstreamHits.push(hit);
  const parsed = JSON.parse(hit.body || "{}");
  if (typeof parsed.input === "string" && (parsed.input.includes("stream") || parsed.input.includes("abort"))) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: first\n\n");
    await gateWait;
    if (!hit.aborted) {
      res.write("event: second\n\n");
      res.end();
    }
    return;
  }
  if (parsed.input === "nope") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream says no" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
const relayUpstreamBase = `http://127.0.0.1:${upstream.port}`;
const relayState = makeCtx({
  llmSpec: {
    "ark": [{ id: "deepseek-v4-1-flash-261017", name: "Ark" }],
    "pipo-devllm": [{ id: "GLM-5.3-Flash", name: "GLM" }],
    "deepseek-official": [{ id: "deepseek-chat", name: "Chat" }],
    "deepseek-account": [{ id: "deepseek-chat", name: "Chat" }],
  },
  services: {
    settings: {
      describe: () => [
        { ns: "llm-pi-ai", value: { providers: {
          "ark": { api: "openai-responses", baseURL: `${relayUpstreamBase}/v3`, headers: { Authorization: "Bearer ark-inline" }, models: [{ id: "deepseek-v4-1-flash-261017", name: "Ark" }] },
          "pipo-devllm": { api: "openai-completions", baseURL: `${relayUpstreamBase}/v1`, apiKeyEnv: "PIPO_KEY", models: [{ id: "GLM-5.3-Flash", name: "GLM" }] },
        } } },
        { ns: "llm-deepseek-api-key", value: { baseURL: `${relayUpstreamBase}/anthropic`, apiKeyEnv: "DEEPSEEK_API_KEY" } },
        { ns: "llm-deepseek-account", value: { baseURL: `${relayUpstreamBase}/anthropic-account` } },
      ],
    },
    deepseekAccount: { resolveToken: async () => "account-token-123" },
  },
});
apply(relayState.ctx, Config({}));
const handler = relayState.ctx.webServer.registered[0].handler;
const relayServer = await listen(handler);
const relayUrl = `http://127.0.0.1:${relayServer.port}`;

// 4a. openai-responses 目标：inline header 胜出，model 去前缀，其余 body 原样
const inline = await fetch(`${relayUrl}/v1/responses?trace=1`, {
  method: "POST",
  headers: { "content-type": "application/json", "authorization": "Bearer inbound-secret", "originator": "codex_cli_rs" },
  body: JSON.stringify({ model: "ark/deepseek-v4-1-flash-261017", input: "hi", stream: true }),
});
check(inline.status === 200, "relay 200", String(inline.status));
await new Promise((r) => setTimeout(r, 50));
const hit = upstreamHits[0];
check(hit.url === "/v3/responses?trace=1", "path + query suffix preserved", hit.url);
check(hit.headers.authorization === "Bearer ark-inline", "profile inline header wins over inbound auth", hit.headers.authorization);
check(hit.headers.originator === "codex_cli_rs", "originator preserved");
check(JSON.parse(hit.body).model === "deepseek-v4-1-flash-261017", "model prefix stripped downstream", hit.body);
check(JSON.parse(hit.body).input === "hi" && JSON.parse(hit.body).stream === true, "rest of body untouched");
check(relayState.logs.info.some((line) => line.includes("model=ark/deepseek-v4-1-flash-261017") && line.includes("-> 200")), "per-request log line", JSON.stringify(relayState.logs.info));

// 4b. openai-completions 目标：credentials 服务解析 → Bearer
const bearer = await fetch(`${relayUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "pipo-devllm/GLM-5.3-Flash", messages: [] }),
});
check(bearer.status === 200, "completions relay 200");
await new Promise((r) => setTimeout(r, 50));
check(upstreamHits.at(-1).headers.authorization === "Bearer key-for-PIPO_KEY", "credential ref resolved to Bearer", upstreamHits.at(-1).headers.authorization);
check(JSON.parse(upstreamHits.at(-1).body).model === "GLM-5.3-Flash", "model unprefixed for completions target");

// 4c. anthropic-messages 目标：x-api-key（official）/ x-dsh-auth-token（account）
await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-official/deepseek-chat", input: "x" }) });
await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-account/deepseek-chat", input: "x" }) });
await new Promise((r) => setTimeout(r, 50));
const officialHit = upstreamHits.at(-2);
const accountHit = upstreamHits.at(-1);
check(officialHit.headers["x-api-key"] === "key-for-DEEPSEEK_API_KEY" && officialHit.headers.authorization === undefined, "anthropic target uses x-api-key", JSON.stringify(officialHit.headers));
check(accountHit.headers["x-dsh-auth-token"] === "account-token-123", "account target uses live account token", accountHit.headers["x-dsh-auth-token"]);

// 4c'. Anthropic wire paths (Claude Code CLI): /v1/messages 与 count_tokens 同样透传
await fetch(`${relayUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-official/deepseek-chat", max_tokens: 8, messages: [] }) });
await fetch(`${relayUrl}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-official/deepseek-chat", messages: [] }) });
await new Promise((r) => setTimeout(r, 50));
check(upstreamHits.at(-2).url === "/anthropic/messages" && JSON.parse(upstreamHits.at(-2).body).model === "deepseek-chat", "anthropic wire /v1/messages relays to the anthropic route", upstreamHits.at(-2).url);
check(upstreamHits.at(-1).url === "/anthropic/messages/count_tokens", "count_tokens suffix preserved", upstreamHits.at(-1).url);

// 4d. SSE 透传 + 客户端断连掐上游
armGate();
const sseRes = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ark/deepseek-v4-1-flash-261017", input: "stream me" }) });
check(sseRes.headers.get("content-type") === "text/event-stream", "SSE headers passthrough");
const reader = sseRes.body.getReader();
check(new TextDecoder().decode((await reader.read()).value) === "event: first\n\n", "first SSE frame relayed");
gateRelease();
check(new TextDecoder().decode((await reader.read()).value) === "event: second\n\n", "second SSE frame relayed");
await reader.cancel().catch(() => {});
armGate();
const abortController = new AbortController();
const abortRes = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ark/deepseek-v4-1-flash-261017", input: "abort me" }), signal: abortController.signal });
const abortedReader = abortRes.body.getReader();
await abortedReader.read();
abortController.abort();
await new Promise((r) => setTimeout(r, 100));
check(upstreamHits.at(-1).aborted === true, "client disconnect aborts upstream");
gateRelease();

// 4e. 上游非 200 原样回传
const unauthorized = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ark/deepseek-v4-1-flash-261017", input: "nope" }) });
check(unauthorized.status === 401 && (await unauthorized.text()).includes("upstream says no"), "upstream status + error body passthrough");

// ── 5. 请求校验 ──────────────────────────────────────────────────────────────

console.log("5. request validation");
const badJson = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
check(badJson.status === 400, "non-JSON body 400");
const noModel = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "x" }) });
check(noModel.status === 400 && (await noModel.text()).includes("body.model"), "missing model 400");
const bareModel = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "GLM-5.3-Flash", input: "x" }) });
check(bareModel.status === 400 && (await bareModel.json()).error.message.includes("carries no"), "prefix-less model 400", String(bareModel.status));
const unknownModel = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ark/not-in-catalog", input: "x" }) });
check(unknownModel.status === 502 && (await unknownModel.json()).error.message.includes("serves no model"), "unknown model readable 502");
const wrongMethod = await fetch(`${relayUrl}/v1/responses`, { method: "GET" });
check(wrongMethod.status === 405, "GET 405");
const unknownPath = await fetch(`${relayUrl}/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(unknownPath.status === 404, "unknown /v1 path 404");

// ── 6. settings 热更新：下一跳即生效 ─────────────────────────────────────────

console.log("6. live route table");
relayState.services.settings.describe = () => [
  { ns: "llm-pi-ai", value: { providers: {
    "ark": { api: "openai-responses", baseURL: `${relayUpstreamBase}/v9`, models: [{ id: "renamed-model", name: "Renamed" }] },
  } } },
];
let retargetError = null;
try { await relayState.services.llmBase.resolve("ark/deepseek-v4-1-flash-261017"); } catch (error) { retargetError = error; }
check(retargetError?.message.includes('serves no model "deepseek-v4-1-flash-261017"'), "old model gone after settings change", String(retargetError));
const newTarget = await relayState.services.llmBase.resolve("ark/renamed-model");
check(newTarget.baseURL === `${relayUpstreamBase}/v9`, "new route visible without reload", JSON.stringify(newTarget));
const retargeted = await fetch(`${relayUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ark/renamed-model", input: "x" }) });
check(retargeted.status === 200, "relay after retarget succeeds");
await new Promise((r) => setTimeout(r, 50));
check(upstreamHits.at(-1).url.startsWith("/v9/") || upstreamHits.at(-1).url === "/v9/responses", "request hit the new baseURL", upstreamHits.at(-1).url);

// ── 7. 空路由表：可读报错 ────────────────────────────────────────────────────

console.log("7. empty route table");
const bareState = makeCtx({ services: { settings: { describe: () => [] } } });
apply(bareState.ctx, Config({}));
const bareServer = await listen(bareState.ctx.webServer.registered[0].handler);
const bareRes = await fetch(`http://127.0.0.1:${bareServer.port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "anything/model", input: "x" }) });
check(bareRes.status === 502 && (await bareRes.json()).error.message.includes("unknown provider prefix"), "empty route table yields readable 502");

// ── 8. 非 loopback 绑定：token 强制 + 连接闸门回落 ──────────────────────────

console.log("8. remote bind auth");
const remoteHits = [];
const remoteUpstream = await listen(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  remoteHits.push(Buffer.concat(chunks).toString("utf8"));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
const remoteBase = `http://127.0.0.1:${remoteUpstream.port}`;
// 浏览器会话闸门 mock：带 cookie 视为已认证，否则 401（同 requestRejection 语义）。
const connection = { requestRejection: (req) => (req.headers.cookie === undefined ? 401 : undefined) };
const remoteState = makeCtx({
  host: "192.0.2.7",
  llmSpec: { "ark": [{ id: "m", name: "Ark" }] },
  services: {
    settings: { describe: () => [{ ns: "llm-pi-ai", value: { providers: { "ark": { api: "openai-responses", baseURL: `${remoteBase}/v1`, models: [{ id: "m", name: "Ark" }] } } } }] },
    connection,
  },
});
apply(remoteState.ctx, Config({}));
const remoteEndpoint = remoteState.services.llmBase.localEndpoint();
check(typeof remoteEndpoint.token === "string" && remoteEndpoint.token.length > 20, "remote localEndpoint carries generated token", JSON.stringify({ ...remoteEndpoint, token: `<${remoteEndpoint.token?.length} chars>` }));
check(remoteEndpoint.baseUrl === "http://192.0.2.7:3080/v1", "remote baseUrl from bind host");
const remoteServer = await listen(remoteState.ctx.webServer.registered[0].handler);
const remoteUrl = `http://127.0.0.1:${remoteServer.port}`;
const post = (headers) => fetch(`${remoteUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "ark/m", input: "x" }) });
check((await post({})).status === 401, "remote no-token 401");
check((await post({ authorization: "Bearer wrong" })).status === 401, "remote wrong token 401");
check((await post({ authorization: `Bearer ${remoteEndpoint.token}` })).status === 200, "remote Bearer token 200");
check((await post({ "x-api-key": remoteEndpoint.token })).status === 200, "remote x-api-key token 200");
check(remoteHits.length === 2, "only token-authenticated requests relayed", String(remoteHits.length));
// 浏览器会话（cookie）作为替代凭据经闸门放行
const session = await fetch(`${remoteUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "cookie": "session=1", "host": "192.0.2.7:3080" }, body: JSON.stringify({ model: "ark/m", input: "x" }) });
check(session.status === 200, "remote browser session passes the gate", String(session.status));
// 闸门本身拒绝（无 token 无会话）时取闸门的 401/403
const fenced = await fetch(`${remoteUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "host": "evil.example:3080" }, body: JSON.stringify({ model: "ark/m", input: "x" }) });
check(fenced.status === 401, "gate rejection status forwarded", String(fenced.status));
check(remoteState.logs.info.some((line) => line.includes("rejected 401")), "rejection logged without body/credential", JSON.stringify(remoteState.logs.info.filter((l) => l.includes("rejected"))));

await Promise.all([upstream.close(), upstreamFixture.close(), relayServer.close(), bareServer.close(), remoteUpstream.close(), remoteServer.close()]);
// ── 9. harness slot：注册 → 镜像 → 统一 reroute → prompt section ─────────────

console.log("9. harness slot");
const harnessState = makeCtx({
  llmSpec: {
    "ark": [{ id: "m", name: "Ark" }],
    "codex": [{ id: "x", name: "X" }],
    "claude": [{ id: "c", name: "C" }],
  },
});
apply(harnessState.ctx, Config({}));
const sections = harnessState.ctx.systemPrompt.sections;
check(sections.length === 1 && sections[0].name === "harness-base:harness", "prompt section registered");
const routeListener = harnessState.listeners["llm/stream"][0];
check(typeof routeListener === "function", "llm/stream route registered");

const svc = harnessState.services.llmBase; // the instance apply() created (via reflect.provide)
const svgMark = "<svg viewBox='0 0 8 8'><path d='M1 1h6v6H1z' fill='currentColor'/></svg>";
const disposer = svc.registerHarness({ id: "codex", displayName: "Codex", icon: svgMark, prompt: "You are running on the Codex harness." });
svc.registerHarness({ id: "claude", displayName: "Claude", prompt: "You are running on the Claude harness." });
await new Promise((r) => setImmediate(r));
const mirrorRow = harnessState.settingsRows.find((r) => r.ns === "harness-base");
check(mirrorRow?.value?.harnesses?.codex === "Codex" && mirrorRow?.value?.harnesses?.claude === "Claude", "registry mirrored into settings values", JSON.stringify(mirrorRow));
check(mirrorRow?.value?.harnessIcons?.codex === svgMark && mirrorRow?.value?.harnessIcons?.claude === undefined, "icon (inline svg mark) mirrored verbatim only for harnesses that register one", JSON.stringify(mirrorRow?.value?.harnessIcons));
disposer();
await new Promise((r) => setImmediate(r));
check(mirrorRow.value.harnesses.claude === "Claude" && mirrorRow.value.harnesses.codex === undefined, "unregister removes the mirror entry");
check(mirrorRow.value.harnessIcons.codex === undefined, "unregister removes the icon mirror entry");
svc.registerHarness({ id: "codex", displayName: "Codex" });
await new Promise((r) => setImmediate(r));
check(mirrorRow.value.harnessIcons && Object.keys(mirrorRow.value.harnessIcons).length === 0, "re-registration without an icon clears the stale icon mirror", JSON.stringify(mirrorRow.value.harnessIcons));

// reroute 语义：共享选择状态（harness-base ns）→ 统一 dispatch
harnessState.settingsRows.length = 0;
harnessState.settingsRows.push({ ns: "harness-base", value: { harness: "", harnessBySession: { "s1": "claude", "s2": "codex", "s3": "" } } });
const dispatched = [];
const passthrough = Symbol("passthrough");
harnessState.ctx.llm.stream = (options) => { dispatched.push(options); return (async function* () {})(); };
await routeListener.call({}, { provider: "pipo-devllm", model: "GLM-5.3-Flash", sessionId: "s1" }, () => passthrough);
check(dispatched.length === 1 && dispatched[0].provider === "claude" && dispatched[0].model === "pipo-devllm/GLM-5.3-Flash", "session bound to claude reroutes with the qualified id", "dispatched=" + JSON.stringify(dispatched));
await routeListener.call({}, { provider: "pipo-devllm", model: "GLM-5.3-Flash", sessionId: "s2" }, () => passthrough);
check(dispatched.at(-1).provider === "codex", "session bound to codex reroutes to codex");
await routeListener.call({}, { provider: "pipo-devllm", model: "GLM-5.3-Flash", sessionId: "s3" }, () => passthrough);
check(dispatched.length === 2, "native session passes through");
await routeListener.call({}, { provider: "claude", model: "x/y", sessionId: "s1" }, () => passthrough);
check(dispatched.length === 2, "already-routed call passes through (no recursion)");
// 跨 harness 直通：会话 pin 在 claude，调用已指向注册 harness codex → 原样放行
const crossResult = await routeListener.call({}, { provider: "codex", model: "x/y", sessionId: "s1" }, () => passthrough);
check(dispatched.length === 2 && crossResult === passthrough, "cross-harness already-routed call passes through (s1 pinned to claude, call aimed at codex)", `dispatched=${JSON.stringify(dispatched)} result=${String(crossResult)}`);
await routeListener.call({}, { provider: "pipo-devllm", model: "GLM-5.3-Flash", sessionId: "s9" }, () => passthrough);
check(dispatched.length === 2, "unknown session passes through (no harness selected)");

// prompt section 跟随选中 harness
const promptText = sections[0].text({ agent: { session: { id: "s1" } } });
check(promptText === "You are running on the Claude harness.", "prompt section renders the selected harness prompt", JSON.stringify(promptText));
check(sections[0].text({ agent: { session: { id: "s3" } } }) === "", "native session renders no prompt");

// ── 10. harness 存储链：plugin 记录 → 投影 → 路由 ────────────────────────────

console.log("10. harness session store");
const { Session } = await import("@deepseek-ai/dsh-session");
const storeState = makeCtx({ llmSpec: { "claude": [{ id: "c", name: "C" }] } });
apply(storeState.ctx, Config({}));
const routeListener10 = storeState.listeners["llm/stream"][0];
const configListener10 = storeState.listeners["internal/config"][0];
const eventListener10 = storeState.listeners["session/event"][0];
const svc10 = storeState.services.llmBase;
svc10.registerHarness({ id: "claude", displayName: "Claude", prompt: "Claude harness." });
await new Promise((r) => setImmediate(r));
const session10 = Session.create("session-10a");
storeState.sessionsStore.set("session-10a", session10);
storeState.settingsRows.find((r) => r.ns === "harness-base").value.harness = "claude";

// 10a. 首次使用（首个事件）把当时默认 pin 成 ignorable 记录，路由跟随投影
eventListener10(session10, { type: "user/message", data: {} });
await new Promise((r) => setImmediate(r));
const record10 = session10.snapshotEvents().find((e) => e.type === "plugin:harness/selection");
check(record10?.data?.harness === "claude" && record10?.ignorable === true, "first use appends an ignorable plugin record with the pinned default", JSON.stringify(record10));
check(storeState.settingsRows.find((r) => r.ns === "harness-base").value.harnessBySession?.["session-10a"] === undefined, "host no longer stamps the settings dict (client-written transport only)");
// 首次使用前不 pin：只创建不产生事件的会话不落记录，读 live default
const session10b = Session.create("session-10b");
storeState.sessionsStore.set("session-10b", session10b);
await new Promise((r) => setImmediate(r));
check(session10b.snapshotEvents().length === 0, "a session that never ran holds no record (live default applies)");
const dispatched10 = [];
const passthrough10 = Symbol("passthrough");
storeState.ctx.llm.stream = (options) => { dispatched10.push(options); return (async function* () {})(); };
await routeListener10.call({}, { provider: "pipo-devllm", model: "GLM", sessionId: "session-10a" }, () => passthrough10);
check(dispatched10.length === 1 && dispatched10[0].provider === "claude", "routing follows the record (projection-first read)");

// 10b. 客户端切换（settings 写入 → internal/config）转换成记录
storeState.settingsRows[0].value.harnessBySession = { "session-10a": "" };
const switchRaw10 = { harness: "claude", harnessBySession: { "session-10a": "" } };
configListener10.call(storeState.ctx.fiber, switchRaw10, () => switchRaw10);
await new Promise((r) => setImmediate(r));
const beforeLen10 = dispatched10.length;
await routeListener10.call({}, { provider: "pipo-devllm", model: "GLM", sessionId: "session-10a" }, () => passthrough10);
check(dispatched10.length === beforeLen10, "switch back to native passes through");
const records10 = session10.snapshotEvents().filter((e) => e.type === "plugin:harness/selection");
check(records10.length === 2 && records10[1].data.harness === "", "switch appended exactly one more record", JSON.stringify(records10.map((r) => r.data)));

// 10c. 幂等：重复照面 / 重复切换不追加
eventListener10(session10, records10[1]);
configListener10.call(storeState.ctx.fiber, switchRaw10, () => switchRaw10);
await new Promise((r) => setImmediate(r));
check(session10.snapshotEvents().filter((e) => e.type === "plugin:harness/selection").length === 2, "repeat sightings and repeat switches append nothing");

// 10d. 不在进程里的会话：settings 回落，不崩溃也不写记录
await routeListener10.call({}, { provider: "pipo-devllm", model: "GLM", sessionId: "session-offline" }, () => passthrough10);
check(dispatched10.length === 2 && dispatched10.at(-1).provider === "claude", "offline unseen session takes the default", JSON.stringify(dispatched10));
check(!storeState.sessionsStore.has("session-offline"), "offline session appended nothing and stays dict-free");

// 10e. 未注册 id 不落记录（与 selectModel requireModel 同一 fail-loud 契约）
storeState.settingsRows[0].value.harnessBySession = { "session-10a": "nosuch" };
const rawNosuch10 = { harness: "claude", harnessBySession: { "session-10a": "nosuch" } };
const recordsBefore10e = session10.snapshotEvents().filter((e) => e.type === "plugin:harness/selection").length;
configListener10.call(storeState.ctx.fiber, rawNosuch10, () => rawNosuch10);
await new Promise((r) => setImmediate(r));
check(session10.snapshotEvents().filter((e) => e.type === "plugin:harness/selection").length === recordsBefore10e, "unregistered harness id records nothing", JSON.stringify(session10.snapshotEvents().filter((e) => e.type === "plugin:harness/selection").map((e) => e.data)));
check(storeState.logs.warn.some((line) => line.includes('unregistered harness "nosuch"')), "unregistered refusal is logged", JSON.stringify(storeState.logs.warn));

// ── 11. 存量迁移：dict 条目 → 会话日志记录 ──────────────────────────────────

console.log("11. legacy migration");
const { migrateHarnessBySession } = await import(pathToFileURL(PLUGIN).href);
const migState = makeCtx({ llmSpec: { "claude": [{ id: "c", name: "C" }] } });
apply(migState.ctx, Config({}));
await new Promise((r) => setImmediate(r)); // the auto-run converges an empty dict and sets the flag
const seedStored = (id, events) => migState.storedSessions.set(id, events.map((event, seq) => ({ seq, time: 1, ...event })));
seedStored("session-mig1", [{ type: "user/message", data: {} }]);
seedStored("session-mig2", [{ type: "user/message", data: {} }, { type: "assistant/message", data: {} }]);
seedStored("session-mig3", [{ type: "user/message", data: {} }, { type: "plugin:harness/selection", data: { harness: "codex" }, ignorable: true }]);
seedStored("session-live", [{ type: "user/message", data: {} }]);
seedStored("session-never-ran", []);
migState.sessionsStore.set("session-live", Session.create("session-live"));
migState.settingsRows.find((r) => r.ns === "harness-base").value.harnessBySession = {
  "session-mig1": "claude",
  "session-mig2": "",
  "session-mig3": "claude",
  "session-live": "codex",
  "session-never-ran": "claude",
  "session-gone": "claude",
};
await migrateHarnessBySession(migState.ctx);
const recordsOf = (id) => (migState.storedSessions.get(id) ?? []).filter((e) => e.type === "plugin:harness/selection");
const record11 = recordsOf("session-mig1");
check(record11.length === 1 && record11[0].seq === 1 && record11[0].data.harness === "claude" && record11[0].ignorable === true && typeof record11[0].time === "number", "dict entry appended as an ignorable record at the next seq", JSON.stringify(record11));
check(recordsOf("session-mig2").at(-1)?.data?.harness === "" && recordsOf("session-mig2").length === 1, "native choice recorded too", JSON.stringify(recordsOf("session-mig2")));
check(recordsOf("session-mig3").length === 2 && recordsOf("session-mig3")[1].data.harness === "claude", "stale record converges to the dict value", JSON.stringify(recordsOf("session-mig3")));
check(recordsOf("session-live").length === 0, "live session skipped (its materialize path writes the record)");
check(recordsOf("session-never-ran").length === 0, "empty-log session skipped (never ran, reads the live default)");
check(recordsOf("session-gone").length === 0 && migState.logs.warn.some((line) => line.includes("session-gone")), "missing stored session warns and skips");
check(migState.settingsRows.find((r) => r.ns === "harness-base").value.harnessBySessionMigrated === true, "migration flag set");
const before11 = recordsOf("session-mig1").length;
await migrateHarnessBySession(migState.ctx);
check(recordsOf("session-mig1").length === before11, "second pass appends nothing (current records skipped)");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

