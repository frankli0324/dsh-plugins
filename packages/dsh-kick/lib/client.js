// dsh-kick 客户端：排队 dock 行内的 Kick 按钮（用户选定的 DOM 增强方案）。
//
// 排队 dock（QueueDock）是核心渲染的，行操作区没有插件插槽；本组件以
// 700ms 限频轮询扫描 dock 行（steer 按钮的 aria-label =「插话发送 / Steer
// queued message」，本地回显行按 pendingRow 类排除），在删除与 steer 之间
// 注入 ⚡ Kick —— 点击 = 打断当前运行，该条排队消息立即作为新回合执行
// （POST /api/kick {sessionId, itemId}）。
//
// 卡死教训：初版用 MutationObserver 观察全文档 + 微任务扫描，应用挂载的
// mutation 风暴会饿死主线程。现版定频轮询，每轮有界（无 steer 按钮直接
// 返回），无观察器、无微任务链。
//
// 行 ↔ 消息对齐：dock 的持久行按 inbox next-turn 顺序渲染，服务端
// GET /api/kick 返回同序的 {id, text} 清单，按序号一一对应；本地回显行
// （尚未入箱，按钮全禁用）跳过，入箱后自动补上。

window.__ModuleLoader__.load({
	id: "dsh-kick",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		var STEER_LABEL_SELECTOR = 'button[aria-label="插话发送"], button[aria-label="Steer queued message"]';
		var BOLT_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style="width:16px;height:16px"><path d="M8.9 1.3 3.6 8.4a.55.55 0 0 0 .44.88h2.9l-1.1 4.9c-.1.47.47.76.78.39l5.3-7.1a.55.55 0 0 0-.44-.88h-2.9l1.1-4.9a.5.5 0 0 0-.78-.39Z" fill="currentColor"></path></svg>';

		function KickRows(props) {
			var sessionId = props.sessionId;

			react.useEffect(function () {
				if (sessionId == null) return undefined;
				var items = [];
				var itemsAt = 0;
				var fetching = false;
				var stopped = false;

				function fetchItems() {
					if (fetching) return Promise.resolve();
					fetching = true;
					return fetch("/api/kick?sessionId=" + encodeURIComponent(sessionId))
						.then(function (res) { return res.ok ? res.json() : null; })
						.then(function (body) {
							if (body && Array.isArray(body.items)) {
								items = body.items;
								itemsAt = Date.now();
							}
						})
						.catch(function () {})
						.finally(function () { fetching = false; });
				}

				function onKick(btn) {
					var itemId = btn.__dshKickItem;
					if (!itemId || btn.disabled) return;
					btn.disabled = true;
					fetch("/api/kick", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: sessionId, itemId: itemId }),
					}).then(function (res) {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					}).then(function (body) {
						if (body && body.action === "none") btn.title = "Kick：该消息已不在排队中";
					}).catch(function (error) {
						btn.title = "Kick 失败：" + (error && error.message ? error.message : "网络错误");
						btn.style.color = "var(--dsw-alias-state-error-primary)";
						console.warn("dsh-kick: kick item failed", error);
					}).finally(function () {
						setTimeout(function () { btn.disabled = false; }, 300);
					});
				}

				function removeInjected(scope) {
					var injected = scope.querySelectorAll("button[data-dsh-kick]");
					for (var i = 0; i < injected.length; i++) injected[i].remove();
				}

				function scan() {
					if (stopped) return;
					var steerButtons = document.querySelectorAll(STEER_LABEL_SELECTOR);
					if (steerButtons.length === 0) {
						if (itemsAt !== 0) removeInjected(document);
						return;
					}
					// steer 按钮 → 操作区（其父）→ 行（操作区的父）；回显行跳过。
					var rows = [];
					for (var i = 0; i < steerButtons.length; i++) {
						var steer = steerButtons[i];
						var group = steer.parentElement;
						var row = group === null ? null : group.parentElement;
						if (group === null || row === null || /pendingRow/.test(row.className)) continue;
						rows.push({ group: group, steer: steer });
					}
					// 行序 = inbox next-turn 顺序 = 服务端清单顺序；数量不齐（回显
					// 未落定/清单过期）时清理失效按钮并限频刷新清单，下轮再对齐。
					if (rows.length !== items.length) {
						for (var j = 0; j < rows.length; j++) {
							var stale = rows[j].group.querySelector("button[data-dsh-kick]");
							if (stale) stale.remove();
						}
						if (!fetching && Date.now() - itemsAt > 1200) fetchItems();
						return;
					}
					for (var k = 0; k < rows.length; k++) {
						var entry = rows[k];
						var item = items[k];
						var mine = entry.group.querySelector("button[data-dsh-kick]");
						if (mine !== null) {
							mine.__dshKickItem = item.id; // 行序变化时原地改指向
							continue;
						}
						var btn = document.createElement("button");
						btn.type = "button";
						btn.className = entry.steer.className;
						btn.setAttribute("aria-label", "Kick");
						btn.title = "Kick：打断当前运行，立即执行这条排队消息";
						btn.dataset.dshKick = "1";
						btn.__dshKickItem = item.id;
						btn.innerHTML = BOLT_SVG;
						btn.addEventListener("click", function (event) { onKick(event.currentTarget); });
						entry.group.insertBefore(btn, entry.steer);
					}
				}

				fetchItems().then(function () { if (!stopped) scan(); });
				var timer = setInterval(function () { if (!stopped) scan(); }, 700);

				return function () {
					stopped = true;
					clearInterval(timer);
					removeInjected(document);
				};
			}, [sessionId]);

			return null;
		}

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.slots.inject("conversation.composer.dock", function () {
					return ctx.slots.register({
						name: "conversation.composer.dock",
						id: "kick",
					}, function (props) {
						return react.createElement(KickRows, Object.assign({}, props, { host: { ctx: ctx } }));
					});
				});
			}, "dsh-kick: queue row kick buttons");
		}

		var inject = ["slots"];
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
