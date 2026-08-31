/**
 * `/piflux view` — read-only viewer for the active workflow's artifacts
 * and state: two sequential TUI screens (a selector in the editor slot,
 * then the selected item in a full-screen overlay pager), same idiom as the
 * `/piflux settings` overlay.
 *
 * The content screen is a self-contained pager (own `scrollTop` + a
 * viewport-sized slice of the rendered lines, like pi's own Editor) because
 * pi-tui's `ScrollView` only scrolls when the layout engine calls
 * `updateLayout()` on it — a layout descent that never reaches extension
 * components (editor slot, overlay compositing, or widgets) — so its
 * `scrollBy()` would clamp to 0 and keyboard scrolling would be dead. The
 * pager also parses raw SGR/legacy wheel sequences itself: only a focused
 * overlay in fullscreen mode receives those; in regular mode the wheel
 * scrolls native terminal scrollback (terminal-level constraint).
 *
 * This module is deliberately NOT a standalone extension: it exports only a
 * deps-injected factory (`createWorkflowViewer`) plus pure helpers, and the
 * package manifest pins `pi.extensions` to `["./extensions/index.ts"]`, so
 * this file can never be auto-discovered or loaded on its own. It exists
 * solely as the `/piflux` subcommand wired up in index.ts.
 *
 * Read-only everywhere: no writes to the state file, settings file,
 * artifacts, or git; no state-machine changes; no session creation or
 * switching — safe to run while the agent is processing. Artifact content is
 * snapshotted once when the content screen opens; reopen to refresh. The
 * selector items are re-read on every visit, so mtimes refresh and newly
 * written artifacts appear.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { DynamicBorder, stripFrontmatter, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
// The no-import-from-index.ts constraint holds: shared path helpers come
// from paths.ts, which both index.ts and this module import.
import { artifactPath } from "./paths.ts";

export { artifactPath };

/**
 * Structural view of the workflow state — duck-typed against index.ts's
 * `WorkflowState` (deps injection keeps this module free of a circular
 * import back into index.ts).
 */
export interface ViewerState {
	step: string;
	branch: string;
	sessions: Partial<Record<string, string>>;
}

export interface WorkflowViewerDeps {
	/** Reads the workflow state file; null = no (or corrupt) active workflow. */
	readState: (cwd: string, ctx?: ExtensionContext) => ViewerState | null;
	/** Valid next commands per step (index.ts's NEXT_COMMANDS). */
	nextCommands: Record<string, string[]>;
}

const ARTIFACT_STEPS = ["start", "plan", "code", "review"] as const;

/**
 * The five direct-view targets, in selector order: `state` plus the four
 * artifacts. Exported so index.ts (arg parsing) and the unit tests share
 * one source of truth with the content screen.
 */
export const VIEW_TARGETS = ["state", ...ARTIFACT_STEPS] as const;
export type ViewTarget = (typeof VIEW_TARGETS)[number];

/** Type guard for the direct-view target tokens accepted after `/piflux view`. */
export function isViewTarget(token: string): token is ViewTarget {
	return (VIEW_TARGETS as readonly string[]).includes(token);
}

// ------------------------------------------------------------------
// Pure helpers (module-level, exported — unit-testable)
// ------------------------------------------------------------------

/**
 * Selector sentinel for an artifact that does not exist on disk yet.
 * Shared by `buildSelectorItems` (writes it) and `viewArgumentCompletions`
 * (drops rows carrying it) so the coupling is explicit — a future change
 * to one side cannot silently diverge from the other.
 */
const MISSING_DESCRIPTION = "missing";

/**
 * Relative mtime for the selector descriptions: "just now" under a minute,
 * then "Nm ago" / "Nh ago" / "Nd ago". A future mtime (clock skew) counts
 * as "just now".
 */
