// dsh-rename — 用模型对整段对话重新总结并重命名会话。
//
// 替代内置的 session-title-first-prompt-llm（它只看第一条用户消息，长对话
// 标题往往失真）。本插件做两件事：
//
//  1. 注册一个 all-prompts 的会话标题 provider：每条用户消息之后，把整段
//     对话（用户 + 助手回合、助手用过的工具名）压缩成有预算的 digest 交给
//     模型，产出并应用新标题 —— 对话推进时自动“重新总结 + 重命名”。
//  2. 提供 /rename 斜杠命令：无参数 = 让模型立即重新总结并重命名（可覆盖
//     手动命名，是唯一的“解锁”途径）；带参数 = 手动命名并锁定（暂停自动
//     生成），与 Web UI 的重命名行为一致。
//
// LLM 调用策略与内置 @deepseek-ai/dsh-session-title-llm 完全同构：
// purpose "session-title"、deadline 超时熔断、BlockAssembler 汇编、
// normalizeSessionTitle 归一化、session/title-llm-request 预派发留痕。
// 区别仅在喂给模型的内容：内置只框选人类消息，本插件框选整个会话。

import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { deadline } from "@deepseek-ai/dsh-timeout";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import {
	SessionTitleInvalidError,
	SessionTitleProviderId,
	normalizeSessionTitle,
} from "@deepseek-ai/dsh-session-title";

const name = "dsh-rename";
const inject = ["sessionTitle", "llm", "sessions", "commands"];
const TIMEOUT_CODE = "SESSION_TITLE_TIMEOUT";
const MAX_TIMER_DELAY_MS = 2147483647;

/** 直接构造（无 Loader schema 兜底）时的默认策略；与 Config 的 default 保持一致。 */
const DEFAULTS = Object.freeze({
	// 消息驱动的自动节奏：first-prompt（仅会话第一条消息后生成一次，与内置
	// 行为一致）/ all-prompts（每条用户消息后重新总结）。压缩前的重命名由
	// renameBeforeCompact 单独控制，不受此项影响。
	automatic: "first-prompt",
	// compact（手动 /compact 与自动压缩）开始时重新总结并重命名；设为 false 关闭。
	renameBeforeCompact: true,
	// 总结请求的取材策略：
	// - "replay"（默认）：按 dsh-compaction-basic 同款方式重放对话自身的可缓存
	//   前缀（system 头 + 工具 schema + 表面消息逐节点 derive）+ 末尾追加命名
	//   指令，使命名请求成为主对话请求的真前缀，命中 provider 的 KV 缓存；
	//   增量成本≈指令本身，标题质量也更好（看到真实全文而非截断摘要）。
	//   计费口径：整个对话按 input 计（命中部分按 provider 缓存价）。
	// - "digest"：独立摘要帧（≤maxInputBytes），前缀每次全新、100% miss，
	//   成本有界；适合缓存读不打折、或会话极长导致 replay 计费偏高的场景。
	promptStrategy: "replay",
	targetWords: 6,
	targetCjkCharacters: 14,
	maxInputBytes: 24000,
	// 512 而非内置的 64：推理型模型（如 GLM-5.3-Flash）会先吐思考 token，
	// 64 上限会被 reasoning 吃光导致 max-tokens 失败。这里只是首试预算，
	// 不作为正确性闸门：触顶但已有文本 → 直接抢救为标题；零文本 → 预算
	// ×4 自动重试一次。标题文本最终仍由服务端 maxTitleBytes（默认 80 字节）截断。
	maxOutputTokens: 512,
	timeoutMs: 60000,
	maxTurns: 40,
	maxCharsPerTurn: 260,
	showToolNames: true,
});

