// dsh-rename 离线冒烟测试：mock cordis ctx / session / llm，驱动 apply + generate + /rename。
import { pathToFileURL } from "node:url";

import { fileURLToPath } from "node:url";
const PLUGIN = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const { name, inject, Config, apply, default: def } = await import(pathToFileURL(PLUGIN).href);
const { SessionTitleInvalidError } = await import("@deepseek-ai/dsh-session-title");

let failures = 0;
function check(ok, label, detail = "") {
	if (ok) console.log(`  ok  ${label}`);
	else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// ── mock 设施 ────────────────────────────────────────────────────────────────

function makeSession(seedEvents) {
	const events = seedEvents.map((e, i) => ({ ...e, seq: i, time: Date.now() }));
	return {
		id: "session-test",
		snapshotEvents: () => events,
		append(type, data) {
			const event = { type, seq: events.length, time: Date.now(), data };
			events.push(event);
			return event;
		},
	};
}

function makeCtx(llmStream) {
	const state = { registered: [], commands: [], effects: [], listeners: {}, logs: { info: [], warn: [] } };
	state.ctx = {
		logger: { info: (m) => state.logs.info.push(m), warn: (m) => state.logs.warn.push(m) },
		on: (event, handler) => { (state.listeners[event] ??= []).push(handler); return () => {}; },
		effect: (execute, label) => {
			const iter = execute();
			const collected = [];
			for (;;) { const r = iter.next(); if (r.done) break; collected.push(r.value); }
			state.effects.push({ label, collected });
		},
		sessionTitle: { register: (p) => { state.registered.push(p); return () => state.registered.pop(); } },
		commands: { register: (d) => { state.commands.push(d); return () => state.commands.pop(); } },
		llm: { stream: llmStream },
	};
	return state;
}

const user = (text) => ({ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } });
const assistant = (text, tools = []) => ({
	type: "assistant/message",
	data: { message: { role: "assistant", content: [
		...(tools.map((name) => ({ type: "tool-call", id: `c-${name}`, name, arguments: "{}" }))),
		...(text ? [{ type: "text", text }] : []),
	] } },
});

async function* okStream(text, finishKind = "stop") {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
	yield { type: "finish", reason: { kind: finishKind } };
}

// ── 1. 模块形状 ──────────────────────────────────────────────────────────────

console.log("1. module shape");
check(name === "dsh-rename", "name");
check(Array.isArray(inject) && inject.includes("sessionTitle") && inject.includes("llm") && inject.includes("commands"), "inject");
check(def === undefined, "no default export needed");
check(typeof Config?.["~K"] === "function" || typeof Config === "function" || Config != null, "Config schema present");

// ── 2. apply 装配 ────────────────────────────────────────────────────────────

console.log("2. apply wiring");
const state = makeCtx(okStream("优化 DSH 会话标题插件"));
apply(state.ctx, {});
check(state.registered.length === 1, "title provider registered");
check(state.registered[0]?.automatic === "first-prompt", "automatic first-prompt default");
check(typeof state.registered[0]?.generate === "function", "generate fn");
check(state.commands.length === 1 && state.commands[0].name === "rename", "/rename registered");
check(state.effects.length === 3, "three effects", JSON.stringify(state.effects.map((e) => e.label)));
check(state.effects.every((e) => typeof e.collected[0] === "function"), "disposers collected");

// ── 3. generateTitle 正常路径 ────────────────────────────────────────────────