export function formatRelativeTime(mtimeMs: number, nowMs: number): string {
	const diff = nowMs - mtimeMs;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

export interface SelectorItem {
	value: string;
	label: string;
	description: string;
}

/**
 * The five selector rows: `state` first (description shows the current
 * step), then the four artifacts with a relative mtime or "missing".
 * Missing artifacts stay listed — visibility mid-workflow is the point
 * (e.g. the plan hasn't been written yet).
 */
export function buildSelectorItems(state: ViewerState, cwd: string, nowMs: number = Date.now()): SelectorItem[] {
	const items: SelectorItem[] = [{ value: "state", label: "state", description: `step: ${state.step}` }];
	for (const step of ARTIFACT_STEPS) {
		let description = MISSING_DESCRIPTION;
		try {
			description = `modified ${formatRelativeTime(statSync(artifactPath(cwd, state.branch, step)).mtimeMs, nowMs)}`;
		} catch {
			// ENOENT (or any stat failure) → the artifact is missing
		}
		items.push({ value: step, label: step, description });
	}
	return items;
}

/**
 * Second-token completions for `/piflux view <TAB>`. Returns items whose
 * `value` is the FULL argument text (`view plan`), because pi's argument
 * autocomplete replaces the entire argument text — a bare `plan` value
 * would clobber the `view ` prefix (see pi-tui's `applyCompletion`). Only
 * targets that exist on disk are suggested: `state` is always listed when
 * a workflow is active, "missing" artifact rows are dropped.
 *
 * Returns null when the argument text is not a view invocation (the
 * caller falls back to first-token completion) or when there is no active
 * workflow — never throws, so it is safe on every keystroke.
 */
export function viewArgumentCompletions(
	argumentText: string,
	state: ViewerState | null,
	cwd: string,
	nowMs: number = Date.now(),
): Array<{ value: string; label: string; description: string }> | null {
	if (argumentText !== "view" && !argumentText.startsWith("view ")) return null;
	if (!state) return null;
	const targetPrefix = argumentText.slice("view ".length);
	return buildSelectorItems(state, cwd, nowMs)
		.filter((item) => item.description !== MISSING_DESCRIPTION)
		.filter((item) => item.value.startsWith(targetPrefix))
		.map((item) => ({ value: `view ${item.value}`, label: item.value, description: item.description }));
}

/**
 * The `state` content: current step, branch, valid next commands, and a
 * session table (step → session file path, with exists/missing on disk).
 * Markdown-flavored — the content screen renders it in a Markdown component.
 */
export function renderStateSummary(state: ViewerState, nextCommands: Record<string, string[]>, cwd: string): string {
	const lines = ["## State", "", `- Step: **${state.step}**`, `- Branch: **${state.branch}**`];
	const next = nextCommands[state.step] ?? [];
	lines.push(`- Next: ${next.length > 0 ? next.map((c) => `\`${c}\``).join(", ") : "—"}`);
	lines.push("", "## Sessions", "");
	const sessionSteps = Object.keys(state.sessions);
	if (sessionSteps.length === 0) {
		lines.push("- None recorded yet.");
	} else {
		for (const step of sessionSteps) {
			const session = state.sessions[step];
			if (!session) continue;
			lines.push(`- ${step}: \`${session}\` — ${existsSync(session) ? "exists" : "missing"}`);
		}
	}
	return lines.join("\n") + "\n";
}

/**
 * Clamp a scroll position to the valid range for the given content and
 * viewport heights. Returns 0 when the content fits (or the content is
 * empty); viewport heights are clamped to ≥ 1 line so degenerate sizes
 * cannot produce an unbounded range.
 */
export function clampScrollTop(scrollTop: number, contentHeight: number, viewportHeight: number): number {
	const view = Math.max(1, viewportHeight);
	const maxScroll = Math.max(0, contentHeight - view);
	return Math.max(0, Math.min(scrollTop, maxScroll));
}

/**
 * A scroll action from `keyToScrollDelta`: a signed line delta, or the
 * sentinels `"home"` / `"end"` for jumps to the top / bottom.
 */
export type ScrollTarget = number | "home" | "end";

/**
 * Map a raw input event to a scroll action for the content pager: a signed
 * line delta (↑/↓/j/k, page up/down), the sentinels `"home"` / `"end"` for
 * jumps, or null when the event is not a scroll key. Page scroll is the
 * viewport minus one overlap line (keeps context between pages), minimum 1.
 * j/k go through `matchesKey` so kitty-protocol CSI-u encodings match too.
 */
export function keyToScrollDelta(data: string, viewportHeight: number): ScrollTarget | null {
	if (matchesKey(data, Key.up) || matchesKey(data, "k")) return -1;
	if (matchesKey(data, Key.down) || matchesKey(data, "j")) return 1;
	if (matchesKey(data, Key.pageUp)) return -Math.max(1, viewportHeight - 1);
	if (matchesKey(data, Key.pageDown)) return Math.max(1, viewportHeight - 1);
	if (matchesKey(data, Key.home)) return "home";
	if (matchesKey(data, Key.end)) return "end";
	return null;
}

export interface WheelEvent {
	/** -1 = wheel up, 1 = wheel down. */
	direction: -1 | 1;
	/** 0-based column of the pointer. */
	x: number;
	/** 0-based row of the pointer. */
	y: number;
}

