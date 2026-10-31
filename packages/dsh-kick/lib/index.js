// dsh-kick — 与 steer 平行的「打断发送」投递概念（封装 cancel + steer）。
//
// 交互形态「先 Kick、后原生发送」：Kick 按钮（lib/client.js）给会话设置
// 一次性标记（30s TTL）；之后任何原生手势发出的下一条人工消息入箱瞬间，
// 消费标记执行 kick —— cancel({keepInbox}) 打断当前回合，消息改投为
// 新回合的第一条立即处理。不点 Kick = 原生行为零改动。
//
// 编程面：cordis 服务 "kick"（inject = ["kick"] 或 ctx.get("kick")）+
// agent/created 时给每个 agent 实例挂 kick(message)。jobs 通知 /
// runtime-context 注入以 source.kind === "user" 过滤；compaction 等维护
// 任务期间 status 为 idle 不会误杀；空闲会话 kick 退化为直接 steer。
// 全部公开原语，不改 dsh 核心。

import { Service } from "@deepseek-ai/cordis";
import { isLoopbackHost } from "@deepseek-ai/dsh-host-webserver";
import z from "@deepseek-ai/schemastery";

const name = "dsh-kick";
const inject = ["webServer"];
const KICK_TTL_MS = 30_000;
const Config = z.object({});

class KickService extends Service {
	// sessionId → 标记过期时刻。进程内状态：kick 是提交时刻的即时意图，
	// 无需跨进程/跨重启存续。public 属性（cordis 跨 fiber 是 shadow proxy，
	// #private 字段会炸）。
	kicks;

	constructor(ctx) {
		super(ctx, "kick");
		this.kicks = new Map();
	}

	armed(sessionId) {
		const expiresAt = this.kicks.get(sessionId);
		if (expiresAt === undefined) return false;
		if (Date.now() > expiresAt) {
			this.kicks.delete(sessionId);
			return false;
		}
		return true;
	}

	arm(sessionId, ttlMs = KICK_TTL_MS) {
		this.kicks.set(sessionId, Date.now() + ttlMs);
	}

	disarm(sessionId) {
		this.kicks.delete(sessionId);
	}

	/** 打断投递一条未入箱的新消息：running 先 cancel({keepInbox}) 再 steer（abort
	 * 后核心自动归 next-turn 并唤醒）；idle 直接 steer 开新回合。 */
	kick(sessionId, message) {
		return this.kickAgent(this.ctx.get("agents")?.get(sessionId), message);
	}

	/** 已持有 agent 句柄的调用方（如 agent-team）用这个变体。 */
	kickAgent(agent, message) {
		if (agent === undefined || typeof agent.steer !== "function") return false;
		if (agent.status === "running") {
			agent.cancel({ kind: "user" }, { keepInbox: true });
			this.deliverFirst(agent, message);
		} else {
			agent.steer(message);
		}
		return true;
	}

	/**
	 * abort 后核心把 steer 的消息改投 next-turn 末尾（send 以 Infinity 追加），
	 * 队首更早的排队消息会先被认领 —— kick 排队第二条实际先跑第一条的根因。
	 * steer 负责唤醒，随后把消息挪回 next-turn 队首，保证被 kick 的消息就是
	 * 新回合的第一条，其余排队按原序继续。仅 running 路径需要：idle 的 steer
	 * 进 next-step，认领时本就最先。
	 */
	deliverFirst(agent, message) {
		agent.steer(message);
		if (agent.inbox.remove(message.id)) agent.inbox.prepend("next-turn", message);
	}

	/** 排队 dock 的待处理行（next-turn 人工消息，FIFO）：[{id, text}]。 */
	queue(sessionId) {
		const agent = this.ctx.get("agents")?.get(sessionId);
		if (agent === undefined) return [];
		return (agent.inbox.nextTurn ?? [])
			.filter((m) => m?.source?.kind === "user" && typeof m?.id === "string")
			.map((m) => ({
				id: m.id,
				text: (m.content ?? []).filter((b) => b?.type === "text").map((b) => b?.text ?? "").join(""),
			}));
	}

	/**
	 * Kick 排队中的某一条（dock 行内按钮）：打断当前运行，该消息立即作为
	 * 新回合的第一条执行；其余待处理工作随新回合继续被认领。消息不在排队
	 * 中（已被认领/移除）返回 {action:"none"}。
	 */
	kickItem(sessionId, itemId) {
		const agent = this.ctx.get("agents")?.get(sessionId);
		if (agent === undefined || typeof agent.steer !== "function") return { action: "none" };
		const message = [...(agent.inbox.nextTurn ?? []), ...(agent.inbox.nextStep ?? [])]
			.find((m) => m?.source?.kind === "user" && m?.id === itemId);
		if (message === undefined) return { action: "none" };
		if (agent.status === "running") {
			agent.cancel({ kind: "user" }, { keepInbox: true });
			agent.inbox.remove(itemId);
			this.deliverFirst(agent, message);
		} else {
			agent.inbox.remove(itemId);
			agent.steer(message);
		}
		return { action: "kick" };
	}

