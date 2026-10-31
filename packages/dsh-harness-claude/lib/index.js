// dsh LLM adapter that drives Claude Code (the `claude` CLI) via its
// stream-json print mode. Identity: a HARNESS, not a model provider — the
// adapter advertises no models (listModels stays empty, no model discovery);
// callers address it with qualified "<provider>/<modelId>" ids that the
// dsh-harness-base relay routes back to the real provider. Main streams reuse a
// persistent per-dsh-session `claude -p --input-format stream-json` process,
// so the CLI keeps its own conversation memory (and resumes from its own
// transcript via --resume after a restart or respawn). Main turns send only
// the last real user input — no dsh system prompt, no replayed conversation.
// Title turns run on a dedicated one-shot process. Stream translation maps
// claude's message-granularity stream-json onto the dsh stream protocol with
// the same append-only chunk-log + cursor state machine the codex adapter
// uses; claude tool calls render as display receipts under mapped dsh names.
//
// Protocol reference (verified against claude 2.1.251/2.1.310):
// archive/v0.2.1/vendor/claude-stream-json/README.md.

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

const name = "harness-claude";
// "llmBase" is the dsh-harness-base relay service, a hard dependency: every claude
// process routes its model through the gateway (ANTHROPIC_BASE_URL env), and
// the harness registration/selection/dispatch all live there.
const inject = ["llm", "tools", "sessions", "llmBase"];

// The claude CLI emits `system/init` within moments of spawning; a spawn
// that produces no line in this window is treated as a failed start (bad
// binary, broken auth) instead of parking the dsh request forever.
const STARTUP_TIMEOUT_MS = Number(process.env.DSH_CLAUDE_STARTUP_TIMEOUT_MS) || 30_000;

// Idle per-session claude processes are reaped after this long without a
// turn. Unlike codex (one shared app-server), every dsh session owns a
// whole CLI process, so unreaped sessions would leak processes.
const SESSION_IDLE_MS = Number(process.env.DSH_CLAUDE_SESSION_IDLE_MS) || 600_000;

// dsh tool names claude calls are re-rendered as. Everything else is emitted
// under claude's real tool name and stub-registered on demand.
const RECEIPT_TOOL_NAMES = new Set(["bash", "apply_patch", "view_image", "web_search", "image_generation"]);

// Receipt-stub tracking, keyed on the agent's ctx — the identity the scope
// registration lives in — as { adapter, byName }. Module-level on purpose:
// cordis re-runs apply() on plugin reload while the ESM module persists, so
// the next instance can reach the previous instance's disposers and replace
// its dead-map stubs; a per-apply WeakMap would orphan them forever.
const receiptToolsRegistered = new WeakMap();

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

