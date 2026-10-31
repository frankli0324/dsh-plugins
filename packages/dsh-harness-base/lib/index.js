// dsh-harness-base: **第三方扩展**（dsh 生态插件，不是 dsh 核心模型面
// ——核心模型面是 dsh-llm 的 provider registry + 原生 agent loop，本插件不动它）。
// 它为第三方 harness（codex、claude code 等外部 agent runtime）代理真实上游：
// 上游来源 = llm-pi-ai 的 providers 配置 + DeepSeek 自家适配器（官方 API key /
// 账号），以 wire-agnostic 的 /v1 relay 暴露（qualified id "<provider>/<modelId>"
// 解析到真实上游：`/v1` 后缀原样拼到目标 baseURL、仅改写 model 字段、SSE 双向
// 管道、客户端断连掐上游；路由表每请求现读 settings）。它同时是这些 harness 的
// 宿主：持有 harness 注册表（registerHarness）、会话级选择状态（session log
// 的 plugin:harness/selection 记录 + "harness" 投影，settings ns 只做切换传输
// 与菜单镜像）、统一的 llm/stream reroute、prompt section 与模型菜单里的
// Harness 行；harness 插件只贡献身份与自己的 adapter。

import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { isLoopbackHost } from "@deepseek-ai/dsh-host-webserver";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
// Must be the SAME module instance the host runs (workspace links it via
// "file:" to the running dsh's copy): appendPluginRecord reaches
// Session.#appendRecord through a private-method brand check, so a second
// copy of the package would reject every host-built Session.
import { appendPluginRecord, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { z as zod } from "zod";
import z from "@deepseek-ai/schemastery";

const name = "harness-base";
// "settings" reads the live selection state (this plugin's own namespace),
// "systemPrompt" renders the selected harness's prompt section.
const inject = ["webServer", "connection", "llm", "credentials", "settings", "systemPrompt", "sessions", "sessionProjections", "sessionPersistence"];

// The base owns no relay configuration of its own: the route table is the
// live llm-pi-ai provider profiles plus the DeepSeek built-in routes, re-read
// per request so settings hot updates apply on the next hop. It DOES own the
// harness selection state: which sessions run on which harness provider
// ("" = dsh's own agent loop), read live per request the same way.
const Config = z.object({
  // Default harness for sessions without an explicit choice. Empty (default)
  // leaves them on dsh's own agent loop; a harness id routes their model calls
  // through that provider while the session keeps its real (provider, model)
  // binding. A Harness row switch moves the switching session AND this
  // default (future sessions take the new choice); existing conversations
  // hold — each session's harness is pinned on first sight, so a later
  // default change cannot reach them. The pin lives in the session log (the
  // harness projection) and is mirrored here for the client menu display.
  harness: z.string().default("").volatile(),
  // Per-session harness override: sessionId -> "" | harness id. This dict is
  // the SWITCH TRANSPORT, written only by the client menu row and consumed
  // into log records by the internal/config listener below; harnessFor keeps
  // reading it for the unconverged window between a switch and the record
  // landing. The durable per-session store is the `plugin:harness/selection`
  // log records behind the "harness" projection — the host never writes this
  // dict.
  harnessBySession: z.dict(z.string()).default({}).volatile(),
  // Runtime mirror of the registered harnesses (id -> displayName), written
  // by the plugin itself on registerHarness/unregister so the client menu row
  // can render the options through the ordinary settings mirror. Never edited
  // from the UI.
  harnesses: z.dict(z.string()).default({}).volatile(),
  // Icon mirror (id -> the dsh client primitives icon component name the
  // harness registered, e.g. "IconCodeOutlineRegular"), written alongside
  // `harnesses` by the same sync. The switch UI resolves the name against the
  // primitives module; unknown or missing names render the default icon.
  harnessIcons: z.dict(z.string()).default({}).volatile(),
  // One-time convergence marker: the legacy harnessBySession dict entries
  // have been written into their sessions' logs as plugin:harness/selection
  // records. Sessions seen after the migration converge through
  // materializeHarness instead.
  harnessBySessionMigrated: z.boolean().default(false).volatile(),
});

// Request headers never forwarded upstream: hop-by-hop framing, lengths fetch
// recomputes, and every inbound auth surface (the dsh web session cookie
// included — it must not leak to a model provider).
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "authorization",
  "x-api-key",
  "cookie",
]);

