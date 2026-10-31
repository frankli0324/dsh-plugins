// dsh LLM adapter that drives codex via the shared app-server control socket
// (WebSocket-over-UDS, one JSON message per frame).
// Main streams reuse a persistent codex thread with thread/resume; title
// streams remain ephemeral. Main turns send only the user input — no dsh
// system prompt, no replayed conversation — and codex keeps its own
// instructions and its own thread history. Title turns instead receive the
// caller's full conversation prefix via thread/inject_items so the titler
// sees the real transcript. Stream translation maps codex notifications onto
// the dsh stream protocol.
// Deferred text replay is keyed per dsh session. Codex tool calls are rendered
// under their real names without entering dsh's model-visible tool registry.

import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

const name = "harness-codex";
// "llmBase" is the dsh-harness-base relay service, a hard dependency: the
// codex model catalog mirrors gateway.targets() and every thread routes its
// model through the gateway, so without the gateway plugin this adapter does
// not activate.
const inject = ["llm", "tools", "sessions", "llmBase", "systemPrompt"];

// Per-call timeout for codex app-server RPCs (ms). A hung protocol must not
// park a dsh request forever; on timeout the pending call rejects and the
// client connection is dropped (the shared listener keeps running). Override
// with DSH_CODEX_RPC_TIMEOUT_MS.
const RPC_TIMEOUT_MS = Number(process.env.DSH_CODEX_RPC_TIMEOUT_MS) || 120_000;

