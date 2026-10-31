// dsh-kick 的离线单测：mock 插件宿主（捕获 session/event 与 webServer 路由，
// 可注入 agents 注册表与 connection 服务），逐条覆盖武装的消费规则与
// cancel+steer 封装的调用序列。全部不发网络、不spawn进程。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../lib/index.js";

function makeCtx({ connection, host = "127.0.0.1" } = {}) {
	const handlers = {};
	const routes = new Map();
	const agents = new Map();
	const services = new Map();
	const logs = [];
	const ctx = {
		logger: {
			info: (...args) => logs.push(["info", ...args]),
			warn: (...args) => logs.push(["warn", ...args]),
		},
		effect: (factory) => factory(),
		webServer: {
			host,
			register: (spec) => {
				routes.set(spec.path, spec.handler);
				return () => {};
			},
		},
		get: (service) => {
			if (service === "agents") return { get: (id) => agents.get(id) };
			if (service === "connection") return connection;
			if (services.has(service)) return services.get(service);
			return undefined;
		},
		on: (eventName, handler) => {
			handlers[eventName] = handler;
			return () => {};
		},
		// cordis Service.super(ctx, name) 走 ctx.reflect.provide 注册。
		reflect: { provide: (serviceName, instance) => services.set(serviceName, instance) },
	};
	apply(ctx, {});
	return { ctx, handlers, routes, agents, services, logs };
}

function makeAgent(sessionId, status = "running") {
	const calls = [];
	return {
		id: sessionId,
		status,
		calls,
		cancel(cause, options) { calls.push(["cancel", cause, options]); },
		inbox: {
			remove(id) { calls.push(["remove", id]); return true; },
			prepend(target, message) { calls.push(["prepend", target, message]); },
		},
		steer(message) { calls.push(["steer", message]); },
		followup(message) { calls.push(["followup", message]); },
	};
}

function makeInboxAgent(sessionId, status = "running") {
	const agent = makeAgent(sessionId, status);
	agent.inbox.nextStep = [];
	agent.inbox.nextTurn = [];
	return agent;
}

const userMessage = (id) => ({
	id,
	role: "user",
	content: [{ type: "text", text: "hi" }],
	source: { kind: "user", rpcId: `rpc-${id}` },
});

const contextMessage = (id) => ({
	id,
	role: "user",
	content: [{ type: "text", text: "runtime context" }],
	source: { kind: "runtime-context" },
});

const jobsMessage = (id) => ({
	id,
	role: "user",
	content: [{ type: "text", text: "job done" }],
	source: { kind: "tool-jobs", form: "notice", summary: "done" },
});

const spliceEvent = (target, inserted, extra = {}) => ({
	type: "agent/inbox/spliced",
	data: { target, start: 0, inserted, ...extra },
});

async function callRoute(handler, { method = "POST", url = "/api/kick", body } = {}) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	const req = {
		method,
		url,
		[Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk; },
	};
	const res = {
		statusCode: 0,
		headersSent: false,
		headers: {},
		body: undefined,
		setHeader(key, value) { this.headers[key] = value; },
		end(chunk) {
			this.headersSent = true;
			if (chunk !== undefined) this.body = chunk;
		},
	};
	await handler(req, res);
	return { res, json: typeof res.body === "string" ? JSON.parse(res.body) : undefined };
}

const armBody = (sessionId, armed = true) => ({ method: "POST", body: { sessionId, armed } });