// Response headers not forwarded back: framing that ends when the relay body
// ends, plus content-encoding (fetch hands over the decoded stream).
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

// The request shapes the base relays; anything else under /v1 is 404. The
// relay is wire-agnostic: /v1/messages (+ count_tokens) is the Anthropic wire
// the Claude Code CLI speaks and relays like any other path.
const RELAYED_PATHS = new Set(["/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens"]);

// ---------------------------------------------------------------------------
// Qualified id codec — the ONE place "<provider>/<modelId>" ids are built and
// parsed. Provider ids are route-table keys (never contain "/"); the model id
// is everything after the first "/", so model ids may themselves contain "/".
// ---------------------------------------------------------------------------

function encodeQualifiedId(provider, modelId) {
  return `${provider}/${modelId}`;
}

function parseQualifiedId(qualifiedId) {
  if (typeof qualifiedId !== "string") return undefined;
  const at = qualifiedId.indexOf("/");
  if (at <= 0 || at === qualifiedId.length - 1) return undefined;
  return { provider: qualifiedId.slice(0, at), modelId: qualifiedId.slice(at + 1) };
}

// ---------------------------------------------------------------------------
// Route table: llm-pi-ai provider profiles + DeepSeek built-in routes, read
// live from settings on every lookup.
// ---------------------------------------------------------------------------

// DeepSeek routes are adapters with fixed endpoints, not pi-ai profiles. Their
// endpoint and credential source mirror dsh-llm-deepseek / dsh-llm-deepseek-api-key /
// dsh-llm-deepseek-account defaults; the route only exists when that adapter is
// registered. Both speak the anthropic-messages wire.
const DEEPSEEK_BUILT_IN_ROUTES = {
  "deepseek-official": {
    settingsNs: "llm-deepseek-api-key",
    auth: "x-api-key",
    defaultBaseURL: "https://api.deepseek.com/anthropic",
    defaultCredentialRef: "DEEPSEEK_API_KEY",
  },
  "deepseek-account": {
    settingsNs: "llm-deepseek-account",
    auth: "account-token",
    defaultBaseURL: "https://api.deepseek.com/anthropic",
  },
};

/** Live settings values keyed by namespace (the host-wide SettingsForms seam). */
function settingsRows(ctx) {
  const settings = ctx.get("settings");
  if (settings === undefined) return [];
  return settings.describe();
}

function settingsValue(ctx, ns) {
  return settingsRows(ctx).find((row) => row.ns === ns)?.value;
}

/** The pi-ai route for one profile in the `providers` dict. */
function piAiRoute(routeId, profile) {
  const modelIds = new Set([
    ...(Array.isArray(profile.models) ? profile.models.map((model) => model.id) : []),
    ...Object.keys(profile.modelOverrides ?? {}),
  ]);
  return {
    provider: routeId,
    api: profile.api,
    baseURL: profile.baseURL,
    ...profile.headers === undefined ? {} : { headers: profile.headers },
    ...profile.apiKeyEnv === undefined ? {} : { credentialRef: profile.apiKeyEnv },
    auth: "credential",
    modelIds,
  };
}

function deepSeekRoute(ctx, providerId) {
  const builtIn = DEEPSEEK_BUILT_IN_ROUTES[providerId];
  const value = settingsValue(ctx, builtIn.settingsNs);
  return {
    provider: providerId,
    api: "anthropic-messages",
    baseURL: value?.baseURL ?? builtIn.defaultBaseURL,
    ...builtIn.defaultCredentialRef === undefined ? {} : { credentialRef: value?.apiKeyEnv ?? builtIn.defaultCredentialRef },
    auth: builtIn.auth,
    // Model membership is the adapter's live catalog (network/account state);
    // resolve() passes the model through and the provider judges it.
    modelIds: undefined,
  };
}

