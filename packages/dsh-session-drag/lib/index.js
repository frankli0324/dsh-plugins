// dsh-session-drag — 在 Web UI 侧边栏把会话跨工作区拖动。
//
// DSH 的会话归属由 cwd 推导：工作区注册表只把 header cwd 等于工作区 path 的
// 会话算作成员，且官方持久化把 header 声明为 immutable，没有"改 cwd / 搬家"
// 的 API。本插件用受支持的接口组合出"移动"：
//
//   1. 读源会话完整事件日志（sessionPersistence.open(id, 'read')）；
//   2. 以目标工作区 path 作为新 cwd 创建新会话（sessionPersistence.create），
//      源日志逐事件 append（与 fork 落盘同构：isSeeded / inheritedEventCount
//      沿源、事件原文照抄）；
//   3. 副本 attach 到目标工作区（cwd 匹配，注册表校验自然通过）；
//   4. 源会话归档（registry-global archive set，可 unarchive 撤销）。
//
// 先复制后归档：归档前的任何失败源会话都原封不动；归档撞上活动竞态则撤下
// 副本中止。有运行中工作时经 `workspace/session-activity` waterfall 拒绝，
// 不与 Agent 抢写。Web 侧（lib/client.js）在侧边栏 DOM 上做原生 drag & drop。

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

const name = "dsh-session-drag";
const inject = ["connection", "workspaceRegistry", "sessionPersistence"];

/** Fetch 路由挂在 Connection 的共享 /api 通道下（载体统一做信任围栏 + cookie 鉴权）。 */
const ROUTE_PREFIX = "/api/dsh-session-drag";
/** 事件分片大小：整段日志分批 append，避免一次性持有超大日志的两份拷贝。 */
const APPEND_BATCH = 512;

/** 会话 id 的构造方式与官方 fork（SessionCommandController.fork）一致。 */
const newSessionId = () => `session-${randomUUID()}`;

/** Connection fetch 路由的统一 JSON 响应。 */
const jsonResponse = (payload, status = 200) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

/**
 * 把一个会话迁移到目标工作区。
 * @returns { status, body } - 直接对应 HTTP 状态与响应体；body.ok 为 false 时
 * body.code 是客户端可判别的稳定码。
 */
async function moveSession(ctx, sessionId, workspaceId) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	const fail = (status, code, error, details) => ({
		status,
		body: { ok: false, code, error, ...(details === undefined ? {} : { details }) },
	});

	if (typeof sessionId !== "string" || sessionId.length === 0 || typeof workspaceId !== "string" || workspaceId.length === 0) {
		return fail(400, "invalid-request", "sessionId and workspaceId must be non-empty strings");
	}
	const workspace = registry.get(workspaceId);
	if (workspace === undefined) return fail(404, "workspace-not-found", `workspace "${workspaceId}" is not registered`);
	if ((await workspace.status()) !== "ok") {
		return fail(409, "workspace-missing-dir", `workspace "${workspace.title}" (${workspace.path}) 的目录当前不存在`);
	}
	const snapshot = await persistence.stat(sessionId);
	if (snapshot === undefined) return fail(404, "session-not-found", `session "${sessionId}" is not stored`);

	// 活动守卫：与 archiveSession 同一个 waterfall，turn/job/subagent/schedule
	// 任一在跑都拒绝，不与运行中的 Agent 抢写同一份日志。
	const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => []);
	if (activity.length > 0) return fail(409, "session-active", "会话仍有进行中的工作，先停止后再移动", { activity });

	// cwd 已等于目标（含经 realpath 归一，如 macOS /tmp → /private/tmp）→ no-op。
	if (snapshot.header.cwd !== undefined) {
		const current = await realpath(snapshot.header.cwd).catch(() => undefined);
		if (current === workspace.path) return { status: 200, body: { ok: true, moved: false, sessionId, workspaceId } };
	}

	// ── 1. 读源日志 ──
	const source = await persistence.open(sessionId, "read");
	const { header: sourceHeader, inheritedEventCount } = source;
	const events = [];
	try {
		for (;;) {
			const slice = await source.read(events.length, APPEND_BATCH);
			events.push(...slice.events);
			if (slice.events.length < APPEND_BATCH) break;
		}
	} finally {
		await source.close().catch(() => {});
	}
	if (events.length === 0) return fail(409, "session-empty", "会话还没有任何事件，不能移动");

	// ── 2. 建副本：新 id + 目标 cwd，日志逐事件照抄（fork 落盘同构） ──
	const copyId = newSessionId();
	const copy = await persistence.create(Object.freeze({ ...sourceHeader, id: copyId, cwd: workspace.path }), { inheritedEventCount });
	try {
		for (let at = 0; at < events.length; at += APPEND_BATCH) await copy.append(events.slice(at, at + APPEND_BATCH));
		await copy.flush();
	} finally {
		await copy.close().catch(() => {});
	}

	// ── 3. 副本挂到目标工作区（cwd 匹配 → 注册表校验通过） ──
	try {
		await workspace.attachSession(copyId);
	} catch (error) {
		ctx.logger.warn(`dsh-session-drag: copy "${copyId}" stored but attach to "${workspaceId}" failed: ${error?.message ?? String(error)}`);
		return fail(500, "attach-failed", `副本创建成功但挂载到目标工作区失败：${error?.message ?? String(error)}`);
	}

	// ── 4. 归档源会话（registry-global，可 unarchive 撤销）；竞态则撤下副本，源不动 ──
	try {
		await registry.archiveSession(sessionId);
	} catch (error) {
		await workspace.detachSession(copyId).catch(() => {});
		if (error?.name === "WorkspaceActiveSessionError") {
			return fail(409, "session-active", "会话在迁移过程中开始运行工作，已中止（未做任何更改）", { activity: error.activity ?? [] });
		}
		return fail(500, "archive-failed", `源会话归档失败，已中止：${error?.message ?? String(error)}`);
	}

	ctx.logger.info(
		`dsh-session-drag: session "${sessionId}" moved to "${workspace.title}" (${workspace.path}) as "${copyId}" (${events.length} events); original archived`,
	);
	return { status: 200, body: { ok: true, moved: true, sessionId: copyId, sourceSessionId: sessionId, workspaceId, eventCount: events.length } };
}

/** 迁移流程暴露成一个 Connection fetch 路由（载体已做信任围栏与 cookie 鉴权）。 */
function apply(ctx) {
	const route = {
		path: `${ROUTE_PREFIX}/move`,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				return jsonResponse({ ok: false, error: "invalid request body" }, 400);
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return jsonResponse({ ok: false, error: "request body must be a JSON object" }, 400);
			}
			try {
				const { status, body: payload } = await moveSession(ctx, body.sessionId, body.workspaceId);
				return jsonResponse(payload, status);
			} catch (error) {
				ctx.logger.warn(`dsh-session-drag: move failed: ${error?.message ?? String(error)}`);
				return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500);
			}
		},
	};

	ctx.effect(() => ctx.connection.fetch.register(route), `dsh-session-drag: route ${ROUTE_PREFIX}/move`);
	ctx.logger.info(`dsh-session-drag: route ready at ${ROUTE_PREFIX}/move (drag a session row onto another workspace)`);
}

export { ROUTE_PREFIX, apply, inject, moveSession, name };
