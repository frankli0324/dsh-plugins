window.__ModuleLoader__.load({
	id: "dsh-mobile-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/mobile-layout-messages.ts
		const MOBILE_LAYOUT_MESSAGES = Object.freeze({
			en: Object.freeze({
				closePanels: "Close panels",
				workspaceNavigation: "Workspace and session navigation",
				backToConversation: "Back to conversation"
			}),
			zh: Object.freeze({
				closePanels: "关闭浮层",
				workspaceNavigation: "工作区与会话导航",
				backToConversation: "返回会话"
			})
		});
		//#endregion
		//#region src/mobile-layout.ts
		/** Whether an optional service value supports the public right-Sidebar controls. */
		function isSidebarRightControl(value) {
			if (typeof value !== "object" || value === null) return false;
			const candidate = value;
			return typeof candidate.isExpanded === "function" && typeof candidate.toggleExpanded === "function";
		}
		const RIGHTBAR_MIN_WIDTH_PX = 300;
		const RIGHTBAR_MAX_WIDTH_PX = 460;
		const RIGHTBAR_CENTER_MIN_WIDTH_PX = 400;
		const RIGHTBAR_DEFAULT_RATIO = .45;
		const SIDEBAR_EXPANDED_WIDTH_PX = 340;
		const SIDEBAR_COLLAPSED_WIDTH_PX = 56;
		/**
		* Viewport width at which the dedicated layout treats the sidebar as a
		* persistent desktop panel instead of an overlay drawer. Narrow screens
		* keep the overlay behavior byte-for-byte.
		*/
		function isWideViewportLayout(viewportWidth) {
			return viewportWidth >= 900;
		}
		/** Preserve a readable conversation width before turning a requested right track into a docked column. */
		function resolveMobileRightbarLayout(viewportWidth, sidebarOpen, track, fullscreen) {
			const wide = isWideViewportLayout(viewportWidth);
			const overlayWidth = wide ? Math.min(viewportWidth * .94, RIGHTBAR_MAX_WIDTH_PX) : viewportWidth;
			/* A fullscreen pane spans the whole window (official desktop semantics):
			   the stock panel renders 100vw wide, so the drawer must give it the full
			   viewport instead of clipping it to the narrow overlay width. */
			if (fullscreen) return Object.freeze({
				docked: false,
				width: viewportWidth
			});
			if (!track || !wide && sidebarOpen) return Object.freeze({
				docked: false,
				width: overlayWidth
			});
			const sidebarWidth = wide && sidebarOpen ? SIDEBAR_EXPANDED_WIDTH_PX : SIDEBAR_COLLAPSED_WIDTH_PX;
			const available = Math.floor(viewportWidth - sidebarWidth - RIGHTBAR_CENTER_MIN_WIDTH_PX);
			if (available < RIGHTBAR_MIN_WIDTH_PX) return Object.freeze({
				docked: false,
				width: overlayWidth
			});
			const preferred = Math.min(RIGHTBAR_MAX_WIDTH_PX, Math.max(RIGHTBAR_MIN_WIDTH_PX, Math.round(viewportWidth * RIGHTBAR_DEFAULT_RATIO)));
			return Object.freeze({
				docked: true,
				width: Math.min(preferred, available)
			});
		}
		/**
		* Query matching devices whose primary pointer cannot hover: the phones and
		* tablets where focusing an editor raises a soft keyboard the user did not ask
		* for. A desktop keeps stock behaviour because it has a real keyboard already.
		*/
		const TOUCH_PRIMARY_QUERY = "(hover: none), (pointer: coarse)";
		const elementTarget = (target) => target instanceof Element ? target : null;
		/** The stock composer wrapper, which owns everything the phone adapter edits. */
		const COMPOSER_CARD_SELECTOR = "[data-composer-card]";
		/** The composer's editing host, whichever contenteditable flavour it boots with. */
		const COMPOSER_EDITOR_SELECTOR = `${COMPOSER_CARD_SELECTOR} :is([contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""])`;
		/** The composer's Add trigger, whose menu must open without summoning the IME. */
		const COMPOSER_COMMAND_TRIGGER_SELECTOR = `${COMPOSER_CARD_SELECTOR} button[aria-haspopup="listbox"]`;
		/**
		* The host's session branch (fork) button. The host exposes no structural hook
		* for it — only localized `aria-label`/`title` text — so this stays coupled to
		* those strings in the languages the host UI ships (independent of the layout
		* language `resolveMobileLayoutLanguage` resolves). A host rebuild or a new
		* locale can silently drop the match; the only cure is a structural anchor in
		* the host DOM.
		*/
		const BRANCH_BUTTON_WORDS = ["分支", "branch", "ramo"];
		const BRANCH_BUTTON_SELECTOR = `button:is(${BRANCH_BUTTON_WORDS.flatMap((word) => [`[aria-label*="${word}" i]`, `[title*="${word}" i]`]).join(",")})`;
		/**
		* Whether a focus target belongs to the composer, which owns its own keyboard
		* decision and must never be blurred by a suppression window.
		* @param target - the focus target, already narrowed to an element.
		* @returns whether the target sits inside the composer card.
		*/
		function isComposerOwnedFocus(target) {
			return target !== null && target.closest(COMPOSER_CARD_SELECTOR) !== null;
		}
		/**
		* Whether a click opens a different Session, rather than its menu or current row.
		* @param target - the click target in the workspace sidebar.
		* @returns whether the Session selection can change.
		*/
		function isSessionRowNavigation(target) {
			if (target === null) return false;
			const row = target.closest("[role=\"treeitem\"][aria-selected]");
			if (row === null || row.getAttribute("aria-selected") === "true") return false;
			const action = target.closest("button,[role=\"button\"]");
			return action === null || action === row;
		}
		/**
		* Decide how one pointer event changes the composer's soft keyboard.
		*
		* The Add button's own mousedown calls `keepDraftFocus`, which focuses the draft
		* on purpose so the caret survives the menu; on a phone that focus is what
		* raises the keyboard. `inputmode="none"` withholds the IME without moving focus
		* or the caret, so the menu, the caret, and the draft all keep stock behaviour.
		* @param target - the pointer target, already narrowed to an element.
		* @param touchPrimary - whether the device's primary pointer cannot hover.
		* @returns `withhold` for the Add trigger, `restore` for any other tap, and
		* `ignore` where no soft keyboard exists to withhold.
		*/
		function resolveComposerImePolicy(target, touchPrimary) {
			if (!touchPrimary || target === null) return "ignore";
			return target.closest(COMPOSER_COMMAND_TRIGGER_SELECTOR) === null ? "restore" : "withhold";
		}
		/** The query deciding the wide layout — single source of truth for every JS read. */
		const WIDE_VIEWPORT_QUERY = "(min-width: 900px)";
		/** Reads the live viewport. */
		function viewportIsWide() {
			return window.matchMedia(WIDE_VIEWPORT_QUERY).matches;
		}
		/** Resolve the supported language used by the dedicated mobile layout. */
		function resolveMobileLayoutLanguage(documentLanguage, browserLanguageList) {
			return [documentLanguage, ...browserLanguageList].map((value) => value.trim().toLowerCase().split(/[-_]/u)[0]).find((value) => value === "en" || value === "zh") ?? "en";
		}
		/** The browser's preferred languages, fallback for layout-language resolution. */
		const browserLanguages = () => navigator.languages.length > 0 ? navigator.languages : [navigator.language];
		/** The layout language re-read from the live DOM. */
		const readLayoutLanguage = () => resolveMobileLayoutLanguage(document.documentElement.lang, browserLanguages());
		var MobileLayoutController = class {
			snapshot = Object.freeze({
				sidebarOpen: viewportIsWide(),
				detailsOpen: false,
				rightbarTrack: false,
				rightbarFullscreen: false,
				panelInfo: Object.freeze({ activePanelId: null }),
				language: readLayoutLanguage()
			});
			listeners = /* @__PURE__ */ new Set();
			hasMainPanel;
			languageObserver;
			navigation = new AbortController();
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			getSnapshot = () => this.snapshot;
			/**
			* The panel store on the layout service itself (`ctx.layout.panelInfo`),
			* mirroring the official LayoutController of DSH 0.1.7-rc.2+. The root hook
			* wired in `apply` feeds `usePanelInfo` rendering; rc.2 client plugins read
			* this service member directly. Without it `dsh-client-ui-plugin-manager`
			* fails activation on the dedicated mobile frontend ("web boot: 1 entry did
			* not activate") and `dsh-client-ui-open-in-app` throws the first time its
			* shortcut target runs.
			*/
			panelInfo = {
				getSnapshot: () => this.getSnapshot().panelInfo,
				subscribe: (listener) => this.subscribe(listener)
			};
			constructor() {
				this.languageObserver = new MutationObserver(() => {
					this.update({ language: readLayoutLanguage() });
				});
				this.languageObserver.observe(document.documentElement, {
					attributes: true,
					attributeFilter: ["lang"]
				});
			}
			toggleSidebar() {
				this.update({ sidebarOpen: !this.snapshot.sidebarOpen });
			}
			openSidebar() {
				this.update({ sidebarOpen: true });
			}
			closeDetails() {
				this.update({
					detailsOpen: false,
					rightbarTrack: false,
					rightbarFullscreen: false
				});
			}
			closeSidebar() {
				this.update({ sidebarOpen: false });
			}
			/**
			* Invalidate the previous navigation and hand back a fresh signal. The
			* workspace controller wraps this around "open a workspace" and "fork a
			* session" (dsh-client-ui-workspace) — the path behind the sidebar's
			* new-session button. Without it startSession throws inside a
			* `.catch(reason => console.warn('new session failed:', reason))`, so the
			* button silently did nothing.
			*/
			beginNavigation() {
				this.navigation.abort();
				this.navigation = new AbortController();
				return this.navigation.signal;
			}
			/** Invalidate pending navigations and observations when this layout unloads.
			    Each apply builds its own controller, so nothing here needs to survive. */
			dispose() {
				this.navigation.abort();
				this.languageObserver.disconnect();
			}
			/** Bind panel validation to the live slot registry owned by this application. */
			bindMainPanelRegistry(hasMainPanel) {
				this.hasMainPanel = hasMainPanel;
				return () => {
					if (this.hasMainPanel === hasMainPanel) this.hasMainPanel = void 0;
				};
			}
			/** Preserve the native seat's distinction between a docked track and fullscreen. */
			openRightbar(track = true, fullscreen = false) {
				this.update({
					detailsOpen: true,
					rightbarTrack: track,
					rightbarFullscreen: fullscreen
				});
			}
			/** Hide the right panel. */
			closeRightbar() {
				this.closeDetails();
			}
			/**
			* Select the main panel rendered in the center column; null means the
			* conversation. Mirrors the official LayoutController so the `panelInfo`
			* root hook stays truthful. Selecting a panel while the narrow overlay
			* drawer covers the center column dismisses that drawer — the user asked to
			* see the panel, not the navigation over it — while a docked wide sidebar
			* stays open.
			*/
			selectPanel(panelId) {
				if (panelId !== null && this.hasMainPanel?.(panelId) !== true) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
				this.navigation.abort();
				const dismissDrawer = this.snapshot.sidebarOpen && !viewportIsWide();
				const samePanel = this.snapshot.panelInfo.activePanelId === panelId;
				if (!dismissDrawer && samePanel) return;
				this.update({
					...dismissDrawer ? { sidebarOpen: false } : {},
					...samePanel ? {} : { panelInfo: Object.freeze({ activePanelId: panelId }) }
				});
			}
			/** Drop a selected panel once no main-slot entry declares it. */
			retainMainPanels(panelIds) {
				const active = this.snapshot.panelInfo.activePanelId;
				if (active !== null && !panelIds.includes(active)) this.update({ panelInfo: Object.freeze({ activePanelId: null }) });
			}
			update(next) {
				/* Untouched snapshot keys share the previous reference, so comparing
				   just the keys in next is the whole equality check. */
				if (Object.keys(next).every((key) => this.snapshot[key] === next[key])) return;
				this.snapshot = Object.freeze({ ...this.snapshot, ...next });
				for (const listener of this.listeners) listener();
			}
		};
		const FONT_SIZE_VARIABLES = { text: "--dsh-content-font-size", code: "--dsh-code-font-size", terminal: "--dsh-terminal-font-size" };
		const FONT_FAMILY_VARIABLES = { text: "--dsh-font-family-text", code: "--dsh-font-family-code", terminal: "--dsh-font-family-terminal" };
		var ThemePresenter = class {
			appliedTokens = [];
			meta = document.createElement("meta");
			constructor() {
				this.meta.name = "theme-color";
			}
			apply(snapshot) {
				const scheme = snapshot.active.colorScheme;
				document.documentElement.style.colorScheme = scheme;
				document.documentElement.setAttribute("data-ds-theme-source", snapshot.preference === "system" ? "system" : scheme);
				document.body.toggleAttribute("data-ds-dark-theme", scheme === "dark");
				for (const [role, name] of Object.entries(FONT_SIZE_VARIABLES)) document.body.style.setProperty(name, `${snapshot.fontSizes[role]}px`);
				for (const [kind, name] of Object.entries(FONT_FAMILY_VARIABLES)) {
					const list = snapshot.fontFamilies[kind];
					if (list === "") document.body.style.removeProperty(name);
					else document.body.style.setProperty(name, list);
				}
				for (const name of this.appliedTokens) document.body.style.removeProperty(name);
				this.appliedTokens = [];
				for (const [name, value] of Object.entries(snapshot.active.tokens)) {
					document.body.style.setProperty(name, value);
					this.appliedTokens.push(name);
				}
				/* The tokens live on body, and custom properties never inherit upward —
				   without this the html/canvas background resolves to the fallback in
				   both themes, so the status-column strip never matches the app. */
				const rootBackground = getComputedStyle(document.body).backgroundColor;
				document.documentElement.style.setProperty("--dsw-alias-bg-base", rootBackground);
				this.meta.content = rootBackground;
				if (!this.meta.isConnected) document.head.append(this.meta);
			}
			dispose() {
				document.documentElement.style.removeProperty("color-scheme");
				document.documentElement.style.removeProperty("--dsw-alias-bg-base");
				document.documentElement.removeAttribute("data-ds-theme-source");
				document.body.removeAttribute("data-ds-dark-theme");
				for (const name of [...Object.values(FONT_SIZE_VARIABLES), ...Object.values(FONT_FAMILY_VARIABLES)]) document.body.style.removeProperty(name);
				for (const name of this.appliedTokens) document.body.style.removeProperty(name);
				this.meta.remove();
			}
		};
		const MOBILE_LAYOUT_STYLES = `
/* --dshm-vh: standalone WebKit mis-sizes the dynamic viewport after a rotation
   (bug 254868); apply() pins the height chain to 100vh there, every other
   context falls back to the truthful 100% chain. text-size-adjust:100% stops
   iOS text autosizing from inflating body copy on iPad-class displays.
   --dshm-dur/--dshm-ease are the one open/close timing shared by the drawer,
   the details panel, and the scrim. */
:root{--dshm-dur:.3s;--dshm-ease:cubic-bezier(.32,.72,0,1)}
html,body,#root{width:100%;height:var(--dshm-vh,100%);overflow:hidden;background:var(--dsw-alias-bg-base,Canvas);-webkit-text-size-adjust:100%;text-size-adjust:100%}
/* contain:layout paint makes the shell the paint boundary (nothing bleeds into
   the status column) and the containing block for its position:fixed overlays. */
.dshm-shell{position:relative;contain:layout paint;display:grid;grid-template-rows:minmax(0,1fr) auto;box-sizing:border-box;width:100%;height:var(--dshm-vh,100%);min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base,Canvas);padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom) env(safe-area-inset-left)}
.dshm-shell .dshm-mainContent header{margin-right:env(safe-area-inset-right)}
.dshm-main{grid-area:1/1;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;transition:margin-right var(--ds-transition-duration-slow,190ms) var(--ds-ease-in-out,ease)}
.dshm-mainContent{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden}
/* shell.bottom seat (inspector page): auto row reserves no space while empty. */
.dshm-bottom{grid-area:2/1;min-height:0;overflow:hidden}
.dshm-shell[data-rightbar-docked=true] .dshm-main{margin-right:var(--dshm-rightbar-width)}
/* Absolute positioning resolves against the shell's padding box, so the docked
   panel must re-apply the insets the fixed drawer gets for free. */
.dshm-shell[data-rightbar-docked=true] .dshm-details{position:absolute;width:var(--dshm-rightbar-width);box-shadow:none;padding:0 env(safe-area-inset-right) 0 0;top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom)}
/* Draw above the native absolute panel without consuming its width or
   intercepting controls; only docked mode needs this column separator. */
.dshm-shell[data-rightbar-docked=true] .dshm-details::after{content:"";position:absolute;inset:0 auto 0 0;width:.5px;background:var(--dsw-alias-border-l4);z-index:11;pointer-events:none}
/* Fullscreen pane: the stock panel is 100vw wide, so the drawer spans the
   whole window (official desktop behavior) instead of clipping it. On narrow
   viewports the width equals the viewport and this is a no-op. */
.dshm-shell[data-rightbar-fullscreen=true] .dshm-details{width:var(--dshm-rightbar-width);box-shadow:none}
.dshm-main>*,.dshm-main>*>*{min-width:0}
/* Closed on a phone the navigation column leaves no rail: the frame is the
   whole viewport and the drawer lives entirely off the left edge. */
.dshm-drawer{position:fixed;z-index:70;inset:0 auto 0 0;box-sizing:border-box;width:min(88vw,340px);padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);overflow:hidden;background:var(--dsw-alias-bg-layer-1,#f8fafc);box-shadow:18px 0 46px rgb(15 23 42 / 18%);will-change:transform;transform:translateX(-101%);transition:transform var(--dshm-dur) var(--dshm-ease)}
.dshm-drawer[data-open=true]{transform:translateX(0)}
/* Hide only after the slide finishes, or the close is a frame-zero cut. */
.dshm-drawer[data-open=false]{pointer-events:none;visibility:hidden;transition:transform var(--dshm-dur) var(--dshm-ease),visibility 0s linear var(--dshm-dur)}
/* The finger holds the overlay: no transitions, and closed must not hide it. */
.dshm-drawer[data-dragging]{transition:none!important;visibility:visible;pointer-events:none!important}
.dshm-drawer>*{width:100%!important;height:100%!important}
/* display:none also suppresses fixed descendants installed by the phone adapter. */
.dshm-drawer[data-right-modal=true]{display:none!important}
.dshm-details{position:fixed;z-index:80;inset:0 0 0 auto;box-sizing:border-box;width:min(94vw,460px);padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) 0;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:-18px 0 46px rgb(15 23 42 / 18%);transform:translateX(104%);transition:transform var(--dshm-dur) var(--dshm-ease);will-change:transform}
.dshm-details[data-open=true]{transform:translateX(0)}
.dshm-details[data-open=false]{pointer-events:none;visibility:hidden;transition:transform var(--dshm-dur) var(--dshm-ease),visibility 0s linear var(--dshm-dur)}
.dshm-details[data-dragging]{transition:none!important;visibility:visible;pointer-events:none!important}
@media(max-width:899px){.dshm-details{width:100%;box-shadow:none}.dshm-details [data-sidebar-right-toggle],.dshm-details [data-sidebar-right-mode]{min-width:48px;min-height:48px}}
/* Full-width phone overlay: the back bar takes a flow row and the absolutely
   positioned stock panel starts below it (absolute offsets resolve against the
   padding box, so the drawer's own safe-area inset repeats into the offset). */
.dshm-details[data-navback=true] [data-sidebar-right-panel]{top:calc(56px + env(safe-area-inset-top))}
/* The dim follows the theme's mask token — the hardcoded slate was a
   light-theme aesthetic that reads wrong over the dark shell. */
.dshm-scrim{position:fixed;z-index:65;inset:0;border:0;touch-action:none;background:var(--dsw-alias-bg-mask-1,rgb(15 23 42 / 40%));opacity:0;pointer-events:none;transition:opacity var(--dshm-dur) var(--dshm-ease)}
.dshm-scrim[data-open=true]{opacity:1;pointer-events:auto}
.dshm-overlay{position:fixed;z-index:90;inset:0;pointer-events:none}.dshm-overlay>*{pointer-events:auto}
/* The session menu portals to body at z-index:1100 and must never lose to the
   drawers; an explicit opaque base keeps the popup readable if iPadOS WebKit
   drops its nested backdrop-filter material. */
body > [role="menu"]{background:var(--dsw-alias-bg-base,#171a21)}
/* Reserve navigation space instead of covering a panel's own save controls.
   The shell owns the safe-area insets, so this bar stays plain. */
.dshm-panelNav{display:flex;align-items:center;flex-shrink:0;min-height:56px;box-sizing:border-box;padding:4px 12px;border-bottom:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base,#fff)}
/* Self-contained button styling: the stock classes these once borrowed were
   CSS-module hashes (hHd-Xa_*) that a host rebuild regenerates. */
.dshm-panelBack,.dshm-shell .dshm-headerToggle{display:inline-flex;align-items:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#171a21);cursor:pointer}
.dshm-panelBack{gap:8px;min-width:48px;min-height:48px;box-sizing:border-box;padding:8px 12px;font:inherit;text-align:left}
.dshm-shell .dshm-headerToggle{justify-content:center;flex-shrink:0;width:36px;height:36px;padding:0}
.dshm-panelBack:hover,.dshm-shell .dshm-headerToggle:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dshm-panelBack:active,.dshm-shell .dshm-headerToggle:active{background:var(--dsw-alias-interactive-bg-active,#e9ecef)}
.dshm-panelBack:disabled{opacity:.5;cursor:default}
.dshm-panelBack:focus-visible,.dshm-shell .dshm-headerToggle:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#171a21);outline-offset:2px}
.dshm-panelBack svg{width:20px;height:20px;flex-shrink:0}
.dshm-shell header{min-width:0}
/* Mirror of the drawer's sidebar toggle; the persistent wide column keeps its own. */
@media(min-width:900px){.dshm-shell .dshm-headerToggle{display:none}}
/* Touch has no hover: the rows' hover-revealed action cluster would re-layout
   the row mid-tap and swallow the tap, so it stays display:none; a long-press
   or a right-click opens the row's menu instead, and while it is open the stock
   menuOpen reveal takes over (hiding the anchor mid-menu would fling the
   portaled menu to the viewport corner). The drawer also opts out of text
   selection — a long-press there means "menu". */
@media (hover: none), (pointer: coarse) {
.dshm-drawer [role="treeitem"]:not([class*="menuOpen"]) [class*="rowActions"]{display:none!important}
.dshm-drawer, .dshm-drawer *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.dshm-drawer input, .dshm-drawer textarea, .dshm-drawer [contenteditable]{-webkit-user-select:text;user-select:text}
/* While open, translateX(0) is identity — drop it with will-change so the open
   drawer stops being a promoted layer, which iPadOS WebKit painted above
   higher-z body-level popups (the session menu portals at z-index:1100). */
.dshm-drawer[data-open=true]{transform:none;will-change:auto}
}
.dshm-shell table{display:block;max-width:100%;overflow-x:auto}
.dshm-shell pre{max-width:100%;overflow-x:auto}
.dshm-shell img,.dshm-shell video,.dshm-shell canvas,.dshm-shell svg{max-width:100%}
.dshm-shell [class*="_body"]{max-width:100%;overflow-wrap:anywhere}
/* Settings modal (sidebar trigger / option+cmd+,): full-screen sheet whose nav
   rail becomes a horizontal chip row. The doubled attribute stays ahead of the
   lazily injected settings stylesheet; portals reach document.body, so nothing
   here scopes under .dshm-shell. */
@media(max-width:600px){
[data-shortcut-modal=settings][aria-modal=true]{flex-direction:column;width:100vw;height:100dvh;border-radius:0}
[data-shortcut-modal=settings]>nav{width:100%;flex:none;gap:8px;padding:max(10px,env(safe-area-inset-top)) 12px 6px}
[data-shortcut-modal=settings] [class*="navList"]{flex-direction:row;gap:6px;overflow-x:auto;overflow-y:hidden}
[data-shortcut-modal=settings] [class*="navList"]>button{flex:none;height:36px;padding:6px 12px}
[data-shortcut-modal=settings] [class*="options"]{padding:0 14px max(20px,env(safe-area-inset-bottom))}
[data-shortcut-modal=settings] [class*="header"]>[class*="close"]{width:44px;height:44px}
}
@media(min-width:900px){
.dshm-shell{grid-template-columns:auto minmax(0,1fr)}
.dshm-main{grid-area:1/2}
.dshm-drawer{position:static;grid-area:1/1;box-shadow:none;transform:none;padding-top:0;transition:width 200ms cubic-bezier(.22,1,.36,1)}
.dshm-drawer[data-open=true]{width:340px}
.dshm-drawer[data-open=false]{width:56px;visibility:visible;pointer-events:auto;transition:none}
}
@media(prefers-reduced-motion:reduce){.dshm-drawer,.dshm-details,.dshm-scrim,.dshm-main{transition:none!important}}
/* Folded laptop posture: folded/booked (the pre-rename spec value) + portrait —
   measured on the iPhone Duo, laptop pose keeps the viewport PORTRAIT, so the
   hinge is the viewport middle: chat above it, composer seat fixed into the
   lower half (contain:layout paint makes the shell its containing block, and
   !important beats the host's phase-scoped sticky/absolute rules; a vertical-
   hinge foldable half-folded upright would get this split too). Flat-open and
   non-foldable devices keep the stock single column. */
@media (device-posture: folded) and (orientation: portrait),
       (device-posture: booked) and (orientation: portrait) {
.dshm-shell{grid-template-rows:minmax(0,50%) minmax(0,1fr)}
.dshm-shell [data-composer-seat]{position:fixed!important;top:50%;right:0!important;bottom:auto!important;left:0!important;background:none}
}
`;

		/** DeepSeek-blue whale tab glyph; the stock favicons are a black (light) and white (dark) silhouette. */
		const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#4d6bfe" fill-rule="nonzero"/></svg>';
		/** Served by the plugin's server side (lib/index.mjs); iOS needs a real PNG URL, not a data URI. */
		const APPLE_TOUCH_ICON_PATH = "/apple-touch-icon.png";

		/** Overlays a finger is currently holding. */
		const sliding = /* @__PURE__ */ new WeakSet();
		/** Edge-band width in px that arms a drag. */
		const EDGE_ZONE_PX = 24;
		/** Horizontal travel (px) before the overlay starts following the finger. */
		const SWIPE_FOLLOW_PX = 6;
		/** Fraction of its own size past which a release settles on the dragged side. */
		const SWIPE_SETTLE_RATIO = .3;
		/** Release speed (px/ms) that decides the side regardless of distance. */
		const SWIPE_FLING_VELOCITY = .4;
		/** Settle transition, matching the open/close rules — visibility is part of
		    the inline list, or it would apply instantly and cut the slide-out short. */
		const SWIPE_SETTLE = "transform .3s cubic-bezier(.32,.72,0,1), visibility 0s linear .3s";
		/** Hold duration (ms) after which the press itself opens the row's action
		    menu — mid-hold, at the same mark Android fires its native
		    contextmenu. iOS fires no contextmenu for touch at all (WebKit bug
		    213953, still open in 2026), so there the timer is the trigger;
		    where contextmenu does fire, whichever lands first wins the dedup
		    in the row-menu effect. */
		const MENU_LONG_PRESS_MS = 500;
		/** Finger travel (px) that demotes a long-press hold into a scroll. */
		const MENU_LONG_PRESS_SLOP_PX = 10;

		/**
		* Current translateX of a sliding overlay in px, parsed from its computed
		* matrix — the settle animation's live position, so a re-grab mid-flight
		* starts from where the panel actually is.
		* @param element - the sliding overlay.
		* @returns translateX in px.
		*/
		function translateXOf(element) {
			const transform = getComputedStyle(element).transform;
			return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
		}

		function MobileAppFrame(props) {
			const state = (0, react.useSyncExternalStore)(props.controller.subscribe, props.controller.getSnapshot);
			const latest = (0, react.useRef)(state);
			latest.current = state;
			const suppressKeyboardUntil = (0, react.useRef)(0);
			const suppressComposerUntil = (0, react.useRef)(0);
			const previousPanelId = (0, react.useRef)(state.panelInfo.activePanelId);
			const drawerRef = (0, react.useRef)(null);
			const scrimRef = (0, react.useRef)(null);
			const detailsRef = (0, react.useRef)(null);
			/* True while a left-edge drag is pulling the closed drawer open: the slot
			   must render its expanded content, or the drag preview shows the compact
			   rail and the layout only snaps open on release. */
			const [sidebarDragOpening, setSidebarDragOpening] = (0, react.useState)(false);
			/* Composers whose inputmode this plugin withheld, with the value that was
			   there before — restore touches only these, never a "none" the host set
			   itself. Shared by the Add-trigger policy and drawer navigation. */
			const withheldIme = (0, react.useRef)(/* @__PURE__ */ new Map());
			const restoreWithheldIme = () => {
				for (const [editor, previous] of withheldIme.current) {
					if (editor.getAttribute("inputmode") !== "none") continue;
					if (previous === null) editor.removeAttribute("inputmode");
					else editor.setAttribute("inputmode", previous);
				}
				withheldIme.current.clear();
			};
			/* Withhold the IME on every composer editor, recording each previous
			   inputmode so the restore touches only values this plugin set — a
			   "none" the host configured itself must survive our policy. */
			const withholdComposerIme = () => {
				for (const editor of document.querySelectorAll(COMPOSER_EDITOR_SELECTOR)) {
					if (!withheldIme.current.has(editor)) withheldIme.current.set(editor, editor.getAttribute("inputmode"));
					editor.setAttribute("inputmode", "none");
				}
			};
			(0, react.useLayoutEffect)(() => {
				const previous = previousPanelId.current;
				previousPanelId.current = state.panelInfo.activePanelId;
				if (previous === null || state.panelInfo.activePanelId !== null || !window.matchMedia(TOUCH_PRIMARY_QUERY).matches) return;
				restoreWithheldIme();
				suppressComposerUntil.current = performance.now() + 500;
				const active = document.activeElement;
				if (active instanceof HTMLElement && active.matches(COMPOSER_EDITOR_SELECTOR)) active.blur();
			}, [state.panelInfo.activePanelId]);
			const [viewportWidth, setViewportWidth] = (0, react.useState)(window.innerWidth);
			(0, react.useEffect)(() => {
				// Set state directly on resize: an rAF defer left the rendered wide/narrow
				// answer one frame behind the live matchMedia the event handlers read.
				const sync = () => setViewportWidth(window.innerWidth);
				const media = window.matchMedia(WIDE_VIEWPORT_QUERY);
				const cleanup = new AbortController();
				window.addEventListener("resize", sync, { signal: cleanup.signal });
				media.addEventListener("change", sync, { signal: cleanup.signal });
				return () => cleanup.abort();
			}, []);
			const wideViewport = isWideViewportLayout(viewportWidth);
			const wideViewportRef = (0, react.useRef)(wideViewport);
			wideViewportRef.current = wideViewport;
			const rightbar = resolveMobileRightbarLayout(viewportWidth, state.sidebarOpen, state.rightbarTrack, state.rightbarFullscreen);
			const rightbarDocked = state.detailsOpen && rightbar.docked;
			const rightbarFullWidth = state.detailsOpen && !rightbarDocked && !wideViewport;
			const language = state.language;
			const messages = MOBILE_LAYOUT_MESSAGES[language];
			/* The drawer renders its expanded slot while open or being dragged open. */
			const drawerOpen = state.sidebarOpen || sidebarDragOpening;
			/* The details drawer as a covering overlay, versus a docked desktop column. */
			const detailsOverlay = state.detailsOpen && !rightbarDocked;
			/* Narrow viewports dim behind the open navigation drawer; the details
			   drawer dims whenever it covers the center column. */
			const scrimOpen = !rightbarFullWidth && (!wideViewport && state.sidebarOpen || detailsOverlay);
			const activeSessionId = props.useSessions((session) => {
				const current = session.current;
				return current !== void 0 && session.byId[current]?.blank === false ? current : void 0;
			});
			const hasSession = activeSessionId !== void 0;
			/* The gesture effect below runs once; event handlers read this live mirror
			   instead of the render-scoped hasSession. */
			const hasSessionRef = (0, react.useRef)(hasSession);
			hasSessionRef.current = hasSession;
			(0, react.useEffect)(() => {
				let gesture = null;
				let settleToken = 0;
				const controller = props.controller;
				const along = (g, x) => g.edge === "left" ? x - g.pressX : g.pressX - x;
				const place = (g, distance) => {
					g.distance = Math.min(g.width, Math.max(0, distance));
					const offset = g.edge === "left" ? g.distance - g.width : g.width - g.distance;
					g.element.style.transform = `translate3d(${offset}px,0,0)`;
					/* A close-drag runs with no scrim in play; only an open-drag's reveal is measured by the dim. */
					if (g.opens) scrimRef.current.style.opacity = String(g.distance / g.width);
				};
				/** Animate from the finger's position to the verdict; the CSS rule takes over once it agrees. */
				const settle = (g, verdict, token) => {
					const element = g.element;
					const scrim = scrimRef.current;
					const target = g.edge === "left" ? (verdict ? 0 : -g.width) : (verdict ? 0 : g.width);
					element.removeAttribute("data-dragging");
					element.style.transition = SWIPE_SETTLE;
					element.style.transform = `translate3d(${target}px,0,0)`;
					scrim.style.transition = `opacity .3s cubic-bezier(.32,.72,0,1)`;
					scrim.style.opacity = verdict ? "1" : "0";
					sliding.delete(element);
					if (g.edge === "left") verdict ? controller.openSidebar() : controller.closeSidebar();
					else verdict ? props.requestDetailsOpen() : props.requestDetailsClose();
					let done = false;
					const cleanup = () => {
						if (done || token !== settleToken) return;
						if ((element.getAttribute("data-open") === "true") !== verdict) {
							requestAnimationFrame(cleanup);
							return;
						}
						done = true;
						element.style.removeProperty("transition");
						element.style.removeProperty("transform");
						scrim.style.removeProperty("transition");
						scrim.style.removeProperty("opacity");
					};
					element.addEventListener("transitionend", (event) => {
						if (event.target === element && event.propertyName === "transform") cleanup();
					}, { once: true });
					setTimeout(cleanup, 450);
				};
				const onPointerDown = (event) => {
					const scrim = scrimRef.current;
					const drawer = drawerRef.current;
					const details = detailsRef.current;
					if (event.pointerType !== "touch" || scrim === null || drawer === null || details === null || wideViewportRef.current || gesture !== null) return;
					const { sidebarOpen, detailsOpen } = latest.current;
					let target = null;
					/* The open full-width overlay covers the scrim, so either edge band drags it closed. */
					if (detailsOpen && (event.clientX <= EDGE_ZONE_PX || event.clientX >= window.innerWidth - EDGE_ZONE_PX)) target = {
						element: details,
						edge: "right",
						opens: false
					};
					else if (sidebarOpen) {
						// A touch on the drawer itself selects rows; only a press on the scrim pushes it back.
						if (event.target === scrim) target = { element: drawer, edge: "left", opens: false };
					} else if (!detailsOpen) {
						/* The right drawer's occupant is session-scoped: with no Session, or
						   while a main panel replaces the conversation, the host renders
						   nothing there and its expand service has no surface to toggle —
						   so the swipe only arms when the panel can actually show content. */
						const rightbarOpenable = latest.current.panelInfo.activePanelId === null && hasSessionRef.current && props.hasRightbarContent();
						if (event.clientX <= EDGE_ZONE_PX) target = { element: drawer, edge: "left", opens: true };
						else if (rightbarOpenable && event.clientX >= window.innerWidth - EDGE_ZONE_PX) target = { element: details, edge: "right", opens: true };
					}
					if (target === null || sliding.has(target.element)) return;
					const width = target.element.getBoundingClientRect().width;
					if (!(width > 0)) return;
					/* Invalidate a settling animation's cleanup: a re-armed gesture must
					   not have its inline styles torn down mid-hold by the old settle. */
					settleToken += 1;
					gesture = {
						...target,
						width,
						pointerId: event.pointerId,
						pressX: event.clientX,
						pressY: event.clientY,
						/* The CSS rest position for a closed overlay is ∓101/104%, while
						   every distance baseline assumes ∓width — clamp so arming from a
						   fully closed state neither jumps nor eats the first 4% of travel. */
						start: Math.max(-width, Math.min(width, translateXOf(target.element))),
						distance: 0,
						velocity: 0,
						lastX: event.clientX,
						lastT: performance.now(),
						dragging: false,
						released: false
					};
				};
				const onPointerMove = (event) => {
					const g = gesture;
					if (g === null || g.released || event.pointerId !== g.pointerId) return;
					if (!g.dragging) {
						const dx = event.clientX - g.pressX;
						const dy = event.clientY - g.pressY;
						if (Math.abs(dx) < SWIPE_FOLLOW_PX || Math.abs(dy) > Math.abs(dx)) return;
						g.dragging = true;
						g.element.setAttribute("data-dragging", "");
						sliding.add(g.element);
						if (g.edge === "left" && g.opens) setSidebarDragOpening(true);
					}
					const now = performance.now();
					const x = along(g, event.clientX);
					const step = x - along(g, g.lastX);
					if (now > g.lastT) g.velocity = g.velocity * .6 + (step / (now - g.lastT)) * .4;
					g.lastX = event.clientX;
					g.lastT = now;
					/* g.start is the raw translateX (closed = ∓width); convert it to a 0..width
					   distance baseline so the panel follows the finger from either state. */
					place(g, (g.edge === "left" ? g.start + g.width : g.width - g.start) + x);
				};
				const finish = (event, cancelled) => {
					const g = gesture;
					if (g === null || g.released || cancelled && event !== null && event.pointerId !== g.pointerId) return;
					g.released = true;
					gesture = null;
					if (!g.dragging) return;
					if (g.edge === "left" && g.opens) setSidebarDragOpening(false);
					const token = ++settleToken;
					/* Settle on the dragged side: travel is measured toward the state the
					   drag is heading for — open for an open-drag, closed for a close-drag —
					   and a settle past the ratio flips the panel into that state. */
					const traveled = g.opens ? g.distance : g.width - g.distance;
					const verdict = cancelled ? !g.opens : g.velocity > SWIPE_FLING_VELOCITY ? true : g.velocity < -SWIPE_FLING_VELOCITY ? false : (traveled > g.width * SWIPE_SETTLE_RATIO) === g.opens;
					settle(g, verdict, token);
				};
				const onPointerUp = (event) => finish(event, false);
				const onPointerCancel = (event) => finish(event, true);
				/** Once the pan is clearly horizontal, take it from the browser so scrolling never cancels the drag. */
				const onTouchMove = (event) => {
					const g = gesture;
					if (g === null || g.released) return;
					const touch = event.touches[0];
					if (touch === void 0) return;
					if (!g.dragging) {
						const dx = touch.clientX - g.pressX;
						const dy = touch.clientY - g.pressY;
						if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_FOLLOW_PX) {
							gesture = null;
							return;
						}
						if (Math.abs(dx) < SWIPE_FOLLOW_PX) return;
					}
					event.preventDefault();
				};
				const cleanup = new AbortController();
				const { signal } = cleanup;
				document.addEventListener("pointerdown", onPointerDown, { capture: true, signal });
				document.addEventListener("pointermove", onPointerMove, { capture: true, signal });
				document.addEventListener("pointerup", onPointerUp, { capture: true, signal });
				document.addEventListener("pointercancel", onPointerCancel, { capture: true, signal });
				document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false, signal });
				return () => {
					cleanup.abort();
					settleToken += 1;
					setSidebarDragOpening(false);
				};
			}, [props.controller]);
			(0, react.useEffect)(() => {
				if (!hasSession) props.controller.closeDetails();
			}, [hasSession, props.controller]);
			const sessionTitle = props.useSessions((session) => session.current === void 0 ? void 0 : session.byId[session.current]?.title);
			(0, react.useEffect)(() => {
				const productTitle = document.title;
				if (sessionTitle !== void 0) document.title = `${sessionTitle} — ${productTitle}`;
				return () => {
					document.title = productTitle;
				};
			}, [sessionTitle]);
			(0, react.useEffect)(() => {
				const suppressAutofocus = (event) => {
					const target = elementTarget(event.target);
					if (target === null) return;
					if (!(target instanceof HTMLElement && (target.matches("input,textarea") || target.isContentEditable))) return;
					if (isComposerOwnedFocus(target)) {
						if (performance.now() < suppressComposerUntil.current) target.blur();
						return;
					}
					if (performance.now() >= suppressKeyboardUntil.current) return;
					target.blur();
				};
				const suppressBranchAutofocus = (event) => {
					if (!(event.target instanceof Element)) return;
					const branch = event.target.closest(BRANCH_BUTTON_SELECTOR);
					if (branch === null || branch.hasAttribute("disabled") || branch.getAttribute("aria-disabled") === "true") return;
					suppressKeyboardUntil.current = performance.now() + 700;
					window.setTimeout(() => {
						const active = document.activeElement;
						if (active instanceof HTMLElement && (active.matches("input,textarea") || active.isContentEditable)) active.blur();
					}, 0);
				};
				const applyComposerImePolicy = (event) => {
					const target = elementTarget(event.target);
					if (isComposerOwnedFocus(target)) {
						suppressComposerUntil.current = 0;
						restoreWithheldIme();
					}
					const policy = resolveComposerImePolicy(target, window.matchMedia(TOUCH_PRIMARY_QUERY).matches);
					if (policy === "ignore") return;
					if (policy === "withhold") withholdComposerIme();
					else restoreWithheldIme();
				};
				const cleanup = new AbortController();
				const { signal } = cleanup;
				document.addEventListener("focusin", suppressAutofocus, { capture: true, signal });
				document.addEventListener("click", suppressBranchAutofocus, { capture: true, signal });
				document.addEventListener("pointerdown", applyComposerImePolicy, { capture: true, signal });
				return () => {
					cleanup.abort();
					restoreWithheldIme();
				};
			}, []);
			(0, react.useEffect)(() => {
				let press = null;
				let suppressClickUntil = 0;
				/** The one "open this row's action menu" behavior; the touch
				    long-press and the desktop right-click are both just triggers. */
				const openRowMenu = (row) => {
					row.querySelector("[class*='rowActions'] button")?.click();
				};
				const onPointerDown = (event) => {
					if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
					if (!window.matchMedia(TOUCH_PRIMARY_QUERY).matches) return;
					if (!(event.target instanceof Element)) return;
					const row = event.target.closest("aside.dshm-drawer [role='treeitem']");
					if (row === null) return;
					const hold = { x: event.clientX, y: event.clientY, row, menuOpened: false, timer: 0 };
					hold.timer = window.setTimeout(() => {
						if (press !== hold || hold.menuOpened) return;
						hold.menuOpened = true;
						openRowMenu(hold.row);
					}, MENU_LONG_PRESS_MS);
					press = hold;
				};
				const onPointerMove = (event) => {
					const held = press;
					if (held === null) return;
					if (Math.abs(event.clientX - held.x) > MENU_LONG_PRESS_SLOP_PX || Math.abs(event.clientY - held.y) > MENU_LONG_PRESS_SLOP_PX) {
						window.clearTimeout(held.timer);
						press = null;
					}
				};
				/* The hold opened the menu mid-press; the release's synthetic click
				   would then navigate the row underneath, so that one click is
				   swallowed — it resets suppressClickUntil through onClick. A
				   release before the hold elapsed is just a tap and opens nothing. */
				const onPointerUp = () => {
					const held = press;
					press = null;
					if (held === null) return;
					window.clearTimeout(held.timer);
					if (!held.menuOpened) return;
					suppressClickUntil = performance.now() + 500;
					window.setTimeout(() => {
						/* The release click has been dispatched (or never came); let the user's next tap through. */
						suppressClickUntil = 0;
					}, 0);
				};
				const onPressCancel = () => {
					const held = press;
					press = null;
					if (held !== null) window.clearTimeout(held.timer);
				};
				const onClick = (event) => {
					if (performance.now() >= suppressClickUntil) return;
					event.stopPropagation();
					event.preventDefault();
					suppressClickUntil = 0;
				};
				const onContextMenu = (event) => {
					const row = event.target instanceof Element ? event.target.closest("aside.dshm-drawer [role='treeitem']") : null;
					if (row === null) return;
					event.preventDefault();
					/* Android's native mid-hold contextmenu races the hold timer;
					   whichever lands first opens and the other stands down, so the
					   menu never toggles twice. A mouse right-click — desktop, or
					   an iPad with a Bluetooth mouse (bug 213953, comment 3) — leaves
					   no hold record and always opens here. */
					if (press !== null && press.row === row && press.menuOpened) return;
					openRowMenu(row);
					if (press !== null && press.row === row) press.menuOpened = true;
				};
				const cleanup = new AbortController();
				const { signal } = cleanup;
				document.addEventListener("pointerdown", onPointerDown, { capture: true, signal });
				document.addEventListener("pointermove", onPointerMove, { capture: true, signal });
				document.addEventListener("pointerup", onPointerUp, { capture: true, signal });
				document.addEventListener("pointercancel", onPressCancel, { capture: true, signal });
				document.addEventListener("click", onClick, { capture: true, signal });
				document.addEventListener("contextmenu", onContextMenu, { capture: true, signal });
				return () => cleanup.abort();
			}, []);
			const closeDrawerAfterSessionAction = (event) => {
				if (!(event.target instanceof Element)) return;
				if (isSessionRowNavigation(event.target) && window.matchMedia(TOUCH_PRIMARY_QUERY).matches) {
					const deadline = performance.now() + 500;
					suppressComposerUntil.current = deadline;
					withholdComposerIme();
					if (document.activeElement instanceof HTMLElement && document.activeElement.matches(COMPOSER_EDITOR_SELECTOR)) document.activeElement.blur();
					window.setTimeout(() => {
						if (suppressComposerUntil.current !== deadline) return;
						suppressComposerUntil.current = 0;
						restoreWithheldIme();
					}, 500);
				}
				if (wideViewportRef.current) return;
				const row = event.target.closest("[role=\"treeitem\"][aria-selected]");
				const action = event.target.closest("button,[role=\"button\"]");
				const startsSession = action?.matches("button[class*=\"_newSession\"],button[class*=\"_brand\"]") || /新建会话|新会话|new session|new conversation|nuova sessione|nuova conversazione/i.test(action?.getAttribute("aria-label") ?? "");
				if (row === null && !startsSession) return;
				if (row !== null && action !== null && action !== row) return;
				suppressKeyboardUntil.current = performance.now() + 500;
				window.setTimeout(() => {
					props.controller.closeSidebar();
					const active = document.activeElement;
					if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur();
				}, 0);
			};
			return (0, react.createElement)("div", {
				className: "dshm-shell",
				lang: language,
				"data-rightbar-docked": rightbarDocked,
				/* Drives the full-window drawer CSS: a fullscreen pane must not sit
				   in the narrow overlay width (its panel is 100vw and would clip). */
				"data-rightbar-fullscreen": state.detailsOpen && state.rightbarFullscreen,
				style: { "--dshm-rightbar-width": `${rightbar.width}px` }
			}, (0, react.createElement)("main", {
				className: "dshm-main",
				...rightbarFullWidth ? {
					inert: "",
					"aria-hidden": true
				} : {}
			}, state.panelInfo.activePanelId !== null && !wideViewport ? (0, react.createElement)(PanelNav, {
				label: messages.backToConversation,
				disabled: state.sidebarOpen,
				onBack: () => {
					props.controller.selectPanel(null);
				}
			}) : null, (0, react.createElement)("div", { className: "dshm-mainContent" }, props.renderSlot("main", {}, {
				entryKey: state.panelInfo.activePanelId ?? "conversation"
			}))), (0, react.createElement)("div", {
				className: "dshm-bottom"
			}, props.renderSlot("shell.bottom", {})), (0, react.createElement)("button", {
				"aria-label": messages.closePanels,
				className: "dshm-scrim",
				ref: scrimRef,
				"data-open": scrimOpen,
				"aria-hidden": !scrimOpen,
				onClick: () => {
					if (!scrimOpen) return;
					state.detailsOpen ? props.requestDetailsClose() : props.controller.closeSidebar();
				},
				tabIndex: scrimOpen ? 0 : -1,
				type: "button"
			}), (0, react.createElement)("aside", {
				"aria-label": messages.workspaceNavigation,
				className: "dshm-drawer",
				ref: drawerRef,
				"data-open": state.sidebarOpen,
				"data-right-modal": detailsOverlay,
				...detailsOverlay ? {
					inert: "",
					"aria-hidden": true
				} : {},
				onClickCapture: closeDrawerAfterSessionAction
			}, props.renderSlot("sidebar", {
				collapsed: !drawerOpen,
				width: drawerOpen ? SIDEBAR_EXPANDED_WIDTH_PX : SIDEBAR_COLLAPSED_WIDTH_PX
			})), (0, react.createElement)("aside", {
				"aria-hidden": !state.detailsOpen,
				className: "dshm-details",
				"data-open": state.detailsOpen,
				/* The phone overlay has no scrim to tap and its stock chrome is the
				   tiny strip collapse glyph, so it carries the same back bar a main
				   panel gets; the stock panel starts below it (CSS [data-navback]). */
				"data-navback": rightbarFullWidth,
				ref: detailsRef,
				...state.detailsOpen ? {} : { inert: "" }
			}, rightbarFullWidth ? (0, react.createElement)(PanelNav, {
				label: messages.backToConversation,
				onBack: () => {
					props.requestDetailsClose();
				}
			}) : null, props.renderSlot("rightbar", {
				width: rightbar.width,
				viewportWidth,
				canShow: true
			})), (0, react.createElement)("div", {
				className: "dshm-overlay"
			}, props.renderSlot("shell.overlay", {})));
		}
		/** The back bar a full-screen surface gets on a phone; main panels and the
		    full-width right Sidebar overlay render the same one. */
		function PanelNav({ label, disabled, onBack }) {
			return (0, react.createElement)("div", { className: "dshm-panelNav" }, (0, react.createElement)("button", {
				type: "button",
				className: "dshm-panelBack",
				"aria-label": label,
				disabled,
				onClick: onBack
			}, (0, react.createElement)("svg", {
				"aria-hidden": true,
				viewBox: "0 0 24 24",
				fill: "none"
			}, (0, react.createElement)("path", {
				d: "M15 5l-7 7 7 7",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			})), (0, react.createElement)("span", null, label)));
		}
		/** The drawer logoRow's sidebar toggle, mirrored beside the conversation header crumbs. */
		function HeaderSidebarToggle({ controller }) {
			const language = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot).language;
			const messages = MOBILE_LAYOUT_MESSAGES[language];
			return (0, react.createElement)("button", {
				type: "button",
				className: "dshm-headerToggle",
				"aria-label": messages.workspaceNavigation,
				onClick: () => {
					controller.toggleSidebar();
				}
			}, (0, react.createElement)("svg", {
				"aria-hidden": true,
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				strokeWidth: 1
			}, (0, react.createElement)("path", {
				d: "M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z",
				stroke: "currentColor"
			}), (0, react.createElement)("path", {
				d: "M5.5 1.5V14.5",
				stroke: "currentColor"
			})));
		}
		/** Replace the desktop layout module on the authenticated mobile surface. */
		function apply(ctx) {
			/* client-hmr swaps a rebuilt bundle by tearing down the old fiber and
			   calling apply again on the living page (re-enabling the plugin does
			   the same). A second apply in one page's lifetime means the page is
			   no longer the boot state this layout assumes, so reload the whole
			   page instead of re-applying on top of it. The marker is set after
			   the check, so a fresh page load never reloads. */
			if (window.__dshMobileUiApplied === true) {
				window.location.reload();
				return;
			}
			window.__dshMobileUiApplied = true;
			// A fresh controller per apply: reusing a module-cached one leaked the dead
			// apply's snapshot (selected panel, drawer state) and navigation signal.
			const controller = new MobileLayoutController();
			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-mobile-ui";
				style.textContent = MOBILE_LAYOUT_STYLES;
				document.head.append(style);
				const viewport = document.querySelector('meta[name="viewport"]');
				const viewportContent = viewport?.getAttribute("content");
				if (viewport && viewportContent !== null && window.matchMedia(TOUCH_PRIMARY_QUERY).matches) {
					viewport.setAttribute("content", [
						...viewportContent.split(",").map((part) => part.trim()).filter(Boolean).filter((part) => !/^(?:maximum-scale|user-scalable|viewport-fit|interactive-widget)=/i.test(part)),
						"maximum-scale=1",
						"user-scalable=no",
						/* Full-bleed for the standalone home-screen app; env() insets in the shell keep content clear of the status bar and home indicator. */
						"viewport-fit=cover",
						/* Android Chrome 108+ defaults to resizes-visual: the keyboard overlays the
						   viewport and the browser pans the page to reveal the caret, sliding the
						   whole shell up. This makes the layout viewport shrink instead, so the
						   shell's 100% height follows the keyboard and the page never pans. iOS
						   ignores the key; the keyboard effect below covers it. */
						"interactive-widget=resizes-content"
					].join(", "));
				}
				const disposeMainPanelRegistry = controller.bindMainPanelRegistry((id) => ctx.slots.entries("main").some((entry) => entry.options.key === id));
				const disposeService = ctx.reflect.provide("layout", controller);
				const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: controller.panelInfo } });
				/** Close the details drawer from its scrim, collapsing the DSH 0.1.5 right
				    Sidebar first when that optional service owns the visible content. */
				const requestDetailsClose = () => {
					const sidebarRight = ctx.get("sidebarRight");
					if (isSidebarRightControl(sidebarRight) && sidebarRight.isExpanded()) sidebarRight.toggleExpanded();
					controller.closeDetails();
				};
				/** Open the details drawer from the right-edge swipe: the mirror of
				    requestDetailsClose. The swipe only flips the drawer; the panel
				    inside is the host right Sidebar, which draws nothing until its own
				    expanded flag is set — so expand it first or the drawer slides in
				    over a collapsed, blank panel. */
				const requestDetailsOpen = () => {
					const sidebarRight = ctx.get("sidebarRight");
					if (isSidebarRightControl(sidebarRight) && !sidebarRight.isExpanded()) sidebarRight.toggleExpanded();
					controller.openRightbar(false, false);
				};
				/** Whether the rightbar slot has an occupant at all; a surface without
				    the host right Sidebar plugin must not arm the edge swipe. */
				const hasRightbarContent = () => ctx.slots.entries("rightbar").length > 0;
				const disposeRoot = ctx.slots.register({
					name: "root",
					children: {
						sidebar: {
							kind: "single",
							scope: "root"
						},
						main: {
							kind: "keyed",
							scope: "root"
						},
						rightbar: {
							kind: "single",
							scope: "root"
						},
						"shell.overlay": {
							kind: "list",
							scope: "root"
						},
						/* shell.leading (desktop window chrome) intentionally absent on mobile */
						"shell.bottom": {
							kind: "single",
							scope: "root"
						}
					}
				}, (props) => (0, react.createElement)(MobileAppFrame, {
					...props,
					controller,
					requestDetailsClose,
					requestDetailsOpen,
					hasRightbarContent
				}));
				const retainMainPanels = () => {
					controller.retainMainPanels(ctx.slots.entries("main").flatMap((entry) => entry.options.key === void 0 ? [] : [entry.options.key]));
				};
				const disposePanels = ctx.slots.subscribe("main", retainMainPanels);
				retainMainPanels();
				return () => {
					controller.dispose();
					disposePanels();
					disposeRoot();
					disposePanelInfo();
					disposeService();
					disposeMainPanelRegistry();
					style.remove();
					if (viewport && viewportContent !== null) viewport.setAttribute("content", viewportContent);
				};
			}, "dsh-mobile: dedicated root layout");
			ctx.slots.inject("conversation.header.leading", () => ctx.slots.register({
				name: "conversation.header.leading",
				id: "dsh-mobile-sidebar-toggle"
			}, () => (0, react.createElement)(HeaderSidebarToggle, { controller })));
			ctx.effect(() => {
				const stockIcons = [...document.querySelectorAll('link[rel~="icon"]')];
				const favicon = document.createElement("link");
				favicon.rel = "icon";
				favicon.type = "image/svg+xml";
				favicon.href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;
				const touchIcon = document.createElement("link");
				touchIcon.rel = "apple-touch-icon";
				touchIcon.sizes = "180x180";
				touchIcon.href = APPLE_TOUCH_ICON_PATH;
				document.head.append(favicon, touchIcon);
				for (const link of stockIcons) link.remove();
				return () => {
					favicon.remove();
					touchIcon.remove();
					for (const link of stockIcons) document.head.append(link);
				};
			}, "dsh-mobile: brand icons");
			/* Standalone launch: viewport-fit=cover only goes full-bleed when the
			   status bar overlays the page, which the home-screen app does solely
			   with this legacy Apple meta (Safari needs none of it). */
			ctx.effect(() => {
				const statusBarStyle = document.createElement("meta");
				statusBarStyle.name = "apple-mobile-web-app-status-bar-style";
				statusBarStyle.content = "black-translucent";
				document.head.append(statusBarStyle);
				return () => statusBarStyle.remove();
			}, "dsh-mobile: standalone status bar");
			/* Standalone WebKit mis-sizes the dynamic viewport (WebKit bug 254868):
			   after a rotation it reports 867x587 for a 867x669 screen — the portrait
			   status-bar inset stays baked into every dvh/innerHeight reading. 100vh
			   is the large viewport and is unaffected, so pin the height chain to it
			   via --dshm-vh; the CSS fallback (100%) keeps Safari and desktop on the
			   truthful percentage chain. */
			ctx.effect(() => {
				if (navigator.standalone !== true) return;
				document.documentElement.style.setProperty("--dshm-vh", "100vh");
				return () => document.documentElement.style.removeProperty("--dshm-vh");
			}, "dsh-mobile: standalone viewport height");
			/* iOS keyboard: ship the browser's own behavior — it animates the page
			   and the composer up together and lands the composer above the keys —
			   and only repair its known regression. On iOS 26/27 the visual
			   viewport does not fully restore after dismissal (offsetTop can stay
			   panned, height stays smaller than the layout viewport), leaving the
			   whole page shifted up after the keyboard closes — the original
			   "整页上移" report (developer.apple.com/forums/thread/800125,
			   confirmed back on iOS 27 in that thread). The repair is a single
			   plain scrollTop reset once the keyboard is gone (WebKit bug 254861
			   comment 3); it runs only when no editable holds focus and is a no-op
			   whenever the scrollers are already at rest.
			   Deliberately NOT done here, after four rounds of device reports:
			   height-pinning the shell/document while the keyboard is up. WebKit
			   computes its reveal pan from pre-focus geometry and applies it after
			   our reflow, so a speculative pin pushed the composer to the top of
			   the screen on the first open, and any scroll correction issued
			   mid-animation compounded the displacement instead of cancelling it
			   (iOS 27 carries the pan on the visual viewport, out of reach of
			   window.scrollTo). Android needs none of this: the viewport meta's
			   interactive-widget=resizes-content (the viewport effect) gives the
			   anchored, composer-above-keyboard behavior declaratively, and Safari
			   will inherit it whenever it ships that directive (implemented in
			   WebKit, bug 259770, unshipped as of iOS 27). */
			ctx.effect(() => {
				const viewport = window.visualViewport;
				if (!viewport) return;
				const editableFocused = () => {
					const active = document.activeElement;
					return active instanceof HTMLElement && (active.matches("input,textarea") || active.isContentEditable);
				};
				/* Post-dismissal normalization: forcing the scrollers back to zero
				   makes WebKit drop the leftover visual-viewport offset. Plain
				   scrollTop writes only — scroll-based corrections while the
				   keyboard animates are themselves scrolls and compound the pan. */
				const resetScroll = () => {
					document.documentElement.scrollTop = 0;
					document.body.scrollTop = 0;
				};
				let correctionTimer = 0;
				/* WebKit fires the resize event before visualViewport.height settles
				   (bug 254861 comment 4) — judge "keyboard gone" one frame later. */
				let resizeFrame = 0;
				const onViewportResize = () => {
					if (resizeFrame !== 0 || !window.matchMedia(TOUCH_PRIMARY_QUERY).matches) return;
					resizeFrame = window.requestAnimationFrame(() => {
						resizeFrame = 0;
						if (!editableFocused()) resetScroll();
					});
				};
				const onFocusOut = () => {
					window.clearTimeout(correctionTimer);
					correctionTimer = window.setTimeout(() => {
						if (!editableFocused()) resetScroll();
					}, 250);
				};
				viewport.addEventListener("resize", onViewportResize);
				document.addEventListener("focusout", onFocusOut, true);
				return () => {
					viewport.removeEventListener("resize", onViewportResize);
					document.removeEventListener("focusout", onFocusOut, true);
					window.clearTimeout(correctionTimer);
					window.cancelAnimationFrame(resizeFrame);
				};
			}, "dsh-mobile: keyboard dismissal viewport reset");
			ctx.effect(() => {
				const presenter = new ThemePresenter();
				presenter.apply(ctx.theme.getTheme());
				const off = ctx.on("theme/change", (snapshot) => {
					presenter.apply(snapshot);
				});
				return () => {
					off();
					presenter.dispose();
				};
			}, "dsh-mobile: theme presenter");
		}
		/** Preserve the official layout module's dependency ordering. */
		const inject = ["slots", "theme"];
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