/** The full route table: pi-ai profiles first, then registered DeepSeek routes. */
function routeTable(ctx) {
  const routes = new Map();
  const providers = settingsValue(ctx, "llm-pi-ai")?.providers;
  if (typeof providers === "object" && providers !== null) {
    for (const [routeId, profile] of Object.entries(providers)) {
      if (typeof profile?.baseURL !== "string" || profile.baseURL.length === 0) continue;
      routes.set(routeId, piAiRoute(routeId, profile));
    }
  }
  const registered = new Set(ctx.llm.listProviders().map((provider) => provider.id));
  for (const providerId of Object.keys(DEEPSEEK_BUILT_IN_ROUTES)) {
    if (registered.has(providerId) && !routes.has(providerId)) routes.set(providerId, deepSeekRoute(ctx, providerId));
  }
  return routes;
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve the target's credential to the auth headers the wire protocol
 * expects: `Authorization: Bearer` for the OpenAI-compatible protocols,
 * `x-api-key` for anthropic-messages. The DeepSeek account route instead
 * carries the live account session token (`x-dsh-auth-token`).
 */
async function authHeaders(ctx, target) {
  if (target.auth === "account-token") {
    const token = await ctx.get("deepseekAccount")?.resolveToken(target.baseURL);
    if (token === undefined) {
      throw new LlmError(
        "harness-base: the DeepSeek account is not signed in, so the account route has no token — sign in on the account page",
        "ACCOUNT_SIGN_IN_REQUIRED",
      );
    }
    return { "x-dsh-auth-token": token };
  }
  const ref = target.credentialRef;
  if (ref === undefined || ref.length === 0) return {};
  const hit = await ctx.credentials?.resolve(credentialRef(ref));
  const value = hit?.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new LlmError(
      `harness-base: credential "${ref}" is not set — store it through the credentials service (the web Models page writes it)`,
      "MISSING_CREDENTIAL",
    );
  }
  return target.api === "anthropic-messages" ? { "x-api-key": value } : { authorization: `Bearer ${value}` };
}

/** The base credential a client presented, via Bearer or x-api-key. */
function presentedToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : undefined;
}

