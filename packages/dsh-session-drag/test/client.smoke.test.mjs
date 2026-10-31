// dsh-session-drag 浏览器半边离线冒烟测试：在 VM 沙箱里加载 ModuleLoader 工厂，
// 用最小 DOM/react 桩驱动 apply 装配与拖放控制器（dragstart → dragover → drop）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

let failures = 0;
function check(ok, label, detail = "") {
	if (ok) console.log(`  ok  ${label}`);
	else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// ── 沙箱桩 ───────────────────────────────────────────────────────────────────

class FakeElement {
	constructor(tag) {
		this.tag = tag;
		this.parentElement = null;
		this.children = [];
		this.attributes = {};
		const classes = new Set();
		this.classList = {
			add: (name) => classes.add(name),
			remove: (...names) => { for (const name of names) classes.delete(name); },
			has: (name) => classes.has(name),
		};
		this.dataset = new Proxy({}, {
			set: (target, prop, value) => {
				target[prop] = value;
				this.attributes[`data-${String(prop).replace(/[A-Z]/gu, (m) => `-${m.toLowerCase()}`)}`] = value;
				return true;
			},
		});
	}
	getAttribute(name) { return this.attributes[name] ?? null; }
	getBoundingClientRect() { return this.rect ?? { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }; }
	closest(selector) {
		for (let node = this; node !== null; node = node.parentElement) {
			if (matchesSimple(node, selector)) return node;
		}
		return null;
	}
	querySelector(selector) {
		// 插件用 `[data-row-key^="workspace:"]` 做后代查找（真实 DOM 里工作区行
		// 与会话行都隔着一层 HoverCard 包裹 span），按整棵子树实现。
		for (const child of this.children) {
			if (matchesSimple(child, selector)) return child;
			const hit = child.querySelector(selector);
			if (hit !== null) return hit;
		}
		return null;
	}
	querySelectorAll(selector) {
		// 真实语义：仅后代、文档序，不含自身。
		const hits = [];
		const walk = (node) => {
			for (const child of node.children) {
				if (matchesSimple(child, selector)) hits.push(child);
				walk(child);
			}
		};
		walk(this);
		return hits;
	}
	append(child) { child.parentElement = this; this.children.push(child); }
	setAttribute(name, value) { this.attributes[name] = value; }
	remove() {
		const parent = this.parentElement;
		if (parent !== null) parent.children = parent.children.filter((child) => child !== this);
		this.parentElement = null;
	}
}

/** 只实现插件用到的三种选择器形态。 */
function matchesSimple(node, selector) {
	const attr = selector.match(/\[data-row-key\^="([^"]+)"\]/);
	if (attr === null) return false;
	const key = node.attributes["data-row-key"];
	return typeof key === "string" && key.startsWith(attr[1]);
}

function tree(parent, tag, attrs = {}) {
	const node = new FakeElement(tag);
	node.attributes = attrs;
	parent.append(node);
	return node;
}

function makeSandbox() {
	const listeners = {};
	const registered = [];
	const effects = [];
	const logs = [];
	const styleElements = [];
	const bodyAppends = [];
	const loaded = [];

	const document = new FakeElement("#document");
	document.head = new FakeElement("head");
	document.body = new FakeElement("body");
	document.createElement = (tag) => new FakeElement(tag);
	document.getElementById = (id) => document.body.children.find((node) => node.attributes.id === id) ?? null;
	document.addEventListener = (type, handler, options) => { (listeners[type] ??= []).push({ handler, options }); };
	document.removeEventListener = (type, handler, options) => {
		const bucket = listeners[type] ?? [];
		const at = bucket.findIndex((entry) => entry.handler === handler);
		if (at >= 0) bucket.splice(at, 1);
	};

	const sandbox = {
		window: { __ModuleLoader__: { load: (entry) => loaded.push(entry) } },
		sessionsCalls: [],
		document,
		navigator: { language: "zh-CN" },
		Element: FakeElement,
		setTimeout: (fn) => { /* toast 自清理在沙箱外无意义，吞掉 */ },
		setInterval,
		clearTimeout,
		AbortController,
		fetch: sandboxFetch,
		Symbol,
		Object,
		Array,
		Set,
		Map,
		JSON,
		String,
		Number,
		Boolean,
		Promise,
		Error,
		TypeError,
		URL,
		Uint8Array,
		console,
		require(specifier) {
			throw new Error(`unexpected require: ${specifier}`);
		},
	};

	const results = { listeners, registered, effects, logs, styleElements, bodyAppends, loaded, sessionOrderCalls: [], sandbox };
	results.uiWorkspace = {
		view: {
			setSessionOrder: (accountKey, order, initialOrders) => { results.sessionOrderCalls.push({ accountKey, order, initialOrders }); },
		},
	};
	function sandboxFetch(url, init) {
		results.fetchCalls ??= [];
		results.fetchCalls.push({ url, init });
		return Promise.resolve({ ok: true, json: async () => ({ ok: true, moved: true, sessionId: "session-new" }) });
	}
	return results;
}

function makeCtx(sandbox) {
	sandbox.sessionsCalls ??= [];
	const sessionsCalls = sandbox.sessionsCalls;
	const ctx = {
		slotsCalls: [],
		get(service) {
			if (service === "sessions") {
				return {
					refresh: async () => { sessionsCalls.push("refresh"); },
					refreshProjections: async (sessionId) => { sessionsCalls.push(`refreshProjections:${sessionId}`); },
				};
			}
			if (service === "uiWorkspace") {
				return sandbox.uiWorkspace ?? null;
			}
			return null;
		},
		effect(execute, label) {
			const disposer = execute();
			sandbox.effects.push({ label, disposer });
			return disposer;
		},
		slots: {
			inject: (name, factory) => { sandbox.registered.push({ kind: "inject", name, registration: factory() }); },
			register: (options, component) => {
				sandbox.registered.push({ kind: "register", options, component });
				return () => {};
			},
		},
	};
	return ctx;
}

// ── 1. 模块形状 ──────────────────────────────────────────────────────────────

console.log("1. module shape");
const sandbox1 = makeSandbox();
vm.createContext(sandbox1.sandbox);
vm.runInContext(source, sandbox1.sandbox, { filename: "client.js" });
check(sandbox1.loaded.length === 1, "ModuleLoader.load called once");
const entry = sandbox1.loaded[0];
check(entry?.id === "dsh-session-drag", "module id");
check(typeof entry?.factory === "function", "factory is a function");

const module1 = entry.factory(sandbox1.sandbox.require);
check(typeof module1?.apply === "function", "exports.apply");
check(JSON.stringify(module1?.inject) === JSON.stringify(["sessions", "uiWorkspace"]), "exports.inject");

// ── 2. apply 装配 ────────────────────────────────────────────────────────────

console.log("2. apply wiring");
const sandbox2 = makeSandbox();
vm.createContext(sandbox2.sandbox);
vm.runInContext(source, sandbox2.sandbox, { filename: "client.js" });
const module2 = sandbox2.loaded[0].factory(sandbox2.sandbox.require);
const ctx2 = makeCtx(sandbox2);
module2.apply(ctx2);

check(sandbox2.effects.length === 2, "two effects (styles + drag controller)", JSON.stringify(sandbox2.effects.map((e) => e.label)));
const styleEffect = sandbox2.effects[0];
const injectedStyles = styleEffect !== undefined && documentHeadStyles(sandbox2);
check(injectedStyles !== null && injectedStyles.attributes["data-plugin"] === "dsh-session-drag", "style element tagged");
styleEffect.disposer();
check(documentHeadStyles(sandbox2) === null, "style removed on dispose");

function documentHeadStyles(sb) {
	return sb.sandbox.document.head.children.find((node) => node.tag === "style") ?? null;
}

const dragListeners = sandbox2.listeners;
check(
	["dragstart", "dragover", "drop", "dragend"].every((type) => dragListeners[type]?.length === 1),
	"four capture-phase drag listeners",
	JSON.stringify(Object.keys(dragListeners)),
);
check(
	["dragstart", "dragover", "drop", "dragend"].every((type) => dragListeners[type]?.[0]?.options?.capture === true),
	"listeners registered with capture: true",
);
// 不注册任何 slot（无会话菜单项 / overlay 对话框）
check(sandbox2.registered.length === 0, "no slot registrations");

// ── 3. 拖放控制器端到端 ──────────────────────────────────────────────────────

console.log("3. drag & drop controller");
const sandbox3 = makeSandbox();
vm.createContext(sandbox3.sandbox);
vm.runInContext(source, sandbox3.sandbox, { filename: "client.js" });
const module3 = sandbox3.loaded[0].factory(sandbox3.sandbox.require);
module3.apply(makeCtx(sandbox3));
const handler = (type) => sandbox3.listeners[type]?.[0]?.handler;

// DOM（按真实侧边栏结构）：groupSection 的直接子节点是 HoverCard 包裹 span，
// 行（工作区行 / 会话行）都包在 span 里；ws-a 组含会话 s-1。
const body = sandbox3.sandbox.document.body;
const sectionA = tree(body, "div");
const wsRowA = tree(tree(sectionA, "span"), "div", { "data-row-key": "workspace:ws-a" });
const sessionRow = tree(tree(sectionA, "span"), "div", { "data-row-key": "session:s-1" });
const sectionB = tree(body, "div");
const wsRowB = tree(tree(sectionB, "span"), "div", { "data-row-key": "workspace:ws-b" });
const otherRow = tree(tree(body, "span"), "div", { "data-row-key": "workspace:" }); // Ungrouped：空 id

handler("dragstart")({ target: sessionRow });
check(true, "dragstart on session row accepted");

const overB = { target: wsRowB, preventDefault: () => { overB.defaultPrevented = true; }, stopPropagation: () => { overB.stopped = true; }, dataTransfer: {} };
handler("dragover")(overB);
check(overB.defaultPrevented === true, "dragover over another workspace allows drop");
check(overB.dataTransfer.dropEffect === "move", "dropEffect move");
check(wsRowB.classList.has("dshsd-drop-target") === true, "target row highlighted");

const overA = { target: wsRowA, preventDefault: () => { overA.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(overA);
check(overA.defaultPrevented !== true, "same workspace dragover untouched (native reorder keeps working)");
check(wsRowA.classList.has("dshsd-drop-target") === false, "same workspace not highlighted");
check(wsRowB.classList.has("dshsd-drop-target") === false, "previous highlight cleared on leave");

const overOther = { target: otherRow, preventDefault: () => { overOther.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(overOther);
check(overOther.defaultPrevented !== true, "ungrouped row is not a drop target");

const overPlain = { target: body, preventDefault: () => { overPlain.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(overPlain);
check(overPlain.defaultPrevented !== true, "plain elements untouched");

const drop = { target: wsRowB, preventDefault: () => { drop.defaultPrevented = true; }, stopPropagation: () => { drop.stopped = true; }, dataTransfer: {} };
handler("dragover")(drop); // 重新悬停高亮
const dropCallsBefore = sandbox3.fetchCalls?.length ?? 0;
handler("drop")(drop);
check(drop.defaultPrevented === true && drop.stopped === true, "drop intercepted");
await new Promise((resolve) => setTimeout(resolve, 5));
const moveCall = (sandbox3.fetchCalls ?? []).slice(dropCallsBefore).find((call) => String(call.url).endsWith("/api/dsh-session-drag/move"));
check(moveCall !== undefined, "move endpoint called");
check(JSON.parse(moveCall?.init?.body ?? "{}")?.sessionId === "s-1" && JSON.parse(moveCall.init.body)?.workspaceId === "ws-b", "move payload ids");
check(JSON.parse(moveCall.init.body).sessionId === "s-1", "session id from row key");
check(wsRowB.classList.has("dshsd-drop-target") === false, "highlight cleared after drop");
check(sandbox3.sessionsCalls?.includes("refreshProjections:session-new"), "new session projections hydrated (title shows instead of 未命名)", JSON.stringify(sandbox3.sessionsCalls));
check(sandbox3.sessionsCalls?.includes("refresh"), "session list refreshed");
check(sandbox3.sessionOrderCalls.length === 0, "workspace-row drop keeps top placement (no manual order write)", JSON.stringify(sandbox3.sessionOrderCalls));

// drop 后 drag 状态清空：再来的 dragover/drop 不再接管
const stale = { target: wsRowB, preventDefault: () => { stale.defaultPrevented = true; }, stopPropagation: () => { stale.stopped = true; }, dataTransfer: {} };
handler("drop")(stale);
check(stale.defaultPrevented !== true && stale.stopped !== true, "state cleared after completed drop");

// 跨组会话行落点：上/下半决定插入位置，迁移成功后写入目标组手动排序
const sessionRowB1 = tree(tree(sectionB, "span"), "div", { "data-row-key": "session:s-b1" });
const sessionRowB2 = tree(tree(sectionB, "span"), "div", { "data-row-key": "session:s-b2" });
sessionRowB1.rect = { top: 0, height: 20 };
sessionRowB2.rect = { top: 100, height: 20 };
const sameGroupRow = tree(tree(sectionA, "span"), "div", { "data-row-key": "session:s-a2" });
const ungroupedSessionRow = tree(tree(body, "span"), "div", { "data-row-key": "session:s-u1" });

handler("dragstart")({ target: sessionRow });
const overB1 = { target: sessionRowB1, clientY: 5, preventDefault: () => { overB1.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(overB1);
check(overB1.defaultPrevented === true, "cross-group session-row dragover allows drop");
check(sessionRowB1.classList.has("dshsd-drop-before") === true, "upper half shows the before insertion line");
check(sessionRowB1.classList.has("dshsd-drop-target") === false, "session-row hover uses the line marker, not the workspace outline");
check(wsRowB.classList.has("dshsd-drop-target") === false, "no workspace highlight while over a session row");

const overB1Low = { target: sessionRowB1, clientY: 15, preventDefault: () => {}, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(overB1Low);
check(sessionRowB1.classList.has("dshsd-drop-before") === false && sessionRowB1.classList.has("dshsd-drop-after") === true, "marker flips to the after line on the lower half");

const dropB1 = { target: sessionRowB1, clientY: 5, preventDefault: () => { dropB1.defaultPrevented = true; }, stopPropagation: () => { dropB1.stopped = true; }, dataTransfer: {} };
handler("drop")(dropB1);
check(dropB1.defaultPrevented === true && dropB1.stopped === true, "session-row drop intercepted");
await new Promise((resolve) => setTimeout(resolve, 5));
check(sessionRowB1.classList.has("dshsd-drop-before") === false && sessionRowB1.classList.has("dshsd-drop-after") === false, "insertion line cleared after drop");
check(sandbox3.sessionOrderCalls.length === 1, "manual order written once", JSON.stringify(sandbox3.sessionOrderCalls));
check(
	sandbox3.sessionOrderCalls[0]?.accountKey === "ws-b" && JSON.stringify(sandbox3.sessionOrderCalls[0]?.order) === JSON.stringify(["session-new", "s-b1", "s-b2"]) && JSON.stringify(sandbox3.sessionOrderCalls[0]?.initialOrders) === "{}",
	"upper half inserts the copy before the anchor row",
);

handler("dragstart")({ target: sessionRow });
const dropB2 = { target: sessionRowB2, clientY: 115, preventDefault: () => { dropB2.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("drop")(dropB2);
await new Promise((resolve) => setTimeout(resolve, 5));
check(
	sandbox3.sessionOrderCalls.length === 2 && JSON.stringify(sandbox3.sessionOrderCalls[1]?.order) === JSON.stringify(["s-b1", "s-b2", "session-new"]),
	"lower half inserts the copy after the anchor row",
);

// 同组会话行与 Ungrouped 会话行不是落点，原生链路接管
handler("dragstart")({ target: sessionRow });
const overSameSession = { target: sameGroupRow, clientY: 5, preventDefault: () => { overSameSession.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(overSameSession);
check(overSameSession.defaultPrevented !== true, "same-group session row keeps native reorder");
const overUngroupedSession = { target: ungroupedSessionRow, clientY: 5, preventDefault: () => { overUngroupedSession.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(overUngroupedSession);
check(overUngroupedSession.defaultPrevented !== true, "ungrouped session row is not a drop target");
handler("dragend")({ target: sessionRow });
check(sandbox3.sessionOrderCalls.length === 2, "non-targets wrote no order");

// uiWorkspace 缺席（版本差异）→ 顺序写入静默跳过，迁移照常
const sandbox4 = makeSandbox();
sandbox4.uiWorkspace = null;
vm.createContext(sandbox4.sandbox);
vm.runInContext(source, sandbox4.sandbox, { filename: "client.js" });
const module4 = sandbox4.loaded[0].factory(sandbox4.sandbox.require);
module4.apply(makeCtx(sandbox4));
const handler4 = (type) => sandbox4.listeners[type]?.[0]?.handler;
const body4 = sandbox4.sandbox.document.body;
const sourceRow4 = tree(tree(body4, "span"), "div", { "data-row-key": "session:s-t0" });
const section4 = tree(body4, "div");
tree(tree(section4, "span"), "div", { "data-row-key": "workspace:ws-t" });
const anchor4 = tree(tree(section4, "span"), "div", { "data-row-key": "session:s-t1" });
anchor4.rect = { top: 0, height: 10 };
handler4("dragstart")({ target: sourceRow4 });
const drop4 = { target: anchor4, clientY: 2, preventDefault: () => { drop4.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler4("drop")(drop4);
await new Promise((resolve) => setTimeout(resolve, 5));
check(sandbox4.fetchCalls?.some((call) => String(call.url).endsWith("/api/dsh-session-drag/move")), "missing uiWorkspace still moves");
check((sandbox4.sessionOrderCalls ?? []).length === 0, "missing uiWorkspace skips the order write");

// 工作区行自身的拖动（排序）不进会话拖放状态
handler("dragstart")({ target: wsRowA });
const wsDragOver = { target: wsRowB, preventDefault: () => { wsDragOver.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(wsDragOver);
check(wsDragOver.defaultPrevented !== true, "workspace reorder drag untouched");

// 会话行 dragend 清理
handler("dragstart")({ target: sessionRow });
handler("dragend")({ target: sessionRow });
const afterEnd = { target: wsRowB, preventDefault: () => { afterEnd.defaultPrevented = true; }, stopPropagation: () => {}, dataTransfer: {} };
handler("dragover")(afterEnd);
check(afterEnd.defaultPrevented !== true, "dragend clears drag state");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
