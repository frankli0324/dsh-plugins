window.__ModuleLoader__.load({
	id: "dsh-harness-claude",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const SETTINGS_NS = "harness-claude";
		const FIELD_LABELS = {
			command: "Claude 路径",
			effort: "Effort（留空不传 --effort）",
			permissionMode: "权限模式",
		};
		const FIELD_KEYS = ["command", "effort", "permissionMode"];

		// The harness-claude namespace's shared configForms face: one describe mirror
		// reader, one write queue with revision fencing — the same transport the
		// dsh settings pages use.
		function useClaudeSettings(ctx, ns = SETTINGS_NS) {
			const form = ctx.configForms.get(ns);
			const [snapshot, setSnapshot] = react.useState(() => form.getSnapshot());
			react.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);
			return [snapshot, form];
		}

		function claudeSaveOps(current) {
			return FIELD_KEYS.map((key) => {
				const next = current[key].trim();
				return next
					? { op: "set", path: [key], value: next }
					: { op: "unset", path: [key] };
			});
		}

		function ClaudeSettingsSection(props) {
			const { ctx } = props;
			const [snapshot, form] = useClaudeSettings(ctx);
			const [draft, setDraft] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			react.useEffect(() => { setDraft(null); }, [snapshot.value]);
			const ready = snapshot.status === "ready";
			const value = snapshot.value ?? {};
			const current = draft ?? {
				command: value.command ?? "claude",
				effort: value.effort ?? "",
				permissionMode: value.permissionMode ?? "bypassPermissions",
			};
			const dirty = draft !== null;
			const update = (key, next) => setDraft({ ...current, [key]: next });
			const save = async () => {
				setBusy(true);
				setStatus(null);
				try {
					const accepted = await form.mutate(claudeSaveOps(current));
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
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 2px" } },
				ready ? null : react.createElement("p", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "设置分区 harness-claude 不可用（插件可能未启用）"),
				react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
					field("command", "claude"),
					field("effort", "low | medium | high | xhigh | max"),
					field("permissionMode", "bypassPermissions")),
				react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					react.createElement("button", {
						disabled: busy || !ready || !dirty,
						onClick: save,
						style: { borderRadius: "var(--dsw-radius-md)", height: 32, padding: "0 14px", font: "inherit", fontSize: 13, cursor: "pointer", border: "none", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" },
					}, busy ? "保存中…" : "应用"),
					status ? react.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, status) : null));
		}

		function ClaudeProviderCard(props) {
			const { host } = props;
			const [snapshot, form] = useClaudeSettings(host.ctx);
			const [draft, setDraft] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			react.useEffect(() => { setDraft(null); }, [snapshot.value]);
			const ready = snapshot.status === "ready";
			const value = snapshot.value ?? {};
			const current = draft ?? {
				command: value.command ?? "claude",
				effort: value.effort ?? "",
				permissionMode: value.permissionMode ?? "bypassPermissions",
			};
			const dirty = draft !== null;
			const update = (key, next) => setDraft({ ...current, [key]: next });
			const save = async () => {
				setBusy(true);
				setStatus(null);
				try {
					const accepted = await form.mutate(claudeSaveOps(current));
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
				ready ? null : react.createElement("p", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "设置分区 harness-claude 不可用（插件可能未启用）"),
				react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
					field("command", "claude"),
					field("effort", "low | medium | high | xhigh | max"),
					field("permissionMode", "bypassPermissions")),
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

		// Legacy fallback: earlier adapter builds persisted claude's raw
		// Edit/Write/MultiEdit input ({file_path,…}) under the apply_patch
		// name, with no description and without meta.diffs. Recover just the
		// file name so those rows still identify the change; the diff itself
		// is not expandable because that meta was never persisted.
		function legacyPatchPath(block) {
			const call = block.kind === "tool-result" ? block.call : block;
			if (!call?.argsRaw) return "";
			try {
				const args = JSON.parse(call.argsRaw);
				const found = typeof args?.file_path === "string" ? args.file_path
					: typeof args?.notebook_path === "string" ? args.notebook_path : "";
				return found;
			} catch {
				return "";
			}
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

		const APPLY_PATCH_CLASS = "dsh-harness-claude-apply-patch";
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
			const diffs = patchDiffs(props.block);
			const path = patchPath(diffs);
			const expandable = diffs.length > 0;
			const running = props.phase !== "result";
			const totals = expandable ? primitives.diffTotals(diffs) : null;
			// claude streams the tool arguments as partial JSON: the row is
			// mounted with just its name while args are still unparseable.
			// Returning null here would hide the whole edit for that window
			// (seconds for a large Write), so render the running row with an
			// empty summary instead. Legacy rows fall back to their raw
			// file_path so they still name the changed file.
			const summary = path ?? args?.description ?? legacyPatchPath(props.block);
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

		// The apply_patch toolview seat is contended: dsh-harness-codex registers
		// the same key at priority -1. Keyed slots resolve lowest priority
		// first and refuse exact duplicates, so this plugin stays at the
		// default priority — codex receipts render through the codex row, and
		// this identical entry is the fallback when codex is absent. The rows
		// are data-compatible (both render the adapter's meta.diffs), so
		// either entry draws the other's receipts correctly.
		function injectApplyPatchToolview(ctx) {
			ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "apply_patch",
				locale: "conversation",
			}, NativePatchRow)), "harness-claude: apply patch tool view");
		}

		function apply(ctx) {
			injectApplyPatchToolview(ctx);
			ctx.effect(() => ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: SETTINGS_NS,
			}, (props) => react.createElement(ClaudeProviderCard, { ...props, host: { ctx } }))), "harness-claude: models provider card");
			// The plugin's own settings page: registered only while the Host
			// serves the harness-claude namespace, so a composition without this
			// plugin's server half shows no trace of it.
			ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "claude",
				order: 41,
				label: "Claude",
			}, (props) => react.createElement(ClaudeSettingsSection, { ...props, ctx })))), "harness-claude: settings section");
		}
		// configForms (from @deepseek-ai/dsh-client-ui-settings) is the only
		// settings transport this plugin uses: the shared describe mirror and
		// revision-fenced write queue own the remote.settings round-trip.
		const inject = ["slots", "configForms"];

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