function tokenMatches(presented, token) {
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Relay one /v1 request to the resolved target. Non-200 upstream responses
 * pass through with their body verbatim (retry semantics belong to the
 * caller); a client disconnect aborts the upstream request.
 */
async function relay(base, ctx, auth, req, res) {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://base.invalid");
  const abort = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on("close", onClose);
  let status = 0;
  let target = null;
  let model = null;
  try {
    // Non-loopback binds authenticate every caller: a valid base token, or
    // the composition's own gate (Host/Origin fence + browser session) as the
    // alternative credential. Loopback binds stay token-free.
    if (auth.remote) {
      const presented = presentedToken(req);
      if (presented === undefined || !tokenMatches(presented, auth.token)) {
        // No base token: the composition's gate decides — its Host/Origin
        // fence plus browser session, the same control the other dsh web
        // routes sit behind. A missing connection service fails closed.
        const connection = ctx.get("connection");
        const rejection = connection === undefined ? 401 : connection.requestRejection(req);
        if (rejection !== undefined) {
          res.statusCode = rejection;
          res.end();
          ctx.logger.info(`harness-base: ${url.pathname} rejected ${rejection} (no base token, no browser session)`);
          return;
        }
      }
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      res.end();
      return;
    }
    if (!RELAYED_PATHS.has(url.pathname)) {
      sendJson(res, 404, { error: { message: `harness-base: no relay route for ${url.pathname}` } });
      return;
    }
    const text = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, { error: { message: "harness-base: request body must be a JSON object" } });
      return;
    }
    if (typeof parsed.model !== "string" || parsed.model.length === 0) {
      sendJson(res, 400, { error: { message: 'harness-base: body.model is required (a qualified "<provider>/<modelId>" id)' } });
      return;
    }
    // Only qualified ids route: a bare model id means a caller bypassed the
    // harness selection (e.g. a TUI pointed straight at the daemon) — refuse
    // rather than guess a target.
    const qualified = parseQualifiedId(parsed.model);
    if (qualified === undefined) {
      sendJson(res, 400, { error: { message: `harness-base: body.model "${parsed.model}" carries no "<provider>/" prefix — the base routes qualified ids only` } });
      return;
    }
    model = parsed.model;
    target = await base.resolve(model);
    // Only the model field is rewritten: the raw model id goes downstream.
    const downstream = JSON.stringify({ ...parsed, model: qualified.modelId });
    const upstreamAuth = await authHeaders(ctx, target);

    // Inbound headers ride along minus framing and auth; then the target's
    // credential, then the profile's own headers (highest precedence).
    const headers = {};
    for (const [field, value] of Object.entries(req.headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(field)) continue;
      headers[field] = value;
    }
    Object.assign(headers, upstreamAuth);
    for (const [field, value] of Object.entries(target.headers ?? {})) {
      headers[field.toLowerCase()] = value;
    }
    if (headers["content-type"] === undefined) headers["content-type"] = "application/json";

    // The /v1 suffix joins the target baseURL directly: whether the baseURL
    // carries /v1 is the provider profile's own decision.
    const upstream = `${target.baseURL.replace(/\/+$/, "")}${url.pathname.slice("/v1".length)}${url.search}`;
    const upstreamRes = await fetch(upstream, {
      method: "POST",
      headers,
      body: downstream,
      signal: abort.signal,
    });
    status = upstreamRes.status;
    const responseHeaders = {};
    upstreamRes.headers.forEach((value, field) => {
      if (STRIPPED_RESPONSE_HEADERS.has(field)) return;
      responseHeaders[field] = value;
    });
    res.writeHead(upstreamRes.status, responseHeaders);
    if (upstreamRes.body) {
      await pipeline(Readable.fromWeb(upstreamRes.body), res, { signal: abort.signal });
    } else {
      res.end();
    }
  } catch (error) {
    // A client disconnect surfaces here as an AbortError after the upstream
    // fetch already handed back a body: the socket is gone, just tear down.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, { error: { message: `harness-base: ${error?.message ?? error}` } });
  } finally {
    res.off("close", onClose);
    if (target !== null) {
      ctx.logger.info(`harness-base: ${url.pathname} model=${model} provider=${target.provider} -> ${status || "aborted"} ${Date.now() - started}ms`);
    }
  }
}

/**
 * Mirror the harness registry into the harness-base namespace's settings values so
 * the client menu row can render the options through the ordinary settings
 * mirror. Server-side mutate: no revision fencing needed (the registry is the
 * only writer of this field). Module-level on purpose — registerHarness runs
 * through cordis's traceable shadow proxy, whose receiver lacks the class's
 * private-field brand (the same reason service classes avoid #private).
 */
function syncHarnessMirror(base) {
  base.harnessMirrorSync = base.harnessMirrorSync.then(async () => {
    const harnesses = Object.fromEntries([...base.harnesses].map(([id, spec]) => [id, spec.displayName]));
    const harnessIcons = Object.fromEntries(
      [...base.harnesses].filter(([, spec]) => typeof spec.icon === "string").map(([id, spec]) => [id, spec.icon]),
    );
    try {
      await base.ctx.settings.mutate("harness-base", [
        { op: "set", path: ["harnesses"], value: harnesses },
        { op: "set", path: ["harnessIcons"], value: harnessIcons },
      ]);
    } catch (error) {
      base.ctx.logger?.warn?.(`harness-base: failed to sync the harness registry mirror: ${error?.message ?? error}`);
    }
  });
}