const Config = z.object({
  command: z.string().default("claude").volatile(),
  cwd: z.string(),
  // Fallback only: a qualified id from the model menu is the real model
  // authority (the relay routes qualified ids, so the menu choice is a hard
  // prerequisite for gateway-routed calls).
  model: z.string().default("").volatile(),
  // Session-level spawn flag; "" sends no --effort.
  effort: z.string().default("").volatile(),
  permissionMode: z.string().default("bypassPermissions"),
  // dsh tool names exposed to claude as MCP tools (server "dsh", so the CLI
  // sees them as mcp__dsh__<name>). Empty (default) keeps claude on its own
  // toolset; overlapping tools like bash should stay unexposed so the two
  // agents don't run duplicate executors. Exposed tools execute via the dsh
  // tool executor through a local MCP bridge; the tool list is snapshotted
  // when the session's CLI process spawns (claude fixes tools per process,
  // the same staleness as codex's thread/start dynamicTools).
  exposeTools: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Claude CLI process (one conversation per process)
// ---------------------------------------------------------------------------

class ClaudeProcess {
  // Settled by #start() once the spawn is confirmed; waiters resolved on
  // the first output line (see waitFirstLine).
  #firstLineWaiters = null;
  // Set once any output line parsed; a process that dies without it failed
  // to start (bad binary/auth/resume) rather than finished a turn.
  #sawOutput = false;

  constructor(options) {
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    // Spawn environment: the process env plus the gateway relay identity
    // (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN) the CLI should call.
    this.env = options.env ?? { ...process.env };
    this.logger = options.logger;
    this.proc = null;
    this.exited = false;
    this.exitCode = null;
    this.ready = null;
    this.buffer = "";
    this.handlers = new Set();
    this.exitWaiters = new Set();
    this.nextControlId = 1;
    // session_id from the first system/init line. Parsed at the transport
    // level so the conversation id is known before turn handlers attach.
    this.firstSessionId = null;
  }

  // Resolves once the spawn went through and stdin writes are safe. claude
  // with `--input-format stream-json` emits NOTHING until the first stdin
  // line arrives (verified: empty stdin → zero output for 15s), so startup
  // is write-driven: callers write the turn input right after this and then
  // use waitFirstLine() for output/health.
  ensure() {
    if (this.ready) return this.ready;
    this.ready = this.#start();
    return this.ready;
  }

  // Resolves on the first output line; rejects when the process dies
  // without producing one, or stays silent past the watchdog. Callers must
  // have written their input first — silence before input is claude's
  // normal state.
  waitFirstLine(timeoutMs = STARTUP_TIMEOUT_MS) {
    if (this.#sawOutput) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#firstLineWaiters?.delete(waiter);
        this.destroy();
        reject(new Error(`claude CLI produced no output within ${timeoutMs}ms`));
      }, timeoutMs);
      (this.#firstLineWaiters ??= new Set()).add(waiter);
    });
  }

  #start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.command, this.args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      });
      // A respawn must not inherit a partial line buffered for the dead
      // process's stream.
      this.buffer = "";
      const proc = this.proc;

      // Don't let the CLI child and its stdio pipes keep the Node.js event
      // loop alive after the dsh process completes its work.
      proc.unref();
      proc.stdout.unref?.();
      proc.stderr.unref?.();
      proc.stdin.unref?.();

      proc.stdout.on("data", (chunk) => this.#onData(chunk));
      proc.stderr.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) this.logger?.warn?.(`claude cli: ${line}`);
      });
      // Exit/error handlers are scoped to THIS process instance: a
      // superseded process (killed by destroy/idle reap) can deliver its
      // exit event late, after a respawn replaced it.
      proc.on("exit", (code) => {
        if (this.proc !== proc) {
          this.logger?.warn?.(`claude cli: stale exit ignored (code ${code})`);
          return;
        }
        this.exited = true;
        this.exitCode = code;
        this.logger?.warn?.(`claude cli exited (${code})`);
        if (!this.#sawOutput) {
          this.#rejectFirstLine(new Error(`claude CLI exited before producing output (code ${code})`));
        }
        this.#wakeExitWaiters();
      });
      // A failed spawn emits only "error" (no "exit"); without this the
      // write-driven startup would surface as a silent hang.
      proc.on("error", (error) => {
        if (this.proc !== proc) {
          this.logger?.warn?.(`claude cli: stale spawn error ignored: ${error.message}`);
          return;
        }
        this.exited = true;
        this.logger?.warn?.(`claude cli failed to spawn: ${error.message}`);
        if (!this.#sawOutput) {
          this.#rejectFirstLine(error);
        }
        this.#wakeExitWaiters();
      });
      // Writing to a closed pipe emits EPIPE as a stream "error" event;
      // log and swallow — the exit handler tears the transport down anyway.
      proc.stdin.on("error", (error) => {
        this.logger?.warn?.(`claude cli stdin error: ${error.message}`);
      });

      // One clean tick past spawn with no "error" event: the exec went
      // through and stdin writes are safe.
      setImmediate(() => resolve());
    });
  }

  #rejectFirstLine(error) {
    const waiters = this.#firstLineWaiters;
    this.#firstLineWaiters = null;
    for (const waiter of waiters ?? []) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      if (process.env.DSH_CLAUDE_DEBUG) {
        process.stderr.write(`[claude] <- ${line.slice(0, 120)}\n`);
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id && this.firstSessionId === null) {
        this.firstSessionId = msg.session_id;
      }
      if (!this.#sawOutput) {
        this.#sawOutput = true;
        const waiters = this.#firstLineWaiters;
        this.#firstLineWaiters = null;
        for (const waiter of waiters ?? []) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      }
      for (const handler of this.handlers) {
        try {
          handler(msg);
        } catch (error) {
          // A stream-translation failure must fail the turn: record it and tear
          // the CLI down so the waiting turn reports it instead of hanging on a
          // half-translated turn.
          this.handlerError = error;
          this.destroy();
          return;
        }
      }
    }
  }

  write(message) {
    // Handlers must never throw, and a dead stdin throws on write.
    try {
      this.proc?.stdin?.write(JSON.stringify(message) + "\n");
    } catch (error) {
      this.logger?.warn?.(`claude cli write failed: ${error.message}`);
    }
  }

  writeUser(content) {
    this.write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  interrupt() {
    this.write({ type: "control_request", request_id: `dsh-abort-${this.nextControlId++}`, request: { subtype: "interrupt" } });
  }

  onMessage(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  #wakeExitWaiters() {
    const waiters = [...this.exitWaiters];
    this.exitWaiters.clear();
    for (const waiter of waiters) {
      try { waiter(this.handlerError); } catch { /* waiter error */ }
    }
  }

  onExitWait(handler) {
    this.exitWaiters.add(handler);
    return () => this.exitWaiters.delete(handler);
  }

  destroy() {
    if (this.proc) {
      this.proc.stdout?.destroy();
      this.proc.stderr?.destroy();
      this.proc.stdin?.destroy();
      this.proc.kill();
      this.proc = null;
    }
    this.exited = true;
    this.#wakeExitWaiters();
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
// time-sampling footers) AFTER the real user message. Claude must receive
// the user's actual prompt, not the footer, so skip injected messages when
// picking the turn input.
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

// The claude conversation id belongs to the session, not to its last message.
// An interrupted turn records its assistant message WITHOUT replayState (the
// aborted finish carries none), and a failed turn records only an
// assistant/attempt. Reading just the last assistant message drops the id at
// the next adapter/process boundary (dsh restart, plugin reload), and the turn
// after that silently starts a fresh claude conversation: dsh history intact,
// claude's own context gone.
function lastClaudeSessionId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const id = message.source?.replayState?.claudeSessionId;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

// Whether the dsh history already contains a claude answer. Under the harness
// identity the request header keeps the model-selection provider, but the
// assistant step's source records whichever adapter produced it — so a
// claude answer shows up either as source.provider "claude" or as a recorded
// conversation anchor. When a claude answer exists but records no id, the
// adapter cannot resume it and must say so instead of answering without it.
function hasClaudeTurn(messages) {
  return messages.some((message) => {
    if (message?.role !== "assistant") return false;
    if (message.source?.provider === "claude") return true;
    const id = message.source?.replayState?.claudeSessionId;
    return typeof id === "string" && id !== "";
  });
}

// Claude Code writes for a plain-text terminal: a single newline is a visual
// line break. DSH renders assistant text as CommonMark, where a single
// newline is a soft break it collapses into a space — so claude's
// multi-line plain-text answers would cram onto one line. Upgrade soft
// breaks to hard breaks (two trailing spaces) outside fenced code; markdown
// structure is unaffected because tables, list items, and ATX headings
// ignore trailing spaces, and blank lines already break paragraphs.
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

function volatileValue(value) {
  return typeof value?.get === "function" ? value.get() : value;
}

function exposeToolSet(value) {
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === "object") return new Set(Object.values(value));
  return new Set();
}

function storeReceiptResult(map, key, value) {
  map.set(key, value);
  if (map.size > 256) map.delete(map.keys().next().value);
}

function firstLine(text) {
  return String(text ?? "").split("\n")[0];
}

// Quote-aware argv split for preview matching. Refuses (null) anything with
// shell structure the matchers must not guess across: pipes, redirects,
// command separators, unbalanced quotes.
function tokenizeCommand(text) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) return null;
      current += text.slice(i + 1, end);
      quoted = true;
      i = end;
    } else if (ch === ">" || ch === "<" || ch === "|" || ch === ";" || ch === "&") {
      return null;
    } else if (/\s/.test(ch)) {
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
function shortPath(p) {
  const base = p.split("/").filter(Boolean).pop();
  return base ?? p;
}

function sedReadSummary(tokens) {
  const { flags, positionals } = splitArgs(tokens);
  if (!flags.some((f) => f.includes("n")) || positionals.length !== 2) return null;
  const range = /^(\d+),(\d+)p$/.exec(positionals[0]);
  return range ? `读取 ${shortPath(positionals[1])} 第${range[1]}–${range[2]}行` : null;
}

function windowReadSummary(op, tokens, window) {
  const { flags, values, positionals } = splitArgs(tokens, new Set(["n"]));
  if (positionals.length !== 1) return null;
  // -f/-F keeps following (not a one-shot read); -c counts bytes, not lines.
  if (flags.some((f) => f.includes("f") || f.includes("F") || f.includes("c"))) return null;
  let lines = window;
  if (lines !== null && flags.some((f) => /^\d+$/.test(f) || f.startsWith("n"))) return null;
  if (lines === null) {
    const numberFlag = flags.find((f) => /^\d+$/.test(f) || /^n\d+$/.test(f));
    lines = numberFlag ? Number(numberFlag.replace("n", "")) : Number(values.get("n")) || 10;
  }
  return `读取 ${shortPath(positionals[0])} ${op === "head" ? "前" : "后"}${lines}行`;
}

function catReadSummary(tokens, window) {
  const { positionals } = splitArgs(tokens);
  if (positionals.length !== 1) return null;
  return window === null ? `读取 ${shortPath(positionals[0])}` : `读取 ${shortPath(positionals[0])} 前${window}行`;
}

function grepSearchSummary(tokens) {
  const { flags, values, positionals } = splitArgs(tokens, new Set(["A", "B", "C", "m", "e", "f"]));
  const pattern = values.get("e") ?? positionals.shift();
  if (pattern === undefined || pattern === "" || positionals.length === 0) return null;
  const shown = (pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern).replaceAll("'", "\\'");
  const recursive = flags.some((f) => f.includes("r") || f.includes("R"));
  if (positionals.length > 1) return `在 ${positionals.length} 个文件中搜索 '${shown}'`;
  const [target] = positionals;
  if (recursive && (target === "." || target === "./")) return `在当前目录递归搜索 '${shown}'`;
  return `在 ${shortPath(target)} 中${recursive ? "递归搜索" : "搜索"} '${shown}'`;
}

function lsListSummary(tokens) {
  const { positionals } = splitArgs(tokens);
  if (positionals.length === 0) return "列出当前目录";
  if (positionals.length <= 3) return `列出 ${positionals.map(shortPath).join("、")}`;
  return `列出 ${positionals.slice(0, 3).map(shortPath).join("、")} 等 ${positionals.length} 个路径`;
}

// Friendly preview for a command that is exactly one well-known read-only
// operation — optionally behind a leading `cd … &&` and a trailing
// `| head [-N]` window (stderr-to-/dev/null is display noise). Anything
// compound or unknown returns null: a wrong summary is worse than the command.
// Used when a claude Bash call carries no model-written description (the
// claude-side equivalent of codex's commandExecution preview).
function commandReadSummary(command) {
  let text = command.trim();
  const cd = /^cd\s+('[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*([\s\S]+)$/.exec(text);
  if (cd) text = cd[2].trim();
  // stderr-to-/dev/null discards carry no display information, wherever they sit.
  text = text.replace(/\s*2>\s*\/dev\/null(?![\w.-])/gi, "").trim();
  let window = null;
  const head = /^(.*\S)\s*\|\s*head(?:\s+-?(?:n\s*)?(\d+))?$/.exec(text);
  if (head) {
    text = head[1];
    window = head[2] === undefined ? 10 : Number(head[2]);
  }
  const tokens = tokenizeCommand(text);
  if (!tokens || tokens.length === 0) return null;
  const [op, ...rest] = tokens;
  if (op === "sed") return sedReadSummary(rest);
  if (op === "head" || op === "tail") return windowReadSummary(op, rest, window);
  if (op === "cat") return catReadSummary(rest, window);
  if (op === "grep") return grepSearchSummary(rest);
  if (op === "ls") return lsListSummary(rest);
  return null;
}

// Map a claude tool_use onto the display-only dsh receipt tool call. Tools
// with a dsh-native counterpart map onto it so the native cards render
// (terminal row, patch diff card); everything else keeps claude's real name
// and renders through the generic card after on-demand stub registration.
function toolCallFromUse(claudeName, input) {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (claudeName === "Bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return {
      name: "bash",
      args: {
        command,
        // bash's shellCall treats a missing description as a persistent
        // session call and routes the result to the generic card. Prefer the
        // model's own description, then a friendly read-only summary, then
        // the first line (same fallback chain as codex's command preview).
        description: typeof args.description === "string" && args.description
          ? args.description
          : commandReadSummary(command) ?? firstLine(command),
      },
    };
  }
  if (claudeName === "Edit" || claudeName === "MultiEdit" || claudeName === "Write" || claudeName === "NotebookEdit") {
    return { name: "apply_patch", args: { description: `file changes: ${args.file_path ?? args.notebook_path ?? ""}` } };
  }
  if (claudeName === "WebSearch") {
    return { name: "web_search", args: { query: typeof args.query === "string" ? args.query : "" } };
  }
  if (claudeName === "Read" && typeof args.file_path === "string" && IMAGE_PATH.test(args.file_path)) {
    return { name: "view_image", args: { path: args.file_path } };
  }
  return { name: claudeName, args };
}

// Reconstruct {path, oldText, newText} pairs from claude edit inputs so
// dsh's diff card can re-diff and render them (the same meta shape the
// codex adapter's fileChange receipts produce).
function receiptDiffs(claudeName, input) {
  const args = input && typeof input === "object" ? input : {};
  if (claudeName === "Edit" && typeof args.old_string === "string") {
    return [{ path: args.file_path ?? "", oldText: args.old_string, newText: typeof args.new_string === "string" ? args.new_string : "" }];
  }
  if (claudeName === "Write" && typeof args.content === "string") {
    return [{ path: args.file_path ?? "", oldText: null, newText: args.content }];
  }
  if (claudeName === "MultiEdit" && Array.isArray(args.edits)) {
    return args.edits
      .filter((edit) => edit && typeof edit.old_string === "string")
      .map((edit) => ({ path: args.file_path ?? "", oldText: edit.old_string, newText: typeof edit.new_string === "string" ? edit.new_string : "" }));
  }
  return null;
}

// Map a claude tool_result onto the dsh receipt stub result
// ({content, isError, meta?}).
function receiptOutput(toolResult, toolBlock) {
  let text;
  if (typeof toolResult.content === "string") text = toolResult.content;
  else if (Array.isArray(toolResult.content)) {
    text = toolResult.content
      .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(block)))
      .join("\n");
  } else text = "(no result)";
  const diffs = toolBlock ? receiptDiffs(toolBlock.claudeName, toolBlock.input) : null;
  return {
    content: [{ type: "text", text: text || "(no output)" }],
    isError: toolResult.is_error === true,
    ...(diffs && diffs.length > 0 ? { meta: { diffs } } : {}),
  };
}

// Filter the dsh tool schemas down to the names in exposeTools and map them
// onto the MCP tool shape ({name, description, inputSchema}) — the same
// allowlist + projection codex's buildDynamicTools performs before
// thread/start.
function buildMcpTools(toolSchemas, exposeTools) {
  if (!exposeTools || exposeTools.size === 0 || !Array.isArray(toolSchemas)) return [];
  return toolSchemas
    .filter((s) => s?.name && exposeTools.has(s.name))
    .map((s) => ({
      name: s.name,
      description: s.description ?? "",
      inputSchema: s.parameters && typeof s.parameters === "object" ? s.parameters : { type: "object", properties: {} },
    }));
}