/** Loader 配置 schema；字段含义见 DEFAULTS 与下方校验。 */
const Config = z.object({
	provider: z.string(),
	model: z.string(),
	automatic: z.string().default(DEFAULTS.automatic),
	renameBeforeCompact: z.boolean().default(DEFAULTS.renameBeforeCompact),
	promptStrategy: z.string().default(DEFAULTS.promptStrategy),
	targetWords: z.number().default(DEFAULTS.targetWords),
	targetCjkCharacters: z.number().default(DEFAULTS.targetCjkCharacters),
	maxInputBytes: z.number().default(DEFAULTS.maxInputBytes),
	maxOutputTokens: z.number().default(DEFAULTS.maxOutputTokens),
	timeoutMs: z.number().default(DEFAULTS.timeoutMs),
	maxTurns: z.number().default(DEFAULTS.maxTurns),
	maxCharsPerTurn: z.number().default(DEFAULTS.maxCharsPerTurn),
	showToolNames: z.boolean().default(DEFAULTS.showToolNames),
});

const CONFIG_KEYS = new Set([
	"provider",
	"model",
	"automatic",
	"renameBeforeCompact",
	"promptStrategy",
	"targetWords",
	"targetCjkCharacters",
	"maxInputBytes",
	"maxOutputTokens",
	"timeoutMs",
	"maxTurns",
	"maxCharsPerTurn",
	"showToolNames",
]);

/**
 * 校验并固化插件配置（同时覆盖 Loader 解析与直接构造两条路径）。
 * @param config - 未trust的插件配置。
 * @returns 冻结的完整策略对象。
 */
function resolveConfig(config) {
	const value = { ...DEFAULTS, ...(config ?? {}) };
	for (const key of Object.keys(value)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-rename: unknown config key "${key}"`);
	}
	for (const key of [
		"targetWords",
		"targetCjkCharacters",
		"maxInputBytes",
		"maxOutputTokens",
		"timeoutMs",
		"maxTurns",
		"maxCharsPerTurn",
	]) {
		if (!Number.isInteger(value[key]) || value[key] <= 0) {
			throw new Error(`dsh-rename: ${key} must be a positive integer`);
		}
	}
	if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
		throw new Error(`dsh-rename: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
	}
	if (value.automatic !== "first-prompt" && value.automatic !== "all-prompts") {
		throw new Error('dsh-rename: automatic must be "first-prompt" or "all-prompts"');
	}
	if (value.promptStrategy !== "replay" && value.promptStrategy !== "digest") {
		throw new Error('dsh-rename: promptStrategy must be "replay" or "digest"');
	}
	if (typeof value.renameBeforeCompact !== "boolean") {
		throw new Error("dsh-rename: renameBeforeCompact must be a boolean");
	}
	const hasProvider = value.provider !== undefined && value.provider !== null;
	const hasModel = value.model !== undefined && value.model !== null;
	if (hasProvider !== hasModel) throw new Error("dsh-rename: provider and model must be supplied together");
	if (hasProvider && (typeof value.provider !== "string" || value.provider.length === 0 || typeof value.model !== "string" || value.model.length === 0)) {
		throw new Error("dsh-rename: provider and model overrides must be non-empty strings");
	}
	if (hasProvider) {
		value.provider = String(value.provider);
		value.model = String(value.model);
	} else {
		delete value.provider;
		delete value.model;
	}
	return Object.freeze(value);
}

// ── 会话日志 → 摘要回合 ─────────────────────────────────────────────────────

/** 喂给模型的 frame 前缀；字节预算需为其预留。 */
const FRAME_PREFIX = "Summarize this AI coding-assistant session into a title. Conversation transcript as a JSON array of turns:\n";
const FRAME_PREFIX_BYTES = Buffer.byteLength(FRAME_PREFIX, "utf8");
/** 省略提示 note 的字节预留：超出预算时仍保证 “N turns omitted” 提示装得下。 */
const NOTE_RESERVE_BYTES = 96;

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenText(blocks) {
	return (Array.isArray(blocks) ? blocks : [])
		.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function hasVisibleText(text) {
	return typeof text === "string" && text.replace(/\s+/gu, "").length > 0;
}

/** 按码点截断，不劈开代理对，截断后追加省略号。 */
function clipText(text, maxChars) {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	return chars.slice(0, maxChars).join("") + "…";
}

function findLastIndex(list, predicate) {
	for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i], i)) return i;
	return -1;
}