/** The relay contract consumers (dsh-harness-codex) program against. */class LlmBase extends Service {
  // Plain properties, not #private fields: cordis exposes cross-fiber service
  // access through a traceable shadow proxy whose receiver lacks the class's
  // private-field brand, so any `this.#field` read inside a service method
  // throws "Cannot read private member". Public properties survive — the
  // shadow forwards them to the real instance.
  relayToken;
  // Registered harnesses: id → { displayName, prompt?, icon? }. The dispatch
  // route, the prompt section, and the client menu row all read this registry.
  harnesses = new Map();
  // Serializes the settings mirror rewrites across register/unregister calls.
  harnessMirrorSync = Promise.resolve();
  constructor(ctx, token) {
    super(ctx, "llmBase");
    this.relayToken = token;
  }
  /**
   * Register a harness: a provider id (already registered as an llm adapter
   * by the caller) that sessions can route their turns to. The dispatch, the
   * prompt section, and the model-picker row are all owned here — the caller
   * contributes only its identity. `icon` names a dsh client primitives icon
   * component (e.g. "IconCodeOutlineRegular") the switch UI renders for this
   * harness; omitted icons fall back to the UI's default. Returns a disposer.
   * @param {{id: string, displayName: string, prompt?: string, icon?: string}} spec
   * @returns {() => void}
   */
  registerHarness(spec) {
    const id = spec?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new LlmError("harness-base: harness registration requires an id", "INVALID_HARNESS");
    }
    const displayName = typeof spec.displayName === "string" && spec.displayName ? spec.displayName : id;
    this.harnesses.set(id, {
      displayName,
      ...(typeof spec.prompt === "string" ? { prompt: spec.prompt } : {}),
      ...(typeof spec.icon === "string" && spec.icon ? { icon: spec.icon } : {}),
    });
    syncHarnessMirror(this);
    return () => {
      if (this.harnesses.get(id)?.displayName !== displayName) return;
      this.harnesses.delete(id);
      syncHarnessMirror(this);
    };
  }
  /**
   * Mirror of the models this base can relay to, as qualified ids: every
   * registered provider that is also a route-table entry (llm-pi-ai profiles
   * plus the DeepSeek built-ins). Providers the base cannot serve — harness
   * adapter routes like the codex mirror itself — are excluded, so a consumer
   * that feeds this mirror back into the registry cannot recurse. One failed
   * provider drops only its own group (same isolation as the host model
   * catalog); the reason lands in the log.
   * @returns {Promise<Array<{id: string, name: string, provider: string, modelId: string, description?: string, reasoning?: object}>>}
   */
  async targets() {
    const ctx = this.ctx;
    const routes = routeTable(ctx);
    const groups = await Promise.all([...routes.keys()].map(async (providerId) => {
      if (!ctx.llm.listProviders().some((provider) => provider.id === providerId)) return [];
      try {
        const models = await ctx.llm.listModels(providerId);
        return await Promise.all(models.map(async (model) => {
          const info = await ctx.llm.resolveModelInfo(providerId, model.id);
          return {
            id: encodeQualifiedId(providerId, model.id),
            name: model.name,
            provider: providerId,
            modelId: model.id,
            ...model.description === undefined ? {} : { description: model.description },
            ...info.reasoning === undefined ? {} : { reasoning: info.reasoning },
          };
        }));
      } catch (error) {
        ctx.logger.warn(`harness-base: provider "${providerId}" model mirror failed, group skipped: ${error?.message ?? error}`);
        return [];
      }
    }));
    return groups.flat();
  }
  /**
   * Decode a qualified id into the route a /v1 request relays to. Read from
   * live settings on every call, so profile hot updates apply on the next
   * hop. An anthropic-messages target is reported as-is: whether the caller
   * can use it is the caller's decision, not the base's.
   * @returns {Promise<{provider: string, model: string, api: string, baseURL: string, headers?: Record<string, string>, credentialRef?: string, auth: string}>}
   */
  async resolve(qualifiedId) {
    const qualified = parseQualifiedId(qualifiedId);
    if (qualified === undefined) {
      throw new LlmError('harness-base: model must be a qualified "<provider>/<modelId>" id', "INVALID_MODEL");
    }
    const route = routeTable(this.ctx).get(qualified.provider);
    if (route === undefined) {
      throw new LlmError(`harness-base: unknown provider prefix "${qualified.provider}" — no configured route serves it`, "UNKNOWN_PROVIDER");
    }
    if (route.modelIds !== undefined && !route.modelIds.has(qualified.modelId)) {
      throw new LlmError(`harness-base: provider "${qualified.provider}" serves no model "${qualified.modelId}"`, "UNKNOWN_MODEL");
    }
    return {
      provider: route.provider,
      model: qualified.modelId,
      api: route.api,
      baseURL: route.baseURL,
      ...route.headers === undefined ? {} : { headers: route.headers },
      ...route.credentialRef === undefined ? {} : { credentialRef: route.credentialRef },
      auth: route.auth,
    };
  }
  /**
   * The local relay entry for harness-side consumers. Taken from the live
   * webserver (bind address + listened port), never hardcoded. Non-loopback
   * binds carry the token clients must present (`env_key` for the codex
   * wrapper); loopback binds stay token-free.
   */
  localEndpoint() {
    return {
      baseUrl: `${this.ctx.webServer.getOrigin()}/v1`,
      ...this.relayToken === undefined ? {} : { token: this.relayToken },
    };
  }
}