console.log("3. generateTitle happy path");
const seed = [
	user("帮我写一个 dsh 插件，自动总结并重命名会话"),
	assistant("好的，我先研究了 dsh 的 session-title 服务。", ["read", "grep"]),
	assistant("已确认 provider 注册协议。", ["grep"]),
	user("再把整段对话都算进去，不要只看第一条"),
	assistant("已完成：digest 构建器覆盖 user+assistant 回合。", ["str_replace_editor", "bash"]),
];
const session = makeSession(seed);
const requestMessages = [
	{ seq: 0, text: "帮我写一个 dsh 插件，自动总结并重命名会话" },
	{ seq: 3, text: "再把整段对话都算进去，不要只看第一条" },
];
const llmCalls = [];
const state3 = makeCtx(async function* (options) { llmCalls.push(options); yield* okStream("编写会话自动重命名插件"); });
apply(state3.ctx, {});
const provider = state3.registered[0];
const result = await provider.generate({ session, messages: requestMessages, route: { provider: "pipo-devllm", model: "GLM-5.3-Flash" }, signal: AbortSignal.any([]) });
check(typeof result?.title === "string" && result.title.length > 0, "title returned", JSON.stringify(result));
check(Array.isArray(result.messageSeqs) && result.messageSeqs.join() === "0,3", "messageSeqs attribution", JSON.stringify(result.messageSeqs));
check(result.model?.provider === "pipo-devllm" && result.model?.model === "GLM-5.3-Flash", "model identity echoed");
const call = llmCalls[0];
check(call?.purpose === "session-title", "purpose session-title");
check(call?.sessionId === "session-test", "sessionId passed");
check(typeof call?.system === "string" && call.system.includes("6") && call.system.includes("14"), "system prompt targets");
const frame = call?.messages?.[0]?.content?.[0]?.text ?? "";
const digest = JSON.parse(frame.slice(frame.indexOf("[")));
check(digest.some((t) => t.role === "assistant" && Array.isArray(t.tools) && t.tools.includes("str_replace_editor")), "assistant turns with tools in digest", frame.slice(0, 400));
check(digest.some((t) => t.role === "user" && t.seq === 3), "latest user turn present");
check(frame.length > 0 && !frame.includes('"reasoning"'), "no reasoning leak");
const titleEvent = session.snapshotEvents().findLast((e) => e.type === "session/title-llm-request");
check(titleEvent !== undefined, "title-llm-request appended");
check(titleEvent?.data?.titleProvider === "dsh-rename", "provider id logged");
check(JSON.stringify(titleEvent?.data?.messageSeqs) === "[0,3]", "logged seqs match");
check(Array.isArray(titleEvent?.data?.messages) && titleEvent.data.messages[0].role === "user", "logged messages are Message[]");
check(titleEvent?.data?.messages?.[0]?.source?.kind === "dsh-session-title-llm", "embedded source.kind satisfies persistence reader (regression: dsh-rename kind corrupted session logs)");
check(titleEvent?.data?.maxTokens === 512, "logged maxTokens");

// ── 4. 字节预算收敛 ──────────────────────────────────────────────────────────

console.log("4. byte budget");
const longSeed = [];
for (let i = 0; i < 60; i++) {
	longSeed.push(user(`第${i}轮问题：` + "很长的用户输入".repeat(30)));
	longSeed.push(assistant("很长的助手回答。".repeat(40), i % 2 === 0 ? ["bash", "read"] : []));
}
const longSession = makeSession(longSeed);
const longMessages = longSeed.filter((e) => e.type === "user/message").map((e, i) => ({ seq: i * 2, text: e.data.content[0].text }));
const llmCalls4 = [];
const state4 = makeCtx(async function* (options) { llmCalls4.push(options); yield* okStream("长对话批量生成测试"); });
apply(state4.ctx, { maxInputBytes: 3000, maxTurns: 40 });
const result4 = await state4.registered[0].generate({ session: longSession, messages: longMessages, route: { provider: "p", model: "m" }, signal: AbortSignal.any([]) });
const frame4 = llmCalls4[0].messages[0].content[0].text;
const bytes4 = Buffer.byteLength(frame4, "utf8");
check(bytes4 <= 3000, `framed digest within budget (${bytes4}B ≤ 3000B)`);
const digest4 = JSON.parse(frame4.slice(frame4.indexOf("[")));
check(digest4.some((t) => t.role === "note"), "elision note present");
check(result4.messageSeqs.length > 0 && result4.messageSeqs.every((s) => longMessages.some((m) => m.seq === s)), "attribution seqs are request subset");
check(result4.messageSeqs[result4.messageSeqs.length - 1] === longMessages.at(-1).seq, "anchor (last user) attributed");

// ── 5. 路由与失败翻译 ────────────────────────────────────────────────────────