/**
 * 从会话事件中收集有顺序的对话回合（user / assistant）。
 * 读整份当前日志快照：最后一次刷新（/rename）时，最新一条助手回复往往最
 * 能代表“刚做完什么”，因此不按 throughSeq 截断内容；归因（messageSeqs）
 * 仍严格限定在 request.messages（服务端 revision 边界）内，过期结果由
 * 服务的 revision/abort 机制丢弃，不破坏其语义。
 */
function collectTranscript(config, events) {
	const turns = [];
	for (const event of events) {
		if (event.type === "user/message") {
			const data = event.data;
			if (!isRecord(data) || data.source?.kind !== "user") continue;
			const text = flattenText(data.content);
			if (!hasVisibleText(text)) continue;
			turns.push({ role: "user", seq: event.seq, text: clipText(text, config.maxCharsPerTurn) });
			continue;
		}
		if (event.type === "assistant/message") {
			const content = isRecord(event.data) && Array.isArray(event.data.message?.content) ? event.data.message.content : [];
			const text = flattenText(content);
			const tools = config.showToolNames
				? [...new Set(content
					.filter((block) => isRecord(block) && block.type === "tool-call" && typeof block.name === "string" && block.name.length > 0)
					.map((block) => block.name))].slice(0, 6)
				: [];
			if (!hasVisibleText(text) && tools.length === 0) continue;
			const turn = { role: "assistant", text: clipText(text, config.maxCharsPerTurn) };
			if (tools.length > 0) turn.tools = tools;
			turns.push(turn);
		}
	}
	return turns;
}

/**
 * 轮数窗口：超过 maxTurns 时保留开头 2 回合 + 结尾若干回合，中间以 note
 * 回合代替；最后一条真人消息永远保留（它是本次 revision 的锚点）。
 */
function windowTurns(config, turns) {
	if (turns.length <= config.maxTurns) return [...turns];
	const lastUserIdx = findLastIndex(turns, (turn) => turn.role === "user");
	const headCount = Math.min(2, Math.max(0, config.maxTurns - 1));
	const tailCount = Math.max(1, config.maxTurns - headCount);
	const tailStart = Math.max(headCount, turns.length - tailCount);
	const kept = turns.slice(0, headCount);
	let elided = 0;
	for (let i = headCount; i < turns.length; i++) {
		if (i >= tailStart || i === lastUserIdx) {
			if (elided > 0) {
				kept.push({ role: "note", text: `... ${elided} earlier turns omitted ...` });
				elided = 0;
			}
			kept.push(turns[i]);
		} else {
			elided++;
		}
	}
	return kept;
}

/**
 * 字节预算：从尾部贪心保留（结尾最能反映对话走向），锚点回合（最后一条
 * 真人消息）与首回合尽量保留；预算预先扣除 frame 前缀与 note 预留，保证
 * 最终完整 frame（含前缀与 “N turns omitted” 提示）不超 maxInputBytes，
 * 仅锚点回合自身超限时才允许少量溢出。
 */
function fitBytes(config, turns) {
	const jsonBudget = Math.max(0, config.maxInputBytes - FRAME_PREFIX_BYTES);
	const byteLen = (list) => Buffer.byteLength(JSON.stringify(list), "utf8");
	if (byteLen(turns) <= jsonBudget) return turns;
	const budget = Math.max(0, jsonBudget - NOTE_RESERVE_BYTES);
	const lastUserIdx = findLastIndex(turns, (turn) => turn.role === "user");
	const anchorIdx = lastUserIdx >= 0 ? lastUserIdx : turns.length - 1;
	const kept = [];
	let bytes = 2; // "[]"
	for (let i = turns.length - 1; i >= 1; i--) {
		const cost = Buffer.byteLength(JSON.stringify(turns[i]), "utf8") + (kept.length > 0 ? 1 : 0);
		if (i === anchorIdx || bytes + cost <= budget) {
			kept.unshift(turns[i]);
			bytes += cost;
		}
	}
	let headPresent = false;
	if (turns.length > 0) {
		const cost = Buffer.byteLength(JSON.stringify(turns[0]), "utf8") + (kept.length > 0 ? 1 : 0);
		if (kept.length === 0 || bytes + cost <= budget) {
			kept.unshift(turns[0]);
			bytes += cost;
			headPresent = true;
		}
	}
	const dropped = turns.length - kept.length;
	if (dropped > 0) {
		const note = { role: "note", text: `... ${dropped} earlier turns omitted ...` };
		const noteCost = Buffer.byteLength(JSON.stringify(note), "utf8") + 1;
		if (bytes + noteCost <= jsonBudget) {
			kept.splice(headPresent && kept.length > 1 ? 1 : 0, 0, note);
			bytes += noteCost;
		}
	}
	return kept;
}