// Session-scoped harness store, the modelSelection pattern: whole-value
// plugin records (`plugin:harness/selection`) folded by a session projection.
// The log is the store — the state survives restarts and plugin reloads
// (lazy refold from the log), and forks carry it with the rest of the log.
// `null` = never resolved; a record always carries the complete post-change
// value ("" = dsh's own agent loop).
const harnessSelectionProjection = {
  key: "harness",
  stateVersion: 0,
  stateSchema: zod.object({ harness: zod.string().nullable() }),
  init: () => ({ harness: null }),
  apply: (state, event) => {
    if (event.type !== "plugin:harness/selection") return state;
    const harness = event.data?.harness;
    if (typeof harness !== "string" || harness === state.harness) return state;
    return { harness };
  },
  wire: {
    viewSchema: zod.object({ harness: zod.string().nullable() }),
    view: (state) => ({ harness: state.harness }),
  },
};

// One-time convergence of the legacy store: every session the pre-projection
// code stamped has a harnessBySession entry but no log record. Write each
// entry into its stored session's log as a plugin:harness/selection record
// through the persistence write lease, so the "harness" projection reads it
// back. Live sessions skip (their materialize path writes the record; their
// lease belongs to the host); a session whose last record already matches
// skips. Failures warn and leave the session to lazy migration on its next
// open. The harnessBySessionMigrated flag turns the scan off afterwards.
async function migrateHarnessBySession(ctx) {
  const shared = settingsValue(ctx, "harness-base") ?? {};
  const entries = Object.entries(shared.harnessBySession ?? {}).filter(([, value]) => typeof value === "string");
  let migrated = 0;
  let current = 0;
  let skipped = 0;
  for (const [sessionId, value] of entries) {
    if (ctx.sessions.get(sessionId) !== undefined) { skipped++; continue; }
    try {
      const handle = await ctx.sessionPersistence.open(SessionId(sessionId), "write");
      try {
        const { events } = await handle.read();
        // An empty log is a session that never ran: nothing to hold, it reads
        // the live default like any new session (first-use pin semantics).
        if (events.length === 0) { skipped++; continue; }
        const last = events.findLast((event) => event.type === "plugin:harness/selection");
        if (last?.data?.harness === value) { current++; continue; }
        await handle.append([{ type: "plugin:harness/selection", seq: SessionSeq(events.length), time: Date.now(), data: { harness: value }, ignorable: true }]);
        await handle.flush();
        migrated++;
      } finally {
        await handle.close();
      }
    } catch (error) {
      skipped++;
      ctx.logger?.warn?.(`harness-base: harness migration skipped session ${sessionId}: ${error?.message ?? error}`);
    }
  }
  await ctx.settings.mutate("harness-base", [{ op: "set", path: ["harnessBySessionMigrated"], value: true }]);
  ctx.logger?.info?.(`harness-base: legacy harness migration done (${migrated} migrated, ${current} current, ${skipped} skipped)`);
}

