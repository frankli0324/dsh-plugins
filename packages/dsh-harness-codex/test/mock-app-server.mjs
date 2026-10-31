// Minimal codex app-server mock for offline adapter tests: a WebSocket-over-UDS
// JSON-RPC server honoring the subset of the protocol dsh-harness-codex uses
// (initialize / thread/start / thread/resume / thread/inject_items /
// turn/start / mcpServerStatus/list). Every request is appended as one JSONL
// line to $MOCK_LOG; the spawn record (argv + the env vars the wrapper
// contract cares about) is written first.
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";

// Socket now arrives as a spawn parameter: --listen unix://<path>.
const listenArg = process.argv.find((a) => a.startsWith("unix://"));
const sock = listenArg ? listenArg.slice("unix://".length) : process.env.CODEX_APP_SERVER_SOCKET;
const logPath = process.env.MOCK_LOG;
const scenario = process.env.MOCK_SCENARIO;
if (!sock || !logPath) {
  console.error("mock-app-server needs CODEX_APP_SERVER_SOCKET and MOCK_LOG");
  process.exit(1);
}

const log = (record) => fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
let turnCounter = 0;
log({
  type: "spawn",
  argv: process.argv.slice(2),
  env: {
    CODEX_APP_SERVER_SOCKET: sock,
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    ...(process.env.DSH_HARNESS_RELAY_TOKEN ? { DSH_HARNESS_RELAY_TOKEN: process.env.DSH_HARNESS_RELAY_TOKEN } : {}),
  },
});