console.log("5. route + failure translation");
const state5 = makeCtx(okStream("x"));
apply(state5.ctx, {});
let routeError = null;
try {
	await state5.registered[0].generate({ session: makeSession(seed), messages: requestMessages, signal: AbortSignal.any([]) });
} catch (error) { routeError = error; }
check(routeError !== null && /no logged request route/.test(routeError.message), "missing route throws guidance");
// max-tokens 不再一票否决：已有文本 → 抢救；零文本 → ×4 重试一次；仍零文本才失败
const state5b = makeCtx(() => okStream("标题", "max-tokens"));
apply(state5b.ctx, {});
const salvaged = await state5b.registered[0].generate({ session: makeSession(seed), messages: requestMessages, route: { provider: "p", model: "m" }, signal: AbortSignal.any([]) });
check(salvaged.title === "标题", "max-tokens with text: salvaged partial title", JSON.stringify(salvaged));
check(state5b.logs.warn.some((m) => m.includes("maxTokens") && m.includes("salvaged")), "salvage warned");

const retryCalls = [];
const state5c2 = makeCtx(async function* (options) {
	retryCalls.push(options);
	if (retryCalls.length === 1) yield { type: "finish", reason: { kind: "max-tokens" } };
	else yield* okStream("重试后的标题");
});
apply(state5c2.ctx, {});
const retried = await state5c2.registered[0].generate({ session: makeSession(seed), messages: requestMessages, route: { provider: "p", model: "m" }, signal: AbortSignal.any([]) });
check(retryCalls.length === 2, "zero-text max-tokens retried once");
check(retryCalls[0].maxTokens === 512 && retryCalls[1].maxTokens === 2048, "retry escalates budget ×4", JSON.stringify(retryCalls.map((c) => c.maxTokens)));
check(retried.title === "重试后的标题", "retry produces title");
check(state5c2.logs.warn.some((m) => m.includes("retrying with maxTokens=2048")), "retry warned");

const state5d2 = makeCtx(async function* () { yield { type: "finish", reason: { kind: "max-tokens" } }; });
apply(state5d2.ctx, {});
let exhaustedError = null;
try {
	await state5d2.registered[0].generate({ session: makeSession(seed), messages: requestMessages, route: { provider: "p", model: "m" }, signal: AbortSignal.any([]) });
} catch (error) { exhaustedError = error; }
check(exhaustedError !== null && /maxOutputTokens/.test(exhaustedError.message), "exhausted retries still fail with maxOutputTokens");

// ── 5c. replay 策略：重放对话前缀（compaction 同款，命中对话 KV 缓存） ───────