	/**
	 * Kick 队列：打断当前运行，并把 inbox 里所有待处理的人工消息（next-step
	 * + next-turn，FIFO）立即调度执行。从 HTTP 处理器调用（投影已落定），
	 * 不依赖入箱瞬间的时序。无待处理消息时退化为纯打断（等同停止但保留
	 * inbox）；agent 不存在返回 {action:"none"}。
	 */
	flush(sessionId) {
		const agent = this.ctx.get("agents")?.get(sessionId);
		if (agent === undefined || typeof agent.steer !== "function") return { action: "none" };
		const pending = [...(agent.inbox.nextStep ?? []), ...(agent.inbox.nextTurn ?? [])]
			.filter((m) => m?.source?.kind === "user" && typeof m?.id === "string");
		const wasRunning = agent.status === "running";
		if (wasRunning) agent.cancel({ kind: "user" }, { keepInbox: true });
		if (pending.length === 0) return { action: wasRunning ? "interrupt" : "none" };
		for (const m of pending) agent.inbox.remove(m.id);
		// 重新投递：第一条 steer（abort 后核心归 next-turn 并唤醒；idle 直接
		// 开新回合），其余 followup 按 FIFO 排成后续回合。
		agent.steer(pending[0]);
		for (const m of pending.slice(1)) agent.followup(m);
		return { action: "flush", count: pending.length };
	}
}

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

function registerRoute(ctx, kick, remote) {
	return ctx.webServer.register({
		kind: "prefix",
		path: "/api/kick",
		handler: async (req, res) => {
			// 非回环 bind 才过 composition 的 Host/Origin + 浏览器会话门
			// （harness-base 同款：回环开放）。回环上无差别过门会把页面自己的
			// 标记 POST 一并 401 掉，kick 永远不生效。
			if (remote) {
				const rejection = ctx.get("connection")?.requestRejection(req);
				if (rejection !== undefined) {
					res.statusCode = rejection;
					res.end();
					return;
				}
			}
			if (req.method === "GET") {
				const sessionId = new URL(req.url ?? "/", "http://base.invalid").searchParams.get("sessionId");
				if (!sessionId) {
					sendJson(res, 400, { error: { message: "dsh-kick: sessionId is required" } });
					return;
				}
				sendJson(res, 200, { armed: kick.armed(sessionId), items: kick.queue(sessionId) });
				return;
			}
			if (req.method !== "POST") {
				res.statusCode = 405;
				res.end();
				return;
			}
			let body;
			try {
				body = JSON.parse(await readBody(req));
			} catch {
				body = {};
			}
			if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
				sendJson(res, 400, { error: { message: "dsh-kick: sessionId is required" } });
				return;
			}
			if (typeof body.itemId === "string" && body.itemId.length > 0) {
				sendJson(res, 200, kick.kickItem(body.sessionId, body.itemId));
				return;
			}
			if (body.flush === true) {
				sendJson(res, 200, kick.flush(body.sessionId));
				return;
			}
			if (body.armed === false) {
				kick.disarm(body.sessionId);
				sendJson(res, 200, { armed: false });
				return;
			}
			if (body.armed !== true) {
				sendJson(res, 400, { error: { message: "dsh-kick: armed must be a boolean" } });
				return;
			}
			kick.arm(body.sessionId);
			sendJson(res, 200, { armed: true });
		},
	});
}

function apply(ctx) {
	const kick = new KickService(ctx);
	const remote = !isLoopbackHost(ctx.webServer?.host);

	ctx.effect(
		() => registerRoute(ctx, kick, remote),
		"dsh-kick: GET/POST /api/kick",
	);
	ctx.logger?.info?.("dsh-kick: kick route (/api/kick), composer button, and agent.kick() registered");

	ctx.on("session/event", (session, event) => {
		if (event?.type !== "agent/inbox/spliced") return;
		const data = event.data;
		if ((data?.target !== "next-step" && data?.target !== "next-turn") || data?.outcome !== undefined) return;
		const message = (data.inserted ?? []).find((candidate) => candidate?.source?.kind === "user" && typeof candidate?.id === "string");
		// 非人工入箱不触发也不消耗标记。
		if (message === undefined) return;
		const sessionId = session?.id;
		if (!kick.armed(sessionId)) return;
		kick.disarm(sessionId); // 一次性：无论后续是否真正打断
		const agent = ctx.get("agents")?.get(sessionId);
		// 空闲 / 维护任务（status 为 idle）：kick 空转，消息走原生流程。此处的
		// 消息已在 inbox 里，比 KickService.kick 多一步 remove。
		if (agent === undefined || agent.status !== "running") return;
		agent.cancel({ kind: "user" }, { keepInbox: true });
		agent.inbox.remove(message.id);
		kick.deliverFirst(agent, message);
		ctx.logger?.info?.(`dsh-kick: kicked session ${sessionId} — interrupted the running turn and delivered the message as a fresh turn`);
	});

	// agent.kick(message)：其它插件拿到 agent 句柄即可直接打断投递。
	// 已有 kick（其它实现先到）时静默让位，不覆盖。
	ctx.on("agent/created", ({ agent }) => {
		if (agent.kick) return;
		agent.kick = (message) => kick.kickAgent(agent, message);
	});
}

export { Config, KickService, apply, inject, name };