/**
 * Parse a terminal mouse-wheel sequence: SGR (`ESC [ < b ; x ; y M/m`) and
 * legacy X10 (`ESC [ M` + 3 bytes) encodings. Returns null for non-wheel
 * sequences (button presses, drags, horizontal wheels, releases). Mirrors
 * pi-tui's own wheel parser so fullscreen overlays can scroll themselves.
 */
export function parseWheelEvent(data: string): WheelEvent | null {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1], 10);
		if ((button & 64) === 0) return null; // not a wheel button
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return null; // horizontal wheel
		return {
			direction: direction === 0 ? -1 : 1,
			x: Number.parseInt(sgr[2], 10) - 1,
			y: Number.parseInt(sgr[3], 10) - 1,
		};
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return null;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return null;
		return {
			direction: direction === 0 ? -1 : 1,
			x: data.charCodeAt(4) - 33,
			y: data.charCodeAt(5) - 33,
		};
	}
	return null;
}

/**
 * Scroll percentage for the hint line: 0–100 rounded, or null when the
 * content fits in the viewport (no scrolling possible). Callers pass a
 * clamped scrollTop (see `clampScrollTop`).
 */
export function scrollPercent(scrollTop: number, contentHeight: number, viewportHeight: number): number | null {
	const maxScroll = contentHeight - viewportHeight;
	if (maxScroll <= 0) return null;
	return Math.round((scrollTop / maxScroll) * 100);
}

// ------------------------------------------------------------------
// Viewer screens (TUI-only — manual verification)
// ------------------------------------------------------------------

/** Uniform margin (rows and columns) around the full-screen overlay window. */
const OVERLAY_MARGIN = 1;
/**
 * Rows consumed by the overlay chrome around the pager's content slice:
 * top/bottom margins plus top border, title, hint, and bottom border.
 */
const OVERLAY_CHROME = 2 * OVERLAY_MARGIN + 4;
/** Lines scrolled per mouse-wheel notch (SGR/legacy wheel events) in fullscreen mode. */
const WHEEL_SCROLL_LINES = 3;

/**
 * The deps-injected factory. Returns the async `/piflux view` handler:
 * guards mode/state, then runs the sequential screen loop (selector →
 * content → back), re-reading the selector items each time the selector is
 * built. Esc on the selector closes the viewer; the content screen always
 * returns to the selector.
 */