fs.rmSync(sock, { force: true });
const server = net.createServer((socket) => {
  let httpBuf = Buffer.alloc(0);
  let upgraded = false;
  let wsBuf = Buffer.alloc(0);
  const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj));
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
    else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    }
    socket.write(Buffer.concat([header, payload]));
  };
  const respond = (id, result) => send({ id, result });

  const onMessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id === undefined || !msg.method) return;
    log({ type: "request", method: msg.method, params: msg.params });
    switch (msg.method) {
      case "initialize":
        respond(msg.id, { userAgent: "mock-codex/0.0.1" });
        return;
      case "thread/start":
        respond(msg.id, { thread: { id: "t-mock-1" } });
        return;
      case "thread/resume":
        respond(msg.id, { thread: { id: msg.params?.threadId ?? "t-mock-1" } });
        return;
      case "thread/inject_items":
        respond(msg.id, {});
        return;
      case "turn/interrupt": {
        respond(msg.id, {});
        const threadId = msg.params?.threadId ?? "t-mock-1";
        const turnId = msg.params?.turnId ?? "turn-1";
        if (scenario === "interrupt-mid-turn") {
          // Real app-server behavior (verified against codex 0.164): the
          // in-flight exec settles as aborted, then the turn reports
          // status=interrupted.
          setTimeout(() => {
            send({ method: "item/completed", params: { threadId, item: { id: "c2", type: "commandExecution", command: "npm install", cwd: "/tmp", status: "aborted", aggregatedOutput: "aborted by user", exitCode: null } } });
            send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", error: null } } });
          }, 20);
        }
        return;
      }
      case "mcpServerStatus/list":
        respond(msg.id, { data: [], nextCursor: null });
        return;
      case "turn/start": {
        respond(msg.id, { turn: { id: `turn-${++turnCounter}` } });
        const threadId = msg.params?.threadId ?? "t-mock-1";
        if (scenario === "interrupt-mid-turn" && turnCounter >= 2) {
          // The recovery turn after the interrupted one: a plain completed
          // agentMessage turn.
          setTimeout(() => {
            send({ method: "item/started", params: { threadId, item: { id: "m2", type: "agentMessage" } } });
            send({ method: "item/agentMessage/delta", params: { threadId, itemId: "m2", delta: "recovered" } });
            send({ method: "item/completed", params: { threadId, item: { id: "m2", type: "agentMessage", text: "recovered" } } });
            send({ method: "turn/completed", params: { threadId, turn: { id: `turn-${turnCounter}`, status: "completed" } } });
          }, 10);
          return;
        }
        // Emit one scripted agentMessage turn after the response settled.
        setTimeout(() => {
          if (scenario === "unfinished-command") {
            send({ method: "item/started", params: { threadId, item: { id: "c1", type: "commandExecution", command: "printf hi" } } });
            send({ method: "item/commandExecution/outputDelta", params: { threadId, itemId: "c1", delta: "hi" } });
            // No item/completed: codex turns can end without the tool item
            // settling (failed/interrupted turn); the adapter must still close
            // the emitted tool-call block with its wire shape.
            send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
            return;
          }
          if (scenario === "parallel-commands") {
            // Two in-flight commands; the second settles first and the first
            // only much later. Mirrors codex unified-exec: items complete
            // independently, so the adapter's segment freezes while an
            // earlier tool is still open, and its receipt executes before
            // the result exists.
            const cmd = (id, command) => ({ id, type: "commandExecution", command, cwd: "/tmp", status: "completed", aggregatedOutput: `out-${id}`, exitCode: 0 });
            send({ method: "item/started", params: { threadId, item: { id: "c1", type: "commandExecution", command: "echo one" } } });
            send({ method: "item/started", params: { threadId, item: { id: "c2", type: "commandExecution", command: "echo two" } } });
            send({ method: "item/completed", params: { threadId, item: cmd("c2", "echo two") } });
            setTimeout(() => {
              send({ method: "item/completed", params: { threadId, item: cmd("c1", "echo one") } });
              send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
            }, 300);
            return;
          }
          if (scenario === "interrupt-mid-turn") {
            // Turn 1 mirrors the production wedge: a reasoning + message +
            // tool sequence (tool completion freezes segment 0), then a long
            // in-flight command with no completion. When the adapter sends
            // turn/interrupt (dsh abort fired), the server — like the real
            // app-server — settles the tool and reports status=interrupted.
            const cmd = (id, command, status) => ({ id, type: "commandExecution", command, cwd: "/tmp", status, aggregatedOutput: `out-${id}`, exitCode: status === "completed" ? 0 : null });
            send({ method: "item/started", params: { threadId, item: { id: "r1", type: "reasoning" } } });
            send({ method: "item/completed", params: { threadId, item: { id: "r1", type: "reasoning", text: "think" } } });
            send({ method: "item/started", params: { threadId, item: { id: "m1", type: "agentMessage" } } });
            send({ method: "item/agentMessage/delta", params: { threadId, itemId: "m1", delta: "hello" } });
            send({ method: "item/completed", params: { threadId, item: { id: "m1", type: "agentMessage", text: "hello" } } });
            send({ method: "item/started", params: { threadId, item: cmd("c1", "echo one", "inProgress") } });
            send({ method: "item/completed", params: { threadId, item: cmd("c1", "echo one", "completed") } });
            // Long in-flight command; only settles when interrupted.
            setTimeout(() => {
              send({ method: "item/started", params: { threadId, item: cmd("c2", "npm install", "inProgress") } });
            }, 150);
            return;
          }
          send({ method: "item/started", params: { threadId, item: { id: "m1", type: "agentMessage" } } });
          send({ method: "item/agentMessage/delta", params: { threadId, itemId: "m1", delta: "Hello from mock" } });
          send({ method: "item/completed", params: { threadId, item: { id: "m1", type: "agentMessage", text: "Hello from mock" } } });
          send({ method: "turn/completed", params: { threadId, turn: { id: `turn-${turnCounter}`, status: "completed" } } });
        }, 10);
        return;
      }
      default:
        respond(msg.id, {});
    }
  };

  const handleFrames = () => {
    for (;;) {
      if (wsBuf.length < 2) return;
      const opcode = wsBuf[0] & 0x0f;
      const masked = (wsBuf[1] & 0x80) !== 0;
      let len = wsBuf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (wsBuf.length < 4) return;
        len = wsBuf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (wsBuf.length < 10) return;
        len = Number(wsBuf.readBigUInt64BE(2));
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (wsBuf.length < off + 4) return;
        mask = wsBuf.slice(off, off + 4);
        off += 4;
      }
      if (wsBuf.length < off + len) return;
      const payload = Buffer.from(wsBuf.slice(off, off + len));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      wsBuf = wsBuf.slice(off + len);
      if (opcode === 1) onMessage(payload.toString());
    }
  };

  socket.on("data", (chunk) => {
    if (upgraded) {
      wsBuf = Buffer.concat([wsBuf, chunk]);
      handleFrames();
      return;
    }
    httpBuf = Buffer.concat([httpBuf, chunk]);
    const idx = httpBuf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const head = httpBuf.slice(0, idx).toString();
    const key = /Sec-WebSocket-Key: (.*)\r/.exec(head)?.[1]?.trim() ?? "";
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    upgraded = true;
    wsBuf = httpBuf.slice(idx + 4);
    httpBuf = Buffer.alloc(0);
    handleFrames();
  });
  socket.on("error", () => {});
});

server.listen(sock);