const Config = z.object({
  command: z.string().default("codex").volatile(),
  // Shared app-server control socket. Empty (default) derives
  // $CODEX_HOME/app-server-control/<basename(command)>.sock; an absolute
  // path overrides it — the wrapper listener binds whatever the adapter
  // passes via CODEX_APP_SERVER_SOCKET. Changing it respawns the listener.
  socketPath: z.string().volatile(),
  // CODEX_HOME for the spawned app-server (config.toml, auth, sessions,
  // rollouts, and the derived control socket). Empty (default) inherits the
  // dsh process environment (codex's own default: ~/.codex). Changing it
  // respawns the listener — its env carries a frozen CODEX_HOME.
  codexHome: z.string().volatile(),
  cwd: z.string(),
  model: z.string(),
  sandbox: z.string().default("danger-full-access"),
  approvalPolicy: z.string().default("never"),
  // dsh tool names exposed to codex as dynamic tools. Empty (default) keeps
  // codex on its own built-in toolset; overlapping tools like bash should
  // stay unexposed so the two agents don't run duplicate executors. Dynamic
  // tool calls execute via item/tool/call and render no dsh tool block: the
  // real dsh tool is already registered, and re-emitting its name would make
  // the agent loop execute it twice.
  exposeTools: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Codex app-server connection
//
// The adapter talks to a *shared* app-server over its control Unix socket
// ($CODEX_HOME/app-server-control/<command>.sock, WebSocket framing),
// not to a private stdio child. When no listener is up the adapter spawns
// `codex app-server --listen unix://` as a plain child process. While dsh
// runs, the codex CLI can attach to the same app-server and work on the same
// threads: the CLI probes the same default socket at startup, thread/list
// shows the adapter's threads, thread/resume subscribes the CLI to live
// fan-out, and turn/start from either side is visible to both. The listener
// is killed on dsh dispose/shutdown — it never outlives the dsh process.
// ---------------------------------------------------------------------------

const CONTROL_SOCKET_DIR = "app-server-control";
// One RFC6455 text frame per JSON message (matches the app-server's framing).
// Outgoing frames are split at 8 MiB: below tungstenite's 16 MiB default
// max_frame_size, above anything codex RPCs realistically carry.
const WS_FRAME_CHUNK = 8 * 1024 * 1024;
const LISTENER_WAIT_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5_000;

// Listener processes spawned by this module. They are plain children (no
// detached/unref) so their lifecycle is tied to the dsh process: the exit
// hook below is a last-resort reaper for instances whose dispose() never ran.
const spawnedListeners = new Set();
let reaperInstalled = false;
function installListenerReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on("exit", () => {
    for (const proc of spawnedListeners) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  });
}

class CodexAppServer {
  constructor(options) {
    this.command = options.command;
    this.socketPath = options.socketPath;
    this.codexHome = options.codexHome;
    this.cwd = options.cwd;
    this.logger = options.logger;
    // dsh-harness-base service, resolved LAZILY: options.gateway is a getter
    // () => ctx.llmBase, so a gateway reload/reconcile is picked up on the
    // next call instead of holding a stale pre-restart instance. Its
    // localEndpoint() feeds the listener spawn args (the relay provider's
    // base_url, see #listenerArgs) and the spawn key.
    this.gateway = options.gateway;
    this.conn = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.requestHandlers = new Set();
    this.exitWaiters = new Set();
    this.ready = null;
    this.wsBuf = Buffer.alloc(0);
    this.wsFrame = null;
    // The listener we spawned, plus the spawn-args key it was started with.
    // destroy() never kills it; a key change kills and respawns it.
    this.listener = null;
    this.listenerKey = null;
  }

  #controlSocketPath() {
    // Explicit `socketPath` setting wins; otherwise the path is derived from
    // the codex home (configured, then inherited from the environment) and
    // the command name so the command wrapper and the adapter agree without
    // any configuration, and provider-specific servers never
    // collide with the vanilla codex control socket.
    if (this.socketPath) return path.resolve(this.socketPath);
    const home = this.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    return path.join(home, CONTROL_SOCKET_DIR, `${path.basename(this.command)}.sock`);
  }

  #listenerArgs(proxy) {
    // Pure parameter passing — no wrapper contract, no wrapper modification.
    // These -c overrides define a custom provider aimed at the gateway relay.
    // The built-in openai provider cannot be used: it defaults to remote
    // compaction V2 (keyed on is_openai()), and once a thread crosses ~90% of
    // its context window codex sends a `compaction_trigger` item that
    // non-OpenAI upstreams reject with 400 ("Error running remote compact
    // task"). That default has no config escape — `openai` is a reserved
    // provider id (defining model_providers.openai.* hard-errors config
    // loading) and features.remote_compaction_v2 is a removed, unwired flag.
    // A custom Responses provider defaults to remote_compaction=unsupported
    // (declared explicitly below so future default changes cannot silently
    // re-enable it) and carries no credential of its own; the gateway
    // strips/injects upstream auth itself. thread/start passes only the
    // qualified model id and the gateway routes by that prefix. The overrides
    // sit at ROOT level (before the subcommand): after `app-server` a -c
    // stops applying to root config.
    const argv = [];
    if (this.gateway) {
      // Five -c parameters on loopback, six on remote binds: select the relay
      // provider (the user config may point model_provider elsewhere for
      // direct use — that selection is not touched on disk), define it, aim
      // it at the relay, and disable remote compaction explicitly. On a
      // non-loopback bind the relay demands its bearer token, so env_key
      // points codex at the env var #spawnListener injects (the value never
      // rides in argv; the frozen env is what makes a token rotation respawn
      // the listener).
      argv.push("-c", 'model_provider="dsh-codex-relay"');
      argv.push("-c", 'model_providers.dsh-codex-relay.name="DSH Codex Relay"');
      argv.push("-c", `model_providers.dsh-codex-relay.base_url="${proxy.baseUrl}"`);
      argv.push("-c", 'model_providers.dsh-codex-relay.wire_api="responses"');
      argv.push(
        "-c",
        'model_providers.dsh-codex-relay.capabilities.remote_compaction="unsupported"',
      );
      if (proxy.token !== undefined) {
        argv.push("-c", 'model_providers.dsh-codex-relay.env_key="DSH_HARNESS_RELAY_TOKEN"');
      }
    }
    argv.push("app-server", "--listen", `unix://${this.#controlSocketPath()}`);
    return argv;
  }

  ensure() {
    // Always hand out the shared start promise. Checking `this.conn` first
    // would race: #start() sets `conn` synchronously, so a concurrent caller
    // could proceed before `initialize` completed and deadlock.
    if (this.ready) return this.ready;
    const start = this.#start();
    this.ready = start;
    return start;
  }

  async #start() {
    try {
      await this.#ensureListener();
      await this.#connect();
      const result = await this.#call("initialize", {
        clientInfo: { name: "dsh-harness-codex", title: null, version: "0.2.1" },
        // experimentalApi unlocks experimental thread/start fields such as
        // dynamicTools (same opt-in the codex TUI declares).
        capabilities: { experimentalApi: true },
      });
      this.logger?.info?.(`codex app-server ready: ${result.userAgent}`);
      return result;
    } catch (error) {
      this.#dropConnection();
      if (this.ready) this.ready = null;
      throw error;
    }
  }

  // Make sure some app-server is listening on the control socket. If the
  // socket is already live (our previous listener, or one started by the
  // codex CLI / another dsh process) attach to it. If we own the live
  // listener but the spawn flags changed, restart ours so the new flags apply.
  async #ensureListener() {
    // The gateway relay endpoint and the codex home are part of the spawn
    // key: a port change (different baseUrl), a token rotation (the gateway
    // re-issues its token on re-activate), or a codexHome change must
    // respawn the listener.
    const proxy = this.gateway().localEndpoint();
    const key = JSON.stringify([this.command, this.#controlSocketPath(), proxy.baseUrl, proxy.token ?? null, this.codexHome ?? null]);
    if (this.listener && this.listenerKey !== key) {
      const stale = this.listener;
      this.listener = null;
      this.listenerKey = null;
      try { stale.kill(); } catch { /* already gone */ }
      const deadline = Date.now() + 5000;
      while (await this.#socketAlive() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (await this.#socketAlive()) {
      // Live listener we didn't spawn (or spawned with matching flags).
      this.listenerKey ??= key;
      return;
    }
    this.listener = null;
    this.listenerKey = null;
    await this.#spawnListener();
  }

  #socketAlive() {
    return new Promise((resolve) => {
      const probe = net.connect(this.#controlSocketPath());
      const done = (value) => {
        probe.destroy();
        resolve(value);
      };
      probe.setTimeout(750, () => done(false));
      probe.once("connect", () => done(true));
      probe.once("error", () => done(false));
    });
  }

  #spawnListener() {
    return new Promise((resolve, reject) => {
      const proxy = this.gateway().localEndpoint();
      const key = JSON.stringify([this.command, this.#controlSocketPath(), proxy.baseUrl, proxy.token ?? null, this.codexHome ?? null]);
      let settled = false;
      installListenerReaper();
      // codex's --listen bind creates only the final `app-server-control`
      // level (and requires its parent to exist); make sure the whole path —
      // e.g. a freshly configured codexHome — exists before spawning.
      fs.mkdirSync(path.dirname(this.#controlSocketPath()), { recursive: true });
      const proc = spawn(this.command, this.#listenerArgs(proxy), {
        cwd: this.cwd ?? process.cwd(),
        // Plain child in dsh's own process group: it dies with dsh (dispose,
        // exit reaper, or terminal signals hitting the group). No detached,
        // no unref — the listener must never outlive the dsh process.
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          // The configured codex home must reach the spawned codex itself
          // (config.toml, auth, sessions, rollouts). Unset inherits the dsh
          // process environment unchanged.
          ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
          // Remote-bind relay token, read by codex through the env_key
          // #listenerArgs declares. Always paired with that env_key, so the
          // provider never references a missing variable; the frozen env is
          // why a token rotation must respawn (the spawn key covers it).
          ...(proxy.token ? { DSH_HARNESS_RELAY_TOKEN: proxy.token } : {}),
        },
      });
      spawnedListeners.add(proc);
      proc.once("exit", () => spawnedListeners.delete(proc));
      let stderrTail = "";
      proc.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
        this.logger?.warn?.(`codex app-server listener: ${chunk}`);
      });
      const failOnce = (message) => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch { /* already gone */ }
        reject(new Error(message));
      };
      proc.once("exit", (code) => {
        if (this.listener === proc) {
          this.listener = null;
          this.listenerKey = null;
        }
        // Startup-lock race: another process may have won the bind and its
        // socket may already be (or is about to be) live — attach to that
        // instead of failing. A genuinely broken spawn never opens the
        // socket, so the wait below only delays the error report.
        void (async () => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (await this.#socketAlive()) {
              if (settled) return;
              settled = true;
              this.listenerKey = key;
              this.logger?.info?.("codex app-server control socket is served by another process; attaching");
              resolve();
              return;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          failOnce(`codex app-server listener exited (code ${code})${stderrTail ? `: ${stderrTail.trim()}` : ""}`);
        })();
      });
      proc.once("error", (error) => failOnce(`codex app-server listener failed to spawn: ${error.message}`));

      void (async () => {
        const deadline = Date.now() + LISTENER_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (settled) return;
          if (await this.#socketAlive()) {
            if (settled) return;
            settled = true;
            this.listener = proc;
            this.listenerKey = key;
            this.logger?.info?.("codex app-server listener is up on the control socket");
            resolve();
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        failOnce(`codex app-server listener did not open the control socket within ${LISTENER_WAIT_TIMEOUT_MS}ms`);
      })();
    });
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const socketPath = this.#controlSocketPath();
      const socket = net.connect(socketPath);
      let buf = Buffer.alloc(0);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error(`timed out connecting to ${socketPath}`)));
      socket.once("error", (error) => fail(error));
      socket.once("connect", () => {
        socket.write(
          "GET /rpc HTTP/1.1\r\n"
          + "Host: localhost\r\n"
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n`
          + "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => {
        if (settled) {
          this.#onWsData(chunk);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const status = buf.slice(0, buf.indexOf("\r\n")).toString();
        if (!status.includes(" 101 ")) {
          fail(new Error(`codex app-server websocket handshake refused: ${status}`));
          return;
        }
        settled = true;
        socket.setTimeout(0);
        this.conn = socket;
        this.wsBuf = buf.slice(idx + 4);
        this.wsFrame = null;
        socket.on("error", (error) => {
          this.logger?.warn?.(`codex app-server connection error: ${error.message}`);
          this.#onDisconnect();
        });
        socket.on("close", () => this.#onDisconnect());
        resolve();
      });
    });
  }

  #onWsData(chunk) {
    this.wsBuf = Buffer.concat([this.wsBuf, chunk]);
    for (;;) {
      const frame = this.#parseWsFrame();
      if (!frame) return;
      const { opcode, fin, payload } = frame;
      if (opcode === 1 || opcode === 2 || opcode === 0) {
        // Text (we never receive binary; tolerate it) + continuation reassembly.
        if (this.wsFrame === null) {
          this.wsFrame = { opcode, chunks: [payload] };
        } else {
          this.wsFrame.chunks.push(payload);
        }
        if (!fin) continue;
        const message = Buffer.concat(this.wsFrame.chunks).toString();
        const kind = this.wsFrame.opcode;
        this.wsFrame = null;
        if (kind === 1) this.#onMessageText(message);
      } else if (opcode === 9) {
        this.#sendFrame(10, payload); // ping → pong
      } else if (opcode === 8) {
        try { this.conn.end(); } catch { /* already gone */ }
        this.#onDisconnect();
        return;
      }
      // 10 (pong): nothing to do.
    }
  }

  #parseWsFrame() {
    const buf = this.wsBuf;
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    const fin = (buf[0] & 0x80) !== 0;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const mask = masked ? buf.slice(off, off + 4) : null;
    if (masked) off += 4;
    if (buf.length < off + len) return null;
    const payload = Buffer.from(buf.slice(off, off + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.wsBuf = buf.slice(off + len);
    return { opcode, fin, payload };
  }

  #sendFrame(opcode, payload, fin = true) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = (fin ? 0x80 : 0) | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = (fin ? 0x80 : 0) | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.conn?.write(Buffer.concat([header, mask, masked]));
  }

  #sendText(text) {
    const payload = Buffer.from(text);
    if (payload.length <= WS_FRAME_CHUNK) {
      this.#sendFrame(1, payload);
      return;
    }
    // Fragment oversized messages: first frame is text, continuations are 0x0.
    let first = true;
    for (let off = 0; off < payload.length; off += WS_FRAME_CHUNK) {
      const piece = payload.slice(off, Math.min(off + WS_FRAME_CHUNK, payload.length));
      const last = off + WS_FRAME_CHUNK >= payload.length;
      this.#sendFrame(first ? 1 : 0, piece, last);
      first = false;
    }
  }

  #onMessageText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // JSON-RPC response
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "codex app-server error"));
        else p.resolve(msg.result);
      }
    } else if (msg.id !== undefined && msg.method !== undefined) {
      // Server→client request (e.g. item/tool/call). Handlers run async;
      // an unhandled request gets an error reply so codex never blocks
      // waiting forever.
      void this.#dispatchRequest(msg);
    } else if (msg.method) {
      // Notification (may carry emittedAtMs envelope)
      for (const h of this.handlers) {
        try { h(msg.method, msg.params); } catch { /* handler error */ }
      }
    }
  }

  async #dispatchRequest(msg) {
    for (const h of this.requestHandlers) {
      let handled = false;
      try {
        handled = await h(msg.method, msg.params, msg.id) === true;
      } catch (error) {
        this.respondError(msg.id, `dsh-harness-codex request handler failed: ${error.message}`);
        return;
      }
      if (handled) return;
    }
    this.respondError(msg.id, `dsh-harness-codex: no handler for ${msg.method}`);
  }

  respond(id, result) {
    // Request handlers must never throw, and a dead connection throws on write.
    try {
      this.#sendText(JSON.stringify({ id, result }));
    } catch (error) {
      this.logger?.warn?.(`codex app-server respond(${id}) failed: ${error.message}`);
    }
  }

  respondError(id, message) {
    try {
      this.#sendText(JSON.stringify({ id, error: { code: -32000, message } }));
    } catch (error) {
      this.logger?.warn?.(`codex app-server respondError(${id}) failed: ${error.message}`);
    }
  }

  onServerRequest(handler) {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  #onDisconnect() {
    if (this.conn) {
      try { this.conn.destroy(); } catch { /* already gone */ }
      this.conn = null;
    }
    this.wsBuf = Buffer.alloc(0);
    this.wsFrame = null;
    this.ready = null;
    for (const [, p] of this.pending) {
      p.reject(new Error("codex app-server connection closed"));
    }
    this.pending.clear();
    this.#wakeExitWaiters();
  }

  #dropConnection() {
    if (this.conn) {
      try { this.conn.destroy(); } catch { /* already gone */ }
      this.conn = null;
    }
    this.wsBuf = Buffer.alloc(0);
    this.wsFrame = null;
  }

  destroy() {
    // Drop only our client connection — the shared listener must survive so
    // the codex CLI (and a plugin reload) can keep using it.
    this.#dropConnection();
    this.ready = null;
    for (const [, p] of this.pending) {
      p.reject(new Error("codex app-server destroyed"));
    }
    this.pending.clear();
    this.handlers.clear();
    this.#wakeExitWaiters();
  }

  // Full teardown for dsh dispose/shutdown: also kill the listener we
  // spawned, since it is a plain child that must not outlive dsh.
  dispose() {
    this.destroy();
    const proc = this.listener;
    this.listener = null;
    this.listenerKey = null;
    if (proc) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  // Wake stream loops blocked on notifications when the connection goes away;
  // without this they would hang until the dsh-side abort signal fires.
  #wakeExitWaiters() {
    const waiters = [...this.exitWaiters];
    this.exitWaiters.clear();
    for (const waiter of waiters) {
      try { waiter(); } catch { /* waiter error */ }
    }
  }

  onExitWait(handler) {
    this.exitWaiters.add(handler);
    return () => this.exitWaiters.delete(handler);
  }

  #call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn, value) => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.pending.delete(id);
        fn(value);
      };
      // Per-call timeout: reject the call and drop the connection — a protocol
      // that stopped answering is untrusted, so the next request must get a
      // fresh connection. The shared listener keeps running either way.
      timer = setTimeout(() => {
        settle(reject, new Error(`codex app-server RPC ${method} timed out after ${RPC_TIMEOUT_MS}ms`));
        this.#onDisconnect();
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (result) => settle(resolve, result),
        reject: (error) => settle(reject, error),
      });
      try {
        this.#sendText(JSON.stringify({ method, id, params }));
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  async request(method, params) {
    await this.ensure();
    return this.#call(method, params);
  }

  onNotification(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

// ---------------------------------------------------------------------------
// Message conversion helpers
// ---------------------------------------------------------------------------

function extractText(content) {
  const parts = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

// DSH injects runtime-context user messages (file policy / skill catalog /
// time-sampling footers) AFTER the real user message. Codex must receive the
// user's actual prompt, not the footer, so skip injected messages when picking
// the turn input.
function isInjectedUserContext(text) {
  return text.startsWith("Current runtime context.")
    || text.startsWith("<system-reminder>")
    || text.startsWith("Time sampled while preparing");
}

function lastRealUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    if (isInjectedUserContext(extractText(messages[i].content))) continue;
    return i;
  }
  return -1;
}

// Title callers (e.g. dsh-rename replay) send the full DSH conversation plus
// a trailing titling instruction. A title thread is ephemeral and never shares
// the main thread, so project that prefix onto codex Responses-API items and
// inject it via thread/inject_items; only the last real user message goes out
// as turn/start input. System messages and options.system (digest callers pass
// the titling system prompt separately) become role "system" items.
function titlePrefixItems(messages, lastUserIdx, system) {
  const items = [];
  const pushMessage = (role, content) => {
    if (!Array.isArray(content)) return;
    const text = extractText(content).trim();
    if (!text) return;
    const contentType = role === "assistant" ? "output_text" : "input_text";
    items.push({ type: "message", role, content: [{ type: contentType, text }] });
  };
  if (typeof system === "string" && system.trim()) {
    items.push({ type: "message", role: "system", content: [{ type: "input_text", text: system }] });
  }
  for (let i = 0; i < lastUserIdx; i++) {
    const message = messages[i];
    if (message.role === "user" && isInjectedUserContext(extractText(message.content))) continue;
    if (message.role === "system" || message.role === "user" || message.role === "assistant") {
      pushMessage(message.role, message.content);
    }
  }
  return items;
}

// Codex models write for a plain-text terminal: a single newline is a visual
// line break. DSH renders assistant text as CommonMark, where a single
// newline is a soft break it collapses into a space — so codex's multi-line
// plain-text answers would cram onto one line. Upgrade soft breaks to hard
// breaks (two trailing spaces) outside fenced code; markdown structure is
// unaffected because tables, list items, and ATX headings ignore trailing
// spaces, and blank lines already break paragraphs on their own.
function normalizeLineBreaks(text) {
  if (!text?.includes("\n")) return text;
  const lines = text.split("\n");
  let inFence = false;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence || i === lines.length - 1) continue;
    const next = lines[i + 1];
    if (lines[i] === "" || next === "" || / {2,}$|\\$/.test(lines[i])) continue;
    lines[i] += "  ";
  }
  return lines.join("\n");
}

function exposeToolSet(value) {
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === "object") return new Set(Object.values(value));
  return new Set();
}

function volatileValue(value) {
  return typeof value?.get === "function" ? value.get() : value;
}


function storeReceiptResult(map, key, value) {
  map.set(key, value);
  if (map.size > 256) map.delete(map.keys().next().value);
}

// Reconstruct {oldText, newText} for one codex FileUpdateChange so dsh's
// edit/write diff card can re-diff and render it. codex carries full new
// content for adds, the removed content for deletes, and a unified diff for
// updates; hunks give both sides with a little context around them.
function fileChangeDiffPair(change) {
  const diff = String(change?.diff ?? "");
  const kind = typeof change?.kind === "string" ? change.kind : change?.kind?.type;
  if (kind === "add") return { path: change.path, oldText: null, newText: diff };
  if (kind === "delete") return { path: change.path, oldText: diff, newText: "" };
  const oldLines = [];
  const newLines = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // ---/+++ headers before the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else break; // trailing prose (e.g. "Moved to: …") or blank separator
  }
  return { path: change.path, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

// Character classes the preview parsers need; no regexes below.
const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
const isDigit = (ch) => ch >= "0" && ch <= "9";
const isDigits = (text) => text !== "" && [...text].every(isDigit);

// Shells the wrapper unwrap accepts (basename after the last `/`).
const SHELL_NAMES = new Set(["sh", "ash", "bash", "dash", "ksh", "mksh", "zsh"]);

// Codex wraps every shell run as `/bin/zsh -lc <script>`; the script is only
// quote-wrapped when it contains shell specials, and carries `'\''` / `\…`
// escapes inside. The wrapper carries nothing a reader wants, so previews show
// the command the model actually wrote: unwrap one shell/-c layer and undo the
// quoting. The closing quote may be missing when the script itself ends with
// broken quoting — the leading quote is still the wrapper, so the rest
// unwraps anyway. Returns the input unchanged when it is not such a wrapper
// (or unwrapping would empty it).
function unwrapShellCommand(command) {
  if (typeof command !== "string") return "";
  // Scan `<shell> <flags…> -c <script>`: the shell token's basename must be a
  // known shell, flags run until the first non-flag token, and one flag must
  // carry the `c`.
  let i = 0;
  const nextToken = () => {
    while (i < command.length && isSpace(command[i])) i++;
    const start = i;
    while (i < command.length && !isSpace(command[i])) i++;
    return command.slice(start, i);
  };
  const shell = nextToken();
  if (!SHELL_NAMES.has(shell.slice(shell.lastIndexOf("/") + 1))) return command;
  let sawC = false;
  for (;;) {
    while (i < command.length && isSpace(command[i])) i++;
    if (i >= command.length || command[i] !== "-") break;
    const start = i;
    while (i < command.length && !isSpace(command[i])) i++;
    if (command.slice(start, i).includes("c")) sawC = true;
  }
  if (!sawC || i >= command.length) return command;
  const body = command.slice(i);
  let inner = body;
  if (body[0] === "'") {
    if (body.endsWith("'") && body.length >= 2) inner = body.slice(1, -1).replaceAll("'\\''", "'");
  } else if (body[0] === '"') {
    // codex escapes " \ $ ` inside double quotes; other \X sequences stay.
    inner = body.slice(1, body.endsWith('"') && body.length >= 2 ? -1 : undefined);
    let unescaped = "";
    for (let j = 0; j < inner.length; j++) {
      const ch = inner[j];
      if (ch === "\\" && j + 1 < inner.length && "\"\\$`".includes(inner[j + 1])) {
        unescaped += inner[j + 1];
        j++;
      } else unescaped += ch;
    }
    inner = unescaped;
  }
  return inner.trim() === "" ? command : inner;
}

// Quote-aware argv split for preview matching. Refuses (null) anything with
// shell structure the matchers must not guess across: pipes, redirects,
// command separators. An unterminated quote is tolerated as "rest of text" —
// models emit stray trailing quotes, and the token content is still right.
function tokenizeCommand(text) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) {
        current += text.slice(i + 1);
        break;
      }
      current += text.slice(i + 1, end);
      quoted = true;
      i = end;
    } else if (ch === ">" || ch === "<" || ch === "|" || ch === ";" || ch === "&") {
      return null;
    } else if (isSpace(ch)) {
      if (current !== "" || quoted) { tokens.push(current); current = ""; quoted = false; }
    } else {
      current += ch;
    }
  }
  if (current !== "" || quoted) tokens.push(current);
  return tokens;
}

