// Local mock LLM for harness e2e — replaces the remote model route so runs
// never depend on provider reachability or credential validity (the Super
// Relay JWT expiry failure mode).
//
// Speaks the Anthropic Messages wire only (`api: anthropic-messages`), on two
// path shapes because the two callers build URLs differently:
//   /v1/messages   — the pi-ai adapter (dsh's own agent loop) via the
//                    Anthropic SDK, which appends /v1/messages to the baseURL
//   /messages      — the dsh-harness-base relay, which forwards the claude
//                    CLI's /v1/messages with the /v1 prefix stripped
// (count_tokens likewise, both shapes).
//
// The model is rule-based over the request's message list — no state:
//   last user message carries tool_result  -> final text (the 只回复: marker)
//   text asks for `ping -c 60`             -> Bash tool_use ping -c 60 127.0.0.1
//   text asks for bash echo E2E_TOOL_OK    -> Bash tool_use echo E2E_TOOL_OK
//   otherwise                              -> text (只回复: marker, else E2E_MOCK_OK)
import http from "node:http";

const MODEL_ID = "e2e-mock";

// Unique ids per response, like the real API: the claude adapter keys stream
// blocks by `messageId:index`, so a reused message id makes the second
// response's blocks collide with the first's and get dropped.
let messageSeq = 0;
let toolUseSeq = 0;
const nextMessageId = () => `msg_e2e_${++messageSeq}`;
const nextToolUseId = () => `toolu_e2e_${++toolUseSeq}`;

export class MockLlm {
  #server = null;
  #port = 0;

  /** Bound origin, e.g. http://127.0.0.1:54321 — valid after start(). */
  get url() {
    return `http://127.0.0.1:${this.#port}`;
  }

  start() {
    this.#server = http.createServer((req, res) => {
      void this.#handle(req, res);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock-llm: listen timed out")), 5000);
      this.#server.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.#server.listen(0, "127.0.0.1", () => {
        clearTimeout(timer);
        this.#port = this.#server.address().port;
        resolve(this.url);
      });
    });
  }

  close() {
    return new Promise((resolve) => this.#server?.close(resolve));
  }

  async #handle(req, res) {
    const body = await readBody(req);
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // A malformed body gets a 400 on the message paths, {} elsewhere.
    }
    const path = req.url.split("?")[0];
    if (path.endsWith("/count_tokens")) {
      return json(res, { input_tokens: 100 });
    }
    if (!path.endsWith("/messages")) {
      return json(res, 404, { error: { message: `mock-llm: no route for ${path}` } });
    }
    if (parsed.stream === false) {
      return json(res, completeMessage(blocksFor(parsed)));
    }
    return stream(res, blocksFor(parsed));
  }
}

// --- model behavior -----------------------------------------------------------

/** Decide the response blocks from one request's message list. */
function blocksFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = [...messages].reverse().find((m) => m?.role === "user");
  const content = Array.isArray(last?.content) ? last.content : [{ type: "text", text: String(last?.content ?? "") }];
  const text = content
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
  // A tool_result turn means the tool round completed: answer the instruction.
  if (content.some((b) => b?.type === "tool_result")) {
    return [{ type: "text", text: markerFrom(messages) }];
  }
  if (/ping -c 60/.test(text)) {
    return [{ type: "tool_use", name: "Bash", input: { command: "ping -c 60 127.0.0.1" } }];
  }
  if (/用 bash 执行 echo E2E_TOOL_OK/.test(text)) {
    return [{ type: "tool_use", name: "Bash", input: { command: "echo E2E_TOOL_OK" } }];
  }
  return [{ type: "text", text: markerFrom(messages) }];
}

/** The newest 只回复:X marker across all user text, else the generic answer. */
function markerFrom(messages) {
  const markers = [];
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      for (const match of block.text.matchAll(/只回复[:：]\s*(\S+)/g)) markers.push(match[1]);
    }
  }
  return markers[markers.length - 1] ?? "E2E_MOCK_OK";
}

// --- wire ---------------------------------------------------------------------

function json(res, ...payloadOrStatus) {
  const [status, payload] = payloadOrStatus.length === 2 ? payloadOrStatus : [200, payloadOrStatus[0]];
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** A complete (non-streaming) Messages API response for the given blocks. */
function completeMessage(blocks) {
  return {
    id: nextMessageId(),
    type: "message",
    role: "assistant",
    model: MODEL_ID,
    content: blocks.map((b) => (b.type === "tool_use" ? { ...b, id: nextToolUseId() } : b)),
    stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function stream(res, blocks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: nextMessageId(),
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  let toolSeen = false;
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      toolSeen = true;
      sse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: nextToolUseId(), name: block.name, input: {} },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
  });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: toolSeen ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