/** 产出喂给模型的回合列表：先做轮数窗口，再做字节收敛；必要时按比例收紧单回合截断。 */
function buildDigest(config, turns) {
	const attempt = (charsPerTurn) => {
		const clipped = turns.map((turn) => {
			if (turn.role === "note") return turn;
			const next = { ...turn, text: clipText(turn.text, charsPerTurn) };
			if (next.tools !== undefined && next.tools.length === 0) delete next.tools;
			return next;
		});
		return fitBytes(config, windowTurns(config, clipped));
	};
	let kept = attempt(config.maxCharsPerTurn);
	let frameBytes = Buffer.byteLength(JSON.stringify(kept), "utf8");
	if (frameBytes > config.maxInputBytes) {
		const scale = Math.max(0.2, Math.min(1, config.maxInputBytes / Math.max(1, frameBytes)));
		kept = attempt(Math.max(40, Math.floor(config.maxCharsPerTurn * scale)));
	}
	return kept;
}

// ── 模型调用（与内置 title-llm 同策略） ─────────────────────────────────────

function systemPrompt(config) {
	return [
		"Create a concise title for an AI coding-assistant session from the supplied conversation transcript (human and assistant turns; role \"note\" marks omitted middle turns; \"tools\" lists tool names the assistant used in that turn).",
		"Weigh the whole conversation: later turns show where the work actually went, so the title should reflect the session's main goal or outcome rather than the first message alone.",
		"Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.",
		"Use the language of the conversation.",
		`Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
	].join("\n");
}

function frameDigest(turns) {
	return FRAME_PREFIX + JSON.stringify(turns);
}

// ── replay 策略：与 dsh-compaction-basic 同款的缓存前缀重放 ─────────────────

/** 追加在重放前缀末尾的命名指令（措辞对齐 COMPACTION_INSTRUCTION 的"引擎化"口径，避免模型续写对话）。 */
function replayInstruction(config) {
	return [
		"You are now acting as a titling engine for this AI coding assistant. Read the conversation ABOVE and propose the session title from ALL of it; later turns show where the work actually went, so reflect the session's main goal or outcome rather than the first message alone.",
		"Do not continue the conversation, answer it, or call any tool.",
		"Output only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.",
		"Use the language of the conversation.",
		`Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
	].join("\n");
}

/**
 * 重放对话最近一次主请求的可缓存前缀（与 buildSummarizationInput 同构）：
 * system/message 头 + 表面消息逐节点 derive（与 agent loop 同一投影函数）+
 * header 的工具 schema。使命名请求成为主对话请求的真前缀 → 命中 provider 的
 * KV 缓存。任一环节不可用（会话对象缺 API / 表面为空）返回 undefined，由
 * 调用方回退 digest。
 */
function buildConversationReplay(session) {
	try {
		if (session === null || typeof session !== "object") return undefined;
		if (typeof session.requestHeader !== "function" || typeof session.eventAt !== "function" || typeof session.deriveEventMessage !== "function") return undefined;
		const nodes = session.surface?.nodes;
		if (!Array.isArray(nodes) || nodes.length === 0) return undefined;
		const headEvent = session.eventAt(nodes[0]);
		const hasSystemHead = headEvent?.type === "system/message";
		const systemMessage = hasSystemHead ? session.deriveEventMessage(headEvent) : null;
		const body = [];
		for (let i = hasSystemHead ? 1 : 0; i < nodes.length; i++) {
			const event = session.eventAt(nodes[i]);
			if (event === undefined) continue;
			const message = session.deriveEventMessage(event);
			if (message !== null && message !== undefined) body.push(message);
		}
		if (body.length === 0) return undefined;
		const header = session.requestHeader();
		return {
			...(header?.tools === undefined ? {} : { tools: header.tools }),
			systemText: systemMessage === null ? "" : flattenText(systemMessage.content),
			messages: [...(systemMessage === null || systemMessage === undefined ? [] : [systemMessage]), ...body],
		};
	} catch {
		return undefined;
	}
}