// Leading dash tokens are flags; flags in `valueFlags` swallow the next token.
// Combined short flags stay one flag string ("rn", "ne", "la").
function splitArgs(tokens, valueFlags = new Set()) {
  const flags = [];
  const values = new Map();
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-") && token.length > 1) {
      const flag = token.slice(1);
      flags.push(flag);
      if (valueFlags.has(flag) && i + 1 < tokens.length) values.set(flag, tokens[++i]);
    } else {
      positionals.push(token);
    }
  }
  return { flags, values, positionals };
}

// Preview rows keep only the file name — the full path stays in the expanded
// detail, and a long directory chain would eat the whole collapsed line.
function shortPath(path) {
  const base = path.split("/").filter(Boolean).pop();
  return base ?? path;
}

// One recognized read-only operation → its preview text; null = unrecognized.
// `window` is the line window a trailing `head` stage contributes; `filters`
// counts `-v` grep stages in a search pipeline.
function operationSummary(op, tokens, window = null, filters = 0) {
  const valueFlags = op === "grep" ? ["A", "B", "C", "m", "e", "f"]
    : op === "head" || op === "tail" ? ["n"] : [];
  const { flags, values, positionals } = splitArgs(tokens, new Set(valueFlags));

  if (op === "grep") {
    const pattern = values.get("e") ?? positionals.shift();
    if (pattern === undefined || pattern === "" || positionals.length === 0) return null;
    const shown = (pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern).replaceAll("'", "\\'");
    const recursive = flags.some((f) => f.includes("r") || f.includes("R"));
    // No window suffix: `head` caps the output, not the file, and `（前3行）`
    // reads like a file range next to the read rows.
    const tail = filters > 0 ? `（排除 ${filters} 项）` : "";
    if (positionals.length > 1) return `在 ${positionals.length} 个文件中搜索 '${shown}'${tail}`;
    const [target] = positionals;
    if (recursive && (target === "." || target === "./")) return `在当前目录递归搜索 '${shown}'${tail}`;
    return `在 ${shortPath(target)} 中${recursive ? "递归搜索" : "搜索"} '${shown}'${tail}`;
  }

  if (op === "sed") {
    if (!flags.some((f) => f.includes("n")) || positionals.length !== 2) return null;
    const script = positionals[0];
    if (!script.endsWith("p")) return null;
    const [from, to] = script.slice(0, -1).split(",");
    if (!isDigits(from) || !isDigits(to)) return null;
    return `读取 ${shortPath(positionals[1])} 第${from}–${to}行`;
  }

  if (op === "ls") {
    if (positionals.length === 0) return "列出当前目录";
    if (positionals.length <= 3) return `列出 ${positionals.map(shortPath).join("、")}`;
    return `列出 ${positionals.slice(0, 3).map(shortPath).join("、")} 等 ${positionals.length} 个路径`;
  }

  if (op !== "cat" && op !== "head" && op !== "tail") return null;
  // cat / head / tail → 读取.
  if (positionals.length !== 1) return null;
  // -f/-F keeps following (not a one-shot read); -c counts bytes, not lines.
  if (flags.some((f) => f.includes("f") || f.includes("F"))) return null;
  if (op !== "cat" && flags.some((f) => f.includes("c"))) return null;
  const path = shortPath(positionals[0]);
  if (op === "cat") return window === null ? `读取 ${path}` : `读取 ${path} 前${window}行`;
  const numberFlag = flags.find((f) => isDigits(f) || (f[0] === "n" && isDigits(f.slice(1))));
  const lines = numberFlag !== undefined
    ? Number(numberFlag.replace("n", ""))
    : Number(values.get("n")) || 10;
  return `读取 ${path} ${op === "head" ? "前" : "后"}${lines}行`;
}

// Top-level split on `|`, `&&` and `;` (a single `&` is not a separator),
// quote- and escape-aware: `\\|` inside a pattern never splits, quotes protect
// their content, an unterminated quote runs to the end of the text. `piped[i]`
// says whether parts[i] continues parts[i - 1] through a `|`.
function splitCommands(text) {
  const parts = [];
  const piped = [];
  let current = "";
  let quote = null;
  let viaPipe = false; // whether the NEXT part continues through a `|`
  const push = () => { parts.push(current.trim()); piped.push(viaPipe); current = ""; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "\\" && i + 1 < text.length) { current += ch + text[i + 1]; i++; continue; }
    if (ch === "|") { push(); viaPipe = true; continue; }
    if (ch === ";" || (ch === "&" && text[i + 1] === "&")) { push(); viaPipe = false; if (ch === "&") i++; continue; }
    current += ch;
  }
  push();
  return [parts, piped];
}

// `head [-N | -n N | -nN]` alone on a pipeline stage → its line window.
function headStageWindow(segment) {
  const tokens = tokenizeCommand(segment);
  if (tokens === null || tokens[0] !== "head" || tokens.length > 3) return null;
  if (tokens.length === 1) return 10;
  const [flag, value] = tokens.slice(1);
  if (flag === "-n") return tokens.length === 3 && isDigits(value) ? Number(value) : null;
  const digits = flag[0] === "-" ? flag.slice(1) : flag;
  return isDigits(digits) ? Number(digits) : null;
}

// Drop `2>/dev/null` (spaces around `>` tolerated) wherever it sits — display
// noise for a preview.
function stripDevNull(text) {
  for (let at = text.indexOf("2>"); at >= 0; at = text.indexOf("2>", at + 1)) {
    let j = at + 2;
    while (text[j] === " ") j++;
    const end = j + "/dev/null".length;
    if (!text.startsWith("/dev/null", j)) continue;
    if (text[end] !== undefined && !isSpace(text[end])) { at = end - 1; continue; }
    let start = at;
    while (start > 0 && text[start - 1] === " ") start--;
    text = text.slice(0, start) + text.slice(end);
    at = start - 1;
  }
  return text;
}

// Friendly preview: walk the command's segments (`|` stages, `&&`/`;`
// statements), start at the first recognizable read-only operation, and
// consume pipe-connected stages while they refine it (grep -v filters, a head
// window). Unrecognized stages stop consumption without discarding earlier
// matches (stderr-to-/dev/null is display noise). Nothing recognized → null,
// and the row keeps the raw command line.
const PREVIEW_OPS = new Set(["grep", "sed", "cat", "head", "tail", "ls"]);
function commandReadSummary(command) {
  const [parts, piped] = splitCommands(stripDevNull(command.trim()));
  if (parts.some((s) => s === "")) return null;
  let start = 0;
  let tokens;
  while (start < parts.length) {
    tokens = tokenizeCommand(parts[start]);
    if (tokens && tokens.length > 0 && PREVIEW_OPS.has(tokens[0])) break;
    start++;
  }
  if (start >= parts.length) return null;
  const [op, ...rest] = tokens;
  let window = null;
  let filters = 0;
  for (let k = start + 1; k < parts.length; k++) {
    if (!piped[k]) break; // && / ; starts a new statement
    const stage = tokenizeCommand(parts[k]);
    if (!stage || stage.length === 0) break;
    if (op === "grep" && stage[0] === "grep") {
      // Count only -v stages as exclusions; other greps just refine (the
      // second dash keeps long flags like --count out).
      if (stage.slice(1).some((t) => t[0] === "-" && t[1] !== "-" && t.includes("v"))) filters++;
      continue;
    }
    if (window === null) {
      const w = headStageWindow(parts[k]);
      if (w !== null) { window = w; continue; }
    }
    break;
  }
  return operationSummary(op, rest, window, filters);
}

// apply_patch rows: the change kinds are what a reader wants —
// `新建 a、修改 b、删除 c` — instead of the flat "file changes: paths".
function fileChangeSummary(changes) {
  const parts = [];
  for (const change of changes ?? []) {
    if (typeof change?.path !== "string" || !change.path) continue;
    const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
    const movePath = kind === "update" ? change.movePath ?? change.move_path : undefined;
    const verb = kind === "add" ? "新建" : kind === "delete" ? "删除" : movePath ? "移动" : "修改";
    parts.push(movePath ? `${verb} ${shortPath(change.path)} → ${shortPath(movePath)}` : `${verb} ${shortPath(change.path)}`);
  }
  if (parts.length === 0) return null;
  return parts.length <= 3 ? parts.join("、") : `${parts.slice(0, 3).join("、")} 等 ${parts.length} 处变更`;
}

