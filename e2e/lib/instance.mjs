// Isolated dsh instance for harness e2e: fresh DSH_HOME with a web profile
// that boots the harness suite, a local mock LLM, and an HTTP/RPC driver.
//
// Why web and not headless: a headless boot lacks the webServer / connection /
// credentials services, so the harness suite can't mount there. The web
// profile is the minimal stack that does mount it, so cases drive one
// long-lived server — `POST /api/<method>` RPCs behind a /connect cookie —
// and read answers from the on-disk session log (zstd jsonl), not stdout.
//
// No remote model: the runner hosts a local Anthropic-wire mock (mock-llm.mjs)
// and the home is written from scratch — the real home's providers and
// credentials are deliberately NOT copied, so a run never touches a provider
// nor depends on credential validity. Both the model binding (agent-default-
// model) and the mock provider registration are patched in the USER layer
// (DSH_HOME/cordis.patch.yml): profile-layer patches are package-scoped —
// they merge under the profile's own packages — while agent-default-model is
// read from the dsh-base bundle, so a profile-layer entry never reaches it.
import { MockLlm } from "./mock-llm.mjs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";

const PROFILE = "harness-e2e-web";

/** Profile-layer patch: package-scoped, reaches only the suite's own config. */
const PROFILE_PATCH = `\
- id: harness-base
  name: dsh-harness-base
  config:
    harnesses:
      codex: Codex
      claude: Claude
`;

/** User-layer entry registering the local mock as the only provider. */
function mockProviderPatch(baseUrl) {
  return `\
- id: llm-pi-ai
  config:
    providers:
      dsh-e2e-mock:
        api: anthropic-messages
        baseURL: ${baseUrl}
        apiKeyEnv: DSH_E2E_MOCK_KEY
        displayName: E2E Mock
        models:
          - id: e2e-mock
            name: e2e-mock
            contextWindow: 200000
            maxTokens: 8192
            input: [text]
`;
}

/** User-layer entry rebinding the default model inside the dsh-base bundle. */
const MODEL_PATCH = `\
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: dsh-e2e-mock
    model: e2e-mock
`;

/** Minimal credentials file: only the mock key the provider profile names. */
const MOCK_CREDENTIALS = `\
version: 1
refs:
  DSH_E2E_MOCK_KEY: e2e-mock
`;

export class DshInstance {
  #proc = null;
  #cookie = "";
  #mock = null;

  constructor(home, bin) {
    this.home = home;
    this.profile = PROFILE;
    this.bin = bin;
    this.url = "";
  }

  /** Build the isolated DSH_HOME and boot the web server. */
  static async create(repoRoot) {
    const home = await mkdtemp(path.join(tmpdir(), "dsh-harness-e2e-"));
    const inst = new DshInstance(home, process.env.DSH_BIN ?? "dsh");
    inst.#mock = new MockLlm();
    await inst.#mock.start();
    const profileDir = path.join(home, "profiles", PROFILE);
    await mkdir(path.join(profileDir, "node_modules"), { recursive: true });
    await writeFile(
      path.join(profileDir, "package.json"),
      JSON.stringify(
        {
          name: `dsh-profile-${PROFILE}`,
          private: true,
          dependencies: {
            "dsh-harness-suite": `link:${path.join(repoRoot, "packages", "dsh-harness-suite")}`,
          },
          dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-harness-suite"] } },
        },
        null,
        2,
      ),
    );
    await writeFile(path.join(profileDir, "cordis.patch.yml"), PROFILE_PATCH);
    await symlink(
      path.join(repoRoot, "packages", "dsh-harness-suite"),
      path.join(profileDir, "node_modules", "dsh-harness-suite"),
    );
    // User layer from scratch: the mock provider + the default-model rebind
    // (see file comment), and the one credential the mock profile names. No
    // real-home file is copied — nothing in a run may reach a remote model.
    // The credentials service refuses world-readable files, hence mode 600.
    await writeFile(path.join(home, "cordis.patch.yml"), `${mockProviderPatch(inst.#mock.url)}\n${MODEL_PATCH}`);
    await writeFile(path.join(home, ".credentials.yaml"), MOCK_CREDENTIALS, { mode: 0o600 });
    // A failed boot must not leak the spawned dsh child (it outlives this
    // process and holds the temp home) — tear the half-built instance down.
    try {
      await inst.#start();
    } catch (error) {
      await inst.dispose();
      throw error;
    }
    return inst;
  }