describe("dsh-kick route", () => {
	it("POST arms the session; GET reports and consumes nothing", async () => {
		const { routes } = makeCtx();
		const handler = routes.get("/api/kick");
		const armed1 = await callRoute(handler, armBody("s1"));
		assert.equal(armed1.res.statusCode, 200);
		assert.equal(armed1.json.armed, true);
		const read1 = await callRoute(handler, { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read1.json.armed, true, "GET 不消费标记");
		const read2 = await callRoute(handler, { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read2.json.armed, true, "GET 幂等");
	});

	it("POST disarms; unknown session reads as unarmed", async () => {
		const { routes } = makeCtx();
		const handler = routes.get("/api/kick");
		await callRoute(handler, armBody("s1"));
		const disarmed = await callRoute(handler, armBody("s1", false));
		assert.equal(disarmed.json.armed, false);
		const read = await callRoute(handler, { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read.json.armed, false);
		const unknown = await callRoute(handler, { method: "GET", url: "/api/kick?sessionId=other" });
		assert.equal(unknown.json.armed, false);
	});

	it("rejects malformed payloads", async () => {
		const { routes } = makeCtx();
		const handler = routes.get("/api/kick");
		const missing = await callRoute(handler, { method: "POST", body: { armed: true } });
		assert.equal(missing.res.statusCode, 400);
		const badArmed = await callRoute(handler, { method: "POST", body: { sessionId: "s1", armed: "yes" } });
		assert.equal(badArmed.res.statusCode, 400);
		const badJson = await callRoute(handler, { method: "POST", body: undefined });
		assert.equal(badJson.res.statusCode, 400, "空请求体不是合法 JSON");
		const put = await callRoute(handler, { method: "PUT", url: "/api/kick", body: { sessionId: "s1", armed: true } });
		assert.equal(put.res.statusCode, 405);
	});

	it("goes through the connection gate only on remote binds", async () => {
		let checked = 0;
		const rejecting = makeCtx({
			host: "192.0.2.5",
			connection: { requestRejection: () => { checked += 1; return 403; } },
		});
		const handler1 = rejecting.routes.get("/api/kick");
		const denied = await callRoute(handler1, armBody("s1"));
		assert.equal(denied.res.statusCode, 403);
		assert.equal(checked, 1);

		const passing = makeCtx({
			host: "192.0.2.5",
			connection: { requestRejection: () => undefined },
		});
		const allowed = await callRoute(passing.routes.get("/api/kick"), armBody("s1"));
		assert.equal(allowed.res.statusCode, 200);
		assert.equal(allowed.json.armed, true);

		// 回环 bind 无差别过门会把页面自己的标记 POST 一并 401 掉（kick 永远
		// 不生效的根因）：回环上一律跳过鉴权门。
		const loopback = makeCtx({
			host: "127.0.0.1",
			connection: { requestRejection: () => 403 },
		});
		const open = await callRoute(loopback.routes.get("/api/kick"), armBody("s1"));
		assert.equal(open.res.statusCode, 200);
		assert.equal(open.json.armed, true);
	});
});

describe("dsh-kick consumption", () => {
	it("kicks the running agent: cancel(keepInbox) → remove → steer → 挪回队首, then the flag is consumed", async () => {
		const { handlers, routes, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		await callRoute(routes.get("/api/kick"), armBody("s1"));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-turn", [userMessage("m1")]));
		assert.deepEqual(agent.calls, [
			["cancel", { kind: "user" }, { keepInbox: true }],
			["remove", "m1"],
			["steer", agent.calls[2][1]],
			["remove", "m1"],
			["prepend", "next-turn", agent.calls[2][1]],
		]);
		assert.equal(agent.calls[2][1].id, "m1", "steer 收到取回的原消息对象");
		const read = await callRoute(routes.get("/api/kick"), { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read.json.armed, false, "kick 一次性消费");
	});

	it("fires for next-step admissions too (steer/queue 都走同一条打断投递)", async () => {
		const { handlers, routes, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		await callRoute(routes.get("/api/kick"), armBody("s1"));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-step", [userMessage("m2")]));
		assert.deepEqual(agent.calls.map((call) => call[0]), ["cancel", "remove", "steer", "remove", "prepend"]);
	});

	it("no flag → no calls", async () => {
		const { handlers, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-turn", [userMessage("m1")]));
		assert.equal(agent.calls.length, 0);
	});

	it("idle agent: flag consumed, stock flow untouched", async () => {
		const { handlers, routes, agents } = makeCtx();
		const agent = makeAgent("s1", "idle");
		agents.set("s1", agent);
		await callRoute(routes.get("/api/kick"), armBody("s1"));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-turn", [userMessage("m1")]));
		assert.equal(agent.calls.length, 0);
		const read = await callRoute(routes.get("/api/kick"), { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read.json.armed, false, "空转仍消耗标记");
	});

	it("non-user insertions neither fire nor consume the flag", async () => {
		const { handlers, routes, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		await callRoute(routes.get("/api/kick"), armBody("s1"));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-step", [contextMessage("c1")]));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-step", [jobsMessage("j1")]));
		assert.equal(agent.calls.length, 0);
		const read = await callRoute(routes.get("/api/kick"), { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read.json.armed, true, "标记保留给真正的人工消息");
		// 混合批次：取第一条人工消息。
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-step", [contextMessage("c2"), userMessage("m9")]));
		assert.deepEqual(agent.calls.map((call) => call[0]), ["cancel", "remove", "steer", "remove", "prepend"]);
		assert.equal(agent.calls[1][1], "m9");
	});

	it("canceled splices and empty insertions are ignored, flag kept", async () => {
		const { handlers, routes, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		await callRoute(routes.get("/api/kick"), armBody("s1"));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-step", [userMessage("m1")], { outcome: "canceled" }));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-step", []));
		assert.equal(agent.calls.length, 0);
		const read = await callRoute(routes.get("/api/kick"), { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read.json.armed, true);
	});

	it("claims skip (inserted empty) never fire — claim 是原生认领路径", async () => {
		const { handlers, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-step", []));
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-turn", []));
		assert.equal(agent.calls.length, 0);
	});

	it("TTL expiry disarms silently", async () => {
		const { handlers, routes, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		await callRoute(routes.get("/api/kick"), armBody("s1"));
		const realNow = Date.now;
		Date.now = () => realNow() + 31_000;
		try {
			handlers["session/event"]({ id: "s1" }, spliceEvent("next-turn", [userMessage("m1")]));
		} finally {
			Date.now = realNow;
		}
		assert.equal(agent.calls.length, 0);
		const read = await callRoute(routes.get("/api/kick"), { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.equal(read.json.armed, false);
	});

	it("unknown sessions and other event types are ignored", async () => {
		const { handlers, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		handlers["session/event"]({ id: "other" }, spliceEvent("next-turn", [userMessage("m1")]));
		handlers["session/event"]({ id: "s1" }, { type: "turn/start", data: { turn: 1 } });
		assert.equal(agent.calls.length, 0);
	});
});

describe("dsh-kick service API（供其它插件编程调用）", () => {
	it("registers the cordis service 'kick'", async () => {
		const { services } = makeCtx();
		assert.equal(services.get("kick")?.constructor.name, "KickService");
	});

	it("kick(sessionId, message)：running 先 cancel(keepInbox) 再 steer 并挪回队首", async () => {
		const { services, agents } = makeCtx();
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		const message = userMessage("fresh-1");
		const hit = services.get("kick").kick("s1", message);
		assert.equal(hit, true);
		assert.deepEqual(agent.calls, [
			["cancel", { kind: "user" }, { keepInbox: true }],
			["steer", message],
			["remove", "fresh-1"],
			["prepend", "next-turn", message],
		]);
	});

	it("kick(sessionId, message)：idle 只 steer（开新回合，等价插话）", async () => {
		const { services, agents } = makeCtx();
		const agent = makeAgent("s1", "idle");
		agents.set("s1", agent);
		const hit = services.get("kick").kick("s1", userMessage("fresh-2"));
		assert.equal(hit, true);
		assert.deepEqual(agent.calls.map((call) => call[0]), ["steer"]);
	});

	it("kick(sessionId, message)：未知会话返回 false 不抛", async () => {
		const { services } = makeCtx();
		assert.equal(services.get("kick").kick("nobody", userMessage("fresh-3")), false);
	});

	it("kickAgent(agent, message)：已持有句柄的调用方直接用", async () => {
		const { services } = makeCtx();
		const agent = makeAgent("s1");
		const hit = services.get("kick").kickAgent(agent, userMessage("fresh-4"));
		assert.equal(hit, true);
		assert.deepEqual(agent.calls.map((call) => call[0]), ["cancel", "steer", "remove", "prepend"]);
		assert.equal(services.get("kick").kickAgent(undefined, userMessage("x")), false);
	});

	it("arm/disarm/armed 与路由/监听共享同一份状态", async () => {
		const { services, handlers, agents } = makeCtx();
		const kick = services.get("kick");
		const agent = makeAgent("s1");
		agents.set("s1", agent);
		kick.arm("s1", 1000);
		assert.equal(kick.armed("s1"), true);
		handlers["session/event"]({ id: "s1" }, spliceEvent("next-turn", [userMessage("m1")]));
		assert.deepEqual(agent.calls.map((call) => call[0]), ["cancel", "remove", "steer", "remove", "prepend"]);
		assert.equal(kick.armed("s1"), false, "监听消费后标记消失");
		kick.disarm("s1");
		assert.equal(kick.armed("s1"), false);
	});

	it("agent/created 给 agent 实例挂 kick(message)，其它插件可 agent.kick()", async () => {
		const { handlers } = makeCtx();
		const agent = makeAgent("s2");
		handlers["agent/created"]({ agent });
		assert.equal(typeof agent.kick, "function");
		const message = userMessage("fresh-5");
		const hit = agent.kick(message);
		assert.equal(hit, true);
		assert.deepEqual(agent.calls, [
			["cancel", { kind: "user" }, { keepInbox: true }],
			["steer", message],
			["remove", "fresh-5"],
			["prepend", "next-turn", message],
		]);
		// idle 会话上 agent.kick 退化为直接投递。
		const idleAgent = makeAgent("s3", "idle");
		handlers["agent/created"]({ agent: idleAgent });
		assert.deepEqual(idleAgent.calls.map((call) => call[0]), []);
		assert.equal(idleAgent.kick(userMessage("fresh-6")), true);
		assert.deepEqual(idleAgent.calls.map((call) => call[0]), ["steer"]);
	});

	it("agent 已有 kick 时静默让位，不覆盖也不告警", async () => {
		const { handlers, logs } = makeCtx();
		const agent = makeAgent("s4");
		const existing = () => "existing";
		agent.kick = existing;
		const logsBefore = logs.length;
		handlers["agent/created"]({ agent });
		assert.equal(agent.kick, existing, "已有实现不被覆盖");
		assert.equal(logs.length, logsBefore, "静默：不产生新日志");
	});
});

describe("dsh-kick flush（排队 dock 的 Kick 队列）", () => {
	it("running：cancel(keepInbox) → 全部 remove → steer(first) + followup(rest) 按 FIFO", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		agent.inbox.nextStep = [contextMessage("ctx-1"), userMessage("steered-1")];
		agent.inbox.nextTurn = [userMessage("queued-1"), userMessage("queued-2")];
		agents.set("s1", agent);
		const result = services.get("kick").flush("s1");
		assert.deepEqual(result, { action: "flush", count: 3 });
		assert.deepEqual(agent.calls.map((call) => call[0]), [
			"cancel", "remove", "remove", "remove", "steer", "followup", "followup",
		]);
		// 重投递顺序：steered → queued-1 → queued-2（原始 FIFO）。
		assert.equal(agent.calls[4][1].id, "steered-1");
		assert.equal(agent.calls[5][1].id, "queued-1");
		assert.equal(agent.calls[6][1].id, "queued-2");
	});

	it("running 且无待处理：纯打断", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		agents.set("s1", agent);
		const result = services.get("kick").flush("s1");
		assert.deepEqual(result, { action: "interrupt" });
		assert.deepEqual(agent.calls.map((call) => call[0]), ["cancel"]);
	});

	it("idle 且有待处理：不打断，直接调度执行", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1", "idle");
		agent.inbox.nextTurn = [userMessage("queued-1")];
		agents.set("s1", agent);
		const result = services.get("kick").flush("s1");
		assert.deepEqual(result, { action: "flush", count: 1 });
		assert.deepEqual(agent.calls.map((call) => call[0]), ["remove", "steer"]);
	});

	it("idle 且无待处理：none", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1", "idle");
		agents.set("s1", agent);
		assert.deepEqual(services.get("kick").flush("s1"), { action: "none" });
		assert.equal(agent.calls.length, 0);
	});

	it("未知会话：none 不抛", async () => {
		const { services } = makeCtx();
		assert.deepEqual(services.get("kick").flush("nobody"), { action: "none" });
	});

	it("路由：{flush:true} 走 flush", async () => {
		const { routes, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		agent.inbox.nextTurn = [userMessage("queued-1")];
		agents.set("s1", agent);
		const sent = await callRoute(routes.get("/api/kick"), { method: "POST", body: { sessionId: "s1", flush: true } });
		assert.equal(sent.res.statusCode, 200);
		assert.deepEqual(sent.json, { action: "flush", count: 1 });
	});
});

describe("dsh-kick kickItem（dock 行内按钮）与 queue 清单", () => {
	it("queue(sessionId)：next-turn 人工消息 → [{id, text}]", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		agent.inbox.nextTurn = [userMessage("q1"), contextMessage("ctx-9")];
		agents.set("s1", agent);
		assert.deepEqual(services.get("kick").queue("s1"), [{ id: "q1", text: "hi" }]);
	});

	it("kickItem：running 先 cancel(keepInbox) 再 remove+steer 那一条", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		const target = userMessage("q1");
		agent.inbox.nextTurn = [target];
		agents.set("s1", agent);
		const result = services.get("kick").kickItem("s1", "q1");
		assert.deepEqual(result, { action: "kick" });
		assert.deepEqual(agent.calls, [
			["cancel", { kind: "user" }, { keepInbox: true }],
			["remove", "q1"],
			["steer", target],
			["remove", "q1"],
			["prepend", "next-turn", target],
		]);
	});

	it("回归：队列里有更早消息时，被 kick 的消息挪到 next-turn 队首（kick 第二条实际先跑第一条的根因）", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		const first = userMessage("q1");
		const second = userMessage("q2");
		agent.inbox.nextTurn = [first, second];
		agents.set("s1", agent);
		assert.deepEqual(services.get("kick").kickItem("s1", "q2"), { action: "kick" });
		// 核心 send 在 abort 后把 steer 改投 next-turn 末尾；随后 remove+prepend
		// 把被 kick 的 q2 挪回队首 —— 驱动唤醒后 claim 的 next-turn[0] 是 q2。
		assert.deepEqual(agent.calls, [
			["cancel", { kind: "user" }, { keepInbox: true }],
			["remove", "q2"],
			["steer", second],
			["remove", "q2"],
			["prepend", "next-turn", second],
		]);
	});

	it("kickItem：idle 不 cancel，直接 remove+steer（搁浅队列的恢复出口）", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1", "idle");
		agent.inbox.nextTurn = [userMessage("q1")];
		agents.set("s1", agent);
		const result = services.get("kick").kickItem("s1", "q1");
		assert.deepEqual(result, { action: "kick" });
		assert.deepEqual(agent.calls.map((call) => call[0]), ["remove", "steer"]);
	});

	it("kickItem：消息已不在排队（被认领/移除）→ none", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		agents.set("s1", agent);
		assert.deepEqual(services.get("kick").kickItem("s1", "gone"), { action: "none" });
		assert.equal(agent.calls.length, 0);
		assert.deepEqual(services.get("kick").kickItem("nobody", "gone"), { action: "none" });
	});

	it("kickItem 也能命中 next-step 里待插话的消息", async () => {
		const { services, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		agent.inbox.nextStep = [userMessage("s1msg")];
		agents.set("s1", agent);
		assert.deepEqual(services.get("kick").kickItem("s1", "s1msg"), { action: "kick" });
		assert.deepEqual(agent.calls.map((call) => call[0]), ["cancel", "remove", "steer", "remove", "prepend"]);
	});

	it("路由：{itemId} 走 kickItem；GET 带 items 清单", async () => {
		const { routes, agents } = makeCtx();
		const agent = makeInboxAgent("s1");
		agent.inbox.nextTurn = [userMessage("q1")];
		agents.set("s1", agent);
		const listed = await callRoute(routes.get("/api/kick"), { method: "GET", url: "/api/kick?sessionId=s1" });
		assert.deepEqual(listed.json.items, [{ id: "q1", text: "hi" }]);
		const sent = await callRoute(routes.get("/api/kick"), { method: "POST", body: { sessionId: "s1", itemId: "q1" } });
		assert.equal(sent.res.statusCode, 200);
		assert.deepEqual(sent.json, { action: "kick" });
	});
});