/** 显式配置的路由优先；否则优先取会话最近一次主请求的实际路由（replay 前缀要与缓存同模型才能命中），再退回服务给定的 route。 */
function resolveRoute(config, request, session) {
	if (config.provider !== undefined && config.model !== undefined) {
		return { provider: config.provider, model: config.model };
	}
	const headerConfig = session?.requestHeader?.()?.config;
	if (headerConfig !== undefined
		&& typeof headerConfig.provider === "string" && headerConfig.provider.length > 0
		&& typeof headerConfig.model === "string" && headerConfig.model.length > 0) {
		return { provider: headerConfig.provider, model: headerConfig.model };
	}
	if (request.route !== undefined) return request.route;
	throw new Error("dsh-rename: no logged request route is available; configure provider and model together");
}

/**
 * 从模型原始输出中挑出标题行：模型常在标题后追加说明（多行），取第一个
 * 非空行；若该行以冒号结尾（“标题如下：”式前导），取下一行。
 */
function pickTitleLine(rawText) {
	const lines = String(rawText ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	if (lines.length > 1 && /[:：]\s*$/u.test(lines[0])) return lines[1];
	return lines[0];
}

/** 行首装饰符：强调符、井号/引用、各类开括号引号、破折号等。 */
const LEADING_DECOR = new Set([..."*_~`#> \t/—–-“”\"'「（《(【"]);
/** 行尾装饰符：强调符、闭括号引号、句读（保留 ！? 收尾的疑问/感叹标题）。 */
const TRAILING_DECOR = new Set([..."*_~` \t/—–-”\"'」》）)]】.。，,、;；:："]);
/** “标题：/Title:”式前缀。 */
const TITLE_PREFIX = /^(?:标题|title)\s*[:：]\s*/iu;

/**
 * 清洗标题行：反复从两端剥除装饰性字符（模型常输出 `**标题：** 通俗解读…`
 * 这类不对称杂讯，成对匹配处理不了），再去掉“标题：”前缀，直到稳定。
 */
function cleanTitleLine(line) {
	let out = String(line ?? "").trim();
	for (;;) {
		const before = out;
		let start = 0;
		let end = out.length;
		while (start < end && LEADING_DECOR.has(out[start])) start++;
		while (end > start && TRAILING_DECOR.has(out[end - 1])) end--;
		out = out.slice(start, end).trim();
		const prefix = TITLE_PREFIX.exec(out);
		if (prefix !== null) out = out.slice(prefix[0].length).trim();
		if (out === before) return out;
	}
}

/** 将终止原因翻译为辅助调用失败（与内置 finishError 同构）。 */
function finishError(finish) {
	switch (finish?.kind) {
		case "stop":
			return undefined;
		case "error":
		case "aborted": {
			const error = new Error(finish.failure?.message ?? "title request failed");
			error.code = finish.failure?.code;
			return error;
		}
		case "max-tokens":
			return new Error("dsh-rename: title output reached maxOutputTokens");
		case "tool-calls":
			return new Error("dsh-rename: title model unexpectedly requested a tool");
		default:
			return new Error(`dsh-rename: unsupported finish reason "${String(finish?.kind)}"`);
	}
}

/**
 * 跑一次标题流式调用并规整出标题。maxOutputTokens 不再一票否决：
 * 1) 触顶但已产出文本 → 直接抢救为标题（首行往往就是标题本身），打 warn；
 * 2) 触顶且零文本（预算被 reasoning 吃光）→ 输出预算 ×4 自动重试一次
 *    （共用调用方传入的同一 deadline，总时长仍受 timeoutMs 约束）；
 * 3) 重试仍零文本 → 才抛 maxOutputTokens 失败。
 */
async function streamTitle(ctx, { route, messages, system, tools, toolHistory, maxTokens, sessionId, signal }) {
	let budget = maxTokens;
	for (let attempt = 0; ; attempt++) {
		const assembler = new BlockAssembler();
		const options = {
			provider: route.provider,
			model: route.model,
			messages,
			maxTokens: budget,
			sessionId,
			purpose: "session-title",
			signal,
		};
		if (system !== undefined) options.system = system;
		if (tools !== undefined) options.tools = tools;
		if (toolHistory !== undefined) options.toolHistory = toolHistory;
		for await (const chunk of ctx.llm.stream(options)) {
			signal.throwIfAborted();
			assembler.push(chunk);
		}
		signal.throwIfAborted();
		const finish = assembler.finish;
		const blocks = assembler.blocks();
		if (blocks.some((block) => block.type === "tool-call")) {
			throw new Error("dsh-rename: title output must contain text only");
		}
		const rawText = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		const title = normalizeSessionTitle(cleanTitleLine(pickTitleLine(rawText)), Number.MAX_SAFE_INTEGER);
		if (title.length > 0) {
			if (finish?.kind === "max-tokens") {
				ctx.logger.warn(`dsh-rename: output hit maxTokens=${budget}; salvaged title from partial output`);
			}
			return { title, budget };
		}
		if (finish?.kind !== "max-tokens" || attempt >= 1) {
			throw finishError(finish) ?? new Error("dsh-rename: title model produced no text");
		}
		budget *= 4;
		ctx.logger.warn(`dsh-rename: no text within maxTokens=${budget / 4} (reasoning likely consumed it); retrying with maxTokens=${budget}`);
	}
}

/**
 * 一次“重新总结”：digest → 留痕 → 辅助 LLM 调用 → 归一化标题。
 * 返回 { title, messageSeqs, model }，messageSeqs 是本次 digest 覆盖到的、
 * 属于 request.messages 的真人消息 seq（服务端会校验其必须为请求内有序子集）。
 */
async function generateTitle(ctx, config, providerId, request) {
	request.signal.throwIfAborted();
	const session = request.session;
	if (request.messages.length === 0) throw new Error("dsh-rename: no eligible human messages to summarize");
	const knownSeqs = new Set(request.messages.map((message) => message.seq));
	const throughSeq = request.messages[request.messages.length - 1].seq;

	// ── replay：重放对话前缀 + 尾部命名指令（compaction 同款，命中对话 KV 缓存）──
	const replay = config.promptStrategy === "replay" ? buildConversationReplay(session) : undefined;
	if (replay !== undefined) {
		const route = resolveRoute(config, request, session);
		const instruction = replayInstruction(config);
		const callMessages = [...replay.messages, { role: "user", content: [{ type: "text", text: instruction }] }];
		// 留痕：replay 的输入就是会话表面自身（本日志上方即是），事件里只持久化
		// 指令帧，避免把整段对话复制进 title-llm-request 使日志膨胀。持久化形状
		// 仍满足持久化读取端校验（单条 user 消息 + text 块 + source kind）。
		session.append("session/title-llm-request", {
			titleProvider: providerId,
			messageSeqs: request.messages.map((message) => message.seq),
			route,
			system: replay.systemText,
			messages: [createUserMessage({
				content: [{ type: "text", text: instruction }],
				source: { kind: "dsh-session-title-llm" },
			})],
			maxTokens: config.maxOutputTokens,
		});

		const stop = deadline(request.signal, config.timeoutMs, TIMEOUT_CODE);
		try {
			const { title } = await streamTitle(ctx, {
				route,
				messages: callMessages,
				tools: replay.tools,
				toolHistory: typeof session.toolHistory === "function" ? session.toolHistory() : undefined,
				maxTokens: config.maxOutputTokens,
				sessionId: session.id,
				signal: stop.signal,
			});
			ctx.logger.info(`dsh-rename: session "${session.id}" → "${title}" (${route.provider}/${route.model}, replay ${callMessages.length} messages)`);
			return { title, messageSeqs: request.messages.map((message) => message.seq), model: route };
		} finally {
			stop[Symbol.dispose]?.();
		}
	}

	// ── digest：独立摘要帧（显式策略，或 replay 不可用时的回退） ──
	const digest = buildDigest(config, collectTranscript(config, session.snapshotEvents()));
	const userSeqs = digest
		.filter((turn) => turn.role === "user" && Number.isSafeInteger(turn.seq) && knownSeqs.has(turn.seq))
		.map((turn) => turn.seq);
	const messageSeqs = userSeqs.length > 0 ? userSeqs : [throughSeq];

	const route = resolveRoute(config, request, session);
	const system = systemPrompt(config);
	const framed = frameDigest(digest);
	const inputBytes = Buffer.byteLength(framed, "utf8");
	if (inputBytes > config.maxInputBytes) {
		ctx.logger.warn(`dsh-rename: digest is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes} (must-keep turns preserved)`);
	}
	const messages = [createUserMessage({
		content: [{ type: "text", text: framed }],
		// 持久化读取端（dsh-session-persistence-jsonl 的 titleSources 校验）对
		// session/title-llm-request 内嵌消息硬性要求 source.kind === "dsh-session-title-llm"，
		// 自定义 kind 会让整份会话日志在加载时被判为 corrupt。
		source: { kind: "dsh-session-title-llm" },
	})];

	session.append("session/title-llm-request", {
		titleProvider: providerId,
		messageSeqs,
		route,
		system,
		messages,
		maxTokens: config.maxOutputTokens,
	});

	const stop = deadline(request.signal, config.timeoutMs, TIMEOUT_CODE);
	try {
		const { title } = await streamTitle(ctx, {
			route,
			messages,
			system,
			maxTokens: config.maxOutputTokens,
			sessionId: session.id,
			signal: stop.signal,
		});
		ctx.logger.info(`dsh-rename: session "${session.id}" → "${title}" (${route.provider}/${route.model}, ${digest.length} turns, ${inputBytes}B in)`);
		return { title, messageSeqs, model: route };
	} finally {
		stop[Symbol.dispose]?.();
	}
}

// ── /rename 命令 ────────────────────────────────────────────────────────────

async function runRenameCommand(ctx, config, providerId, invocation) {
	const session = invocation.agent?.session;
	if (session === undefined) return { kind: "error", text: "dsh-rename: 找不到当前会话" };
	const raw = invocation.rawInput.trim();

	// 带参数：显式用户命名（锁定标题，自动生成随之暂停）。
	if (raw.length > 0) {
		try {
			const snapshot = ctx.sessionTitle.rename(session, raw);
			return { kind: "success", text: `已手动命名：${snapshot.title}（自动重命名已暂停；无参数执行 /rename 可恢复由模型命名）` };
		} catch (error) {
			if (error instanceof SessionTitleInvalidError) return { kind: "error", text: "标题不能为空或仅含空白/控制字符" };
			if (invocation.signal?.aborted) return { kind: "error", text: "已取消" };
			throw error;
		}
	}

	// 无参数：让模型对整段对话重新总结并重命名（refresh 是唯一会覆盖手动
	// 标题的正式途径）。模型调用不阻塞命令返回：Web 端 claim submit 在
	// handler settle 前会一直持有输入框草稿，await 会让 /rename 文字留存
	// 整个总结过程（与 /compact 回车即清空不一致）。这里同步做轻量校验后
	// 立即返回，总结转后台；完成后补发一对 command/run+command/done 流
	// 节点回显「旧标题 → 新标题」（已知的 log-only 事件对，聊天端按
	// commandId 关联渲染），失败同样以 error 节点提示。
	if (!session.snapshotEvents().some((event) =>
		event.type === "user/message"
		&& isRecord(event.data) && event.data.source?.kind === "user"
		&& hasVisibleText(flattenText(event.data.content)))) {
		return { kind: "error", text: "对话中还没有可用于总结的文本消息" };
	}
	const before = ctx.sessionTitle.get(session)?.title ?? null;
	const report = (kind, text) => {
		try {
			const commandId = randomUUID();
			session.append("command/run", { commandId, name: "rename" });
			session.append("command/done", { commandId, kind, ...(text === undefined ? {} : { text }) });
		} catch (error) {
			ctx.logger.warn(`dsh-rename: failed to append rename outcome: ${error?.message ?? String(error)}`);
		}
	};
	ctx.sessionTitle.refresh(session).then((snapshot) => {
		if (snapshot === undefined) return;
		const via = snapshot.source?.kind === "provider" && snapshot.model ? `（${snapshot.model.provider} / ${snapshot.model.model}）` : "";
		const renamed = before !== null && before !== snapshot.title;
		report("success", `${renamed ? `「${before}」→ ` : "标题："}${snapshot.title}${via}`);
	}, (error) => {
		if (error?.name === "AbortError" || error?.code === "ABORTED") return; // 被更新的总结取代，不发节点
		if (error?.code === TIMEOUT_CODE) { report("error", "重新总结超时"); return; }
		if (String(error?.message ?? error).includes("no logged request route")) {
			report("error", "无法确定用于总结的模型：先在对话里发一条消息，或在插件配置中同时指定 provider 与 model");
			return;
		}
		report("error", `重新总结失败：${error?.message ?? String(error)}`);
	});
	return { kind: "success", text: "正在重新总结会话标题…" };
}

// ── 插件装配 ────────────────────────────────────────────────────────────────

/**
 * compact 前的重命名钩子：监听会话日志上的 `compaction/start`（手动 /compact
 * 与自动压缩在摘要生成前都会同步追加该标记），触发一次模型重新总结。标题
 * 是 log-only 投影，与压缩对历史的替换互不干扰；refresh 的 revision/取消
 * 语义保证并发时旧结果被丢弃。失败只告警，绝不阻断压缩。
 */
function handleCompactionStart(ctx, session) {
	const pending = ctx.sessionTitle.refresh(session).catch((error) => {
		ctx.logger.warn(`dsh-rename: pre-compact rename failed: ${error?.message ?? String(error)}`);
	});
	void pending;
}

function apply(ctx, config) {
	const cfg = resolveConfig(config);
	const providerId = SessionTitleProviderId(name);

	// 会话标题 provider：注册 Cleanup 挂在本插件 fiber 上（yield 出 disposer），
	// 插件重载/卸载时先注销，再由新 fiber 重新注册，配置热更安全。
	ctx.effect(function* () {
		yield ctx.sessionTitle.register({
			id: providerId,
			automatic: cfg.automatic,
			generate: (request) => generateTitle(ctx, cfg, providerId, request),
		});
	}, "dsh-rename title provider");

	// compact 前重命名（renameBeforeCompact: true 时启用）。
	if (cfg.renameBeforeCompact) {
		ctx.effect(function* () {
			yield ctx.on("session/event", (session, event) => {
				if (event?.type !== "compaction/start") return;
				handleCompactionStart(ctx, session);
			});
		}, "dsh-rename pre-compact hook");
	}

	ctx.effect(function* () {
		yield ctx.commands.register({
			definitionId: CommandDefinitionId("dsh-rename"),
			name: "rename",
			description: "用模型重新总结整段对话并重命名；带标题则手动命名并锁定",
			// 声明 input：命令带参数占位（Web 命令菜单与 Space 触发参数 claim，
			// hint 显示在输入框）；回车按当前草稿立即执行——留空参数 = 模型
			// 重新总结并重命名，带文字 = 手动命名并锁定。模型总结不阻塞命令
			// 返回（见 runRenameCommand），输入框随提交立即清空，与 /compact
			// 一致；终端等直连入口语义不变。
			input: { hint: "标题（留空则由模型重新总结）" },
			handler: (invocation) => runRenameCommand(ctx, cfg, providerId, invocation),
		});
	}, "dsh-rename command");

	ctx.logger.info(
		`dsh-rename: whole-conversation title provider registered (automatic: ${cfg.automatic}`
		+ `, renameBeforeCompact: ${cfg.renameBeforeCompact}`
		+ (cfg.provider !== undefined ? `, route: ${cfg.provider}/${cfg.model}` : ", route: follow session")
		+ `; /rename available)`,
	);
}

export { Config, apply, inject, name };