console.log("5c. replay strategy (conversation prefix replay)");
const replaySeed = [
	{ type: "system/message", data: { content: [{ type: "text", text: "你是编程助手" }] } },
	user("帮我写一个 dsh 插件，自动总结并重命名会话"),
	assistant("好的，我先研究了 dsh 的 session-title 服务。", ["read"]),
	user("再把整段对话都算进去，不要只看第一条"),
];
function makeReplaySession(seedEvents) {
	const base = makeSession(seedEvents);
	const derive = (event) => {
		if (event.type === "system/message") return { role: "system", content: event.data.content };
		if (event.type === "user/message") return { role: "user", content: event.data.content };
		if (event.type === "assistant/message") return { role: "assistant", content: event.data.message.content };
		return null;
	};
	return {
		...base,
		requestHeader: () => ({ config: { provider: "pipo-devllm", model: "GLM-5.3-Flash" }, tools: [{ name: "bash" }] }),
		surface: { nodes: seedEvents.map((_, i) => i) },
		eventAt: (seq) => base.snapshotEvents()[seq],
		deriveEventMessage: (event) => derive(event),
		toolHistory: () => [],
	};
}
const replaySession = makeReplaySession(replaySeed);
const replayMessages = [
	{ seq: 1, text: "帮我写一个 dsh 插件，自动总结并重命名会话" },
	{ seq: 3, text: "再把整段对话都算进去，不要只看第一条" },
];
const llmCalls5c = [];
const state5c = makeCtx(async function* (options) { llmCalls5c.push(options); yield* okStream("编写会话自动重命名插件"); });
apply(state5c.ctx, {});
const replayResult = await state5c.registered[0].generate({ session: replaySession, messages: replayMessages, route: { provider: "p", model: "m" }, signal: AbortSignal.any([]) });
const call5c = llmCalls5c[0];
check(call5c !== undefined, "replay: llm called");
check(call5c?.system === undefined, "replay: no separate system option (prefix fidelity)");
check(call5c?.provider === "pipo-devllm" && call5c?.model === "GLM-5.3-Flash", "replay: route from requestHeader (cache-affine model)");
check(call5c?.messages?.length === 5, "replay: system + surface + instruction", JSON.stringify(call5c?.messages?.length));
check(call5c?.messages?.[0]?.role === "system" && call5c.messages[0].content?.[0]?.text === "你是编程助手", "replay: conversation system head replayed");
check(call5c?.messages?.[1]?.role === "user" && call5c.messages[1].content?.[0]?.text.includes("dsh 插件"), "replay: surface messages replayed");
const tail5c = call5c?.messages?.at(-1);
check(tail5c?.role === "user" && tail5c.content?.[0]?.text.includes("titling engine") && tail5c.content[0].text.includes("Do not continue"), "replay: titling instruction appended, forbids continuation");
check(Array.isArray(call5c?.tools) && call5c.tools[0]?.name === "bash", "replay: header tools passed");
check(Array.isArray(call5c?.toolHistory), "replay: toolHistory passed");
check(replayResult.messageSeqs.join() === "1,3", "replay: attribution covers all human turns");
const replayEvent = replaySession.snapshotEvents().findLast((e) => e.type === "session/title-llm-request");
check(replayEvent?.data?.messages?.length === 1 && replayEvent.data.messages[0].source?.kind === "dsh-session-title-llm", "replay: persisted event stays lean and valid");
check(replayEvent?.data?.system === "你是编程助手", "replay: persisted system text");
check(replayEvent?.data?.route?.provider === "pipo-devllm", "replay: persisted route");

// 显式 digest 策略在 replay 能力可用的会话上也应走摘要帧
const llmCalls5d = [];
const state5d = makeCtx(async function* (options) { llmCalls5d.push(options); yield* okStream("标题"); });
apply(state5d.ctx, { promptStrategy: "digest" });
await state5d.registered[0].generate({ session: makeReplaySession(replaySeed), messages: replayMessages, route: { provider: "p", model: "m" }, signal: AbortSignal.any([]) });
check(llmCalls5d[0]?.system !== undefined, "digest strategy: separate system prompt used");
check(typeof llmCalls5d[0]?.messages?.[0]?.content?.[0]?.text === "string" && llmCalls5d[0].messages[0].content[0].text.startsWith("Summarize this AI coding-assistant session"), "digest strategy: framed digest used");

// 非法策略值拒绝
let strategyError = null;
try { apply(makeCtx(okStream("x")).ctx, { promptStrategy: "bogus" }); } catch (error) { strategyError = error; }
check(strategyError !== null && /promptStrategy/.test(strategyError.message), "invalid promptStrategy rejected");

// ── 6. /rename 命令 ──────────────────────────────────────────────────────────

console.log("6. /rename command");
const state6 = makeCtx(okStream("t"));
apply(state6.ctx, {});
const cmd = state6.commands[0];
check(cmd.definitionId === "dsh-rename", "definition id");
// 声明 input：命令带参数占位（Web 菜单/Space 触发参数 claim）；回车按当前
// 草稿立即执行，留空参数 = 模型重新总结，带文字 = 手动命名并锁定。
check(typeof cmd.input?.hint === "string" && cmd.input.hint.length > 0, "input hint present (leading claim)");

