window.__ModuleLoader__.load({
	id: "dsh-session-drag",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region i18n（与 dsh-mobile-ui 同款内联双语，避免引入 locale 注册面）
		const STRINGS = Object.freeze({
			zh: Object.freeze({
				moved: "已移动到目标工作区（原会话已归档，可在归档列表找回）",
				alreadyThere: "会话已在该工作区，无需移动",
				active: "会话仍有进行中的工作，已停止后才能移动",
				openFail: "无法完成移动",
			}),
			en: Object.freeze({
				moved: "Moved to the target workspace (original archived; restore it from the archived list)",
				alreadyThere: "The session is already in that workspace",
				active: "The session still has running work; stop it before moving",
				openFail: "The move did not complete",
			}),
		});
		const isZh = /^zh/i.test(typeof navigator === "object" && navigator !== null && typeof navigator.language === "string" ? navigator.language : "");
		const t = (key) => (isZh ? STRINGS.zh[key] : STRINGS.en[key]) ?? STRINGS.en[key] ?? key;
		//#endregion

		//#region Host HTTP 接口（同源 fetch；Connection fetch 路由，载体已做鉴权）
		async function postMove(sessionId, workspaceId) {
			const res = await fetch("/api/dsh-session-drag/move", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, workspaceId }),
			});
			const body = await res.json().catch(() => undefined);
			if (body?.ok === true) return body;
			if (body?.code === "session-active") throw new Error(t("active"));
			throw new Error(typeof body?.error === "string" && body.error.length > 0 ? body.error : `${t("openFail")} (${res.status})`);
		}
		//#endregion

		//#region 全局 toast（拖放路径不经过 React，直接走 DOM）
		const TOAST_HOLDS_MS = 4200;
		function showToast(message) {
			if (typeof document === "undefined") return;
			const host = document.getElementById("dshsd-toast-host") ?? (() => {
				const created = document.createElement("div");
				created.id = "dshsd-toast-host";
				created.className = "dshsd-toast-host";
				document.body.append(created);
				return created;
			})();
			const toast = document.createElement("div");
			toast.className = "dshsd-toast";
			toast.setAttribute("role", "status");
			toast.textContent = message;
			host.append(toast);
			setTimeout(() => {
				toast.classList.add("dshsd-toast-out");
				setTimeout(() => {
					toast.remove();
					if (host.childElementCount === 0) host.remove();
				}, 240);
			}, TOAST_HOLDS_MS);
		}
		//#endregion

		//#region 跨工作区拖放：document 捕获阶段的原生 DnD 控制器
		const WORKSPACE_KEY = "workspace:";
		const SESSION_KEY = "session:";
		const DROP_CLASS = "dshsd-drop-target";
		const DROP_BEFORE_CLASS = "dshsd-drop-before";
		const DROP_AFTER_CLASS = "dshsd-drop-after";
		/**
		 * 拖放中的会话；null = 没有会话拖动。
		 * sourceWorkspaceId 由 DOM 推导（会话行所在分组的工作区行）；顶层列表等
		 * 无分组的行记为 null，此时任何工作区都可作为落点。hoverRow/hoverMarker
		 * 记录当前悬停的落点行与插入侧，换行或离开时清除。
		 */
		let drag = null;

		function rowKeySuffix(element, prefix) {
			const key = element?.getAttribute?.("data-row-key");
			return typeof key === "string" && key.startsWith(prefix) ? key.slice(prefix.length) : null;
		}
		/**
		 * 从会话行向上找到它所属的分组区块：最近一个包含工作区行后代的祖先。
		 * 行与区块之间隔着 HoverCard 包裹 span，工作区行也不是区块的直接子
		 * 节点（分组区块必然只含自己的工作区行；再往上是包含全部分组的列表
		 * 容器，不会先命中）。Ungrouped 区块的行 key 是空的 `workspace:`。
		 * @param row - 会话行元素。
		 * @returns 分组区块元素，或 null（顶层列表等无分组场景）。
		 */
		function groupSection(row) {
			let node = row.parentElement;
			while (node !== null && node !== document.body) {
				if (typeof node.querySelector === "function" && node.querySelector(`[data-row-key^="${WORKSPACE_KEY}"]`) !== null) return node;
				node = node.parentElement;
			}
			return null;
		}
		/** 会话行所属分组的工作区 id；Ungrouped（空 key）与无分组返回 null。 */
		function groupWorkspaceId(row) {
			const section = groupSection(row);
			const head = section === null ? null : section.querySelector(`[data-row-key^="${WORKSPACE_KEY}"]`);
			if (head === null) return null;
			const id = rowKeySuffix(head, WORKSPACE_KEY);
			return id !== null && id.length > 0 ? id : null;
		}
		function workspaceRowFromEvent(event) {
			const target = event.target instanceof Element ? event.target : null;
			return target === null ? null : target.closest(`[data-row-key^="${WORKSPACE_KEY}"]`);
		}
		/**
		 * 标记当前悬停的落点；换行、换插入侧或离开时清掉旧的。工作区行用
		 * outline 高亮，会话行用上/下沿插线——原生的 before/after 标记只在
		 * 同组拖动时激活（行的 dragover 以 `active: sameGroupDrag && …` 为门，
		 * 跨组行上原生链路完全沉默），跨组的线由本插件绘制。
		 */
		function setHover(row, marker) {
			const previous = drag?.hoverRow ?? null;
			if (previous === row && (drag?.hoverMarker ?? undefined) === marker) return;
			previous?.classList.remove(DROP_CLASS, DROP_BEFORE_CLASS, DROP_AFTER_CLASS);
			if (drag !== null) {
				drag.hoverRow = row;
				drag.hoverMarker = marker;
			}
			if (row !== null) row.classList.add(marker === "before" ? DROP_BEFORE_CLASS : marker === "after" ? DROP_AFTER_CLASS : DROP_CLASS);
		}
		/**
		 * 解析当前悬停的合法落点。工作区行 → `{ workspaceId }`（置顶迁移，原生
		 * 无人接手的落点）；另一工作区组内的会话行 → `{ workspaceId, anchorId,
		 * after, sessionRow }`，迁移成功后把副本按悬停位置写进该组的手动排序
		 * （after 由鼠标在行的上/下半决定，与原生排序的 before/after 同语义；
		 * 原生的插入线只在同组拖动时激活，跨组的线由 setHover 绘制）。
		 * 同组会话行与 Ungrouped 行返回 null，原生排序链路原样接管。
		 */
		function dropTarget(event) {
			if (drag === null) return null;
			const target = event.target instanceof Element ? event.target : null;
			if (target === null) return null;
			const sessionRow = target.closest(`[data-row-key^="${SESSION_KEY}"]`);
			if (sessionRow !== null) {
				const workspaceId = groupWorkspaceId(sessionRow);
				if (workspaceId === null || workspaceId === drag.sourceWorkspaceId) return null;
				const anchorId = rowKeySuffix(sessionRow, SESSION_KEY);
				if (anchorId === null || anchorId.length === 0) return null;
				const rect = typeof sessionRow.getBoundingClientRect === "function" ? sessionRow.getBoundingClientRect() : null;
				return { workspaceId, anchorId, after: rect !== null && event.clientY >= rect.top + rect.height / 2, sessionRow };
			}
			const row = target.closest(`[data-row-key^="${WORKSPACE_KEY}"]`);
			if (row === null) return null;
			const id = rowKeySuffix(row, WORKSPACE_KEY);
			if (id === null || id.length === 0 || id === drag.sourceWorkspaceId) return null;
			return { workspaceId: id };
		}
		/**
		 * 把迁移成功的副本按拖放落点写进目标组的手动排序——与原生组内拖动同一
		 * 个视图存储（uiWorkspace.view.setSessionOrder，persist
		 * dsh.workspace.view.v5）。initialOrders 传空在两种排序模式下都安全：
		 * updated 模式该 map 本就是空，manual 模式 Object.assign 空对象不动其他
		 * 组的已存顺序。写入失败只损失落点，不影响已完成的迁移。
		 */
		function saveDropOrder(copyId, target) {
			try {
				const view = uiWorkspace === null ? undefined : uiWorkspace.view;
				if (typeof view?.setSessionOrder !== "function") return;
				const section = groupSection(target.sessionRow);
				if (section === null || typeof section.querySelectorAll !== "function") return;
				const ids = Array.from(section.querySelectorAll(`[data-row-key^="${SESSION_KEY}"]`), (row) => rowKeySuffix(row, SESSION_KEY)).filter((id) => id !== null && id.length > 0);
				const at = ids.indexOf(target.anchorId);
				if (at === -1) return;
				ids.splice(target.after === true ? at + 1 : at, 0, copyId);
				view.setSessionOrder(target.workspaceId, ids, {});
			} catch {
				// 视图存储面是未文档化内部 API，版本间可能变化：落点损失可接受
			}
		}
		async function performMove(sessionId, target) {
			try {
				const result = await postMove(sessionId, target.workspaceId);
				if (result.moved === false) {
					showToast(t("alreadyThere"));
					return;
				}
				showToast(t("moved"));
				if (target.anchorId !== undefined && typeof result.sessionId === "string") saveDropOrder(result.sessionId, target);
				// 新会话 id 的投影（标题等）客户端尚未拉取过，不补拉会显示成
				// "未命名"：先按 id 拉投影，再整体刷新列表。
				if (typeof sessionsService?.refreshProjections === "function" && typeof result.sessionId === "string") {
					await sessionsService.refreshProjections(result.sessionId).catch(() => {});
				}
				if (typeof sessionsService?.refresh === "function") {
					await sessionsService.refresh().catch(() => {});
				}
			} catch (error) {
				showToast(error instanceof Error ? error.message : String(error));
			}
		}
		function onDragStart(event) {
			const target = event.target instanceof Element ? event.target : null;
			const row = target === null ? null : target.closest(`[data-row-key^="${SESSION_KEY}"]`);
			if (row === null) return;
			const sessionId = rowKeySuffix(row, SESSION_KEY);
			if (sessionId === null || sessionId.length === 0) return;
			// 只接管会话拖动；工作区行的拖动（排序）不进这里，保持原生行为。
			drag = { sessionId, sourceWorkspaceId: groupWorkspaceId(row), hoverRow: null };
		}
		function onDragOver(event) {
			const target = dropTarget(event);
			if (target === null) {
				setHover(null);
				return;
			}
			// 捕获阶段放行 drop：原生 DnD 需要 dragover preventDefault 才允许落。
			// 不 stopPropagation——同组会话行的原生排序 dragover/drop 链路保持原样。
			event.preventDefault();
			if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = "move";
			if (target.sessionRow === undefined) setHover(workspaceRowFromEvent(event));
			else setHover(target.sessionRow, target.after === true ? "after" : "before");
		}
		function onDrop(event) {
			if (drag === null) return;
			const target = dropTarget(event);
			if (target === null) return;
			event.preventDefault();
			event.stopPropagation();
			const { sessionId } = drag;
			setHover(null);
			drag = null;
			void performMove(sessionId, target);
		}
		function onDragEnd() {
			setHover(null);
			drag = null;
		}
		//#endregion

		const DSHSD_STYLES = [
			".dshsd-drop-target{outline:1.5px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:-1.5px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
			".dshsd-drop-before{box-shadow:inset 0 2px 0 var(--dsw-alias-state-business-primary,#4c8dff)}",
			".dshsd-drop-after{box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary,#4c8dff)}",
			".dshsd-toast-host{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none}",
			".dshsd-toast{max-width:min(560px,80vw);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-tooltip,#2a2a2e);color:var(--dsw-alias-label-primary,#f5f5f5);font-size:12px;line-height:18px;padding:8px 14px;box-shadow:0 6px 24px rgba(0,0,0,.28);animation:dshsd-in .18s ease-out}",
			".dshsd-toast-out{opacity:0;transition:opacity .24s ease}",
			"@keyframes dshsd-in{from{opacity:0;transform:translateY(6px)}to{opacity:1}}",
		].join("\n");

		/** 客户端 sessions 服务；迁移成功后立即刷新会话列表，让新会话马上带标题出现。 */
		let sessionsService = null;
		/** 客户端 uiWorkspace 服务；其 view 是侧边栏视图存储的 actions，落点排序写这里。 */
		let uiWorkspace = null;

		const inject = ["sessions", "uiWorkspace"];

		function apply(ctx) {
			sessionsService = ctx.get("sessions") ?? null;
			uiWorkspace = ctx.get("uiWorkspace") ?? null;

			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-session-drag";
				style.textContent = DSHSD_STYLES;
				document.head.append(style);
				return () => {
					style.remove();
					document.getElementById("dshsd-toast-host")?.remove();
					setHover(null);
					drag = null;
				};
			}, "dsh-session-drag: styles");

			ctx.effect(() => {
				// 捕获阶段挂在 document：会话行的原生 dragover/drop 只在"同组同
				// pinned 状态"时激活，跨组拖动时整条链路无人 preventDefault，浏览器
				// 显示禁止落点 —— 这里在捕获阶段对合法目标放行，原生排序不受影响。
				const options = { capture: true };
				document.addEventListener("dragstart", onDragStart, options);
				document.addEventListener("dragover", onDragOver, options);
				document.addEventListener("drop", onDrop, options);
				document.addEventListener("dragend", onDragEnd, options);
				return () => {
					document.removeEventListener("dragstart", onDragStart, options);
					document.removeEventListener("dragover", onDragOver, options);
					document.removeEventListener("drop", onDrop, options);
					document.removeEventListener("dragend", onDragEnd, options);
				};
			}, "dsh-session-drag: drag controller");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