  /** Boot `dsh web`, parse the announced URL+token, exchange it for a cookie. */
  async #start() {
    const child = spawn(
      this.bin,
      ["--profile", this.profile, "--port", "0", "--host", "127.0.0.1", "--no-open"],
      { env: { ...process.env, DSH_HOME: this.home }, cwd: this.home, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#proc = child;
    const stderr = [];
    child.stderr.on("data", (d) => stderr.push(String(d)));
    const announced = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`dsh web server did not announce within 60s\n${stderr.join("").slice(-2000)}`)),
        60000,
      );
      let buffer = "";
      child.stdout.on("data", (d) => {
        buffer += String(d);
        const match = buffer.match(/dsh web: (\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`dsh exited ${code} during boot\n${stderr.join("").slice(-2000)}`));
      });
    });
    const url = new URL(announced);
    this.url = url.origin;
    const res = await fetch(`${this.url}/connect?token=${url.searchParams.get("token")}`, { redirect: "manual" });
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("/connect returned no session cookie");
    this.#cookie = cookie;
  }

  /** One `POST /api/<method>` RPC; resolves the result value or throws. */
  async rpc(method, args) {
    const res = await fetch(`${this.url}/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.#cookie },
      body: JSON.stringify({
        type: "client-request",
        rpcId: `e2e-${randomUUID()}`,
        method,
        payload: { args },
      }),
    });
    const body = await res.json();
    if (body.type !== "server-response") {
      throw new Error(`${method}: unexpected response ${JSON.stringify(body).slice(0, 300)}`);
    }
    if (!body.result?.ok) {
      throw new Error(`${method}: ${JSON.stringify(body.result ?? body).slice(0, 300)}`);
    }
    return body.result.value;
  }

  /** Hot-switch harness routing: `{harness, harnessBySession}` keys or both. */
  setRouting(patch) {
    return this.rpc("settings/update", { ns: "harness-base", patch });
  }

  async createSession(cwd = this.home) {
    const value = await this.rpc("session/create", { request: { cwd } });
    return value.sessionId;
  }

  prompt(sessionId, text) {
    return this.rpc("session/prompt", {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }],
        clientTimeZone: "Asia/Shanghai",
      },
    });
  }

  cancel(sessionId) {
    return this.rpc("session/cancel", { request: { sessionId } });
  }

  /** Path of the session's on-disk event log, or null until first write. */
  async sessionLogPath(sessionId) {
    const root = path.join(this.home, "sessions");
    if (!existsSync(root)) return null;
    for (const slug of await readdir(root)) {
      const candidate = path.join(root, slug, sessionId, "session.v4.jsonl.zstd");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Parsed events from the session log; empty while absent/corrupt. */
  async events(sessionId) {
    const logPath = await this.sessionLogPath(sessionId);
    if (!logPath) return [];
    try {
      return zstdDecompressSync(await readFile(logPath))
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return []; // mid-write decompress failure — the poll retries
    }
  }

  /**
   * Poll the log until the session records a turn/end after `afterSeq`.
   * Returns `{ events, end }` with the full event list and the end event.
   */
  async waitTurn(sessionId, { afterSeq = 0, timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = await this.events(sessionId);
      const end = events.find((e) => e.type === "turn/end" && e.seq > afterSeq);
      if (end) return { events, end };
      if (Date.now() > deadline) {
        throw new Error(`turn did not end within ${timeoutMs}ms (after seq ${afterSeq})`);
      }
      await sleep(500);
    }
  }

  /** Side-effect dir the claude adapter keeps its CLI config/transcripts in. */
  claudeConfigDir() {
    return path.join(this.home, "harness-claude", "claude-config");
  }

  /** All claude CLI transcript files, with sizes: `Map<file, bytes>`. */
  async claudeTranscripts() {
    const root = this.claudeConfigDir();
    const out = new Map();
    if (!existsSync(root)) return out;
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".jsonl")) out.set(p, statSync(p).size);
      }
    };
    walk(root);
    return out;
  }

  async dispose() {
    const proc = this.#proc;
    if (proc?.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
          resolve();
        }, 5000);
        proc.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.#mock?.close();
    // The dsh children outlive SIGTERM for a moment (their own CLI children
    // keep writing into the home), so rm races them — retry past ENOTEMPTY.
    await rm(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

/** Concatenated assistant text from events: claude attempts (deltas) or dsh messages (blocks). */
export function answerText(events) {
  const parts = [];
  for (const event of events) {
    if (event.type === "assistant/attempt") {
      for (const item of event.data.stream ?? []) {
        const chunk = item.chunk;
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") parts.push(chunk.text);
      }
    } else if (event.type === "assistant/message") {
      for (const block of event.data.message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
  }
  return parts.join("");
}

/** Highest event seq seen (0 when the log has nothing yet). */
export function lastSeq(events) {
  return events.length > 0 ? events[events.length - 1].seq : 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