// Codex commandExecution → dsh bash receipt call. bash's shellCall treats a
// missing description as a persistent session call and routes the result to
// the generic card, so description always carries a preview line: a friendly
// summary for well-known read-only shapes, else the first line of the
// unwrapped command. args.command stays codex's raw command verbatim — the
// unwrap only feeds the collapsed-row description, never the expanded detail.
function commandExecutionToolCall(item) {
  const command = unwrapShellCommand(item.command);
  return {
    name: "bash",
    args: {
      command: item.command,
      description: commandReadSummary(command) ?? command.split("\n")[0],
      ...(item.cwd ? { workdir: item.cwd } : {}),
    },
  };
}

// MCP receipt preview: the row title already names mcp__server__tool, so the
// summary carries the arguments instead of repeating "server/tool".
function mcpToolDescription(item) {
  const json = item.arguments && typeof item.arguments === "object"
    ? JSON.stringify(item.arguments)
    : null;
  if (!json || json === "{}") return `${item.server}/${item.tool}`;
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

function receiptOutput(item) {
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput || "(no output)";
    // dsh's bash row parses the trailing status marker for the exit code and
    // treats a non-zero exit as result data (isError stays false).
    const text = item.exitCode != null ? `${output}\n[exit code: ${item.exitCode}]` : output;
    return {
      content: [{ type: "text", text }],
      isError: false,
      meta: { exitCode: item.exitCode, ...(item.cwd ? { cwd: item.cwd } : {}) },
    };
  }
  if (item.type === "fileChange") {
    const failed = item.status === "failed" || item.status === "declined";
    return {
      content: [{ type: "text", text: failed ? `File change ${item.status}` : "File changes applied" }],
      isError: failed,
      // {path, oldText, newText} pairs are what dsh's diff-card model validates
      // against; the previous {path, diff} shape was ignored by the renderer.
      meta: { diffs: (item.changes ?? []).map(fileChangeDiffPair) },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      content: [{ type: "text", text: item.error ? `Error: ${item.error.message ?? "unknown"}` : item.result ? JSON.stringify(item.result) : "(no result)" }],
      isError: !!item.error,
      meta: { server: item.server, tool: item.tool },
    };
  }
  if (item.type === "imageView") {
    return { content: [{ type: "text", text: `Viewed image: ${item.path}` }] };
  }
  if (item.type === "webSearch") {
    const results = item.results ?? [];
    return { content: [{ type: "text", text: results.length > 0 ? JSON.stringify(results, null, 2).slice(0, 3000) : "No results" }] };
  }
  if (item.type === "imageGeneration") {
    return {
      // ImageGenerationFailure = {type, limitId, resetsAt} — there is no
      // human-readable message field, so render the structured fields.
      content: [{ type: "text", text: item.failure ? `Image generation failed: ${item.failure.type ?? "unknown"}${item.failure.limitId ? ` (limit ${item.failure.limitId}, resets ${item.failure.resetsAt ?? "unknown"})` : ""}` : `Generated image: ${item.savedPath ?? item.result}` }],
      isError: !!item.failure,
    };
  }
  return { content: [{ type: "text", text: "" }] };
}

// Expose allowlisted dsh tool schemas to codex as dynamic tools.
function buildDynamicTools(toolSchemas, exposeTools, excludeNames) {
  if (!exposeTools || exposeTools.size === 0 || !Array.isArray(toolSchemas)) return [];
  return toolSchemas
    .filter((s) => s?.name && !excludeNames.has(s.name) && exposeTools.has(s.name))
    .map((s) => ({
      type: "function",
      name: s.name,
      description: s.description ?? "",
      inputSchema: s.parameters && typeof s.parameters === "object" ? s.parameters : { type: "object", properties: {} },
    }));
}

// Map a dsh tool outcome ({content: [...blocks], isError}) onto the codex
// DynamicToolCallResponse wire shape ({contentItems: [...], success}).
function outcomeContentItems(outcome) {
  const items = [];
  for (const block of outcome?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      items.push({ type: "inputText", text: block.text });
    } else if (block?.type === "image" && typeof block.url === "string") {
      items.push({ type: "inputImage", imageUrl: block.url });
    } else if (block != null) {
      items.push({ type: "inputText", text: JSON.stringify(block) });
    }
  }
  if (items.length === 0) items.push({ type: "inputText", text: "(no output)" });
  return items;
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

class CodexAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.server = new CodexAppServer(options);
    this.logger = options.logger;
    // dsh-harness-base service getter (lazy, see CodexAppServer) for the model
    // catalog mirror + per-thread routing, and the dsh llm registry
    // (source-provider model metadata).
    this.gateway = options.gateway;
    this.llm = options.llm;
    this.model = options.model;
    this.sandbox = options.sandbox;
    this.approvalPolicy = options.approvalPolicy;
    this.exposeTools = exposeToolSet(volatileValue(options.exposeTools));
    this.toolExecutor = options.toolExecutor;
    this.cwd = options.cwd;
    // Optional resolver (sessionId) → the live session's workspace cwd.
    this.sessionCwd = options.sessionCwd ?? null;
    // Optional resolver (sessionId) → the session's DSH rollout log path
    // (current-generation artifact). Feeds the one-shot harness-switch
    // pointer in #rolloutPointerNote.
    this.sessionRollout = options.sessionRollout ?? null;
    this.warnedNullCwd = false;
    this.threads = new Map();
    this.receiptResults = new Map();
    this.activeCodexSessions = new Set();
    // Ongoing split codex turns, keyed by dsh session id ("" is never keyed:
    // one-shot ephemeral callers keep using #singleStream). One codex turn is
    // sliced into one dsh step per tool call so the durable event order stays
    // reasoning → tool → reasoning → tool instead of all tools first.
    this.codexTurns = new Map();
    // Long-lived state for an in-flight codex turn that is split across
    // multiple dsh steps (one stream() per tool-call boundary). Keyed by dsh
    // session id; notification handlers and the semantic event queue live
    // here so notifications arriving between two stream() calls are never
    // lost. Ephemeral callers (no sessionId) do not participate in splitting
    // and never get an entry here.
    this.codexTurns = new Map();

    // Fail-safe approvals: approvalPolicy "never" should keep codex from
    // asking, but if a server-side approval request arrives anyway, answer it
    // with an explicit decline instead of the generic "no handler" error —
    // codex understands a decision and adapts, an error may read as a
    // transport failure. Registered before any per-stream handler, which only
    // claims item/tool/call.
    this.server.onServerRequest((method, _params, requestId) => {
      const decision = this.#approvalDenial(method);
      if (!decision) return false;
      this.logger?.warn?.(`harness-codex: declined unexpected approval request ${method}`);
      this.server.respond(requestId, decision);
      return true;
    });
  }

  #approvalDenial(method) {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: { denied: { rejection: "approvals are disabled (approvalPolicy never)" } } };
      default:
        return null;
    }
  }

  // Resolve the cwd for a codex thread and warn once when it falls through
  // to null: on the wire null means "inherit the app-server process cwd",
  // which under launchd is "/" — never what a session wants.
  #effectiveCwd(sessionId) {
    const cwd = this.sessionCwd?.(sessionId) ?? this.cwd ?? null;
    if (cwd === null && !this.warnedNullCwd) {
      this.warnedNullCwd = true;
      this.logger?.warn?.("harness-codex: no session cwd and no configured cwd; codex threads will inherit the app-server process cwd");
    }
    return cwd;
  }

  // Codex thread ids live in adapter-private DSH replay metadata.
  async #thread(options, dynamicTools) {
    const model = options.model || this.model || null;
    const overrides = {
      model,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      // Per-session workspace: resolved from the live session's immutable
      // header (#effectiveCwd), falling back to the static config cwd, with
      // a warning when both are missing (null would inherit the app-server
      // process cwd — "/" under launchd).
      cwd: this.#effectiveCwd(options.sessionId),
    };
    if (!options.sessionId) {
      const response = await this.server.request("thread/start", {
        ...overrides,
        ephemeral: true,
        ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      });
      return { response, resumed: false };
    }

    const source = `dsh:${options.sessionId}`;
    let threadId = this.threads.get(options.sessionId);
    if (!threadId) {
      // Harness mode binds sessions to real providers, so the thread id is
      // read from the replay state alone — not gated on a "codex" source.
      const lastAssistant = options.messages.findLast((message) => message.role === "assistant");
      threadId = lastAssistant?.source?.replayState?.codexThreadId;
    }
    if (threadId) this.threads.set(options.sessionId, threadId);

    if (threadId) {
      try {
        const response = await this.server.request("thread/resume", {
          ...overrides,
          threadId,
          excludeTurns: true,
        });
        return { response, resumed: true };
      } catch (error) {
        // The codex rollout behind the stored thread id can disappear (session
        // cleanup, retention). Start a fresh thread rather than failing the
        // turn — no dsh history is replayed into it; codex rebuilds its own
        // context from the turns that follow, and the turn input carries the
        // DSH rollout pointer (#rolloutPointerNote) for anything earlier.
        this.logger?.warn?.(`harness-codex: thread/resume ${threadId} failed (${error.message}); starting a fresh thread`);
        this.threads.delete(options.sessionId);
      }
    }

    const response = await this.server.request("thread/start", {
      ...overrides,
      ephemeral: false,
      threadSource: source,
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
    });
    this.threads.set(options.sessionId, response.thread.id);
    return { response, resumed: false };
  }

  // One-shot turn-input pointer for a fresh codex thread on a session that
  // already has conversation history — a harness switch, or codex-side
  // context loss (thread/resume failed, replay metadata gone). The history
  // itself still never crosses into codex; instead the harness is told where
  // the DSH rollout records it, so it can read prior turns itself when it
  // needs them. A brand-new conversation (nothing before the last user
  // message) and resumed threads (codex restored its own context) get
  // nothing. A resolver failure only drops the pointer, never the turn.
  async #rolloutPointerNote(options, messages, lastUserIdx) {
    if (!options.sessionId || !this.sessionRollout || lastUserIdx <= 0) return null;
    if (!messages.slice(0, lastUserIdx).some((message) => message.role === "assistant")) return null;
    let rolloutPath = null;
    try {
      rolloutPath = await this.sessionRollout(options.sessionId);
    } catch (error) {
      this.logger?.warn?.(`harness-codex: rollout pointer for session ${options.sessionId} unavailable (${error.message})`);
      return null;
    }
    if (!rolloutPath) return null;
    return `[dsh] The turns of this conversation before this message are not in this thread's memory. They are recorded in the DSH session rollout at ${rolloutPath} — newline-delimited JSON events, zstd-framed when the file name ends in .jsonl.zstd. Read it there if you need context from earlier turns.`;
  }

  providerInfo(provider) {
    return { id: provider, name: "Codex" };
  }

  // The adapter stays registered as the "codex" provider but advertises no
  // models of its own: callers address it with qualified "<provider>/<model>"
  // ids (see resolveModel), not through the model picker.
  async listModels(_provider) {
    return [];
  }

  // Exact metadata for one qualified id: decode via the gateway, then forward
  // to the source provider's adapter so reasoning efforts (and any other
  // metadata) pass through unchanged.
  async resolveModel(provider, model) {
    const target = await this.gateway().resolve(model);
    const info = await this.llm.resolveModelInfo(target.provider, target.model);
    return {
      ...info,
      provider,
      id: model,
    };
  }

  // Live config updates from the settings user layer. The per-thread
  // overrides (sandbox/approvalPolicy/cwd) are read on every
  // turn/start, so they apply live. command, socketPath, and codexHome are
  // spawn flags: changing them tears the connection down; the next stream
  // respawns with the new flag (a changed flag also restarts the shared
  // listener).
  applyConfig(config) {
    const command = volatileValue(config.command);
    if (command !== this.server.command) {
      this.server.command = command;
      this.server.destroy();
    }
    const socketPath = volatileValue(config.socketPath) || undefined;
    if (socketPath !== this.server.socketPath) {
      this.server.socketPath = socketPath;
      this.server.destroy();
    }
    const codexHome = volatileValue(config.codexHome) || undefined;
    if (codexHome !== this.server.codexHome) {
      this.server.codexHome = codexHome;
      this.server.destroy();
    }
    this.model = volatileValue(config.model);
    this.sandbox = config.sandbox ?? "danger-full-access";
    this.approvalPolicy = config.approvalPolicy ?? "never";
    this.cwd = config.cwd;
    this.exposeTools = exposeToolSet(volatileValue(config.exposeTools));
  }

  // One-shot title generation on its own ephemeral thread. The caller's
  // conversation prefix (and titling system prompt) is injected into the
  // thread first, so replay callers are titling the real transcript rather
  // than the bare instruction. Errors propagate — dsh's title pipeline falls
  // back to its own first-prompt derivation.
  async *#titleStream(options) {
    const server = this.server;
    const messages = options.messages;
    const lastUserIdx = lastRealUserIndex(messages);
    const lastUserText = lastUserIdx >= 0 ? extractText(messages[lastUserIdx].content) : "";
    const model = options.model || this.model || null;
    const threadResp = await server.request("thread/start", {
      model,
      approvalPolicy: this.approvalPolicy,
      // Title turns only produce a short line of text; force read-only so
      // title generation can never touch the filesystem even when the main
      // threads run with a write-capable sandbox.
      sandbox: "read-only",
      cwd: this.#effectiveCwd(options.sessionId),
      ephemeral: true,
    });
    const threadId = threadResp.thread.id;

    const prefixItems = titlePrefixItems(messages, lastUserIdx, options.system);
    if (prefixItems.length > 0) {
      await server.request("thread/inject_items", { threadId, items: prefixItems });
    }

    const queue = [];
    let waitResolve = null;
    let finished = false;
    let turnId = null;
    let title = "";
    const unregister = server.onNotification((method, params) => {
      if (params?.threadId !== threadId) return;
      if (method === "item/agentMessage/delta") {
        title += params.delta ?? "";
        return;
      }
      if (method === "turn/completed") {
        finished = true;
        queue.push({ type: "done" });
        waitResolve?.();
      }
    });
    const onAbort = () => {
      if (turnId) server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    const onServerExit = server.onExitWait(() => {
      queue.push({ type: "error", error: new LlmError("codex app-server exited during title turn", "TRANSPORT") });
      waitResolve?.();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const turnResp = await server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: lastUserText || "continue", text_elements: [] }],
      });
      turnId = turnResp.turn.id;
      while (!finished) {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item.type === "error") throw item.error;
          if (item.type === "done") finished = true;
        }
        if (!finished) await new Promise((resolve) => { waitResolve = resolve; });
      }
    } finally {
      unregister();
      onServerExit();
      options.signal?.removeEventListener("abort", onAbort);
    }
    const line = title.trim().split("\n").find((candidate) => candidate.trim()) ?? "";
    if (!line) throw new LlmError("codex title turn produced no text", "TURN_FAILED");
    const finalTitle = line.trim().slice(0, 80);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: finalTitle };
    yield { type: "block-end", index: 0, block: { type: "text", text: finalTitle } };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  async *stream(options) {
    const messages = options.messages;

    // Session-title generation: a dedicated ephemeral codex thread, seeded
    // with the caller's conversation prefix, answers the title prompt; it
    // never touches the main conversation's thread.
    if (options.purpose === "session-title") {
      yield* this.#titleStream(options);
      return;
    }

    // Mark the codex session before any chunk is produced: the receipt-tool
    // interceptor in apply() gates on this set. One-shot callers without a
    // dsh session keep the legacy single-stream path; session turns go
    // through the per-session chunk-log state machine.
    this.activeCodexSessions.add(options.sessionId ?? "");

    if (!options.sessionId) {
      yield* this.#singleStream(options);
      return;
    }

    // Find the last user message — it becomes the turn input. Nothing else
    // crosses into codex: no dsh system prompt, no replayed conversation.
    // Codex runs on its own instructions and remembers via thread/resume.
    const lastUserIdx = lastRealUserIndex(messages);

    const turnInput = this.#buildTurnInput(messages, lastUserIdx);

    const sessionKey = options.sessionId;
    // Leftover state from a previous dsh turn is dead weight: its queue tail
    // belongs to an interrupted or already-concluded codex turn and must not
    // leak into this message. Retire it and start fresh (observed 2026-10-28:
    // without this, a user abort mid-exec left the state registered and the
    // next message drained a dead queue forever — 4 minutes of zero output).
    // A continuation step reuses the SAME dsh phase signal, so any signal
    // difference means the previous dsh turn ended.
    const stale = this.codexTurns.get(sessionKey);
    if (stale && (stale.abandoned || stale.signal !== (options.signal ?? null))) {
      if (stale.turnId) {
        this.server.request("turn/interrupt", { threadId: stale.threadId, turnId: stale.turnId }).catch(() => {});
      }
      this.destroyCodexTurn(sessionKey);
      this.logger?.warn?.(`harness-codex: retired stalled codex turn state for session ${sessionKey} (previous dsh turn ended without a terminal codex notification)`);
    }
    const existing = this.codexTurns.get(sessionKey);
    if (existing) {
      // Continuation step: the dsh loop executed the previous step's receipt
      // tool and calls back immediately. The codex turn is already running —
      // drain the next chunk range, never start another codex turn.
      yield* this.#driveTurn(existing);
      return;
    }

    // Fresh codex turn.
    const dynamicTools = buildDynamicTools(options.tools, this.exposeTools, new Set());
    const threadInfo = await this.#thread(options, dynamicTools);
    // Harness-switch turn (fresh thread + existing history): prepend the
    // one-shot DSH rollout pointer ahead of the user's message.
    if (!threadInfo.resumed) {
      const pointer = await this.#rolloutPointerNote(options, messages, lastUserIdx);
      if (pointer) turnInput.unshift({ type: "text", text: pointer, text_elements: [] });
    }
    const state = this.#createTurnState(sessionKey, options, {
      threadId: threadInfo.response.thread.id,
      knownReceiptNames: await this.#discoverReceiptNames(),
    });
    this.codexTurns.set(sessionKey, state);
    try {
      const turnResp = await this.server.request("turn/start", {
        threadId: state.threadId,
        // Fall back to a bare "continue" when the last user message carried
        // no usable content blocks.
        input: turnInput.length > 0 ? turnInput : [{ type: "text", text: "continue", text_elements: [] }],
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      });
      state.turnId = turnResp.turn.id;
      if (state.pendingInterrupt) {
        this.server.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).catch(() => {});
      }
    } catch (error) {
      this.destroyCodexTurn(sessionKey);
      throw error;
    }
    yield* this.#driveTurn(state);
  }

  // Turn input: every content block of the last real user message crosses
  // into codex — text blocks as text items, image blocks as {type:"image",
  // url} (v2 UserInput enum; inputImage/imageUrl is ONLY legal in the
  // item/tool/call response). dsh (pi-ai) sends base64 payloads {data,
  // mimeType}; codex takes no inline bytes, so the payload crosses as an
  // inline data URL — the form codex itself recommends (remote http(s)
  // image URLs are rejected at turn/start). An image with neither data nor
  // url fails the turn: dropping it would let codex answer as if the user
  // had never sent it. Anything else (e.g. dsh file receipts) has no codex
  // representation and is skipped with a single warning.
  #buildTurnInput(messages, lastUserIdx) {
    const turnInput = [];
    if (lastUserIdx < 0) return turnInput;
    const skippedTypes = [];
    for (const block of messages[lastUserIdx].content ?? []) {
      if (block?.type === "text") {
        if (typeof block.text === "string" && block.text) turnInput.push({ type: "text", text: block.text, text_elements: [] });
      } else if (block?.type === "image") {
        if (typeof block.data === "string" && block.data) {
          turnInput.push({ type: "image", url: `data:${block.mimeType ?? "image/png"};base64,${block.data}` });
        } else if (typeof block.url === "string" && block.url) {
          turnInput.push({ type: "image", url: block.url });
        } else {
          throw new LlmError("harness-codex: image block without data or url has no codex representation", "UNSUPPORTED_CONTENT");
        }
      } else if (block?.type) {
        skippedTypes.push(block.type);
      }
    }
    if (skippedTypes.length > 0) {
      this.logger?.warn?.(`harness-codex: dropped ${skippedTypes.length} content block(s) without a codex representation (${[...new Set(skippedTypes)].join(", ")})`);
    }
    return turnInput;
  }

  // Legacy single-generator path for one-shot callers without a dsh session
  // (and kept intact for behavior parity). Session turns go through the
  // per-session chunk-log state machine (#createTurnState / #driveTurn).
  async *#singleStream(options) {
    const server = this.server;
    const messages = options.messages;
    this.activeCodexSessions.add(options.sessionId ?? "");

    // Find the last user message — it becomes the turn input. Nothing else
    // crosses into codex: no dsh system prompt, no replayed conversation.
    // Codex runs on its own instructions and remembers via thread/resume.
    const lastUserIdx = lastRealUserIndex(messages);

    const lastUserText = lastUserIdx >= 0 ? extractText(messages[lastUserIdx].content) : "";

    const turnInput = this.#buildTurnInput(messages, lastUserIdx);

    const dynamicTools = buildDynamicTools(options.tools, this.exposeTools, new Set());
    const knownReceiptNames = new Set([
      "bash",
      "apply_patch",
      "view_image",
      "web_search",
      "image_generation",
    ]);
    let mcpCursor;
    try {
      do {
        const page = await server.request("mcpServerStatus/list", {
          detail: "toolsAndAuthOnly",
          ...(mcpCursor ? { cursor: mcpCursor } : {}),
        });
        for (const status of page.data ?? []) {
          for (const tool of Object.keys(status.tools ?? {})) {
            knownReceiptNames.add(`mcp__${status.name}__${tool}`);
          }
        }
        mcpCursor = page.nextCursor;
      } while (mcpCursor);
    } catch (error) {
      this.logger?.warn?.(`harness-codex: mcp tool discovery failed: ${error.message}`);
      mcpCursor = null;
    }
    const threadInfo = await this.#thread(options, dynamicTools);
    const threadResp = threadInfo.response;
    const threadId = threadResp.thread.id;
    // Event queue bridging async notifications to the generator
    const queue = [];
    let waitResolve = null;
    let finished = false;
    let turnId = null;
    // Set when the abort signal fires before turn/start resolved; the
    // interrupt is fired right after the turn id becomes known.
    let pendingInterrupt = false;
    let usage = null;
    // `started` marks blocks whose block-start chunk was actually enqueued —
    // text blocks only get it at emission time, so the turn/completed closer
    // never emits a block-end for a block the consumer never saw open.
    const blocks = new Map(); // itemId → { index, type, text, started, toolArgs? }
    // Item ids already warned about for deltas arriving without a block —
    // one warning per item, never per delta.
    const warnedUnknownDeltaItems = new Set();
    let nextBlockIndex = 0;
    let hadToolCalls = false;

    const enqueue = (item) => {
      queue.push(item);
      if (waitResolve) { waitResolve(); waitResolve = null; }
    };

    // Deltas for an item we never saw started would be dropped silently;
    // surface that once per item instead.
    const warnUnknownDelta = (method, itemId) => {
      if (warnedUnknownDeltaItems.has(itemId)) return;
      warnedUnknownDeltaItems.add(itemId);
      this.logger?.warn?.(`harness-codex: ${method} for unknown itemId ${itemId}; delta dropped`);
    };

    // Dynamic tool calls (dsh tools exposed via thread/start.dynamicTools):
    // codex sends an item/tool/call server request mid-turn; execute the real
    // dsh tool and answer it.
    const onServerRequest = server.onServerRequest(async (method, params, requestId) => {
      if (method !== "item/tool/call") return false;
      if (params?.threadId !== threadId) return false;
      if (process.env.DSH_CODEX_DEBUG) {
        process.stderr.write(`[codex] dynamic tool call tool=${params.tool} callId=${params.callId}\n`);
      }
      try {
        if (typeof this.toolExecutor !== "function") {
          throw new Error("no dsh tool executor configured (exposeTools is set but apply() did not wire ctx.tools)");
        }
        const outcome = await this.toolExecutor(params.tool, params.arguments ?? {}, options.signal);
        server.respond(requestId, {
          contentItems: outcomeContentItems(outcome),
          success: outcome?.isError !== true,
        });
      } catch (error) {
        server.respond(requestId, {
          contentItems: [{ type: "inputText", text: `Error: ${error?.message ?? String(error)}` }],
          success: false,
        });
      }
      return true;
    });

    const unregister = server.onNotification((method, params) => {
      if (params?.threadId !== threadId) return;

      if (method === "item/started") {
        const item = params.item;
        if (!item) return;
        const itemId = item.id;
        if (blocks.has(itemId)) return;

        if (process.env.DSH_CODEX_DEBUG) {
          process.stderr.write(`[codex] item/started type=${item.type} id=${itemId}\n`);
        }

        // Text / reasoning blocks — created immediately so ordering is correct.
        if (item.type === "agentMessage" || item.type === "plan") {
          const index = nextBlockIndex++;
          blocks.set(itemId, { index, type: "text", text: "", started: true });
          enqueue({ type: "chunk", chunk: { type: "block-start", index, blockType: "text" } });
          return;
        }
        if (item.type === "reasoning") {
          // One block per reasoning item (mirrors pi-ai's thinking_start),
          // so reasoning blocks interleave correctly with tool calls.
          const index = nextBlockIndex++;
          blocks.set(itemId, { index, type: "reasoning", text: "", started: true });
          enqueue({ type: "chunk", chunk: { type: "block-start", index, blockType: "reasoning" } });
          return;
        }

        // Tool-call blocks use codex's real names only for rendering. They are
        // deliberately not registered in dsh's model-visible tool registry.
        // dynamicToolCall is deliberately unmapped: the exposed dsh tool is
        // registered in dsh itself, and re-emitting its name would make the
        // agent loop execute it a second time.
        const toolCall = this.#toolCallFromItem(item);
        if (toolCall && !knownReceiptNames.has(toolCall.name)) {
          // No block for unregistered names: dsh-tools' dispatch re-resolves
          // every emitted tool call and would throw ToolNotFoundError, failing
          // the step. Log the drop instead of emitting a broken block.
          this.logger?.warn?.(`harness-codex: ${item.type} maps to unregistered tool "${toolCall.name}"; item skipped without a block`);
        } else if (toolCall) {
          hadToolCalls = true;
          const index = nextBlockIndex++;
          const argsStr = JSON.stringify(toolCall.args);
          blocks.set(itemId, { index, type: "tool-call", text: "", toolArgs: argsStr, name: toolCall.name, started: true });
          enqueue({ type: "chunk", chunk: { type: "block-start", index, blockType: "tool-call" } });
          enqueue({
            type: "chunk",
            chunk: { type: "tool-call-delta", index, id: itemId, name: toolCall.name, argumentsDelta: argsStr },
          });
        }
      } else if (method === "item/commandExecution/outputDelta") {
        const { itemId, delta } = params;
        const block = blocks.get(itemId);
        if (!block) {
          warnUnknownDelta(method, itemId);
          return;
        }
        block.text += delta;
      } else if (method === "item/completed") {
        const item = params.item;
        if (!item) return;
        const block = blocks.get(item.id);
        if (!block) return;

        // Close text / reasoning blocks on their own item/completed.
        if (item.type === "agentMessage" || item.type === "plan") {
          block.closed = true;
          block.text = normalizeLineBreaks(item.text ?? block.text);
          return;
        }
        if (item.type === "reasoning") {
          block.closed = true;
          enqueue({
            type: "chunk",
            chunk: { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } },
          });
          return;
        }

        if (item.type !== "agentMessage" && item.type !== "plan" && item.type !== "reasoning") {
          // All codex tool item types share one receipt shape: stash the result
          // for the dsh receipt stub, close the block, then hand the agent loop
          // a settlement chunk so it can commit tool/call + tool/result right
          // away instead of waiting for the stream to finish.
          const result = receiptOutput(item);
          storeReceiptResult(this.receiptResults, item.id, result);
          block.closed = true;
          const toolBlock = { type: "tool-call", id: item.id, name: block.name, arguments: block.toolArgs };
          enqueue({
            type: "chunk",
            chunk: { type: "block-end", index: block.index, block: toolBlock },
          });
          enqueue({
            type: "chunk",
            chunk: { type: "tool-call-result", index: block.index, block: toolBlock, result },
          });
        }
      } else if (method === "item/agentMessage/delta") {
        const { itemId, delta } = params;
        const block = blocks.get(itemId);
        if (!block) { warnUnknownDelta(method, itemId); return; }
        block.text += delta;
        enqueue({ type: "chunk", chunk: { type: "text-delta", index: block.index, text: delta } });
      } else if (method === "item/plan/delta") {
        const { itemId, delta } = params;
        const block = blocks.get(itemId);
        if (!block) { warnUnknownDelta(method, itemId); return; }
        block.text += delta;
        enqueue({ type: "chunk", chunk: { type: "text-delta", index: block.index, text: delta } });
      } else if (method === "item/reasoning/textDelta") {
        const { itemId, delta } = params;
        const block = blocks.get(itemId);
        if (!block) { warnUnknownDelta(method, itemId); return; }
        block.text += delta;
        enqueue({ type: "chunk", chunk: { type: "reasoning-delta", index: block.index, text: delta } });
      } else if (method === "item/reasoning/summaryTextDelta") {
        const { itemId, delta } = params;
        const block = blocks.get(itemId);
        if (!block) { warnUnknownDelta(method, itemId); return; }
        block.text += delta;
        enqueue({ type: "chunk", chunk: { type: "reasoning-delta", index: block.index, text: delta } });
      } else if (method === "item/reasoning/summaryPartAdded") {
        // New summary part; separate it from what is already shown.
        const block = blocks.get(params.itemId);
        if (!block || !block.text) return;
        block.text += "\n\n";
        enqueue({ type: "chunk", chunk: { type: "reasoning-delta", index: block.index, text: "\n\n" } });
      } else if (method === "thread/tokenUsage/updated") {
        const u = params.tokenUsage?.last;
        if (u) {
          usage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            ...(u.cachedInputTokens ? { cacheReadTokens: u.cachedInputTokens } : {}),
            ...(u.reasoningOutputTokens ? { reasoningTokens: u.reasoningOutputTokens } : {}),
          };
        }
      } else if (method === "turn/completed") {
        const turn = params.turn;
        if (process.env.DSH_CODEX_DEBUG) {
          process.stderr.write(`[codex] turn/completed status=${turn.status} hadToolCalls=${hadToolCalls}\n`);
        }
        // Close blocks left open by a missing item/completed notification.
        for (const [itemId, block] of blocks) {
          if (!block.started || block.closed) continue;
          block.closed = true;
          enqueue({
            type: "chunk",
            chunk: {
              type: "block-end",
              index: block.index,
              block: block.type === "tool-call"
                ? { type: "tool-call", id: itemId, name: block.name, arguments: block.toolArgs }
                : { type: block.type, text: block.text },
            },
          });
        }

        if (usage) enqueue({ type: "chunk", chunk: { type: "usage", usage } });

        const status = turn.status;
        if (status === "completed") {
          enqueue({
            type: "chunk",
            chunk: {
              type: "finish",
              reason: { kind: "stop" },
              replayState: { codexThreadId: threadId },
            },
          });
        } else if (status === "interrupted") {
          enqueue({
            type: "chunk",
            chunk: {
              type: "finish",
              reason: { kind: "aborted", failure: { message: "Codex turn interrupted", code: "ABORTED" } },
            },
          });
        } else {
          enqueue({
            type: "chunk",
            chunk: {
              type: "finish",
              reason: {
                kind: "error",
                failure: { message: turn.error?.message || `Codex turn ${status}`, code: "TURN_FAILED" },
              },
            },
          });
        }
        enqueue({ type: "done" });
        finished = true;
      }
    });

    // Abort handling: interrupt the codex turn
    const onAbort = () => {
      if (turnId) {
        server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      } else {
        pendingInterrupt = true;
      }
    };
    const onServerExit = server.onExitWait(() => {
      enqueue({ type: "error", error: new LlmError("codex app-server exited mid-turn", "TRANSPORT") });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const turnResp = await server.request("turn/start", {
        threadId,
        // Fall back to a bare "continue" when the last user message carried
        // no usable content blocks.
        input: turnInput.length > 0 ? turnInput : [{ type: "text", text: "continue", text_elements: [] }],
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      });
      turnId = turnResp.turn.id;
      // Abort fired before turn/start resolved: interrupt now that the turn
      // id is known.
      if (pendingInterrupt) {
        server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      }

      // Drain the event queue until turn/completed
      while (true) {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item.type === "chunk") {
            yield item.chunk;
          }
          else if (item.type === "error") {
            throw item.error;
          }
          else if (item.type === "done") {
            if (process.env.DSH_CODEX_DEBUG) {
              process.stderr.write(`[codex] generator exiting (done) threadId=${threadId}\n`);
            }
            return;
          }
        }
        await new Promise((resolve) => { waitResolve = resolve; });
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      // An aborted call surfaces its original error instead of a fabricated
      // TRANSPORT wrap — the caller asked to stop, that is not a transport
      // failure.
      if (options.signal?.aborted) throw error;
      throw new LlmError(
        `codex turn failed: ${error.message}`,
        "TRANSPORT",
        { cause: error },
      );
    } finally {
      if (!hadToolCalls) this.activeCodexSessions.delete(options.sessionId ?? "");
      unregister();
      onServerRequest();
      onServerExit();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  // -------------------------------------------------------------------------
  // Split-turn state machine (sessions with a dsh session id)
  //
  // One codex turn may interleave several reasoning → tool rounds. dsh gives
  // an adapter exactly one stream() per step and appends tool/call +
  // tool/result for tool-call content blocks only AFTER the stream finishes
  // (when no tool-call-result chunk is emitted). Each codex tool call is
  // therefore sliced into its own dsh step:
  //
  //   segment 1 stream(): reasoning1 + toolcall1 + finish(stop)
  //     → assistant/message appends first, then the receipt tool executes and
  //       tool/call + tool/result append after it; the loop immediately calls
  //       stream() again (step returned null after tool dispatch)
  //   segment 2 stream(): reasoning2 + toolcall2 + finish(stop)
  //   ...
  //   final stream(): pending text answer, replayed with no tool block
  //
  // Durable seq order then matches the real codex order. A standalone
  // tool-less (reasoning-only) segment must never be emitted: the dsh loop
  // treats a finished step without tool calls as turn completion, which would
  // strand the codex turn and its buffered final answer. Reasoning arriving
  // after a tool is held as an "orphan" and leads the next tool's segment; if
  // no further tool follows, it merges into the last tool's segment at
  // turn/completed.
  // -------------------------------------------------------------------------

  async #discoverReceiptNames() {
    const names = new Set(["bash", "apply_patch", "view_image", "web_search", "image_generation"]);
    let cursor;
    try {
      do {
        const page = await this.server.request("mcpServerStatus/list", {
          detail: "toolsAndAuthOnly",
          ...(cursor ? { cursor } : {}),
        });
        for (const status of page.data ?? []) {
          for (const tool of Object.keys(status.tools ?? {})) {
            names.add(`mcp__${status.name}__${tool}`);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      this.logger?.warn?.(`harness-codex: mcp tool discovery failed: ${error.message}`);
    }
    return names;
  }

  // Map a codex tool item onto the display-only dsh receipt tool call.
  // dynamicToolCall is deliberately unmapped: the exposed dsh tool is
  // registered in dsh itself and must not be executed twice.
  #toolCallFromItem(item) {
    if (item.type === "commandExecution") return commandExecutionToolCall(item);
    if (item.type === "fileChange") {
      return { name: "apply_patch", args: { description: fileChangeSummary(item.changes) ?? "file changes" } };
    }
    if (item.type === "mcpToolCall") {
      return {
        name: `mcp__${item.server}__${item.tool}`,
        args: {
          description: mcpToolDescription(item),
          ...(item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments) ? { arguments: item.arguments } : {}),
        },
      };
    }
    if (item.type === "imageView") return { name: "view_image", args: { path: item.path } };
    if (item.type === "webSearch") return { name: "web_search", args: { query: item.query ?? "" } };
    if (item.type === "imageGeneration") return { name: "image_generation", args: { prompt: item.revisedPrompt ?? "" } };
    return null;
  }

  #createTurnState(sessionKey, options, { threadId, knownReceiptNames }) {
    const server = this.server;
    const state = {
      sessionKey,
      signal: options.signal ?? null,
      threadId,
      turnId: null,
      // Set when abort fires before turn/start resolved.
      pendingInterrupt: false,
      // Set when the driving dsh turn's signal aborted: the codex turn is
      // being interrupted and its remaining output has no consumer.
      abandoned: false,
      knownReceiptNames,
      // itemId → { kind, index, text, closed, name?, toolArgs? }
      blocks: new Map(),
      warned: new Set(),
      // Append-only chunk log. Codex notifications append chunks with
      // turn-global block indexes; stream() drains from `cursor`. A finish
      // chunk ends one dsh step: a tool completion appends a pause finish so
      // dsh runs the receipt stub before codex continues, and
      // turn/completed appends the terminal finish (stop/aborted/error).
      queue: [],
      cursor: 0,
      nextIndex: 0,
      waiters: new Set(),
      usage: null,
      done: false,
      exitError: null,
      unregister: null,
      unrequest: null,
      unexit: null,
      onAbort: null,
    };

    state.wake = () => {
      const waiters = [...state.waiters];
      state.waiters.clear();
      for (const resolve of waiters) resolve();
    };
    state.push = (chunk) => {
      state.queue.push(chunk);
      state.wake();
    };
    state.warnUnknown = (method, itemId) => {
      if (state.warned.has(itemId)) return;
      state.warned.add(itemId);
      this.logger?.warn?.(`harness-codex: ${method} for unknown itemId ${itemId}; delta dropped`);
    };

    // One abort listener per dsh turn: every step of a turn shares the phase
    // signal, so this also covers the between-steps window (receipt stub
    // execution) where no stream() call is draining.
    state.onAbort = () => {
      state.abandoned = true;
      if (state.turnId) {
        server.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).catch(() => {});
      } else {
        state.pendingInterrupt = true;
      }
    };
    state.signal?.addEventListener("abort", state.onAbort, { once: true });

    state.unregister = server.onNotification((method, params) => {
      this.#onTurnNotification(state, method, params);
    });
    state.unrequest = server.onServerRequest(async (method, params, requestId) => {
      if (method !== "item/tool/call" || params?.threadId !== threadId) return false;
      if (process.env.DSH_CODEX_DEBUG) {
        process.stderr.write(`[codex] dynamic tool call tool=${params.tool} callId=${params.callId}\n`);
      }
      try {
        if (typeof this.toolExecutor !== "function") {
          throw new Error("no dsh tool executor configured (exposeTools is set but apply() did not wire ctx.tools)");
        }
        const outcome = await this.toolExecutor(params.tool, params.arguments ?? {}, state.signal);
        server.respond(requestId, {
          contentItems: outcomeContentItems(outcome),
          success: outcome?.isError !== true,
        });
      } catch (error) {
        server.respond(requestId, {
          contentItems: [{ type: "inputText", text: `Error: ${error?.message ?? String(error)}` }],
          success: false,
        });
      }
      return true;
    });
    state.unexit = server.onExitWait(() => {
      state.exitError = new LlmError("codex app-server exited mid-turn", "TRANSPORT");
      state.done = true;
      state.wake();
    });
    return state;
  }

  destroyCodexTurn(sessionKey) {
    const state = this.codexTurns.get(sessionKey);
    if (state) {
      state.unregister?.();
      state.unrequest?.();
      state.unexit?.();
      if (state.onAbort && state.signal) state.signal.removeEventListener("abort", state.onAbort);
      this.codexTurns.delete(sessionKey);
    }
    this.activeCodexSessions.delete(sessionKey);
  }

  #onTurnNotification(state, method, params) {
    if (params?.threadId !== state.threadId) return;

    if (method === "item/started") {
      const item = params.item;
      if (!item) return;
      const itemId = item.id;
      if (state.blocks.has(itemId)) return;

      if (process.env.DSH_CODEX_DEBUG) {
        process.stderr.write(`[codex] item/started type=${item.type} id=${itemId}\n`);
      }

      // Text / reasoning blocks stream the moment codex starts them; the
      // pause finish after a tool completion separates dsh steps, so a block
      // arriving after a tool naturally opens the next step — no holding.
      if (item.type === "agentMessage" || item.type === "plan") {
        const index = state.nextIndex++;
        state.blocks.set(itemId, { kind: "text", index, text: "", closed: false });
        state.push({ type: "block-start", index, blockType: "text" });
        return;
      }
      if (item.type === "reasoning") {
        const index = state.nextIndex++;
        state.blocks.set(itemId, { kind: "reasoning", index, text: "", closed: false });
        state.push({ type: "block-start", index, blockType: "reasoning" });
        return;
      }

      const toolCall = this.#toolCallFromItem(item);
      if (!toolCall) return;
      if (!state.knownReceiptNames.has(toolCall.name)) {
        // dsh-tools' dispatch re-resolves every emitted tool call and would
        // throw ToolNotFoundError for an unregistered name; drop the block.
        this.logger?.warn?.(`harness-codex: ${item.type} maps to unregistered tool "${toolCall.name}"; item skipped without a block`);
        return;
      }
      const index = state.nextIndex++;
      const argsStr = JSON.stringify(toolCall.args);
      state.blocks.set(itemId, { kind: "tool-call", index, text: "", closed: false, name: toolCall.name, toolArgs: argsStr });
      state.push({ type: "block-start", index, blockType: "tool-call" });
      state.push({ type: "tool-call-delta", index, id: itemId, name: toolCall.name, argumentsDelta: argsStr });
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const block = state.blocks.get(params.itemId);
      if (!block) { state.warnUnknown(method, params.itemId); return; }
      block.text += params.delta;
      return;
    }

    if (method === "item/completed") {
      const item = params.item;
      if (!item) return;
      const block = state.blocks.get(item.id);
      if (!block) return;

      if (item.type === "agentMessage" || item.type === "plan") {
        block.closed = true;
        block.text = normalizeLineBreaks(item.text ?? block.text);
        state.push({
          type: "block-end",
          index: block.index,
          block: { type: "text", text: block.text },
        });
        return;
      }
      if (item.type === "reasoning") {
        block.closed = true;
        state.push({
          type: "block-end",
          index: block.index,
          block: { type: "reasoning", text: block.text },
        });
        return;
      }

      // Tool item: stash the receipt result for the dsh receipt stub (which
      // the agent loop invokes after this step finishes), close the block,
      // then append the pause finish. The pause splits the dsh step here so
      // the receipt executes before codex continues; everything codex emits
      // afterwards (final answer included) lands in the next step naturally.
      // No tool-call-result chunk: mid-stream settlement would append tool
      // events BEFORE this step's assistant/message, inverting the order.
      const result = receiptOutput(item);
      storeReceiptResult(this.receiptResults, item.id, result);
      block.closed = true;
      state.push({
        type: "block-end",
        index: block.index,
        block: { type: "tool-call", id: item.id, name: block.name, arguments: block.toolArgs },
      });
      state.push({ type: "finish", reason: { kind: "stop" }, replayState: { codexThreadId: state.threadId } });
      return;
    }

    if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      const block = state.blocks.get(params.itemId);
      if (!block) { state.warnUnknown(method, params.itemId); return; }
      block.text += params.delta;
      state.push({ type: "text-delta", index: block.index, text: params.delta });
      return;
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      const block = state.blocks.get(params.itemId);
      if (!block) { state.warnUnknown(method, params.itemId); return; }
      block.text += params.delta;
      state.push({ type: "reasoning-delta", index: block.index, text: params.delta });
      return;
    }

    if (method === "item/reasoning/summaryPartAdded") {
      const block = state.blocks.get(params.itemId);
      if (!block || !block.text) return;
      block.text += "\n\n";
      state.push({ type: "reasoning-delta", index: block.index, text: "\n\n" });
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const u = params.tokenUsage?.last;
      if (u) {
        state.usage = {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          ...(u.cachedInputTokens ? { cacheReadTokens: u.cachedInputTokens } : {}),
          ...(u.reasoningOutputTokens ? { reasoningTokens: u.reasoningOutputTokens } : {}),
        };
      }
      return;
    }

    if (method === "turn/completed") {
      this.#onTurnCompleted(state, params.turn);
    }
  }

  #onTurnCompleted(state, turn) {
    // Only the turn this state is driving may close it. A retired stale
    // turn's late completion (the retirement's own turn/interrupt settles the
    // old turn AFTER a fresh turn already started) must never terminate the
    // new state — before the turnId filter it killed the fresh turn with a
    // fabricated "Codex turn interrupted" finish.
    if (state.turnId === null || turn.id !== state.turnId) return;
    if (process.env.DSH_CODEX_DEBUG) {
      process.stderr.write(`[codex] turn/completed status=${turn.status}\n`);
    }

    // Close any still-open blocks: codex turns can end without settling
    // every item (failed/interrupted turns), and an unclosed block would
    // leave the step's assembler partial dangling.
    for (const [itemId, block] of state.blocks) {
      if (block.closed) continue;
      block.closed = true;
      state.push({
        type: "block-end",
        index: block.index,
        block: block.kind === "tool-call"
          ? { type: "tool-call", id: itemId, name: block.name, arguments: block.toolArgs }
          : { type: block.kind, text: block.text },
      });
    }

    if (state.usage && turn.status === "completed") {
      state.push({ type: "usage", usage: state.usage });
    }
    if (turn.status === "completed") {
      state.push({ type: "finish", reason: { kind: "stop" }, replayState: { codexThreadId: state.threadId } });
    } else if (turn.status === "interrupted") {
      state.push({ type: "finish", reason: { kind: "aborted", failure: { message: "Codex turn interrupted", code: "ABORTED" } } });
    } else {
      state.push({
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: turn.error?.message || `Codex turn ${turn.status}`, code: "TURN_FAILED" },
        },
      });
    }
    state.done = true;
    state.wake();
  }

  // Yield queued chunks for one dsh step. Every finish chunk ends the step:
  // a pause finish lets dsh run the receipt stub and call stream() again,
  // the terminal finish ends the dsh turn and tears the state down.
  async *#driveTurn(state) {
    while (true) {
      if (state.exitError) {
        this.destroyCodexTurn(state.sessionKey);
        throw state.exitError;
      }
      if (state.cursor < state.queue.length) {
        const chunk = state.queue[state.cursor++];
        if (chunk.type === "finish") {
          if (state.done) this.destroyCodexTurn(state.sessionKey);
          yield chunk;
          return;
        }
        yield chunk;
        continue;
      }
      if (state.done) return;
      await new Promise((resolve) => { state.waiters.add(resolve); });
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

// Receipt-stub tracking, keyed on the agent's ctx — the identity the scope
// registration lives in — as { adapter, byName }. Module-level on purpose:
// cordis re-runs apply() on plugin reload while the ESM module persists, so
// the next instance can reach the previous instance's disposers and replace
// its dead-map stubs; a per-apply WeakMap would orphan them forever.
const receiptToolsRegistered = new WeakMap();

function apply(ctx, config) {
  // Codex executes its own tools inside the app-server; the tool-call blocks we
  // emit are display receipts. They must resolve as REAL dsh tool definitions,
  // because dsh-tools' normalizeDispatchResult re-resolves the tool for every
  // successful (isError: false) result and throws ToolNotFoundError for
  // unregistered names. Registering them on the codex session's agent scope
  // keeps them invisible to every other session (no global-registry leak)
  // while letting the dispatch complete and carry content + meta (diffs, exit
  // code) into the transcript.
  const interceptCodexReceipts = (adapter) => {
    // These stubs must stay registered for every codex-emitted receipt name:
    // the dispatch path re-resolves each tool call it executes, and an
    // unregistered name would throw ToolNotFoundError and fail the step.
    const RECEIPT_TOOL_NAMES = new Set(["bash", "apply_patch", "view_image", "web_search", "image_generation"]);
    const receiptToolDefinition = (name) => ({
      name,
      description: `Codex ${name} call receipt (display only; execution happened inside codex).`,
      parameters: { type: "object", properties: {} },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => Array.isArray(value?.content) && value.content.length > 0
          ? value.content
          : [{ type: "text", text: "(no output)" }],
        // dsh-tools' snapshotProjection rejects undefined ("non-lossless
        // JSON"): receipts without meta (mcp/image/web/imageGeneration)
        // must yield null, not undefined.
        presentationMeta: (_args, value) => value?.meta ?? null,
      },
      execute: async (_args, exec) => {
        const result = adapter.receiptResults.get(exec.callId) ?? {
          content: [{ type: "text", text: `No result found for ${exec.callId}` }],
          isError: true,
        };
        adapter.receiptResults.delete(exec.callId);
        return result;
      },
    });
    const dropEntry = (entry) => {
      for (const disposer of entry?.byName.values() ?? []) {
        if (typeof disposer !== "function") continue;
        try {
          disposer();
        } catch (error) {
          ctx.logger?.warn?.(`harness-codex: failed to unregister receipt stub: ${error.message}`);
        }
      }
    };
    const ensureReceiptTool = (agent, name) => {
      const agentCtx = agent?.ctx;
      if (!agentCtx?.tools || typeof agentCtx.tools.register !== "function") {
        ctx.logger?.warn?.(`harness-codex: agent ctx has no tools service; receipt "${name}" not registered`);
        return false;
      }
      // A stub left by a previous adapter instance (plugin reload) answers
      // from a dead receiptResults map and is invisible to this instance's
      // tracking; dispose the stale generation and re-register fresh.
      let entry = receiptToolsRegistered.get(agentCtx);
      if (entry?.adapter !== adapter) {
        dropEntry(entry);
        entry = { adapter, byName: new Map() };
        receiptToolsRegistered.set(agentCtx, entry);
      }
      if (entry.byName.has(name)) return true;
      try {
        entry.byName.set(name, agentCtx.tools.register(receiptToolDefinition(name)));
      } catch (error) {
        ctx.logger?.warn?.(`harness-codex: failed to register scope-local receipt tool "${name}": ${error.message}`);
        entry.byName.set(name, null);
        return false;
      }
      return true;
    };
    // Scoped registrations shadow the global tool for the agent's whole
    // lifetime, so a receipt stub left behind after the codex turn ends keeps
    // answering "No result found" for every native bash/apply_patch call —
    // the harness switch back to dsh looks broken (observed 2026-10-28:
    // session-ee27753c, three "ls" calls in a row all stub-answered after the
    // user switched the session back to the dsh harness). The claim release
    // alone cannot undo the registration, so drop on two triggers; a later
    // codex turn re-registers on demand:
    // - the session's turn/start while unclaimed — session/event observers
    //   run synchronously inside append, BEFORE the dsh loop assembles the
    //   request, so the first post-switch turn's model-facing tool list is
    //   the real one instead of the stubs' display-only schemas;
    // - the first exec that finds no claim (fallback for a stale claim
    //   racing a dsh turn).
    const dropReceiptTools = (agent) => {
      const agentCtx = agent?.ctx;
      const registered = receiptToolsRegistered.get(agentCtx);
      if (!registered?.byName.size) return;
      receiptToolsRegistered.delete(agentCtx);
      dropEntry(registered);
    };
    ctx.on("session/event", (session, event) => {
      if (event?.type !== "turn/start") return;
      const sessionId = session?.id;
      if (!sessionId || adapter.activeCodexSessions.has(sessionId)) return;
      dropReceiptTools(ctx.get("agents")?.get(sessionId));
    });
    return ctx.on("tools/execute", async (exec, next) => {
      if (!adapter.activeCodexSessions.has(exec.agent?.session?.id)) {
        dropReceiptTools(exec.agent);
        return next();
      }
      const isReceipt = RECEIPT_TOOL_NAMES.has(exec.name) || exec.name.startsWith("mcp__");
      if (!isReceipt) return next();
      // Register on demand (covers dynamic mcp__server__tool names), then let
      // the dispatch run the scope-local receipt tool body.
      if (!ensureReceiptTool(exec.agent, exec.name)) return next();
      return next();
    });
  };

  const adapter = new CodexAdapter({
    command: volatileValue(config.command),
    cwd: config.cwd,
    model: volatileValue(config.model),
    socketPath: volatileValue(config.socketPath),
    sandbox: config.sandbox ?? "danger-full-access",
    approvalPolicy: config.approvalPolicy ?? "never",
    exposeTools: volatileValue(config.exposeTools),
    // Gateway service getter (resolved at call time — see CodexAppServer) +
    // llm registry: the catalog mirror (targets) and the source-provider
    // metadata lookups (resolveModelInfo) run through them.
    gateway: () => ctx.llmBase,
    llm: ctx.llm,
    toolExecutor: async (name, args, signal) =>
      ctx.tools.execute({ name, arguments: args, signal }),
    // Resolve the streaming session's workspace cwd at call time: the dsh-llm
    // stream options do not carry it, but every stream belongs to a live
    // session whose immutable header records the workspace directory.
    sessionCwd: (sessionId) => {
      const session = sessionId ? ctx.sessions.get(sessionId) : null;
      return session?.header?.cwd ?? null;
    },
    // Resolve the streaming session's rollout log path at call time: the
    // sessionPersistence backend (JSONL store) derives the current-generation
    // artifact path from its own root/compression config. Absent backend or a
    // not-yet-materialized session yields null and the adapter skips the
    // harness-switch pointer.
    sessionRollout: async (sessionId) => {
      const persistence = ctx.get("sessionPersistence");
      return (await persistence?.resolveCurrentLog?.(sessionId)) ?? null;
    },
    logger: ctx.logger,
  });
  interceptCodexReceipts(adapter);
  ctx.llm.registerAdapter(["codex"], adapter);
  ctx.logger.info("harness-codex: registered provider 'codex'");

  // Models settings page: one provider row for codex, edited through the
  // plugin's own settings section (ns = the patch entry id "harness-codex").
  ctx.llm.registerConfigurableProviders([{
    provider: "codex",
    displayName: "Codex",
    settingsNs: "harness-codex",
    settingsPath: [],
  }]);
  // Harness identity registration: the selection state, the reroute dispatch,
  // the prompt section, and the model-picker row are all owned by dsh-harness-base
  // (the neutral relay). This plugin contributes only its identity — the
  // dispatch lands back here through the ordinary "codex" provider adapter.
  ctx.llmBase.registerHarness({
    id: "codex",
    displayName: "Codex",
    icon: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 320'><path d='m297.06 130.97c7.26-21.79 4.76-45.66-6.85-65.48-17.46-30.4-52.56-46.04-86.84-38.68-15.25-17.18-37.16-26.95-60.13-26.81-35.04-.08-66.13 22.48-76.91 55.82-22.51 4.61-41.94 18.7-53.31 38.67-17.59 30.32-13.58 68.54 9.92 94.54-7.26 21.79-4.76 45.66 6.85 65.48 17.46 30.4 52.56 46.04 86.84 38.68 15.24 17.18 37.16 26.95 60.13 26.8 35.06.09 66.16-22.49 76.94-55.86 22.51-4.61 41.94-18.7 53.31-38.67 17.57-30.32 13.55-68.51-9.94-94.51zm-120.28 168.11c-14.03.02-27.62-4.89-38.39-13.88.49-.26 1.34-.73 1.89-1.07l63.72-36.8c3.26-1.85 5.26-5.32 5.24-9.07v-89.83l26.93 15.55c.29.14.48.42.52.74v74.39c-.04 33.08-26.83 59.9-59.91 59.97zm-128.84-55.03c-7.03-12.14-9.56-26.37-7.15-40.18.47.28 1.3.79 1.89 1.13l63.72 36.8c3.23 1.89 7.23 1.89 10.47 0l77.79-44.92v31.1c.02.32-.13.63-.38.83l-64.41 37.19c-28.69 16.52-65.33 6.7-81.92-21.95zm-16.77-139.09c7-12.16 18.05-21.46 31.21-26.29 0 .55-.03 1.52-.03 2.2v73.61c-.02 3.74 1.98 7.21 5.23 9.06l77.79 44.91-26.93 15.55c-.27.18-.61.21-.91.08l-64.42-37.22c-28.63-16.58-38.45-53.21-21.95-81.89zm221.26 51.49-77.79-44.92 26.93-15.54c.27-.18.61-.21.91-.08l64.42 37.19c28.68 16.57 38.51 53.26 21.94 81.94-7.01 12.14-18.05 21.44-31.2 26.28v-75.81c.03-3.74-1.96-7.2-5.2-9.06zm26.8-40.34c-.47-.29-1.3-.79-1.89-1.13l-63.72-36.8c-3.23-1.89-7.23-1.89-10.47 0l-77.79 44.92v-31.1c-.02-.32.13-.63.38-.83l64.41-37.16c28.69-16.55 65.37-6.7 81.91 22 6.99 12.12 9.52 26.31 7.15 40.1zm-168.51 55.43-26.94-15.55c-.29-.14-.48-.42-.52-.74v-74.39c.02-33.12 26.89-59.96 60.01-59.94 14.01 0 27.57 4.92 38.34 13.88-.49.26-1.33.73-1.89 1.07l-63.72 36.8c-3.26 1.85-5.26 5.31-5.24 9.06l-.04 89.79zm14.63-31.54 34.65-20.01 34.65 20v40.01l-34.65 20-34.65-20z' fill='currentColor'/></svg>",
    prompt: "You are running on the Codex harness.",
  });
  // Route at the stream boundary — AFTER the request header is built, not in
  // agent/request. The header's (provider, model) belongs to model selection:
  // the pre-step switch notice compares the selection against it and resume
  // seeds from it, so persisting the harness route there would turn every
  // step into a phantom "model changed" — whose notice the codex adapter
  // would then read as turn input (it consumes only the last real user
  // message). Rerouting the call itself keeps the model binding and the
  // harness orthogonal. The codex thread is addressed with the qualified
  // "<provider>/<model>" id so the gateway relays the model call back to
  // that provider. Calls already routed to "codex" pass through unchanged
  // (no recursion). Note: cordis binds waterfall listeners to the dispatcher
  // (the llm service), not to this plugin's fiber — never gate on `this`.
  // global: the llm service dispatches this waterfall on its own fiber, and
  // cordis filters non-global listeners to the dispatching service's isolate —
  // a plain plugin-scoped listener never fires (the same reason
  // dsh-session-title registers global+prepend). `this` is the dispatcher.
  // Settings user-layer edits reach the running adapter live.
  ctx.on("internal/config", function(_raw, next) {
    const raw = next();
    if (this !== ctx.fiber) return raw;
    const candidate = Config(raw);
    adapter.applyConfig(candidate);
    return raw;
  });

  // Per-session state must die with the plugin, not only the app-server
  // process: session claims and receipt results would otherwise leak across
  // a dispose/re-register cycle.
  const clearAdapterState = () => {
    adapter.activeCodexSessions.clear();
    adapter.receiptResults.clear();
    for (const sessionKey of adapter.codexTurns.keys()) {
      adapter.destroyCodexTurn?.(sessionKey);
    }
    adapter.codexTurns.clear();
  };

  ctx.on("dispose", () => {
    if (process.env.DSH_CODEX_DEBUG) {
      process.stderr.write("[codex] ctx dispose event\n");
    }
    adapter.server.dispose();
    clearAdapterState();
  });

  return () => {
    if (process.env.DSH_CODEX_DEBUG) {
      process.stderr.write("[codex] dispose called\n");
    }
    adapter.server.dispose();
    clearAdapterState();
  };
}

export { name, inject, Config, apply, CodexAdapter };
