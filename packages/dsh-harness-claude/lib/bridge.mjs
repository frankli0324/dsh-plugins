// MCP stdio bridge that exposes dsh tools to a claude CLI process.
// Spawned by the claude CLI via --mcp-config as
//   <node> bridge.mjs <socketPath> <toolsJsonPath> <sessionId>
// It speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0) on
// stdin/stdout, serves the tool list from the JSON file the adapter wrote at
// spawn time, and forwards tools/call requests over the Unix socket to the
// dsh adapter's tool gateway, which executes the real dsh tool.
//
// Wire format on the Unix socket (one JSON object per line):
//   → {"id":<n>,"tool":"<name>","arguments":{…},"sessionId":"…"}
//   ← {"id":<n>,"ok":true,"content":[…MCP content…],"isError":false}
//   ← {"id":<n>,"ok":false,"error":"…"}
import net from "node:net";
import readline from "node:readline";
import { readFileSync } from "node:fs";

const socketPath = process.argv[2];
const toolsPath = process.argv[3];
const sessionId = process.argv[4] ?? "";

// The adapter rewrites the file per spawn; read lazily so claude's
// tools/list (after initialize) sees the final content.
function loadTools() {
  try {
    const parsed = JSON.parse(readFileSync(toolsPath, "utf8"));
    return Array.isArray(parsed?.tools) ? parsed.tools : [];
  } catch {
    return [];
  }
}

// --- Unix-socket client ----------------------------------------------------

let socket = null;
let nextCallId = 1;
const waiters = new Map(); // call id → {resolve}

function failAll(error) {
  for (const [, waiter] of waiters) waiter.reject(error);
  waiters.clear();
}

function connect() {
  if (socket && !socket.destroyed) return socket;
  socket = net.connect(socketPath);
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
      const waiter = waiters.get(message?.id);
      if (!waiter) continue;
      waiters.delete(message.id);
      if (message.ok) waiter.resolve(message);
      else waiter.reject(new Error(message.error || "dsh tool gateway error"));
    }
  });
  socket.on("error", (error) => {
    socket = null;
    failAll(error);
  });
  socket.on("close", () => {
    socket = null;
    failAll(new Error("dsh tool gateway connection closed"));
  });
  return socket;
}

function callTool(tool, args) {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    try {
      connect().write(JSON.stringify({ id, tool, arguments: args ?? {}, sessionId }) + "\n");
    } catch (error) {
      waiters.delete(id);
      reject(error);
    }
  });
}

// --- MCP stdio server ------------------------------------------------------

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }) + "\n");
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  // Notifications (no id) need no response; cancelled requests are dropped.
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dsh-claude-tools", version: "0.3.0" },
      });
      return;
    }
    if (method === "tools/list") {
      respond(id, { tools: loadTools() });
      return;
    }
    if (method === "tools/call") {
      const outcome = await callTool(params?.name, params?.arguments);
      respond(id, { content: outcome.content, isError: outcome.isError === true });
      return;
    }
    if (method === "ping") {
      respond(id, {});
      return;
    }
    respondError(id, `method not found: ${method}`);
  } catch (error) {
    respond(id, { content: [{ type: "text", text: `Error: ${error?.message ?? String(error)}` }], isError: true });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }
  void handle(message);
});
rl.on("close", () => process.exit(0));
