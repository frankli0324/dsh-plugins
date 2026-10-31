// dsh-session-drag 主机端离线冒烟测试：mock cordis ctx / webServer /
// workspaceRegistry / sessionPersistence，驱动 apply 装配、HTTP 语义与迁移全流程。
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const { name, inject, apply, moveSession, ROUTE_PREFIX } = await import(
	pathToFileURL(PLUGIN).href
);

let failures = 0;
function check(ok, label, detail = "") {
	if (ok) console.log(`  ok  ${label}`);
	else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// ── mock 设施 ────────────────────────────────────────────────────────────────

function makeCtx() {
	const state = { routes: [], effects: [], logs: { info: [], warn: [] }, activity: [] };
	state.ctx = {
		logger: { info: (m) => state.logs.info.push(m), warn: (m) => state.logs.warn.push(m) },
		waterfall: async (event, request, fallback) => (state.activity.length > 0 ? state.activity : fallback()),
		connection: {
			fetch: {
				register: (route) => {
					state.routes.push(route);
					return async () => {
						const at = state.routes.indexOf(route);
						if (at >= 0) state.routes.splice(at, 1);
					};
				},
			},
		},
		effect: (execute, label) => {
			const disposer = execute();
			state.effects.push({ label, disposer });
			return disposer;
		},
	};
	return state;
}

function makeWorkspace(id, path, title = id) {
	const calls = { attach: [], detach: [] };
	return {
		id, path, title, calls,
		status: async () => "ok",
		attachSession: async (sessionId) => { calls.attach.push(sessionId); },
		detachSession: async (sessionId) => { calls.detach.push(sessionId); },
	};
}

function makePersistence(sessions) {
	const created = [];
	return {
		created,
		async stat(id) { return sessions.get(id) ?? undefined; },
		async open(id) {
			const stored = sessions.get(id);
			if (stored === undefined) throw new Error(`no such session: ${id}`);
			return {
				id,
				header: stored.header,
				inheritedEventCount: stored.inheritedEventCount ?? 0,
				async read(offset, length) {
					return { eventState: "shared-frozen", events: stored.events.slice(offset, offset + length) };
				},
				close: async () => {},
			};
		},
		async create(header, options = {}) {
			const record = { header, inheritedEventCount: options.inheritedEventCount ?? 0, events: [], flushed: false, closed: false };
			created.push(record);
			return {
				id: header.id,
				header,
				get inheritedEventCount() { return record.inheritedEventCount; },
				append: async (events) => { record.events.push(...events); },
				flush: async () => { record.flushed = true; },
				close: async () => { record.closed = true; },
			};
		},
	};
}

function makeRegistry(workspaces, archived = []) {
	const state = { archived, archiveCalls: [] };
	return {
		state,
		get: (id) => workspaces.get(id) ?? undefined,
		list: () => [...workspaces.values()],
		get archivedSessionIds() { return state.archived; },
		archiveSession: async (sessionId) => {
			state.archiveCalls.push(sessionId);
			if (state.archiveRefusal === true) {
				const error = new Error("session is active");
				error.name = "WorkspaceActiveSessionError";
				error.activity = [{ kind: "turn" }];
				throw error;
			}
			state.archived.push(sessionId);
		},
	};
}

const event = (seq, type, data) => ({ seq, type, data, time: 1700000000000 + seq });

/** 用标准 fetch 语义驱动 Connection 路由的 fetch 处理器。 */
const call = async (route, path, { method = "GET", body = undefined } = {}) => {
	const request = new Request(`http://gui.local${path}`, {
		method,
		...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
	});
	return route.fetch(request);
};

// ── 1. 模块形状 ──────────────────────────────────────────────────────────────

console.log("1. module shape");
check(name === "dsh-session-drag", "name");
check(Array.isArray(inject) && ["connection", "workspaceRegistry", "sessionPersistence"].every((s) => inject.includes(s)), "inject declares host services");
check(ROUTE_PREFIX === "/api/dsh-session-drag", "route prefix under the shared /api channel");
check(typeof moveSession === "function", "moveSession exported");

// ── 2. apply 装配 ────────────────────────────────────────────────────────────

console.log("2. apply wiring");
const state2 = makeCtx();
apply(state2.ctx);
check(state2.routes.length === 1, "one route registered", JSON.stringify(state2.routes.map((r) => r.path)));
check(state2.routes[0]?.path === "/api/dsh-session-drag/move" && JSON.stringify(state2.routes[0]?.methods) === JSON.stringify(["POST"]), "move route POST");
check(state2.effects.length === 1 && state2.effects.every((e) => typeof e.disposer === "function"), "effects yield disposers");
await Promise.all(state2.effects.map((e) => e.disposer()));
check(state2.routes.length === 0, "disposers unregister routes (reload-safe)");

// ── 3. HTTP 语义 ─────────────────────────────────────────────────────────────

console.log("3. HTTP semantics");
const state3 = makeCtx();
state3.ctx.workspaceRegistry = makeRegistry(new Map());
state3.ctx.sessionPersistence = makePersistence(new Map());
apply(state3.ctx);
const [moveRoute] = state3.routes;
// 方法门禁由 Connection 载体执行（createSharedFetchHandler 按 route.methods 分发）。
check(JSON.stringify(moveRoute.methods) === '["POST"]', "move route declares POST only");

const badBodyRes = await call(moveRoute, `${ROUTE_PREFIX}/move`, { method: "POST", body: "{not json" });
check(badBodyRes.status === 400 && (await badBodyRes.json()).ok === false, "invalid JSON body → 400");

const arrayBodyRes = await call(moveRoute, `${ROUTE_PREFIX}/move`, { method: "POST", body: "[1]" });
check(arrayBodyRes.status === 400, "non-object body → 400");

// ── 4. moveSession 全流程 ────────────────────────────────────────────────────

console.log("4. moveSession flow");
const dirA = await mkdtemp(join(tmpdir(), "dshsd-a-"));
const dirB = await mkdtemp(join(tmpdir(), "dshsd-b-"));
const pathA = await realpath(dirA);
const pathB = await realpath(dirB);
try {
	const wsA = makeWorkspace("ws-a", pathA, "A");
	const wsB = makeWorkspace("ws-b", pathB, "B");
	const workspaces = new Map([["ws-a", wsA], ["ws-b", wsB]]);
	const sourceEvents = [event(0, "permission/preset", { preset: "read-only" }), event(1, "user/message", { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } })];
	const source = {
		header: { version: 4, id: "session-src", createdAt: 1700000000000, cwd: pathA, isSeeded: false, delegationDepth: 0 },
		inheritedEventCount: 0,
		events: sourceEvents,
	};
	const sessions = new Map([["session-src", source]]);
	const persistence = makePersistence(sessions);
	const registry = makeRegistry(workspaces);

	const ctx = makeCtx().ctx;
	ctx.workspaceRegistry = registry;
	ctx.sessionPersistence = persistence;

	const result = await moveSession(ctx, "session-src", "ws-b");
	check(result.status === 200 && result.body.ok === true && result.body.moved === true, "moved true");
	check(typeof result.body.sessionId === "string" && result.body.sessionId.startsWith("session-") && result.body.sessionId !== "session-src", "fork-shaped new session id");
	check(result.body.workspaceId === "ws-b" && result.body.sourceSessionId === "session-src" && result.body.eventCount === 2, "result echoes ids and event count");
	const copyId = result.body.sessionId;

	const copy = persistence.created[0];
	check(copy !== undefined && copy.flushed === true && copy.closed === true, "copy flushed and closed");
	check(copy.header.id === copyId && copy.header.cwd === pathB, "copy header: new id + target cwd");
	check(copy.header.isSeeded === false && copy.header.createdAt === source.header.createdAt && copy.header.parentSession === undefined, "copy header keeps the rest of the source header");
	check(copy.inheritedEventCount === 0, "copy inheritedEventCount follows source");
	check(JSON.stringify(copy.events) === JSON.stringify(sourceEvents), "events copied verbatim");
	check(wsB.calls.attach.join() === copyId, "copy attached to target workspace");
	check(registry.state.archived.join() === "session-src", "source archived");

	// cwd 已等于目标 → 无事可做（在目标工作区里的会话拖回它自己的组）
	sessions.set("session-b", {
		header: { version: 4, id: "session-b", createdAt: 1700000000000, cwd: pathB, isSeeded: false },
		events: [event(0, "user/message", { id: "u0", role: "user", content: [{ type: "text", text: "b" }], source: { kind: "user" } })],
	});
	const copiesBefore = persistence.created.length;
	const resultNoop = await moveSession(ctx, "session-b", "ws-b");
	check(resultNoop.status === 200 && resultNoop.body.moved === false && resultNoop.body.sessionId === "session-b", "same workspace → moved:false no-op");
	check(persistence.created.length === copiesBefore, "no copy created for no-op");

	// 源 cwd 不存在（目录被删）→ 继续走迁移（missing cwd 视为可迁移）
	rm(dirA, { recursive: true, force: true }).catch(() => {});
	const sourceMissing = {
		header: { version: 4, id: "session-gone", createdAt: 1700000000000, cwd: pathA, isSeeded: false },
		events: [event(0, "user/message", { id: "u2", role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } })],
	};
	sessions.set("session-gone", sourceMissing);
	const resultGone = await moveSession(ctx, "session-gone", "ws-b");
	check(resultGone.body.moved === true, "missing-cwd session still movable (ENONENT path skipped)");

	// 守卫类失败：直接返回 { status, body.code }，不抛异常
	const guard = makeCtx();
	guard.activity = [{ kind: "turn" }];
	const guardCtx = guard.ctx;
	guardCtx.workspaceRegistry = registry;
	guardCtx.sessionPersistence = persistence;
	const active = await moveSession(guardCtx, "session-src", "ws-a");
	check(active.status === 409 && active.body.code === "session-active", "active session refused 409", JSON.stringify(active.body));

	const unknownWs = await moveSession(ctx, "session-src", "ws-x");
	check(unknownWs.status === 404 && unknownWs.body.code === "workspace-not-found", "unknown workspace 404");
	const unknownSession = await moveSession(ctx, "session-nope", "ws-a");
	check(unknownSession.status === 404 && unknownSession.body.code === "session-not-found", "unknown session 404");
	const badIds = await moveSession(ctx, "", "ws-a");
	check(badIds.status === 400 && badIds.body.code === "invalid-request", "empty sessionId 400");

	const emptySessions = new Map([["session-empty", { header: { version: 4, id: "session-empty", createdAt: 1, cwd: pathA, isSeeded: false }, events: [] }]]);
	const emptyCtx = makeCtx().ctx;
	emptyCtx.workspaceRegistry = makeRegistry(workspaces);
	emptyCtx.sessionPersistence = makePersistence(emptySessions);
	const empty = await moveSession(emptyCtx, "session-empty", "ws-b");
	check(empty.status === 409 && empty.body.code === "session-empty", "empty session refused");

	// 归档撞上活动竞态 → 409 + detach 副本回滚 + 源未归档
	const raceCtx = makeCtx().ctx;
	const raceRegistry = makeRegistry(new Map([["ws-b", wsB]]));
	raceRegistry.state.archiveRefusal = true;
	raceCtx.workspaceRegistry = raceRegistry;
	raceCtx.sessionPersistence = persistence;
	const race = await moveSession(raceCtx, "session-src", "ws-b");
	check(race.status === 409 && race.body.code === "session-active", "archive race → 409 session-active");
	check(wsB.calls.detach.length === 1 && wsB.calls.detach[0] === persistence.created.at(-1).header.id, "copy detached on rollback");
	check(raceRegistry.state.archived.length === 0, "source not archived on race");

	// attach 失败 → attach-failed，源不动
	const attachCtx = makeCtx().ctx;
	const badWs = { ...makeWorkspace("ws-bad", pathB), attachSession: async () => { throw new Error("cwd mismatch"); } };
	attachCtx.workspaceRegistry = makeRegistry(new Map([["ws-bad", badWs]]));
	attachCtx.sessionPersistence = persistence;
	const attach = await moveSession(attachCtx, "session-src", "ws-bad");
	check(attach.status === 500 && attach.body.code === "attach-failed", "attach failure surfaced", JSON.stringify(attach.body));
	check(attachCtx.workspaceRegistry.state.archived.length === 0, "source untouched on attach failure");
} finally {
	await rm(dirB, { recursive: true, force: true }).catch(() => {});
	await rm(dirA, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
