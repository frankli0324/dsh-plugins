window.__ModuleLoader__.load({
	id: "dsh-harness-codex",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const SETTINGS_NS = "harness-codex";
		const FIELD_LABELS = {
			command: "Codex 路径",
			socketPath: "Unix Socket 路径（留空按 Codex Home 与 command 名派生）",
			codexHome: "Codex Home（留空用进程环境，默认 ~/.codex）",
		};
		const FIELD_PLACEHOLDERS = {
			command: "codex",
			codexHome: "自动：进程环境，默认 ~/.codex",
			socketPath: "自动：<Codex Home>/app-server-control/<command>.sock",
		};
		const FIELD_KEYS = ["command", "codexHome", "socketPath"];

		// The harness-codex namespace's shared configForms face: one describe mirror
		// reader, one write queue with revision fencing — the same transport the
		// dsh settings pages use.
		function useCodexSettings(ctx) {
			const form = ctx.configForms.get(SETTINGS_NS);
			const [snapshot, setSnapshot] = react.useState(() => form.getSnapshot());
			react.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);
			return [snapshot, form];
		}

		function codexSectionFields(current, update, disabled) {
			return FIELD_KEYS.map((key) => react.createElement("label", { key, style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
				react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, FIELD_LABELS[key]),
				react.createElement("input", {
					value: current[key],
					placeholder: FIELD_PLACEHOLDERS[key],
					disabled,
					onChange: (event) => update(key, event.target.value),
					style: { border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "var(--dsw-radius-md)", height: 32, padding: "0 10px", font: "inherit", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)" },
				})));
		}

		function codexSaveOps(current) {
			return FIELD_KEYS.map((key) => {
				const next = current[key].trim();
				return next
					? { op: "set", path: [key], value: next }
					: { op: "unset", path: [key] };
			});
		}

		function CodexSettingsSection(props) {
			const { ctx } = props;
			const [snapshot, form] = useCodexSettings(ctx);
			const [draft, setDraft] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			react.useEffect(() => { setDraft(null); }, [snapshot.value]);
			const ready = snapshot.status === "ready";
			const value = snapshot.value ?? {};
			const current = draft ?? {
				command: value.command ?? "codex",
				codexHome: value.codexHome ?? "",
				socketPath: value.socketPath ?? "",
			};
			const dirty = draft !== null;
			const update = (key, next) => setDraft({ ...current, [key]: next });
			const save = async () => {
				setBusy(true);
				setStatus(null);
				try {
					const accepted = await form.mutate(codexSaveOps(current));
					if (accepted) {
						setDraft(null);
						setStatus("已保存");
					} else {
						setStatus("保存被拒绝（配置已刷新，请重试）");
					}
				} catch (error) {
					setStatus(error.message);
				} finally {
					setBusy(false);
				}
			};
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 2px" } },
				react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
					codexSectionFields(current, update, busy || !ready)),
				react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					react.createElement("button", {
						disabled: busy || !ready || !dirty,
						onClick: save,
						style: { borderRadius: "var(--dsw-radius-md)", height: 32, padding: "0 14px", font: "inherit", fontSize: 13, cursor: "pointer", border: "none", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" },
					}, busy ? "保存中…" : "应用"),
					status ? react.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, status) : null));
		}

		function CodexProviderCard(props) {
			const { host } = props;
			const [snapshot, form] = useCodexSettings(host.ctx);
			const [draft, setDraft] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			react.useEffect(() => { setDraft(null); }, [snapshot.value]);
			const ready = snapshot.status === "ready";
			const value = snapshot.value ?? {};
			const current = draft ?? {
				command: value.command ?? "codex",
				socketPath: value.socketPath ?? "",
				codexHome: value.codexHome ?? "",
			};
			const dirty = draft !== null;
			const update = (key, value) => setDraft({ ...current, [key]: value });
			const save = async () => {
				setBusy(true);
				setStatus(null);
				try {
					const accepted = await form.mutate(codexSaveOps(current));
					if (accepted) {
						setDraft(null);
						setStatus("已保存");
					} else {
						setStatus("保存被拒绝（配置已刷新，请重试）");
					}
				} catch (error) {
					setStatus(error.message);
				} finally {
					setBusy(false);
				}
			};
			const field = (key, placeholder) => react.createElement("label", { key, style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
				react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, FIELD_LABELS[key]),
				react.createElement("input", {
					value: current[key],
					placeholder,
					disabled: busy || !ready,
					onChange: (event) => update(key, event.target.value),
					style: { border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "var(--dsw-radius-md)", height: 32, padding: "0 10px", font: "inherit", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)" },
				}));
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10, marginTop: 8 } },
				ready ? null : react.createElement("p", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "设置分区 harness-codex 不可用（插件可能未启用）"),
				react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
					field("command", "codex"),
					field("codexHome", "自动：进程环境，默认 ~/.codex"),
					field("socketPath", "自动：<Codex Home>/app-server-control/<command>.sock")),
				react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					react.createElement("button", {
						disabled: busy || !ready || !dirty,
						onClick: save,
						style: { borderRadius: "var(--dsw-radius-md)", height: 32, padding: "0 14px", font: "inherit", fontSize: 13, cursor: "pointer", border: "none", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" },
					}, busy ? "保存中…" : "应用"),
					status ? react.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, status) : null));
		}

		function patchArgs(block) {
			const call = block.kind === "tool-result" ? block.call : block;
			if (!call?.argsRaw) return null;
			try {
				const args = JSON.parse(call.argsRaw);
				return typeof args.description === "string" ? args : null;
			} catch {
				return null;
			}
		}

		function patchDiffs(block) {
			// Matches the adapter receipt's meta: [{path, oldText, newText}] — the
			// shape dsh's native DiffBlock re-diffs and renders with +/− coloring.
			if (block.kind !== "tool-result" || !Array.isArray(block.meta?.diffs)) return [];
			return block.meta.diffs.filter((diff) => typeof diff?.path === "string"
				&& (diff?.oldText === null || typeof diff?.oldText === "string")
				&& typeof diff?.newText === "string");
		}

		function patchPath(diffs) {
			const paths = [...new Set(diffs.map((diff) => diff.path).filter(Boolean))];
			if (paths.length <= 1) return paths[0] ?? "";
			if (paths.length <= 3) return paths.join("、");
			return `${paths.slice(0, 3).join("、")} 等 ${paths.length} 个文件`;
		}

		function codeToolbarLabels(t) {
			return {
				codeLabel: t("codeBlock.title"),
				wrapLabel: t("codeBlock.wrap"),
				unwrapLabel: t("codeBlock.unwrap"),
			};
		}

		function diffLabels(t) {
			return {
				...codeToolbarLabels(t),
				copy: t("copy"),
				copied: t("copied"),
				collapseAria: t("diff.collapseAria"),
				expandAria: (count) => t("diff.expandAria", { count }),
				collapse: t("collapse"),
				expand: (count) => t("diff.expandRest", { count }),
			};
		}

		const APPLY_PATCH_CLASS = "dsh-harness-codex-apply-patch";
		const APPLY_PATCH_STYLE = `
.${APPLY_PATCH_CLASS}{flex-direction:column;display:flex}
.${APPLY_PATCH_CLASS}__row{font-weight:400}
.${APPLY_PATCH_CLASS}__title{font-weight:400}
.${APPLY_PATCH_CLASS}__sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.${APPLY_PATCH_CLASS}__summary{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${APPLY_PATCH_CLASS}__summarySuffix{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none;margin-left:4px;white-space:nowrap}
.${APPLY_PATCH_CLASS}__diffStat{font-family:var(--ds-font-family-code);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);margin-left:10px;transform:translateY(.5px)}
.${APPLY_PATCH_CLASS}__row:is(:hover,[aria-expanded=true]) .${APPLY_PATCH_CLASS}__added{color:var(--dsw-alias-state-success-primary)}
.${APPLY_PATCH_CLASS}__row:is(:hover,[aria-expanded=true]) .${APPLY_PATCH_CLASS}__removed{color:var(--dsw-alias-state-error-primary)}
.${APPLY_PATCH_CLASS}__body{flex-direction:column;display:flex}
.${APPLY_PATCH_CLASS}__diff{margin:4px 0 4px 4px}
`;

		const NativePatchRow = react.memo(function NativePatchRow(props) {
			const args = patchArgs(props.block);
			if (!args) return null;
			const diffs = patchDiffs(props.block);
			const path = patchPath(diffs);
			const expandable = diffs.length > 0;
			const running = props.phase !== "result";
			const totals = expandable ? primitives.diffTotals(diffs) : null;
			const summary = path ?? args.description;
			const { expanded, toggle } = props.useDisclosure();
			const open = expanded && expandable;
			return react.createElement(react.Fragment, null,
				react.createElement("style", null, APPLY_PATCH_STYLE),
				react.createElement("div", {
					className: APPLY_PATCH_CLASS,
					"data-tool": props.toolName,
					"data-state": running ? "running" : "ok",
				}, react.createElement(primitives.DisclosureRow, {
					className: APPLY_PATCH_CLASS,
					rowClassName: `${APPLY_PATCH_CLASS}__row`,
					titleClassName: `${APPLY_PATCH_CLASS}__title`,
					icon: react.createElement(primitives.IconEditOutlineRegular, { size: 14 }),
					title: props.t("tool.title.edit"),
					running,
					open,
					expandable,
					expandOnRowClick: true,
					keepContentWhenOpen: true,
					onToggle: toggle,
					collapsedContent: react.createElement(react.Fragment, null,
						react.createElement("span", { className: `${APPLY_PATCH_CLASS}__sep`, "data-shimmer-decoration": true, "aria-hidden": true }),
						react.createElement("span", { className: `${APPLY_PATCH_CLASS}__summary` },
							react.createElement(primitives.TextShimmer, null, summary),
						),
							totals ? react.createElement(primitives.TextShimmer, {
							className: `${APPLY_PATCH_CLASS}__summarySuffix ${APPLY_PATCH_CLASS}__diffStat`,
						},
							react.createElement("span", { className: `${APPLY_PATCH_CLASS}__added` }, `+${totals.added}`),
							" ",
							react.createElement("span", { className: `${APPLY_PATCH_CLASS}__removed` }, `-${totals.removed}`),
						) : null,
					),
				}, open ? react.createElement("div", { className: `${APPLY_PATCH_CLASS}__body` },
					react.createElement(primitives.DiffBlock, {
						className: `${APPLY_PATCH_CLASS}__diff`,
						diffs,
						labels: diffLabels(props.t),
						maxLines: 9,
					}),
				) : null)),
			);
		});


		// The apply_patch toolview seat is contended: dsh-harness-claude registers
		// the same key at the default priority. Keyed slots resolve lowest
		// priority first and refuse exact duplicates, so this plugin takes a
		// lower priority — codex receipts render through the codex row, and
		// claude's identical entry stays as the fallback when this plugin is
		// absent. The rows are data-compatible (both render the adapter's
		// meta.diffs), so either entry draws the other's receipts correctly.
		function injectApplyPatchToolview(ctx) {
			ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "apply_patch",
				priority: -1,
				locale: "conversation",
			}, NativePatchRow)), "harness-codex: apply patch tool view");
		}

		function apply(ctx) {
			injectApplyPatchToolview(ctx);
			ctx.effect(() => ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: SETTINGS_NS,
			}, (props) => react.createElement(CodexProviderCard, { ...props, host: { ctx } }))), "harness-codex: models provider card");
			// The plugin's own settings page: registered only while the Host
			// serves the harness-codex namespace (the standard whileServed contract),
			// so a composition without the Host plugin shows no trace of it.
			ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "codex",
				order: 40,
				label: "Codex",
			}, (props) => react.createElement(CodexSettingsSection, { ...props, ctx })))), "harness-codex: settings section");
		}
		// configForms (from @deepseek-ai/dsh-client-ui-settings) is the only
		// settings transport this plugin uses: the shared describe mirror and
		// revision-fenced write queue own the remote.settings round-trip.
		// modelDirectories/uiSession were declared historically but never used
		// by any component — dropped.
		const inject = ["slots", "configForms"];

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