// Map a dsh tool outcome ({content: [...blocks], isError}) onto MCP tool
// result content. Text blocks cross over directly; anything else has no MCP
// representation and is stringified (mirrors codex's outcomeContentItems).
function mcpResultContent(outcome) {
  const content = [];
  for (const block of outcome?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block != null) {
      content.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });
  return content;
}

// Title callers send the full DSH conversation plus a trailing titling
// instruction. A title turn is a one-shot ephemeral process, so the prefix
// is flattened into a single prompt: system prompt first, then the
// transcript, then the last real user message.
function buildTitlePrompt(messages, lastUserIdx, system) {
  const parts = [];
  if (typeof system === "string" && system.trim()) parts.push(system.trim());
  for (let i = 0; i < lastUserIdx; i++) {
    const message = messages[i];
    if (message.role === "user" && isInjectedUserContext(extractText(message.content))) continue;
    if (message.role === "user" || message.role === "assistant") {
      const text = extractText(message.content).trim();
      if (text) parts.push(`${message.role}: ${text}`);
    }
  }
  if (lastUserIdx >= 0) {
    const text = extractText(messages[lastUserIdx].content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

class ClaudeAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.logger = options.logger;
    this.command = options.command;
    this.model = options.model ?? "";
    this.effort = options.effort ?? "";
    this.permissionMode = options.permissionMode ?? "bypassPermissions";
    this.cwd = options.cwd;
    // dsh-harness-base service getter (lazy, like codex's options.gateway) plus
    // the dsh llm registry for source-provider metadata lookups.
    this.gateway = options.gateway;
    this.llm = options.llm;
    // Optional resolver (sessionId) → the live session's workspace cwd.
    this.sessionCwd = options.sessionCwd ?? null;
    this.toolExecutor = options.toolExecutor;
    // Persistent per-dsh-session CLI processes: {key, process,
    // claudeSessionId, endpointKey, spawnModel, emittedToolNames, lastUsed}.
    // One claude process owns one conversation; dsh sessions map 1:1 onto
    // conversations.
    this.sessions = new Map();
    // Ongoing claude turns split across multiple dsh steps (one stream()
    // per tool-call boundary), keyed by dsh session id. The presence of a
    // turn state marks a continuation step.
    this.claudeTurns = new Map();
    // One-shot callers without a dsh session keep the single-stream path.
    this.activeSessions = new Set();
    // Deferred text replay for one-shot single-stream turns, keyed by dsh
    // session id ("" for callers without one). Session turns stream text
    // live into the post-tool step and never use this.
    this.pendingReplay = new Map();
    this.receiptResults = new Map();
    // agentCtx → { adapter, byName: Map<receipt name, disposer> }; see
    // ensureReceiptTool. Disposed with the plugin so a reload re-registers
    // cleanly instead of colliding with stale scope entries.
    this.receiptStubs = new Map();
    this.reaper = null;
    // exposeTools plumbing: a lazily created temp dir holding the per-spawn
    // MCP config + tool-schema JSON files, and a Unix-socket gateway the
    // bridge processes call back into for tool execution.
    this.exposeTools = exposeToolSet(volatileValue(options.exposeTools));
    this.assetsDir = null;
    this.toolsGateway = null;
    this.mcpAssets = new Map(); // sessionKey → {configPath, toolsPath}
  }

  providerInfo(provider) {
    return { id: provider, name: "Claude" };
  }

  // The adapter stays registered as the "claude" provider but advertises no
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

  // The gateway relay identity for spawned CLI processes. ANTHROPIC_BASE_URL
  // carries the ORIGIN (no /v1): the CLI appends /v1/messages itself.
  #endpoint() {
    const local = this.gateway()?.localEndpoint?.();
    if (!local?.baseUrl) {
      throw new LlmError("harness-claude: the dsh-harness-base relay has no local endpoint", "TRANSPORT");
    }
    return {
      baseUrl: local.baseUrl.replace(/\/v1\/?$/, ""),
      token: local.token,
    };
  }

  #spawnEnv(endpoint, configDir) {
    return {
      ...process.env,
      // Isolated config dir: settings.json here (written per spawn) carries
      // the model and relay env — see #claudeConfigDir.
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: endpoint.baseUrl,
      // Non-loopback binds carry the gateway token; loopback is token-free
      // but the CLI must not fall into its login flow, so a non-empty
      // placeholder goes out. Inbound authorization/x-api-key are on the
      // relay's strip list, so the placeholder never reaches a provider.
      ANTHROPIC_AUTH_TOKEN: endpoint.token ?? "dsh-local",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  }

  // Live config updates from the settings user layer. command is a spawn
  // flag: changing it tears every session process down; the next turn
  // respawns with the new command. model/effort/permissionMode only apply
  // to processes spawned afterwards (claude fixes them per process). The
  // The harness selection state is owned by dsh-harness-base and read live per
  // request there — nothing to apply here.
  applyConfig(config) {
    const command = volatileValue(config.command);
    if (command && command !== this.command) {
      this.command = command;
      for (const session of this.sessions.values()) {
        session.process?.destroy();
        session.process = null;
      }
    }
    this.model = volatileValue(config.model) ?? "";
    this.effort = volatileValue(config.effort) ?? "";
    this.permissionMode = config.permissionMode ?? "bypassPermissions";
    this.cwd = config.cwd;
    // Applies to CLI processes spawned afterwards (claude fixes tools per
    // process — the same staleness as codex's thread/start dynamicTools).
    this.exposeTools = exposeToolSet(volatileValue(config.exposeTools));
  }

  // Resolve the cwd for a claude process. A claude conversation belongs to the
  // workspace it was started in; inheriting the dsh process cwd would silently
  // point claude at a different project, so refuse to spawn without one.
  #effectiveCwd(sessionId) {
    const cwd = this.sessionCwd?.(sessionId) ?? this.cwd;
    if (!cwd) throw new LlmError("harness-claude: no session cwd and no configured cwd", "INVALID_DIRECTORY");
    return cwd;
  }

  #spawnArgs({ model, effort, resumeId, ephemeral, disallowWriteTools, mcpConfig }) {
    return [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      // stream-json output is a print-mode detail channel; --verbose is
      // accepted (and historically required) alongside it.
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", this.permissionMode,
      // The qualified id from the rerouted call: the CLI puts it verbatim
      // into the request body's model field — the relay's routing key.
      ...(model ? ["--model", model] : []),
      // Effort is a process-level flag: a per-turn change would need a
      // respawn, so the configured effort wins and per-call efforts are
      // only honored on ephemeral processes.
      ...(effort && EFFORT_LEVELS.has(effort) ? ["--effort", effort] : []),
      ...(resumeId ? ["--resume", resumeId] : []),
      ...(ephemeral ? ["--no-session-persistence"] : []),
      // dsh tools exposed as MCP tools (bridge server "dsh"); only when the
      // filtered tool list for this spawn is non-empty.
      ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
      // Title turns only produce a short line of text; keep them from
      // touching the filesystem even when main sessions may write.
      ...(disallowWriteTools ? ["--disallowedTools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"] : []),
    ];
  }

  // Ensure the persistent CLI process for a dsh session, resuming the claude
  // conversation recorded in its dsh history. The caller's turn input is
  // written immediately after the spawn is confirmed (claude is silent until
  // the first stdin line), then the first output line confirms a healthy
  // start. A failed resume fails the turn: the claude conversation IS the
  // session's context, so quietly starting a new one would answer without it.
  // The transcript replay state is the only anchor source — no side file.
  async #sessionFor(options, turnInput) {
    const sessionKey = options.sessionId;
    if (turnInput.length === 0) {
      throw new LlmError("harness-claude: last user message carried no claude-representable content", "UNSUPPORTED_CONTENT");
    }
    let session = this.sessions.get(sessionKey);
    if (!session) {
      // Transcript anchor only: dsh-llm's forAdapter strips replayState from
      // a previous process's assistant messages when the header provider ≠
      // this adapter (always true under the harness), so the anchor is
      // process-lifetime state by design.
      const claudeSessionId = lastClaudeSessionId(options.messages);
      if (!claudeSessionId && hasClaudeTurn(options.messages)) {
        throw new LlmError(
          "harness-claude: session history has claude turns but records no claudeSessionId to resume",
          "INVALID_REQUEST",
        );
      }
      session = {
        key: sessionKey,
        process: null,
        claudeSessionId,
        endpointKey: null,
        spawnModel: null,
        emittedToolNames: new Set(),
        lastUsed: Date.now(),
      };
      this.sessions.set(sessionKey, session);
    }
    session.lastUsed = Date.now();
    this.#ensureReaper();

    // The model and the relay endpoint are spawn-time identities (the same
    // staleness as codex's spawn-key): a menu model switch or a gateway
    // port/token change voids the live process and the next spawn resumes
    // the conversation with the new flags.
    const endpoint = this.#endpoint();
    const endpointKey = `${endpoint.baseUrl}|${endpoint.token ?? ""}`;
    const spawnModel = options.model || this.model || "";
    if (session.process && !session.process.exited
      && (session.endpointKey !== endpointKey || session.spawnModel !== spawnModel)) {
      session.process.destroy();
      session.process = null;
    }

    if (session.process && !session.process.exited) {
      // Alive process from a previous turn: the new turn input is all that
      // is needed — the conversation continues in memory.
      session.process.writeUser(turnInput);
      return session;
    }

    const resumeId = session.claudeSessionId;
    // dsh tools exposed as MCP tools are snapshotted at spawn time (the same
    // staleness as codex's thread/start dynamicTools).
    const mcpConfig = this.#sessionAssets(sessionKey ?? "", options.tools);
    const process = this.#spawnProcess({
      sessionId: sessionKey,
      model: spawnModel,
      effort: this.effort,
      resumeId,
      ephemeral: false,
      mcpConfig,
      endpoint,
    });
    try {
      await process.ensure();
      // claude stays silent until the first stdin line, so the turn input
      // goes out before waiting for startup output.
      process.writeUser(turnInput);
      await process.waitFirstLine();
    } catch (error) {
      this.sessions.delete(sessionKey);
      throw new LlmError(
        `harness-claude: claude CLI failed to start (${resumeId ? `resume ${resumeId}` : "new conversation"}): ${error.message}`,
        "TRANSPORT",
        { cause: error },
      );
    }
    if (!session.claudeSessionId && process.firstSessionId) {
      session.claudeSessionId = process.firstSessionId;
    }
    session.process = process;
    session.endpointKey = endpointKey;
    session.spawnModel = spawnModel;
    return session;
  }

  // The isolated CLAUDE_CONFIG_DIR for one spawn scope. The user's real
  // ~/.claude/settings.json would otherwise win the model and relay identity:
  // its top-level "model" outranks the --model flag, a --settings override,
  // AND the ANTHROPIC_MODEL env (observed 2026-10-28: every request went out
  // with the user settings model, bypassing the relay routing). A private
  // config dir carrying our own settings.json removes that whole precedence
  // fight — the CLI reads model + env from here. Sessioned spawns share one
  // dir per dsh session: the CLI transcripts (and therefore --resume) live
  // there, so the dir must be PERSISTENT — it lives under the dsh home (not
  // the tmp assets dir, which dies with the plugin and would orphan every
  // conversation). One-shot spawns get a throwaway dir under the assets dir.
  #claudeConfigDir(sessionKey) {
    if (!sessionKey) {
      const dir = path.join(this.#ensureAssetsDir(), "claude-config", `oneshot-${crypto.randomUUID()}`);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const dir = path.join(home, "harness-claude", "claude-config", `session-${String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, "_")}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  #writeClaudeSettings(configDir, endpoint, model) {
    fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
      // The request model: the qualified id from the rerouted call goes
      // verbatim into the request body — the relay's routing key.
      ...(model ? { model } : {}),
      env: {
        ANTHROPIC_BASE_URL: endpoint.baseUrl,
        ANTHROPIC_AUTH_TOKEN: endpoint.token ?? "dsh-local",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    }, null, 2));
  }

  #spawnProcess({ sessionId, model, effort, resumeId, ephemeral, disallowWriteTools, mcpConfig, endpoint }) {
    endpoint ??= this.#endpoint();
    const configDir = this.#claudeConfigDir(sessionId);
    this.#writeClaudeSettings(configDir, endpoint, model);
    return new ClaudeProcess({
      command: this.command,
      args: this.#spawnArgs({ model, effort, resumeId, ephemeral, disallowWriteTools, mcpConfig }),
      cwd: this.#effectiveCwd(sessionId),
      env: this.#spawnEnv(endpoint, configDir),
      logger: this.logger,
    });
  }

  // -------------------------------------------------------------------------
  // exposeTools plumbing
  //
  // Claude has no dynamic-tools RPC (codex's thread/start dynamicTools); the
  // CLI-side equivalent is one MCP server. A tiny stdio bridge (lib/bridge.mjs)
  // is spawned by the claude CLI from a per-spawn --mcp-config file and
  // forwards tools/call requests over a Unix socket to the gateway below,
  // which executes the real dsh tool via the shared toolExecutor. Without
  // exposeTools nothing of this exists: no files, no socket, no extra flag.
  // -------------------------------------------------------------------------

  #ensureAssetsDir() {
    this.assetsDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "dsh-harness-claude-"));
    return this.assetsDir;
  }

  // Lazily create the Unix-socket tool gateway. Returns the socket path.
  #ensureToolGateway() {
    if (this.toolsGateway?.listening) return this.toolsSocketPath;
    const dir = this.#ensureAssetsDir();
    const socketPath = path.join(dir, "tools.sock");
    try { fs.rmSync(socketPath, { force: true }); } catch { /* not there */ }
    const server = net.createServer((socket) => this.#onBridgeConnection(socket));
    // Keep the gateway off the event loop's ref count: it must not hold the
    // dsh process open on its own.
    server.unref();
    server.listen(socketPath);
    this.toolsGateway = server;
    this.toolsSocketPath = socketPath;
    return socketPath;
  }

  // One JSON message per line from a bridge process:
  //   {id, tool, arguments, sessionId} → {id, ok, content?, isError?}
  //                                     | {id, ok: false, error}
  #onBridgeConnection(socket) {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message && typeof message === "object" && message.id !== undefined) {
          void this.#executeBridgeCall(socket, message);
        }
      }
    });
    socket.on("error", () => { /* bridge died; its CLI process is gone too */ });
  }

  async #executeBridgeCall(socket, message) {
    const respond = (payload) => {
      try { socket.write(JSON.stringify(payload) + "\n"); } catch { /* bridge gone */ }
    };
    try {
      if (typeof message.tool !== "string" || !message.tool) throw new Error("bridge call without tool name");
      // Abort with the streaming turn that the calling CLI process belongs to.
      const signal = this.claudeTurns.get(message.sessionId)?.signal ?? undefined;
      const outcome = await this.toolExecutor(message.tool, message.arguments ?? {}, signal);
      respond({
        id: message.id,
        ok: true,
        content: mcpResultContent(outcome),
        isError: outcome?.isError === true,
      });
    } catch (error) {
      respond({ id: message.id, ok: false, error: error?.message ?? String(error) });
    }
  }

  // Write the per-spawn MCP assets for one CLI process and return the
  // --mcp-config path (null when nothing is exposed or the filtered tool
  // list is empty — the flag must not point at an empty server).
  #sessionAssets(sessionKey, toolSchemas) {
    const tools = buildMcpTools(toolSchemas, this.exposeTools);
    if (tools.length === 0) return null;
    const socketPath = this.#ensureToolGateway();
    const safeKey = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
    const unique = `${safeKey}-${crypto.randomUUID()}`;
    const toolsPath = path.join(this.#ensureAssetsDir(), `${unique}.tools.json`);
    const configPath = path.join(this.#ensureAssetsDir(), `${unique}.mcp.json`);
    const bridgePath = fileURLToPath(new URL("./bridge.mjs", import.meta.url));
    fs.writeFileSync(toolsPath, JSON.stringify({ tools }));
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        dsh: {
          command: process.execPath,
          args: [bridgePath, socketPath, toolsPath, sessionKey ?? ""],
        },
      },
    }));
    const assets = { configPath, toolsPath };
    // A respawn supersedes the previous files; drop them so the temp dir
    // does not grow with every process restart.
    const previous = this.mcpAssets.get(sessionKey ?? "");
    if (previous) {
      for (const file of [previous.configPath, previous.toolsPath]) {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    }
    this.mcpAssets.set(sessionKey ?? "", assets);
    return configPath;
  }

  disposeAssets() {
    for (const server of [this.toolsGateway]) {
      try { server?.close(); } catch { /* already closed */ }
    }
    this.toolsGateway = null;
    this.toolsSocketPath = null;
    this.mcpAssets.clear();
    if (this.assetsDir) {
      try { fs.rmSync(this.assetsDir, { recursive: true, force: true }); } catch { /* best effort */ }
      this.assetsDir = null;
    }
  }

  // Reap session processes that have not streamed for SESSION_IDLE_MS and
  // hold no in-flight turn. Without this, every dsh session ever used
  // leaves a claude process behind. Only the process dies: the entry keeps
  // its claudeSessionId so the next turn respawns with --resume. Deleting
  // the whole entry dropped the anchor and the next turn silently started a
  // fresh claude conversation (2026-10-29 session 0aa726f2: a 10-minute gap
  // crossed the reap window and claude lost all prior context).
  #ensureReaper() {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      let allReaped = true;
      for (const [key, session] of this.sessions) {
        if (this.claudeTurns.has(key) || now - session.lastUsed < SESSION_IDLE_MS) {
          allReaped = false;
          continue;
        }
        session.process?.destroy();
        session.process = null;
      }
      if (allReaped) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
    }, 60_000);
    this.reaper.unref?.();
  }

  // Turn input: every content block of the last real user message crosses
  // into claude — text blocks as text items, image blocks as Anthropic-API
  // images. dsh (pi-ai) sends base64 payloads {data, mimeType}; a url-source
  // image is accepted when a caller provides one. A block claude cannot
  // represent fails the turn: dropping it would let claude answer as if the
  // user had never sent it.
  #buildTurnInput(messages, lastUserIdx) {
    const turnInput = [];
    if (lastUserIdx < 0) return turnInput;
    for (const block of messages[lastUserIdx].content ?? []) {
      if (block?.type === "text") {
        if (typeof block.text === "string" && block.text) turnInput.push({ type: "text", text: block.text });
      } else if (block?.type === "image") {
        if (typeof block.data === "string" && block.data) {
          turnInput.push({
            type: "image",
            source: { type: "base64", media_type: block.mimeType ?? "image/png", data: block.data },
          });
        } else if (typeof block.url === "string" && block.url) {
          turnInput.push({ type: "image", source: { type: "url", url: block.url } });
        } else {
          throw new LlmError("harness-claude: image block without data or url has no claude representation", "UNSUPPORTED_CONTENT");
        }
      } else if (block?.type) {
        throw new LlmError(`harness-claude: user message block "${block.type}" has no claude representation`, "UNSUPPORTED_CONTENT");
      }
    }
    return turnInput;
  }

  #usageFrom(result) {
    const u = result?.usage;
    if (!u) return null;
    return {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(u.output_tokens_details?.thinking_tokens ? { reasoningTokens: u.output_tokens_details.thinking_tokens } : {}),
    };
  }

  // One-shot title generation on its own ephemeral process. The caller's
  // conversation prefix (and titling system prompt) is flattened into the
  // prompt. Errors propagate — dsh's title pipeline falls back to its own
  // first-prompt derivation.
  async *#titleStream(options) {
    const messages = options.messages;
    const lastUserIdx = lastRealUserIndex(messages);
    const process = this.#spawnProcess({
      sessionId: options.sessionId,
      model: options.model || this.model,
      effort: EFFORT_LEVELS.has(options.reasoningEffort) ? options.reasoningEffort : this.effort,
      resumeId: undefined,
      ephemeral: true,
      disallowWriteTools: true,
    });

    const queue = [];
    let waitResolve = null;
    let finished = false;
    let title = "";
    const unregister = process.onMessage((msg) => {
      if (msg.type !== "result") return;
      queue.push({ type: "done", text: typeof msg.result === "string" ? msg.result : "" });
      waitResolve?.();
    });
    const onAbort = () => process.interrupt();
    const onServerExit = process.onExitWait((handlerError) => {
      queue.push({
        type: "error",
        error: handlerError
          ? new LlmError(`claude stream translation failed: ${handlerError.message}`, "MALFORMED_RESPONSE", { cause: handlerError })
          : new LlmError("claude process exited during title turn", "TRANSPORT"),
      });
      waitResolve?.();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await process.ensure();
      process.writeUser([{ type: "text", text: buildTitlePrompt(messages, lastUserIdx, options.system) }]);
      // claude stays silent until this input line; the first output line
      // (init) confirms a healthy start.
      await process.waitFirstLine();
      while (true) {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item.type === "error") throw item.error;
          if (item.type === "done") {
            finished = true;
            title = item.text;
          }
        }
        if (finished) break;
        await new Promise((resolve) => { waitResolve = resolve; });
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (options.signal?.aborted) throw error;
      throw new LlmError(`claude title turn failed: ${error.message}`, "TRANSPORT", { cause: error });
    } finally {
      unregister();
      onServerExit();
      options.signal?.removeEventListener("abort", onAbort);
      process.destroy();
    }
    const line = title.trim().split("\n").find((candidate) => candidate.trim()) ?? "";
    if (!line) throw new LlmError("claude title turn produced no text", "TURN_FAILED");
    const finalTitle = line.trim().slice(0, 80);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: finalTitle };
    yield { type: "block-end", index: 0, block: { type: "text", text: finalTitle } };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  async *stream(options) {
    const messages = options.messages;

    // Session-title generation: a dedicated one-shot claude process answers
    // the title prompt; it never touches the main conversation's process.
    if (options.purpose === "session-title") {
      yield* this.#titleStream(options);
      return;
    }

    // Second step: emit text buffered from the previous one-shot claude turn.
    // The dsh web UI's latestAnswer() returns null when the last assistant
    // step contains tool-call blocks, which folds everything into the process
    // group. By deferring text to a second step (after tool execution), the
    // last step has only text, so the response renders outside the fold.
    // Session turns never take this path: their final answer streams live
    // into the post-tool step.
    if (!options.purpose) {
      const sessionKey = options.sessionId ?? "";
      const pending = this.pendingReplay.get(sessionKey);
      if (pending) {
        // The buffer is bound to the user input it was produced for: recompute
        // the last real user input and replay only when it is unchanged. On a
        // mismatch (user edited or sent a new prompt meanwhile) drop the stale
        // buffer and the claude session claim and fall through to the normal
        // claude turn path below — no early return.
        const replayUserIdx = lastRealUserIndex(messages);
        const replayUserText = replayUserIdx >= 0 ? extractText(messages[replayUserIdx].content) : "";
        if (pending.userText === replayUserText) {
          this.pendingReplay.delete(sessionKey);
          // The split turn that produced this buffer is fully drained once
          // the replay step closes; tear down its per-session state here.
          if (sessionKey) this.destroyTurn(sessionKey);
          else this.activeSessions.delete(sessionKey);
          const pendingBlocks = pending.blocks;
          for (let i = 0; i < pendingBlocks.length; i++) {
            yield { type: "block-start", index: i, blockType: "text" };
            yield { type: "text-delta", index: i, text: pendingBlocks[i].text };
            yield { type: "block-end", index: i, block: { type: "text", text: pendingBlocks[i].text } };
          }
          if (pending.usage) {
            yield { type: "usage", usage: pending.usage };
          }
          // The replay finish must carry the claude session id: this step's
          // assistant message is the last thing a resumed dsh session has to
          // read the conversation from. A turn that reaches here without an
          // id is a CLI protocol break, not something to paper over.
          if (!pending.claudeSessionId) {
            throw new LlmError("harness-claude: claude turn finished without a session id", "TRANSPORT");
          }
          yield {
            type: "finish",
            reason: { kind: "stop" },
            replayState: { claudeSessionId: pending.claudeSessionId },
          };
          return;
        }
        this.pendingReplay.delete(sessionKey);
        if (sessionKey) this.destroyTurn(sessionKey);
        else this.activeSessions.delete(sessionKey);
      }
    }

    // One-shot callers without a dsh session keep the single-stream path
    // (it manages its own claim); session turns go through the per-session
    // chunk-log state machine. The session claim is taken in front of
    // #driveTurn, not here: turn-input conversion and the CLI spawn can
    // throw without ever producing a turn, and a claim left behind by such
    // a throw keeps the receipt-tool interceptor treating native tool calls
    // as display receipts — after a harness switch back to dsh, every
    // bash/apply_patch call then answers from the dead receipt map (the
    // codex adapter's production incident, replayed 2026-10-29 in session
    // 851e3948 turns 9-11 after an image turn failed).
    if (!options.sessionId) {
      yield* this.#singleStream(options);
      return;
    }

    // Find the last user message — it becomes the turn input. Nothing else
    // crosses into claude: no dsh system prompt, no replayed conversation.
    // Claude runs on its own instructions and remembers via its process and
    // its own transcript (--resume).
    const lastUserIdx = lastRealUserIndex(messages);
    const turnInput = this.#buildTurnInput(messages, lastUserIdx);

    const sessionKey = options.sessionId;
    // Leftover state from a previous dsh turn is dead weight: its queue tail
    // belongs to an interrupted or already-concluded claude turn and must not
    // leak into this message. Retire it and start fresh. A continuation step
    // reuses the SAME dsh phase signal, so any signal difference means the
    // previous dsh turn ended.
    const stale = this.claudeTurns.get(sessionKey);
    if (stale && (stale.abandoned || stale.signal !== (options.signal ?? null))) {
      // The CLI turn is still producing; stop it. The session process
      // survives — the next turn continues the conversation in memory.
      stale.session?.process?.interrupt();
      this.destroyTurn(sessionKey);
      this.logger?.warn?.(`harness-claude: retired stalled claude turn state for session ${sessionKey} (previous dsh turn ended without a terminal result)`);
    }
    const existing = this.claudeTurns.get(sessionKey);
    if (existing) {
      // Continuation step: the dsh loop executed the previous step's receipt
      // tool and calls back immediately. The claude turn is already running —
      // drain the next chunk range, never start another claude turn. The
      // claim from the step that created the state is still held; re-assert
      // it so the invariant "a driving turn state owns the claim" is local
      // to the driveTurn call sites.
      this.activeSessions.add(sessionKey);
      yield* this.#driveTurn(existing);
      return;
    }

    const session = await this.#sessionFor(options, turnInput);
    const state = this.#createTurnState(sessionKey, session, options);
    this.claudeTurns.set(sessionKey, state);
    this.activeSessions.add(sessionKey);
    yield* this.#driveTurn(state);
  }

  // Legacy single-generator path for one-shot callers without a dsh session
  // (kept for behavior parity with the codex adapter). Session turns go
  // through the chunk-log state machine.
  async *#singleStream(options) {
    const messages = options.messages;
    this.activeSessions.add(options.sessionId ?? "");

    const lastUserIdx = lastRealUserIndex(messages);
    const lastUserText = lastUserIdx >= 0 ? extractText(messages[lastUserIdx].content) : "";
    const turnInput = this.#buildTurnInput(messages, lastUserIdx);

    // A one-shot conversation never outlives this call: dedicated ephemeral
    // process, no persistence, destroyed in finally. Asset key must be
    // unique per call — concurrent one-shot callers would race on shared files.
    const process = this.#spawnProcess({
      sessionId: options.sessionId,
      model: options.model || this.model,
      effort: EFFORT_LEVELS.has(options.reasoningEffort) ? options.reasoningEffort : this.effort,
      resumeId: undefined,
      ephemeral: true,
      mcpConfig: this.#sessionAssets(`oneshot-${crypto.randomUUID()}`, options.tools),
    });

    // Event queue bridging async messages to the generator
    const queue = [];
    let waitResolve = null;
    let finished = false;
    let usage = null;
    let currentMessageId = "";
    let nextIndex = 0;
    // key → block record. Claude re-emits each content block as its own
    // `assistant` message sharing one message id, whose content array holds
    // just that block — so blocks are matched by message id + type in
    // creation order, never by array position.
    const blocks = new Map();
    const blockKeysByMessage = new Map();
    const toolBlocksByCallId = new Map();
    const rememberBlockKey = (messageId, type, key) => {
      let byType = blockKeysByMessage.get(messageId);
      if (!byType) { byType = new Map(); blockKeysByMessage.set(messageId, byType); }
      let keys = byType.get(type);
      if (!keys) { keys = []; byType.set(type, keys); }
      keys.push(key);
    };
    const takeBlockKey = (messageId, type) =>
      blockKeysByMessage.get(messageId)?.get(type)?.shift() ?? null;
    // Item ids already warned about for deltas arriving without a block —
    // one warning per item, never per delta.
    const warned = new Set();
    let hadToolCalls = false;

    const enqueue = (item) => {
      queue.push(item);
      if (waitResolve) { waitResolve(); waitResolve = null; }
    };

    const warnUnknown = (what, key) => {
      if (warned.has(key)) return;
      warned.add(key);
      this.logger?.warn?.(`harness-claude: ${what} for unknown block ${key}; dropped`);
    };

    const unregister = process.onMessage((msg) => {
      if (msg.type === "system") {
        return;
      }
      if (msg.type === "stream_event") {
        const event = msg.event ?? {};
        if (event.type === "message_start") {
          currentMessageId = event.message?.id ?? "";
          return;
        }
        if (event.type === "content_block_start") {
          const blockDef = event.content_block ?? {};
          const key = `${currentMessageId}:${event.index}`;
          if (blocks.has(key)) return;
          if (blockDef.type === "thinking") {
            const block = { kind: "reasoning", text: "", closed: false, emitted: true, index: nextIndex++ };
            blocks.set(key, block);
            enqueue({ type: "chunk", chunk: { type: "block-start", index: block.index, blockType: "reasoning" } });
          } else if (blockDef.type === "tool_use") {
            const mapped = toolCallFromUse(blockDef.name, blockDef.input);
            hadToolCalls = true;
            const block = {
              kind: "tool-call", claudeName: blockDef.name, name: mapped.name,
              callId: blockDef.id, argsText: "", argsJson: null, input: null,
              closed: false, emitted: true, deltaEmitted: false, index: nextIndex++,
            };
            blocks.set(key, block);
            toolBlocksByCallId.set(blockDef.id, block);
            enqueue({ type: "chunk", chunk: { type: "block-start", index: block.index, blockType: "tool-call" } });
            // Mount the running row with id/name; display args arrive with
            // the authoritative assistant message (see its tool_use branch).
            enqueue({
              type: "chunk",
              chunk: { type: "tool-call-delta", index: block.index, id: block.callId, name: block.name, argumentsDelta: "" },
            });
          } else {
            // Text blocks are buffered, never streamed mid-turn (see the
            // turn-result handling below).
            blocks.set(key, { kind: "text", text: "", closed: false, emitted: false });
          }
          rememberBlockKey(currentMessageId, blockDef.type ?? "text", key);
          return;
        }
        if (event.type === "content_block_delta") {
          const key = `${currentMessageId}:${event.index}`;
          const block = blocks.get(key);
          const delta = event.delta ?? {};
          if (!block) { warnUnknown("delta", key); return; }
          if (delta.type === "thinking_delta" && block.kind === "reasoning") {
            block.text += delta.thinking ?? "";
            enqueue({ type: "chunk", chunk: { type: "reasoning-delta", index: block.index, text: delta.thinking ?? "" } });
          } else if (delta.type === "text_delta" && block.kind === "text") {
            block.text += delta.text ?? "";
          } else if (delta.type === "input_json_delta" && block.kind === "tool-call") {
            block.argsText += delta.partial_json ?? "";
          }
          return;
        }
        // content_block_stop / message_delta / message_stop / ping carry no
        // state the single-stream path needs; assistant messages and tool
        // results are authoritative.
        return;
      }

      if (msg.type === "assistant") {
        const message = msg.message ?? {};
        const messageId = message.id ?? currentMessageId;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const blockDef of content) {
          const key = takeBlockKey(messageId, blockDef.type ?? "text");
          const block = key != null ? blocks.get(key) : null;
          if (!block) { warnUnknown("assistant block", `${messageId}:${blockDef.type}`); continue; }
          if (blockDef.type === "thinking") {
            block.text = blockDef.thinking ?? block.text;
            block.closed = true;
            enqueue({
              type: "chunk",
              chunk: { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } },
            });
          } else if (blockDef.type === "text") {
            block.text = normalizeLineBreaks(blockDef.text ?? block.text);
            block.closed = true;
          } else if (blockDef.type === "tool_use") {
            block.input = blockDef.input ?? {};
            // Re-map with the complete input so the receipt carries the
            // synthesized display args the custom card parses (serializing
            // the raw claude input would drop apply_patch's description).
            const mapped = toolCallFromUse(block.claudeName, block.input);
            block.name = mapped.name;
            block.argsJson = JSON.stringify(mapped.args);
            if (!block.deltaEmitted) {
              block.deltaEmitted = true;
              enqueue({
                type: "chunk",
                chunk: { type: "tool-call-delta", index: block.index, id: block.callId, name: block.name, argumentsDelta: block.argsJson },
              });
            }
          }
        }
        return;
      }

      if (msg.type === "user") {
        const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
        for (const blockDef of content) {
          if (blockDef?.type !== "tool_result") continue;
          const block = toolBlocksByCallId.get(blockDef.tool_use_id);
          if (!block) { warnUnknown("tool_result", blockDef.tool_use_id); continue; }
          // Single-stream settlement: stash the receipt result and hand the
          // agent loop a tool-call-result chunk so it can commit tool/call +
          // tool/result right away instead of waiting for the stream to end.
          const result = receiptOutput(blockDef, block);
          storeReceiptResult(this.receiptResults, block.callId, result);
          block.closed = true;
          const toolBlock = { type: "tool-call", id: block.callId, name: block.name, arguments: block.argsJson ?? "{}" };
          enqueue({ type: "chunk", chunk: { type: "block-end", index: block.index, block: toolBlock } });
          enqueue({ type: "chunk", chunk: { type: "tool-call-result", index: block.index, block: toolBlock, result } });
        }
        return;
      }

      if (msg.type === "result") {
        usage = this.#usageFrom(msg);
        // Close still-open blocks that were actually opened on the stream
        // (reasoning). Text blocks may never have been emitted — never send
        // a block-end without a matching block-start.
        for (const block of blocks.values()) {
          if (!block.emitted || block.closed || block.kind === "text") continue;
          block.closed = true;
          enqueue({
            type: "chunk",
            chunk: { type: "block-end", index: block.index, block: { type: block.kind, text: block.text } },
          });
        }

        // When tool calls exist, defer text to the next stream() call so
        // the dsh web UI's latestAnswer() sees a tool-call-free final step.
        if (hadToolCalls) {
          const buffered = [];
          for (const block of blocks.values()) {
            if (block.kind === "text" && block.text) buffered.push({ text: block.text });
          }
          this.pendingReplay.set(options.sessionId ?? "", {
            blocks: buffered,
            usage,
            userText: lastUserText,
            claudeSessionId: msg.session_id,
          });
          while (this.pendingReplay.size > 64) {
            const oldest = this.pendingReplay.keys().next().value;
            this.pendingReplay.delete(oldest);
            this.activeSessions.delete(oldest);
          }
        } else {
          for (const block of blocks.values()) {
            if (block.kind !== "text" || !block.text) continue;
            const index = nextIndex++;
            enqueue({ type: "chunk", chunk: { type: "block-start", index, blockType: "text" } });
            enqueue({ type: "chunk", chunk: { type: "text-delta", index, text: block.text } });
            enqueue({ type: "chunk", chunk: { type: "block-end", index, block: { type: "text", text: block.text } } });
          }
          if (usage) enqueue({ type: "chunk", chunk: { type: "usage", usage } });
        }

        const aborted = msg.terminal_reason === "aborted_streaming";
        if (!aborted && msg.subtype === "success") {
          enqueue({
            type: "chunk",
            chunk: {
              type: "finish",
              reason: { kind: "stop" },
              replayState: { claudeSessionId: msg.session_id },
            },
          });
        } else if (aborted) {
          // Same anchor durability as the split path: an interrupted one-shot
          // turn still records which claude conversation it belongs to.
          enqueue({
            type: "chunk",
            chunk: {
              type: "finish",
              reason: { kind: "aborted", failure: { message: "Claude turn interrupted", code: "ABORTED" } },
              replayState: { claudeSessionId: msg.session_id },
            },
          });
        } else {
          enqueue({
            type: "chunk",
            chunk: {
              type: "finish",
              reason: {
                kind: "error",
                failure: {
                  message: msg.subtype === "error_max_turns" ? "Claude turn reached max turns" : `Claude turn ${msg.subtype ?? "failed"}`,
                  code: "TURN_FAILED",
                },
              },
            },
          });
        }
        enqueue({ type: "done" });
        finished = true;
      }
    });

    // Abort handling: interrupt the claude turn
    const onAbort = () => process.interrupt();
    const onServerExit = process.onExitWait((handlerError) => {
      enqueue({
        type: "error",
        error: handlerError
          ? new LlmError(`claude stream translation failed: ${handlerError.message}`, "MALFORMED_RESPONSE", { cause: handlerError })
          : new LlmError("claude process exited mid-turn", "TRANSPORT"),
      });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (turnInput.length === 0) {
        throw new LlmError("harness-claude: last user message carried no claude-representable content", "UNSUPPORTED_CONTENT");
      }
      await process.ensure();
      // claude stays silent until the first stdin line, so the turn input
      // goes out before waiting for startup output.
      process.writeUser(turnInput);
      await process.waitFirstLine();

      // Drain the event queue until the result message
      while (true) {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item.type === "chunk") {
            yield item.chunk;
          } else if (item.type === "error") {
            throw item.error;
          } else if (item.type === "done") {
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
        `claude turn failed: ${error.message}`,
        "TRANSPORT",
        { cause: error },
      );
    } finally {
      if (!hadToolCalls) this.activeSessions.delete(options.sessionId ?? "");
      unregister();
      onServerExit();
      options.signal?.removeEventListener("abort", onAbort);
      process.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Split-turn state machine (sessions with a dsh session id)
  //
  // One claude turn may interleave several reasoning → tool rounds. dsh gives
  // an adapter exactly one stream() per step and appends tool/call +
  // tool/result for tool-call content blocks only AFTER the stream finishes
  // (when no tool-call-result chunk is emitted). Each claude tool call is
  // therefore sliced into its own dsh step with the codex adapter's
  // append-only chunk log + cursor:
  //
  //   step 1 stream(): reasoning1 + toolcall1 + finish(stop)   [pause finish]
  //     → assistant/message appends first, then the receipt tool executes and
  //       tool/call + tool/result append after it; the loop immediately calls
  //       stream() again (step returned null after tool dispatch)
  //   step 2 stream(): reasoning2 + toolcall2 + finish(stop)   [pause finish]
  //   ...
  //   final step: the live-streamed text answer + terminal finish
  //
  // Durable seq order then matches the real claude order. A standalone
  // tool-less (reasoning-only) step must never be emitted: the dsh loop
  // treats a finished step without tool calls as turn completion, which would
  // strand the claude turn and its final answer. Every finish chunk carries
  // the claude session id so an interrupted turn still leaves a resumable
  // anchor on disk.
  // -------------------------------------------------------------------------

  #createTurnState(sessionKey, session, options) {
    const process = session.process;
    const state = {
      sessionKey,
      session,
      signal: options.signal ?? null,
      // Set when the driving dsh turn's signal aborted: the claude turn is
      // being interrupted and its remaining output has no consumer.
      abandoned: false,
      // Per-turn translation state.
      blocks: new Map(),
      toolBlocksByCallId: new Map(),
      currentMessageId: "",
      // messageId → (blockType → keys in creation order); claude re-emits
      // each completed block as its own `assistant` message whose content
      // array holds just that block, so blocks are matched by message id +
      // type in creation order, never by array position.
      blockKeysByMessage: new Map(),
      warned: new Set(),
      // Append-only chunk log. Claude messages append chunks with
      // turn-global block indexes; stream() drains from `cursor`. A finish
      // chunk ends one dsh step: a tool result appends a pause finish so
      // dsh runs the receipt stub before claude continues, and the `result`
      // message appends the terminal finish (stop/aborted/error).
      queue: [],
      cursor: 0,
      nextIndex: 0,
      waiters: new Set(),
      usage: null,
      done: false,
      exitError: null,
      unregister: null,
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
    state.warnUnknown = (what, key) => {
      if (state.warned.has(key)) return;
      state.warned.add(key);
      this.logger?.warn?.(`harness-claude: ${what} for unknown block ${key}; dropped`);
    };
    state.rememberBlockKey = (messageId, type, key) => {
      let byType = state.blockKeysByMessage.get(messageId);
      if (!byType) { byType = new Map(); state.blockKeysByMessage.set(messageId, byType); }
      let keys = byType.get(type);
      if (!keys) { keys = []; byType.set(type, keys); }
      keys.push(key);
    };
    state.takeBlockKey = (messageId, type) =>
      state.blockKeysByMessage.get(messageId)?.get(type)?.shift() ?? null;

    // One abort listener per dsh turn: every step of a turn shares the phase
    // signal, so this also covers the between-steps window (receipt stub
    // execution) where no stream() call is draining. claude has no turn id
    // to wait for: an interrupt sent before the CLI starts processing is
    // settled by the CLI itself (still_queued).
    state.onAbort = () => {
      state.abandoned = true;
      process.interrupt();
    };
    state.signal?.addEventListener("abort", state.onAbort, { once: true });

    state.unregister = process.onMessage((msg) => {
      this.#onSessionMessage(state, msg);
    });
    state.unexit = process.onExitWait((handlerError) => {
      state.exitError = handlerError
        ? new LlmError(`claude stream translation failed: ${handlerError.message}`, "MALFORMED_RESPONSE", { cause: handlerError })
        : new LlmError("claude process exited mid-turn", "TRANSPORT");
      state.done = true;
      state.wake();
    });
    return state;
  }

  destroyTurn(sessionKey) {
    const state = this.claudeTurns.get(sessionKey);
    if (state) {
      state.unregister?.();
      state.unexit?.();
      if (state.onAbort && state.signal) state.signal.removeEventListener("abort", state.onAbort);
      this.claudeTurns.delete(sessionKey);
    }
    this.activeSessions.delete(sessionKey);
  }

  #onSessionMessage(state, msg) {
    if (msg.type === "system") {
      // system/init arrives once per turn; capture the conversation id on
      // the first one (a fresh conversation gets its id here; a resumed one
      // confirms it).
      if (msg.subtype === "init" && msg.session_id && !state.session.claudeSessionId) {
        state.session.claudeSessionId = msg.session_id;
      }
      return;
    }

    if (msg.type === "stream_event") {
      const event = msg.event ?? {};
      if (event.type === "message_start") {
        state.currentMessageId = event.message?.id ?? "";
        return;
      }
      if (event.type === "content_block_start") {
        const blockDef = event.content_block ?? {};
        const key = `${state.currentMessageId}:${event.index}`;
        if (state.blocks.has(key)) return;

        // Reasoning / text blocks stream the moment claude starts them; the
        // pause finish after a tool result separates dsh steps, so a block
        // arriving after a tool naturally opens the next step — no holding.
        if (blockDef.type === "thinking" || blockDef.type === "text") {
          const kind = blockDef.type === "thinking" ? "reasoning" : "text";
          const index = state.nextIndex++;
          state.blocks.set(key, { kind, text: "", closed: false, emitted: true, index });
          state.push({ type: "block-start", index, blockType: kind });
        } else if (blockDef.type === "tool_use") {
          const mapped = toolCallFromUse(blockDef.name, blockDef.input);
          state.session.emittedToolNames.add(mapped.name);
          const index = state.nextIndex++;
          const block = {
            kind: "tool-call", claudeName: blockDef.name, name: mapped.name,
            callId: blockDef.id, argsText: "", argsJson: null, input: null,
            closed: false, emitted: true, deltaEmitted: false, index,
          };
          state.blocks.set(key, block);
          state.toolBlocksByCallId.set(blockDef.id, block);
          state.push({ type: "block-start", index, blockType: "tool-call" });
          // Mount the running row under the mapped receipt name immediately.
          // claude streams tool arguments as partial JSON until the
          // authoritative assistant message, so the display args arrive
          // later; the empty delta only publishes id/name (argsRaw stays "").
          state.push({
            type: "tool-call-delta",
            index,
            id: block.callId,
            name: block.name,
            argumentsDelta: "",
          });
        }
        state.rememberBlockKey(state.currentMessageId, blockDef.type ?? "text", key);
        return;
      }
      if (event.type === "content_block_delta") {
        const key = `${state.currentMessageId}:${event.index}`;
        const block = state.blocks.get(key);
        const delta = event.delta ?? {};
        if (!block) { state.warnUnknown("delta", key); return; }
        if (delta.type === "thinking_delta" && block.kind === "reasoning") {
          block.text += delta.thinking ?? "";
          state.push({ type: "reasoning-delta", index: block.index, text: delta.thinking ?? "" });
        } else if (delta.type === "text_delta" && block.kind === "text") {
          block.text += delta.text ?? "";
          state.push({ type: "text-delta", index: block.index, text: delta.text ?? "" });
        } else if (delta.type === "input_json_delta" && block.kind === "tool-call") {
          block.argsText += delta.partial_json ?? "";
        }
        return;
      }
      // content_block_stop / message_delta / message_stop / ping: the
      // authoritative `assistant` and `user` messages carry completion.
      return;
    }

    if (msg.type === "assistant") {
      const message = msg.message ?? {};
      const messageId = message.id ?? state.currentMessageId;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const blockDef of content) {
        const key = state.takeBlockKey(messageId, blockDef.type ?? "text");
        const block = key != null ? state.blocks.get(key) : null;
        if (!block) { state.warnUnknown("assistant block", `${messageId}:${blockDef.type}`); continue; }

        if (blockDef.type === "thinking") {
          block.text = blockDef.thinking ?? block.text;
          block.closed = true;
          state.push({
            type: "block-end",
            index: block.index,
            block: { type: "reasoning", text: block.text },
          });
          continue;
        }
        if (blockDef.type === "text") {
          block.text = normalizeLineBreaks(blockDef.text ?? block.text);
          block.closed = true;
          state.push({
            type: "block-end",
            index: block.index,
            block: { type: "text", text: block.text },
          });
          continue;
        }
        if (blockDef.type === "tool_use") {
          block.input = blockDef.input ?? {};
          // Re-map with the now-complete input: the receipt name was known at
          // block start, but the display args (apply_patch's description,
          // bash's command/description) are synthesized from the full input.
          // Serializing the raw claude input here would leave the receipt
          // slot without the fields its card parses (no description → the
          // custom row never renders).
          const mapped = toolCallFromUse(block.claudeName, block.input);
          block.name = mapped.name;
          block.argsJson = JSON.stringify(mapped.args);
          // The non-empty args delta fires once; the empty start delta only
          // carried id/name, and frontend argsRaw is append-only.
          if (!block.deltaEmitted) {
            block.deltaEmitted = true;
            state.push({
              type: "tool-call-delta",
              index: block.index,
              id: block.callId,
              name: block.name,
              argumentsDelta: block.argsJson,
            });
          }
        }
      }
      return;
    }

    if (msg.type === "user") {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const blockDef of content) {
        if (blockDef?.type !== "tool_result") continue;
        const block = state.toolBlocksByCallId.get(blockDef.tool_use_id);
        if (!block) { state.warnUnknown("tool_result", blockDef.tool_use_id); continue; }
        // Tool result: stash the receipt result for the dsh receipt stub
        // (which the agent loop invokes after this stream finishes), close
        // the block, then append the pause finish. The pause splits the dsh
        // step here so the receipt executes before claude continues;
        // everything claude emits afterwards (final answer included) lands
        // in the next step naturally. No tool-call-result chunk: mid-stream
        // settlement would append tool events BEFORE this step's
        // assistant/message, inverting the order.
        const result = receiptOutput(blockDef, block);
        storeReceiptResult(this.receiptResults, block.callId, result);
        block.closed = true;
        state.push({
          type: "block-end",
          index: block.index,
          block: { type: "tool-call", id: block.callId, name: block.name, arguments: block.argsJson ?? "{}" },
        });
        state.push({
          type: "finish",
          reason: { kind: "stop" },
          replayState: { claudeSessionId: state.session.claudeSessionId },
        });
      }
      return;
    }

    if (msg.type === "result") {
      this.#onTurnResult(state, msg);
    }
  }

  #onTurnResult(state, result) {
    if (result.session_id && !state.session.claudeSessionId) {
      state.session.claudeSessionId = result.session_id;
    }
    state.usage = this.#usageFrom(result) ?? state.usage;

    // Close any still-open blocks: claude turns can end without settling
    // every block (failed/interrupted turns), and an unclosed block would
    // leave the step's assembler partial dangling.
    for (const block of state.blocks.values()) {
      if (block.closed || !block.emitted) continue;
      block.closed = true;
      state.push({
        type: "block-end",
        index: block.index,
        block: block.kind === "tool-call"
          ? { type: "tool-call", id: block.callId, name: block.name, arguments: block.argsJson ?? "{}" }
          : { type: block.kind, text: block.text },
      });
    }

    if (state.usage && !state.abandoned) {
      state.push({ type: "usage", usage: state.usage });
    }

    const aborted = state.abandoned || result.terminal_reason === "aborted_streaming";
    if (!aborted && result.subtype === "success") {
      state.push({
        type: "finish",
        reason: { kind: "stop" },
        replayState: { claudeSessionId: state.session.claudeSessionId },
      });
    } else if (aborted) {
      // The anchor rides even on the aborted finish: the claude conversation
      // is the session's context, and a turn interrupted before any tool
      // result must still leave a resumable id on disk (the CLI process
      // continues in memory; after a death the transcript resumes it).
      state.push({
        type: "finish",
        reason: { kind: "aborted", failure: { message: "Claude turn interrupted", code: "ABORTED" } },
        replayState: { claudeSessionId: state.session.claudeSessionId },
      });
    } else {
      state.push({
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: result.subtype === "error_max_turns" ? "Claude turn reached max turns" : `Claude turn ${result.subtype ?? "failed"}`,
            code: "TURN_FAILED",
          },
        },
      });
    }
    state.done = true;
    if (state.abandoned) {
      // The dsh turn is gone (its signal aborted): no further step, no
      // further receipt dispatch. Destroy the state now instead of waiting
      // for a drain that may never come — an abandoned turn's generator is
      // usually already closed mid-await, so driveTurn's consumer-driven
      // destroy never fires and the claim would leak into the next
      // (possibly non-claude) turn. destroyTurn is a no-op when a consumer
      // does still drain the finish.
      this.destroyTurn(state.sessionKey);
    }
    state.wake();
  }

  // Yield queued chunks for one dsh step. Every finish chunk ends the step:
  // a pause finish lets dsh run the receipt stub and call stream() again,
  // the terminal finish ends the dsh turn and tears the state down.
  async *#driveTurn(state) {
    // A generator closed without returning (the dsh loop .return()s it when
    // the turn aborts or dies mid-step) must not leave the turn state and
    // its receipt-tool claim dangling: destroy here — what the next
    // stream() call's stale check would do for a claude turn, and what a
    // non-claude next turn would never do.
    let settled = false;
    try {
      while (true) {
        if (state.exitError) {
          this.destroyTurn(state.sessionKey);
          throw state.exitError;
        }
        if (state.cursor < state.queue.length) {
          const chunk = state.queue[state.cursor++];
          if (chunk.type === "finish") {
            if (state.done) this.destroyTurn(state.sessionKey);
            yield chunk;
            settled = true;
            return;
          }
          yield chunk;
          continue;
        }
        if (state.done) {
          settled = true;
          return;
        }
        await new Promise((resolve) => { state.waiters.add(resolve); });
      }
    } finally {
      if (!settled) this.destroyTurn(state.sessionKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  // Claude executes its own tools inside the CLI process; the tool-call
  // blocks we emit are display receipts. They must resolve as REAL dsh tool
  // definitions, because dsh-tools' normalizeDispatchResult re-resolves the
  // tool for every successful (isError: false) result and throws
  // ToolNotFoundError for unregistered names. Registering them on the
  // claude session's agent scope keeps them invisible to every other
  // session (no global-registry leak) while letting the dispatch complete
  // and carry content + meta (diffs) into the transcript.
  const interceptClaudeReceipts = (adapter) => {
    const receiptToolDefinition = (toolName) => ({
      name: toolName,
      description: `Claude ${toolName} call receipt (display only; execution happened inside Claude Code).`,
      parameters: { type: "object", properties: {} },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => Array.isArray(value?.content) && value.content.length > 0
          ? value.content
          : [{ type: "text", text: "(no output)" }],
        // dsh-tools' snapshotProjection rejects undefined ("non-lossless
        // JSON"): receipts without meta (mcp/real-name tools) must yield
        // null, not undefined.
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
    const ensureReceiptTool = (agent, toolName) => {
      const agentCtx = agent?.ctx;
      if (!agentCtx?.tools || typeof agentCtx.tools.register !== "function") {
        ctx.logger?.warn?.(`harness-claude: agent ctx has no tools service; receipt "${toolName}" not registered`);
        return false;
      }
      let entry = receiptToolsRegistered.get(agentCtx);
      if (entry?.adapter !== adapter) {
        for (const disposer of entry?.byName.values() ?? []) {
          if (typeof disposer !== "function") continue;
          try {
            disposer();
          } catch (error) {
            ctx.logger?.warn?.(`harness-claude: failed to unregister receipt stub: ${error.message}`);
          }
        }
        entry = { adapter, byName: new Map() };
        receiptToolsRegistered.set(agentCtx, entry);
      }
      if (entry.byName.has(toolName)) return true;
      try {
        entry.byName.set(toolName, agentCtx.tools.register(receiptToolDefinition(toolName)));
      } catch (error) {
        ctx.logger?.warn?.(`harness-claude: failed to register scope-local receipt tool "${toolName}": ${error.message}`);
        entry.byName.set(toolName, null);
        return false;
      }
      return true;
    };
    // Scoped registrations shadow the global tool for the agent's whole
    // lifetime, so a receipt stub left behind after the claude turn ends
    // keeps answering from the dead receipt map for every native bash/apply
    // patch call — the harness switch back to dsh looks broken (the codex
    // adapter's production incident). The claim release alone cannot undo
    // the registration, so drop on two triggers; a later claude turn
    // re-registers on demand:
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
      for (const disposer of registered.byName.values()) {
        if (typeof disposer !== "function") continue;
        try {
          disposer();
        } catch (error) {
          ctx.logger?.warn?.(`harness-claude: failed to unregister receipt stub: ${error.message}`);
        }
      }
      receiptToolsRegistered.delete(agentCtx);
    };
    ctx.on("session/event", (session, event) => {
      if (event?.type !== "turn/start") return;
      const sessionId = session?.id;
      if (!sessionId || adapter.activeSessions.has(sessionId)) return;
      dropReceiptTools(ctx.get("agents")?.get(sessionId));
    });
    return ctx.on("tools/execute", async (exec, next) => {
      if (!adapter.activeSessions.has(exec.agent?.session?.id)) {
        dropReceiptTools(exec.agent);
        return next();
      }
      const sessionId = exec.agent?.session?.id;
      const isReceipt = RECEIPT_TOOL_NAMES.has(exec.name)
        || exec.name.startsWith("mcp__")
        // claude tools without a dsh-native counterpart (Read, Grep, Task…)
        // are emitted under their real names and stub-registered on demand.
        || adapter.sessions.get(sessionId)?.emittedToolNames.has(exec.name);
      if (!isReceipt) return next();
      // Register on demand (covers real-name and dynamic mcp__server__tool
      // names), then let the dispatch run the scope-local receipt tool body.
      ensureReceiptTool(exec.agent, exec.name);
      return next();
    });
  };

  const adapter = new ClaudeAdapter({
    command: volatileValue(config.command),
    cwd: config.cwd,
    model: volatileValue(config.model),
    effort: volatileValue(config.effort),
    permissionMode: config.permissionMode ?? "bypassPermissions",
    exposeTools: volatileValue(config.exposeTools),
    // Gateway service getter (resolved at call time) + llm registry: the
    // relay endpoint (spawn env) and the source-provider metadata lookups
    // (resolveModel) run through them.
    gateway: () => ctx.llmBase,
    llm: ctx.llm,
    toolExecutor: async (toolName, args, signal) =>
      ctx.tools.execute({ name: toolName, arguments: args, signal }),
    // Resolve the streaming session's workspace cwd at call time: the dsh-llm
    // stream options do not carry it, but every stream belongs to a live
    // session whose immutable header records the workspace directory.
    sessionCwd: (sessionId) => {
      const session = sessionId ? ctx.sessions.get(sessionId) : null;
      return session?.header?.cwd ?? null;
    },
    logger: ctx.logger,
  });
  interceptClaudeReceipts(adapter);
  ctx.llm.registerAdapter(["claude"], adapter);
  ctx.logger.info("harness-claude: registered provider 'claude'");

  // Models settings page: one provider row for claude, edited through the
  // plugin's own settings section (ns = the patch entry id "harness-claude").
  ctx.llm.registerConfigurableProviders([{
    provider: "claude",
    displayName: "Claude",
    settingsNs: "harness-claude",
    settingsPath: [],
  }]);
  // Harness identity registration: the selection state, the reroute dispatch,
  // the prompt section, and the model-picker row are all owned by dsh-harness-base
  // (the neutral relay). This plugin contributes only its identity — the
  // dispatch lands back here through the ordinary "claude" provider adapter.
  ctx.llmBase.registerHarness({
    id: "claude",
    displayName: "Claude",
    icon: "<svg fill='#D97757' role='img' viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'><path d='m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'/></svg>",
    prompt: "You are running on the Claude harness.",
  });

  // Settings user-layer edits reach the running adapter live.
  ctx.on("internal/config", function(_raw, next) {
    const raw = next();
    if (this !== ctx.fiber) return raw;
    const candidate = Config(raw);
    adapter.applyConfig(candidate);
    return raw;
  });

  // Per-session state must die with the plugin, not only the CLI processes:
  // session claims and receipt results would
  // otherwise leak across a dispose/re-register cycle.
  const clearAdapterState = () => {
    adapter.activeSessions.clear();
    adapter.pendingReplay.clear();
    adapter.receiptResults.clear();
    for (const sessionKey of adapter.claudeTurns.keys()) {
      adapter.destroyTurn?.(sessionKey);
    }
    adapter.claudeTurns.clear();
    for (const session of adapter.sessions.values()) {
      session.process?.destroy();
    }
    adapter.sessions.clear();
    // MCP bridge assets + tool gateway socket must die with the plugin too.
    adapter.disposeAssets();
  };

  ctx.on("dispose", () => {
    if (process.env.DSH_CLAUDE_DEBUG) {
      process.stderr.write("[claude] ctx dispose event\n");
    }
    clearAdapterState();
  });

  return () => {
    if (process.env.DSH_CLAUDE_DEBUG) {
      process.stderr.write("[claude] dispose called\n");
    }
    clearAdapterState();
  };
}

export { name, inject, Config, apply, ClaudeAdapter };
