window.__ModuleLoader__.load({
	id: "dsh-harness-switch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const SETTINGS_NS = "harness-base";

		// CSS replicated from model-selection's ModelSelect.module.css source
		// (github.com/deepseek-ai/deepseek-harness — packages/client/ui-model-selection/src/client/ModelSelect.module.css)
		// using our own class names. All visual properties reference --dsw-*
		// design tokens, which are the stable API.
		var style_el = "\n"+
".dsh-hs-root{position:relative;min-width:0;order:1}\n"+
".dsh-hs-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:min(360px,45cqw);height:28px;padding:0 4px 0 8px;border:none;border-radius:var(--dsw-radius-sm);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:400;cursor:pointer}\n"+
".dsh-hs-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}\n"+
".dsh-hs-trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}\n"+
".dsh-hs-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}\n"+
".dsh-hs-triggerLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n"+
".dsh-hs-triggerEffort{flex-shrink:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption)}\n"+
".dsh-hs-triggerIcon{display:var(--dsh-composer-model-icon-display,none);flex:0 0 auto}\n"+
".dsh-hs-triggerLabel,.dsh-hs-triggerEffort{display:var(--dsh-composer-model-text-display,block)}\n"+
".dsh-hs-chevron{flex:0 0 auto;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}\n"+
".dsh-hs-chevronOpen{transform:rotate(180deg)}\n"+
".dsh-hs-menu{position:fixed;z-index:1100;display:flex;flex-direction:column;width:max-content;min-width:min(240px,calc(100vw - 32px));max-width:min(420px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));overflow:hidden;padding:4px;border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}\n"+
".dsh-hs-option{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:auto;min-width:100%;min-height:34px;padding:5px 7px;border:none;border-radius:var(--dsw-radius-md);outline:none;background:transparent;color:inherit;text-align:left;cursor:pointer}\n"+
".dsh-hs-optionIcon{display:grid;place-items:center;flex:0 0 auto}\n"+
".dsh-hs-iconMark{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center}\n"+
".dsh-hs-iconMark svg{width:16px;height:16px;display:block}\n"+
".dsh-hs-option:focus-visible,.dsh-hs-optionActive:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}\n"+
".dsh-hs-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}\n"+
".dsh-hs-optionCopy{display:flex;flex:1;flex-direction:column;min-width:0}\n"+
".dsh-hs-modelName{overflow:hidden;color:inherit;font-size:13px;line-height:18px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}\n"+
".dsh-hs-check{display:grid;place-items:center;flex:0 0 14px;color:var(--dsw-alias-label-primary)}\n"+
".dsh-hs-check svg{width:14px;height:14px}\n"+
".dsh-hs-error{padding:4px 8px;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary)}\n";

		var MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };

		// Harness icons are registered either as a dsh client primitives icon
		// component name, or as inline SVG markup (a brand mark, `<svg …>` —
		// carries its own fills; CSS locks the rendered size). The native
		// ("" = DeepSeek Harness) row and any unknown/missing name render the
		// default think icon; a component name must actually resolve to a
		// component (the value comes from the registry, not from this bundle).
		var DEFAULT_ICON_NAME = "IconThinkOutlineRegular";
		function isComponent(value) {
			return typeof value === "function" || (value !== null && typeof value === "object" && value.$$typeof !== void 0);
		}
		function iconFor(name) {
			var component = typeof name === "string" ? primitives[name] : void 0;
			return isComponent(component) ? component : primitives[DEFAULT_ICON_NAME];
		}
		// Render one registered icon: SVG markup goes in verbatim (the adapter
		// owns the markup), a primitives name resolves to that component.
		function harnessIcon(name, className) {
			if (typeof name === "string" && name.trimStart().startsWith("<svg")) {
				return react.createElement("span", {
					key: "icon",
					className: "dsh-hs-iconMark" + (className ? " " + className : ""),
					dangerouslySetInnerHTML: { __html: name },
				});
			}
			return react.createElement(iconFor(name), { key: "icon", size: 16, className });
		}

		function useBaseSettings(ctx) {
			var form = ctx.configForms.get(SETTINGS_NS);
			var snapshot = react.useSyncExternalStore(
				function (cb) { return form.subscribe(cb); },
				function () { return form.getSnapshot(); }
			);
			return [snapshot, form];
		}

		function HarnessSwitch(props) {
			var sessionId = props.sessionId;
			var ctx = props.host.ctx;
			// Same seat rule as the model selector: subagent sessions get no
			// harness picker (their session id would pin a meaningless key).
			var available = ctx.sessions.subagentAddress(sessionId) === void 0;
			var hs = useBaseSettings(ctx);
			var snapshot = hs[0]; var form = hs[1];
			// Live selection from the session-log projection (the store); the
			// settings dict is only the switch transport and the pre-record
			// fallback.
			var face = react.useMemo(function () {
				if (sessionId == null) return void 0;
				return ctx.sessions.binding(sessionId)?.session?.projections?.faceOf("harness");
			}, [ctx, sessionId]);
			var live = react.useSyncExternalStore(
				function (cb) { return face ? face.subscribe(cb) : function () {}; },
				function () { return face ? face.getSnapshot() : void 0; },
				function () { return void 0; },
			);
			var liveHarness = live !== void 0 && live !== null && typeof live.harness === "string" ? live.harness : void 0;
			var menuId = react.useId();
			var openState = react.useState(false);
			var open = openState[0]; var setOpen = openState[1];
			var rootRef = react.useRef(null);
			var triggerRef = react.useRef(null);
			var menuRef = react.useRef(null);
			var savingRef = react.useRef(false);
			var menuPosState = react.useState(null);
			var menuPos = menuPosState[0]; var setMenuPos = menuPosState[1];
			var savingState = react.useState(false);
			var saving = savingState[0]; var setSaving = savingState[1];
			var selectionFocusState = react.useState(false);
			var selectionFocus = selectionFocusState[0]; var setSelectionFocus = selectionFocusState[1];
			// Roving highlight, mirrors ModelSelect's optionActive: it follows
			// hover (onMouseMove -> focus) and arrow keys, NOT the selected row.
			var highlightedState = react.useState(null);
			var highlighted = highlightedState[0]; var setHighlighted = highlightedState[1];
			var saveFailState = react.useState(null);
			var saveFail = saveFailState[0]; var setSaveFail = saveFailState[1];

			var ready = snapshot.status === "ready";
			var value = snapshot.value || {};
			var current = liveHarness ?? ((sessionId != null ? (value.harnessBySession || {})[sessionId] : void 0) ?? value.harness ?? "");
			var registered = value.harnesses || {};
			var icons = value.harnessIcons || {};
			var options = [{ id: "", title: "DeepSeek Harness" }];
			for (var hid in registered) options.push({ id: hid, title: registered[hid], icon: icons[hid] });
			var currentTitle = current === "" ? "DeepSeek Harness" : registered[current] || current;

			// Same placement pattern as ModelSelect.tsx: useLayoutEffect measures
			// the trigger, places the menu ABOVE it (right-aligned), clamps to
			// viewport, re-places on scroll/resize/menu-resize.
			react.useLayoutEffect(function () {
				if (!open) { setMenuPos(null); return; }
				var place = function () {
					var rect = triggerRef.current?.getBoundingClientRect();
					if (!rect) return;
					var MARGIN = 12;
					var lw = menuRef.current?.offsetWidth || 0;
					var lh = menuRef.current?.offsetHeight || 0;
					var x = rect.right - lw;
					var y = rect.top - 8 - lh;
					if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
					if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN);
					setMenuPos({ left: x, top: y });
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				var menu = menuRef.current;
				var ro = typeof ResizeObserver !== "undefined" && menu ? new ResizeObserver(place) : null;
				if (menu) ro.observe(menu);
				return function () {
					if (ro) ro.disconnect();
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
				};
			}, [open]);

			react.useEffect(function () {
				setOpen(false);
				setSaveFail(null);
				setSelectionFocus(false);
				setHighlighted(null);
			}, [sessionId]);
			react.useLayoutEffect(function () {
				if (!open) return;
				requestAnimationFrame(function () {
					(menuRef.current?.querySelector('[aria-checked="true"]:not([disabled])') ??
						menuRef.current?.querySelector("button:not([disabled])"))?.focus();
				});
			}, [open]);

			primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, menuRef);
			if (!available) return null;
			function save(next) {
				if (savingRef.current) return;
				// Same fail-loud contract as selectModel's requireModel: never
				// save an id the current registry does not serve (a stale mirror
				// between render and save would otherwise switch to nothing).
				if (next !== "" && registered[next] === void 0) {
					setSaveFail("该 harness 未注册（列表已过期，请重试）");
					return;
				}
				// Move the switching session AND the default future sessions
				// start from. Existing conversations are held in place by
				// harness-base: it stamps each session's harness on first sight,
				// so this default change cannot reach them.
				var ops = [{ op: "set", path: ["harness"], value: next }];
				if (sessionId != null) ops.push({ op: "set", path: ["harnessBySession", sessionId], value: next });
				savingRef.current = true;
				setSaving(true);
				setSelectionFocus(true);
				triggerRef.current?.focus();
				form.mutate(ops).then(function (accepted) {
					if (accepted) { setSaveFail(null); close(true); }
					else setSaveFail("保存被拒绝（配置已刷新，请重试）");
				}).catch(function (e) { setSaveFail(e?.message ?? String(e)); })
					.finally(function () { savingRef.current = false; setSaving(false); });
			}

			function close(restoreFocus) {
				setOpen(false);
				setSelectionFocus(false);
				setHighlighted(null);
				if (restoreFocus) queueMicrotask(function () { triggerRef.current?.focus(); });
			}

			return react.createElement(react.Fragment, null,
				react.createElement("style", { children: style_el }),
				react.createElement("div", {
					ref: rootRef,
					className: "dsh-hs-root",
					onBlur: function (event) {
						if (event.relatedTarget instanceof Node && (
							rootRef.current?.contains(event.relatedTarget) === true ||
							menuRef.current?.contains(event.relatedTarget) === true
						)) return;
						close(false);
					},
					onMouseDown: function (event) {
						if (event.target instanceof Element && event.target.closest("button") !== null) event.preventDefault();
					},
					onKeyDown: function (event) {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Escape" && open) {
							event.preventDefault();
							close(true);
							return;
						}
						if (!open) return;
						var items = menuRef.current ? Array.from(menuRef.current.querySelectorAll("button:not([disabled])")) : [];
						var activeIndex = items.indexOf(document.activeElement);
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							var nextIndex = activeIndex === -1 ? 0 : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
							items[nextIndex]?.focus();
							setHighlighted(nextIndex);
							return;
						}
						if (event.key === "Tab") {
							if (event.shiftKey) {
								event.preventDefault();
								close(true);
								return;
							}
							if (document.activeElement === triggerRef.current) {
								event.preventDefault();
								(items[0] ?? triggerRef.current)?.focus();
								return;
							}
							if (activeIndex !== -1) {
								event.preventDefault();
								items[activeIndex].click();
							}
						}
					},
				},
					react.createElement("button", {
						ref: triggerRef,
						type: "button",
						className: "dsh-hs-trigger",
						"aria-label": "Harness: " + currentTitle,
						"aria-haspopup": "menu",
						"aria-expanded": open,
						"aria-controls": open ? menuId : void 0,
						title: "Harness: " + currentTitle,
						"aria-busy": saving,
						"data-selection-focus": selectionFocus ? "" : void 0,
						disabled: !ready,
						onClick: function () {
							if (open) { close(true); return; }
							setSaveFail(null);
							setSelectionFocus(false);
							triggerRef.current?.focus();
							setOpen(true);
						},
						children: [
							// The trigger is the harness's face: it follows the live
							// selection, so switching harness swaps the logo.
							harnessIcon(current === "" ? void 0 : icons[current]),
							react.createElement(primitives.IconChevronDownOutlineRegular, {
								key: "chevron", className: open ? "dsh-hs-chevron dsh-hs-chevronOpen" : "dsh-hs-chevron",
							}),
						],
					}),
					open ? react_dom.createPortal(
						react.createElement(primitives.MenuSurface, {
							ref: menuRef,
							id: menuId,
							className: "dsh-hs-menu",
							style: menuPos || MEASURE_STYLE,
							role: "menu",
							"aria-label": "Harness",
							"aria-busy": saving,
							children: [
								saveFail ? react.createElement("div", { className: "dsh-hs-error", children: saveFail }) : null,
								options.map(function (option, idx) {
									var selected = current === option.id;
									return react.createElement("button", {
										key: option.id || "none", type: "button",
										role: "menuitemradio",
										className: "dsh-hs-option" + (idx === highlighted ? " dsh-hs-optionActive" : ""),
										"aria-checked": selected,
										disabled: !ready || saving,
										onMouseMove: idx === highlighted ? void 0 : function (event) {
											event.currentTarget.focus();
											setHighlighted(idx);
										},
										onClick: function () { current === option.id ? close(true) : save(option.id); },
										children: [
											harnessIcon(option.icon, "dsh-hs-optionIcon"),
											react.createElement("span", { className: "dsh-hs-optionCopy",
												children: react.createElement("span", { className: "dsh-hs-modelName", children: option.title }) }),
											react.createElement("span", { className: "dsh-hs-check",
												children: selected ? react.createElement(primitives.IconCheckOutlineRegular, null) : null }),
										],
									});
								}),
							],
						}),
						document.body
					) : null,
				),
			);
		}

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.slots.inject("conversation.input.right", function () {
					return ctx.slots.register({
						name: "conversation.input.right",
						id: "harness",
					}, function (props) {
						return react.createElement(HarnessSwitch, Object.assign({}, props, { host: { ctx: ctx } }));
					});
				});
			}, "dsh-harness-switch: harness switch");
		}

		var inject = ["slots", "configForms", "sessions"];
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