// 无参数 → 后台 refresh：handler 立即返回（claim submit 快速 settle，
// Web 输入框即清空，与 /compact 一致）；完成后补发 command 流节点回显结果。
const agent = { session: makeSession(seed) };
const renameRefreshCalls = [];
let settleRefresh;
state6.ctx.sessionTitle = {
	register: state6.ctx.sessionTitle.register,
	get: () => ({ title: "旧标题", source: { kind: "fallback" } }),
	refresh: (s) => { renameRefreshCalls.push(s); return new Promise((resolve) => { settleRefresh = resolve; }); },
	rename: (s, title) => { throw new Error("should not be called"); },
};
let r = await cmd.handler({ agent, rawInput: "  ", signal: AbortSignal.any([]) });
check(r.kind === "success" && r.text.includes("正在重新总结"), `refresh path returns immediately: ${r.text}`);
check(renameRefreshCalls.length === 1 && renameRefreshCalls[0] === agent.session, "refresh dispatched in background");
settleRefresh({ title: "新标题：对话重总结", messageSeqs: [0], source: { kind: "provider", provider: "dsh-rename" }, model: { provider: "p", model: "m" } });
await new Promise((resolve) => setTimeout(resolve, 0));
const outcomeRun = agent.session.snapshotEvents().findLast((e) => e.type === "command/run");
const outcomeDone = agent.session.snapshotEvents().findLast((e) => e.type === "command/done");
check(outcomeRun !== undefined && outcomeDone !== undefined && outcomeRun.data.commandId === outcomeDone.data.commandId, "outcome pair appended with matching commandId");
check(outcomeDone.data.kind === "success" && outcomeDone.data.text.includes("「旧标题」→ 新标题：对话重总结") && outcomeDone.data.text.includes("p / m"), `outcome echoes old → new: ${outcomeDone?.data?.text}`);

// 带参数 → rename
let renamedWith = null;
state6.ctx.sessionTitle.rename = (s, title) => { renamedWith = title; return { title, source: { kind: "user" } }; };
r = await cmd.handler({ agent, rawInput: "  我手动起的名字  ", signal: AbortSignal.any([]) });
check(renamedWith === "我手动起的名字", "manual rename passes trimmed title");
check(r.kind === "success" && r.text.includes("手动命名"), `manual path: ${r.text}`);

// 非法标题 → SessionTitleInvalidError 友好化
state6.ctx.sessionTitle.rename = () => { throw new SessionTitleInvalidError("session title must contain visible characters"); };
r = await cmd.handler({ agent, rawInput: "   \u200b   ", signal: AbortSignal.any([]) });
check(!(r instanceof Error) && r.kind === "error" && /空白/.test(r.text), `invalid title friendly error: ${r.text}`);

// 后台 refresh 失败 → 以 error 流节点提示（不再静默）
state6.ctx.sessionTitle.refresh = async () => { throw new Error("dsh-rename: no logged request route is available; configure provider and model together"); };
r = await cmd.handler({ agent, rawInput: "", signal: AbortSignal.any([]) });
check(r.kind === "success" && r.text.includes("正在重新总结"), "background failure does not fail the command");
await new Promise((resolve) => setTimeout(resolve, 0));
const failureDone = agent.session.snapshotEvents().findLast((e) => e.type === "command/done");
check(failureDone?.data?.kind === "error" && /provider 与 model/.test(failureDone?.data?.text ?? ""), `failure surfaced as error flow node: ${failureDone?.data?.text}`);

// 被更新的总结取代（abort）→ 不补发节点
state6.ctx.sessionTitle.refresh = () => { const e = new Error("command aborted"); e.name = "AbortError"; return Promise.reject(e); };
const eventsBeforeAbort = agent.session.snapshotEvents().length;
r = await cmd.handler({ agent, rawInput: "", signal: AbortSignal.any([]) });
await new Promise((resolve) => setTimeout(resolve, 0));
check(r.kind === "success" && agent.session.snapshotEvents().length === eventsBeforeAbort, "aborted refresh appends no outcome node");

// 会话里没有真人文本 → 同步友好报错，且不派发后台 refresh
const emptyAgent = { session: makeSession([assistant("只有助手消息", [])]) };
r = await cmd.handler({ agent: emptyAgent, rawInput: "", signal: AbortSignal.any([]) });
check(r.kind === "error" && /文本消息/.test(r.text), `empty session friendly: ${r.text}`);
check(renameRefreshCalls.length === 1, "empty session does not dispatch refresh");

// ── 7. 配置校验 ──────────────────────────────────────────────────────────────