function apply(ctx) {
  // Loopback binds keep the token-free local behavior; any other bind forces
  // the generated token, which localEndpoint() exposes for the harness to
  // inject into clients.
  const remote = !isLoopbackHost(ctx.webServer.host);
  const token = remote ? randomBytes(32).toString("base64url") : undefined;
  const base = new LlmBase(ctx, token);

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/v1",
    handler: (req, res) => relay(base, ctx, { remote, token }, req, res),
  }), "harness-base: POST /v1/responses | /v1/chat/completions");

  // Harness selection state. Read path: the session-log projection first,
  // then the settings dict (switch transport + legacy stamps), then the
  // in-memory pin for anything observed before its record landed. A Harness
  // row switch moves the switching session's upcoming requests AND the
  // default that future sessions start from; every conversation that has run
  // at least once holds — its harness was pinned at first use, so a later
  // default change cannot reach it. Both the prompt section and the route
  // call this, so assembly and routing always agree.
  ctx.sessionProjections.register(harnessSelectionProjection);
  // Off the synchronous startup path; a session opened inside its brief
  // migration window hits the writer-held rejection once and recovers on
  // retry (or converges lazily on open).
  if ((settingsValue(ctx, "harness-base") ?? {}).harnessBySessionMigrated !== true) {
    void Promise.resolve().then(() => migrateHarnessBySession(ctx)).catch((error) => {
      ctx.logger?.warn?.(`harness-base: legacy harness migration failed: ${error?.message ?? error}`);
    });
  }
  const pinnedHarness = new Map();
  const recordedHarness = (sessionId) => {
    const session = ctx.sessions.get(sessionId);
    if (session === undefined) return undefined;
    const state = ctx.sessionProjections.stateOf(session, "harness");
    return state === undefined || state.harness === null ? undefined : state.harness;
  };
  const recordHarness = (session, value) => {
    // Unregistered ids never enter the log: a record claiming a dead harness
    // would route as native while the picker claims otherwise (the same
    // fail-loud contract as selectModel's requireModel). The menu refuses
    // them client-side; stale-mirror races and stale defaults skip here.
    if (value !== "" && !base.harnesses.has(value)) {
      ctx.logger?.warn?.(`harness-base: not recording unregistered harness "${value}" for session ${session?.id}`);
      return;
    }
    try {
      appendPluginRecord(session, "plugin:harness/selection", { harness: value });
    } catch (error) {
      // An append inside another event's publication window rejects; the
      // projection stays unresolved and the next sighting retries.
      ctx.logger?.warn?.(`harness-base: failed to record the harness for session ${session?.id}: ${error?.message ?? error}`);
    }
  };
  // Convert one desired value into a record, deduped against the projection.
  // Deferred because a session/event sighting runs inside that event's
  // publication window, where appends reject.
  const ensureRecord = (sessionId, value) => {
    queueMicrotask(() => {
      if (recordedHarness(sessionId) === value) return;
      const session = ctx.sessions.get(sessionId);
      if (session !== undefined) recordHarness(session, value);
    });
  };
  const stampHarness = (sessionId, value) => {
    pinnedHarness.set(sessionId, value);
    ensureRecord(sessionId, value);
  };
  const materializeHarness = (sessionId) => {
    if (sessionId == null || pinnedHarness.has(sessionId)) return;
    const shared = settingsValue(ctx, "harness-base") ?? {};
    const explicit = shared.harnessBySession?.[sessionId];
    if (explicit !== undefined) {
      pinnedHarness.set(sessionId, explicit);
      ensureRecord(sessionId, explicit);
      return;
    }
    const recorded = recordedHarness(sessionId);
    if (recorded !== undefined) { pinnedHarness.set(sessionId, recorded); return; }
    stampHarness(sessionId, shared.harness ?? "");
  };
  const harnessFor = (sessionId) => {
    const shared = settingsValue(ctx, "harness-base") ?? {};
    if (sessionId == null) return shared.harness ?? "";
    const recorded = recordedHarness(sessionId);
    if (recorded !== undefined) return recorded;
    const explicit = shared.harnessBySession?.[sessionId];
    if (explicit !== undefined) return explicit;
    if (!pinnedHarness.has(sessionId)) stampHarness(sessionId, shared.harness ?? "");
    return pinnedHarness.get(sessionId);
  };
  // Pin at first use, the same lock timing as model selection (whose
  // fallback chain reads the live default until the first request/header
  // exists): the event firehose pins a session at its FIRST event — the
  // first message — and harnessFor's lazy stamp covers anything the firehose
  // has not seen. A session that has never produced events holds nothing and
  // reads the live default, so a default change before the first message
  // reaches it. Idempotent.
  ctx.on("session/event", (session) => materializeHarness(session?.id));
  // Client switches arrive as settings edits on this ns: convert each changed
  // session binding into a record so the projection (routing, prompt section)
  // follows the switch. Diffing keeps the registry-mirror writes and
  // default-only changes from appending redundant records; a session that is
  // not live keeps its settings stamp as the fallback until it opens.
  ctx.on("internal/config", function(_raw, next) {
    const raw = next();
    if (this !== ctx.fiber) return raw;
    // The raw entry config is plain JSON written by the settings service (it
    // validates the volatile paths on write); the schemastery Config result is
    // an opaque schema instance, not enumerable data.
    const bySession = raw?.harnessBySession;
    if (typeof bySession !== "object" || bySession === null || Array.isArray(bySession)) return raw;
    for (const [sessionId, value] of Object.entries(bySession)) {
      if (typeof value !== "string") continue;
      if (recordedHarness(sessionId) === value) continue;
      ensureRecord(sessionId, value);
    }
    return raw;
  });
  // The selected harness renders as a prompt section at the same assembly
  // boundary as model selection: the next step after a switch renders the
  // new harness. The prompt text belongs to the harness registration.
  ctx.effect(() => ctx.systemPrompt.section({
    name: "harness-base:harness",
    order: 1,
    text: (context) => {
      const id = harnessFor(context.agent?.session?.id);
      if (!id) return "";
      return base.harnesses.get(id)?.prompt ?? "";
    },
  }), "harness-base: harness prompt section");
  // Route at the stream boundary — AFTER the request header is built, not in
  // agent/request. The header's (provider, model) belongs to model selection;
  // rerouting the call itself keeps the model binding and the harness
  // orthogonal. The harness is addressed with the qualified "<provider>/<model>"
  // id so the relay sends the model call back to that provider. Calls already
  // routed to ANY registered harness pass through unchanged (no recursion,
  // including cross-harness), as do calls when the session's harness is
  // native or unregistered. Note: cordis binds waterfall listeners to the
  // dispatcher (the llm service), not to this plugin's fiber — never gate on
  // `this`. global: the llm service dispatches this waterfall on its own
  // fiber, and cordis filters non-global listeners to the dispatching
  // service's isolate — a plain plugin-scoped listener never fires (the same
  // reason dsh-session-title registers global+prepend). `this` is the
  // dispatcher.
  ctx.on("llm/stream", function(options, next) {
    if (!options?.provider) return next();
    const id = harnessFor(options.sessionId);
    if (!id || base.harnesses.has(options.provider)) return next();
    if (!base.harnesses.has(id)) return next();
    return ctx.llm.stream({ ...options, provider: id, model: `${options.provider}/${options.model}` });
  }, { global: true, prepend: true });

  ctx.logger.info(`harness-base: registered service 'llmBase' and /v1 relay route (${remote ? "token required" : "loopback, token-free"})`);
}

export { name, inject, Config, apply, LlmBase, migrateHarnessBySession };