export function createWorkflowViewer(deps: WorkflowViewerDeps): (ctx: ExtensionCommandContext, target?: ViewTarget) => Promise<void> {
	return async (ctx: ExtensionCommandContext, target?: ViewTarget): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/piflux view is only available in the interactive TUI.", "error");
			return;
		}
		const state = deps.readState(ctx.cwd, ctx);
		if (!state) {
			ctx.ui.notify("No active workflow — nothing to view.", "info");
			return;
		}

		// Direct view: open the content screen immediately and close the
		// viewer when it is dismissed — no selector, no two-level exit. A
		// missing artifact warns and the notify-and-return ends the viewer.
		if (target) {
			await contentScreen(ctx, state, target, "close");
			return;
		}

		while (true) {
			const selected = await selectorScreen(ctx, state);
			if (!selected) return; // Esc on the selector closes the viewer
			await contentScreen(ctx, state, selected, "back");
		}
	};

	function selectorScreen(ctx: ExtensionCommandContext, state: ViewerState): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`Workflow view — ${state.branch}`)), 1, 0));

			const list = new SelectList(buildSelectorItems(state, ctx.cwd), ARTIFACT_STEPS.length + 1, selectListTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(new Text(theme.fg("dim", "enter: view · esc: close"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	function contentScreen(ctx: ExtensionCommandContext, state: ViewerState, selected: string, escHint: "back" | "close"): Promise<void> {
		let content: string;
		if (selected === "state") {
			content = renderStateSummary(state, deps.nextCommands, ctx.cwd);
		} else {
			const path = artifactPath(ctx.cwd, state.branch, selected);
			if (!existsSync(path)) {
				// Missing artifacts stay listed; selecting one warns and
				// returns to the selector.
				ctx.ui.notify(`No ${selected} artifact yet for branch "${state.branch}".`, "warning");
				return Promise.resolve();
			}
			// Snapshot semantics: read once when the screen opens. Artifacts
			// may carry frontmatter — strip it if present.
			content = stripFrontmatter(readFileSync(path, "utf-8"));
		}

		// Full-screen overlay window: DynamicBorder frame + accent title + the
		// pager's content slice + dim hint (with scroll percentage when the
		// content overflows). The overlay is what makes wheel events receivable
		// in fullscreen mode (focused overlay gets raw SGR/legacy wheel
		// sequences); regular mode scrolls native scrollback, unchanged.
		return ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const markdown = new Markdown(content, 1, 0, markdownTheme(theme));
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const title = new Text(theme.fg("accent", theme.bold(`${selected} — ${state.branch}`)), 1, 0);
				const hint = new Text("", 1, 0);

				// Self-managed pager state — the supported idiom on this rendering
				// path (pi's Editor does the same): own scrollTop + a viewport-sized
				// slice of the rendered lines. No ScrollView: its updateLayout() is
				// only ever called by the layout engine, which never reaches
				// extension components, so it cannot scroll here.
				let scrollTop = 0;
				let viewportHeight = Math.max(1, tui.terminal.rows - OVERLAY_CHROME);
				let cachedWidth = -1;
				let cachedLines: string[] = [];
				let contentHeight = 0;

				return {
					render: (width: number) => {
						// Viewport tracks the live terminal size; scrollTop is re-clamped
						// every render so a shrink-while-scrolled (or a width change that
						// re-wraps the markdown) can never leave the pager out of range.
						viewportHeight = Math.max(1, tui.terminal.rows - OVERLAY_CHROME);
						if (width !== cachedWidth) {
							cachedLines = markdown.render(width);
							cachedWidth = width;
							contentHeight = cachedLines.length;
						}
						scrollTop = clampScrollTop(scrollTop, contentHeight, viewportHeight);

						const percent = scrollPercent(scrollTop, contentHeight, viewportHeight);
						hint.setText(`arrows/pgup/pgdn/home/end/j/k: scroll · esc: ${escHint}${percent === null ? "" : ` · ${percent}%`}`);

						const lines: string[] = [...border.render(width), ...title.render(width)];
						const slice = cachedLines.slice(scrollTop, scrollTop + viewportHeight);
						for (let i = 0; i < viewportHeight; i++) lines.push(slice[i] ?? " ".repeat(width));
						lines.push(...hint.render(width), ...border.render(width));
						return lines;
					},
					invalidate: () => {
						cachedWidth = -1;
						markdown.invalidate();
						border.invalidate();
						title.invalidate();
						hint.invalidate();
					},
					handleInput: (data: string) => {
						if (matchesKey(data, Key.escape)) {
							done(); // back to the selector, or close the viewer in direct mode
							return;
						}
						const wheel = parseWheelEvent(data);
						if (wheel) {
							// Wheel sequences only reach a focused overlay in fullscreen
							// mode; regular mode cannot intercept the wheel at all.
							if (tui.mode !== "fullscreen") return;
							scrollTop += wheel.direction * WHEEL_SCROLL_LINES;
							tui.requestRender();
							return;
						}
						const target = keyToScrollDelta(data, viewportHeight);
						if (target === null) return;
						if (target === "home") {
							scrollTop = 0;
						} else if (target === "end") {
							scrollTop = contentHeight; // render clamps to the real max
						} else {
							scrollTop += target;
						}
						tui.requestRender();
					},
			};
		},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: OVERLAY_MARGIN } },
		);
	}
}

// ------------------------------------------------------------------
// Theme helpers (mirror the settings overlay's styling)
// ------------------------------------------------------------------

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

/** Overlay theme → Markdown component theme, mirroring pi's getMarkdownTheme. */
function markdownTheme(theme: Theme) {
	return {
		heading: (t: string) => theme.fg("mdHeading", t),
		link: (t: string) => theme.fg("mdLink", t),
		linkUrl: (t: string) => theme.fg("mdLinkUrl", t),
		code: (t: string) => theme.fg("mdCode", t),
		codeBlock: (t: string) => theme.fg("mdCodeBlock", t),
		codeBlockBorder: (t: string) => theme.fg("mdCodeBlockBorder", t),
		quote: (t: string) => theme.fg("mdQuote", t),
		quoteBorder: (t: string) => theme.fg("mdQuoteBorder", t),
		hr: (t: string) => theme.fg("mdHr", t),
		listBullet: (t: string) => theme.fg("mdListBullet", t),
		bold: (t: string) => theme.bold(t),
		italic: (t: string) => theme.italic(t),
		underline: (t: string) => theme.underline(t),
		strikethrough: (t: string) => theme.strikethrough(t),
		highlightCode: (code: string, _lang?: string) => code.split("\n").map((line) => theme.fg("mdCodeBlock", line)),
	};
}