console.log("7. config validation");
for (const [bad, label] of [
	[{ maxInputBytes: -1 }, "negative budget"],
	[{ timeoutMs: 3e9 }, "oversize timeout"],
	[{ automatic: "sometimes" }, "bad automatic"],
	[{ provider: "p" }, "provider without model"],
	[{ unknown: 1 }, "unknown key"],
]) {
	let threw = false;
	try { apply(makeCtx(okStream("x")).ctx, bad); } catch { threw = true; }
	check(threw, `rejects ${label}`);
}
const state7 = makeCtx(okStream("x"));
apply(state7.ctx, { provider: "a", model: "b", maxTurns: 5 });
check(state7.logs.info[0]?.includes("route: a/b"), "explicit route logged");

// ── 7.5 标题行清洗（真实模型输出形态） ────────────────────────────────────────

console.log("7.5 title line cleaning");
const RAW_CASES = [
	["**标题：TCP 三次握手为何不能是两次，以及 TIME_WAIT 存在的原理与意义**", "TCP 三次握手为何不能是两次，以及 TIME_WAIT 存在的原理与意义"],
	["**标题：** 通俗解读数据库索引原理：为什么 B+ 树适合做索引**", "通俗解读数据库索引原理：为什么 B+ 树适合做索引"],
	["标题：** 通俗解读数据库索引原理：为什么 B+ 树适合做索引", "通俗解读数据库索引原理：为什么 B+ 树适合做索引"],
	["**标题：TCP 三次握手为何不能是两次**\n\n以上是根据对话总结的标题，希望符合要求。", "TCP 三次握手为何不能是两次"],
	["好的，标题如下：\n「TCP 握手与挥手机制解析」", "TCP 握手与挥手机制解析"],
	["### 带井号的标题", "带井号的标题"],
	["普通无修饰标题", "普通无修饰标题"],
	["为什么是三次握手？", "为什么是三次握手？"],
];
for (const [raw, want] of RAW_CASES) {
	const state75 = makeCtx(async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: raw };
		yield { type: "block-end", index: 0, block: { type: "text", text: raw } };
		yield { type: "finish", reason: { kind: "stop" } };
	});
	apply(state75.ctx, {});
	let got = null;
	try {
		const r = await state75.registered[0].generate({ session: makeSession(seed), messages: requestMessages, route: { provider: "p", model: "m" }, signal: AbortSignal.any([]) });
		got = r.title;
	} catch (error) { got = `<threw: ${error.message}>`; }
	check(got === want, `clean ${JSON.stringify(raw).slice(0, 40)}`, `got ${JSON.stringify(got)}`);
}

// ── 8. compact 前重命名钩子 ──────────────────────────────────────────────────

console.log("8. pre-compact hook");
const state8 = makeCtx(okStream("t"));
apply(state8.ctx, {});
check(Array.isArray(state8.listeners["session/event"]) && state8.listeners["session/event"].length === 1, "session/event listener registered");
const hook = state8.listeners["session/event"][0];
let refreshCalls = [];
state8.ctx.sessionTitle.refresh = async (s, signal) => { refreshCalls.push(s); return { title: "压缩前新标题", source: { kind: "provider" } }; };
const compactionSession = makeSession(seed);
hook(compactionSession, { type: "compaction/start", data: {} });
await new Promise((r) => setTimeout(r, 0));
check(refreshCalls.length === 1 && refreshCalls[0] === compactionSession, "compaction/start triggers refresh");
// 其他事件不触发
hook(compactionSession, { type: "compaction/end", data: {} });
hook(compactionSession, { type: "session/title", data: {} });
await new Promise((r) => setTimeout(r, 0));
check(refreshCalls.length === 1, "non-start events ignored");
// refresh 失败只告警不抛出
state8.ctx.sessionTitle.refresh = async () => { throw new Error("boom"); };
let threw = false;
try { hook(compactionSession, { type: "compaction/start", data: {} }); await new Promise((r) => setTimeout(r, 0)); } catch { threw = true; }
check(!threw && state8.logs.warn.some((m) => m.includes("pre-compact rename failed")), "hook failure contained with warn");
// renameBeforeCompact: false → 不注册监听
const state8b = makeCtx(okStream("t"));
apply(state8b.ctx, { renameBeforeCompact: false });
check(state8b.listeners["session/event"] === undefined, "hook disabled via config");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
