/**
 * `/piflux history` — read-only viewer for archived workflows: the same
 * two-screen idiom as `/piflux view` (selector in the editor slot, content
 * in the shared fullscreen overlay pager), one level deeper. Four screens:
 * outcome selector (done / abandoned, with archive counts) → archive list
 * (reverse-chronological) → artifact selector for the chosen archive →
 * fullscreen pager for the selected artifact or the workflow.json metadata
 * card. Esc backs out one level at each screen; Esc on the outcome selector
 * closes the viewer.
 *
 * Unlike `/piflux view`, no active workflow is required — history browsing
 * works mid-workflow or with none running, so this module needs no deps
 * injection at all: it reads only the filesystem plus `ctx.cwd`. It imports
 * the shared pager and selector theme from view.ts and the path helpers
 * from paths.ts — never from index.ts (the deps pattern).
 *
 * Read-only everywhere: no writes to the history tree, state file, settings,
 * sessions, or git — safe to run while the agent is processing. Content is
 * snapshotted when the pager opens; selectors are re-read on every visit.
 * Corrupt or metadata-less archives (unreadable or invalid-`archivedAt`
 * workflow.json) are still listed — slug label, dir-mtime sort, "(no
 * metadata)" marker — and never crash the viewer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DynamicBorder, stripFrontmatter, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { historyRootFor } from "./paths.ts";
import { ARTIFACT_STEPS, openContentPager, selectListTheme, type SelectorItem } from "./view.ts";

// ------------------------------------------------------------------
// Pure helpers (module-level, exported — unit-testable)
// ------------------------------------------------------------------

/** The two archive outcomes, in selector order. */
export const HISTORY_OUTCOMES = ["done", "abandoned"] as const;
export type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number];

/** Type guard for the direct-view tokens accepted after `/piflux history`. */
export function isHistoryOutcome(token: string): token is HistoryOutcome {
	return (HISTORY_OUTCOMES as readonly string[]).includes(token);
}

/**
 * Tolerant shape of an archive's `workflow.json` (written by /done and
 * /abandon before the archive move). Absent, empty, or null-valued fields
 * parse as null; only `archivedAt` is required — an unparseable date makes
 * the whole metadata null (the entry falls back to dir-mtime sorting).
 */
export interface WorkflowMetadata {
	outcome: string | null;
	branch: string | null;
	baseBranch: string | null;
	finalStep: string | null;
	/** Date-parseable timestamp — guaranteed by the parse rules. */
	archivedAt: string;
	/** HEAD of the base branch at /done time; null for abandoned runs. */
	commit: string | null;
	/** Free-text reason, /abandon only. */
	reason: string | null;
}

/**
 * Parse an archive's workflow.json. Tolerant: returns null on any read or
 * parse failure, a non-object payload, or a missing/invalid `archivedAt` —
 * such archives are still listed, just without metadata.
 */
export function parseWorkflowMetadata(path: string): WorkflowMetadata | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.archivedAt !== "string" || Number.isNaN(Date.parse(obj.archivedAt))) return null;
	const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
	return {
		outcome: str(obj.outcome),
		branch: str(obj.branch),
		baseBranch: str(obj.baseBranch),
		finalStep: str(obj.finalStep),
		archivedAt: obj.archivedAt,
		commit: str(obj.commit),
		reason: str(obj.reason),
	};
}

/** One archive dir under `<historyRoot>/<outcome>/`. */
export interface ArchiveEntry {
	/** Absolute path of the archived branch dir. */
	dir: string;
	/** Directory name: the branch slug, possibly with a `.n` collision suffix. */
	name: string;
	/** Parsed workflow.json — null when missing, corrupt, or invalid. */
	metadata: WorkflowMetadata | null;
	/** Sort key: `archivedAt` ms when metadata parses, else the dir mtime. */
	sortKeyMs: number;
}

/**
 * The archive entries for one outcome, reverse-chronologically by
 * `archivedAt` (the semantic truth — dir mtimes lie on touched or
 * timestamp-preserving copies) with a dir-mtime fallback for metadata-less
 * entries. A missing or unreadable outcome root yields no entries; stray
 * non-dir files are ignored. Ties break by name so `.1` collision suffixes
 * keep a stable order.
 */
export function listArchiveEntries(historyRoot: string, outcome: HistoryOutcome): ArchiveEntry[] {
	const outcomeRoot = join(historyRoot, outcome);
	let names: string[];
	try {
		names = readdirSync(outcomeRoot);
	} catch {
		return [];
	}
	const entries: ArchiveEntry[] = [];
	for (const name of names) {
		const dir = join(outcomeRoot, name);
		let mtimeMs = 0;
		try {
			const stats = statSync(dir);
			if (!stats.isDirectory()) continue;
			mtimeMs = stats.mtimeMs;
		} catch {
			continue;
		}
		const metadata = parseWorkflowMetadata(join(dir, "workflow.json"));
		const archivedMs = metadata ? Date.parse(metadata.archivedAt) : Number.NaN;
		entries.push({ dir, name, metadata, sortKeyMs: Number.isNaN(archivedMs) ? mtimeMs : archivedMs });
	}
	entries.sort((a, b) => b.sortKeyMs - a.sortKeyMs || a.name.localeCompare(b.name));
	return entries;
}

/**
 * Absolute local date, `2026-10-16`: used for archive rows and artifact
 * write dates alike. History spans weeks and months, where relative time
 * stops informing.
 */
export function formatLocalDate(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The outcome selector rows: both outcomes always listed, even when empty — one keypress is cheaper than hidden state. */
export function buildOutcomeItems(historyRoot: string): SelectorItem[] {
	return HISTORY_OUTCOMES.map((outcome) => ({
		value: outcome,
		label: outcome,
		description: `${listArchiveEntries(historyRoot, outcome).length} archived`,
	}));
}

/**
 * The archive-list rows, lean: label = branch name (dir slug when metadata
 * is missing), description = absolute archived date, final step, short
 * commit hash — `(no metadata)` when the archive has no usable metadata.
 * `value` is the dir name (unique within the outcome, collision suffixes
 * included), so selection survives label collisions.
 */
export function buildArchiveItems(entries: ArchiveEntry[]): SelectorItem[] {
	return entries.map((entry) => {
		const date = formatLocalDate(entry.sortKeyMs);
		if (!entry.metadata) {
			return { value: entry.name, label: entry.name, description: `${date} · (no metadata)` };
		}
		const label = entry.metadata.branch ?? entry.name;
		return { value: entry.name, label, description: metadataRowSummary(entry.metadata, date) };
	});
}

/** `2026-10-16 · step: ship · bbaa611` — the shared lean-row format (commit segment dropped when absent, _e.g._ abandoned runs). */
function metadataRowSummary(metadata: WorkflowMetadata, date: string): string {
	const parts = [date, `step: ${metadata.finalStep ?? "unknown"}`];
	if (metadata.commit) parts.push(metadata.commit.slice(0, 7));
	return parts.join(" · ");
}

/**
 * The artifact selector rows for one archive: the known artifact steps that
 * exist on disk (deterministic vocabulary — stray files ignored), plus a
 * `workflow` row for the metadata card (always listed; a metadata-less
 * archive renders a graceful "no metadata" card). Artifact descriptions
 * show the artifact's own last-write date (rename preserves mtimes).
 */
export function buildArtifactItems(entry: ArchiveEntry): SelectorItem[] {
	const items: SelectorItem[] = [];
	for (const step of ARTIFACT_STEPS) {
		const path = join(entry.dir, `${step}.md`);
		if (!existsSync(path)) continue;
		let description = "—";
		try {
			description = `written ${formatLocalDate(statSync(path).mtimeMs)}`;
		} catch {
			// vanished between existsSync and stat — keep the placeholder
		}
		items.push({ value: step, label: step, description });
	}
	items.push({
		value: "workflow",
		label: "workflow",
		description: entry.metadata ? metadataRowSummary(entry.metadata, formatLocalDate(entry.sortKeyMs)) : "(no metadata)",
	});
	return items;
}

/**
 * The `workflow` row's pager content: a markdown key-value card (outcome,
 * branch, base branch, final step, archived timestamp, commit, and the
 * abandon `reason` when present). Null metadata (missing/corrupt
 * workflow.json) renders a graceful placeholder card instead.
 */
export function renderWorkflowMetadata(metadata: WorkflowMetadata | null): string {
	if (!metadata) {
		return "## Workflow\n\nNo workflow.json metadata in this archive — the file is missing, corrupt, or has an invalid `archivedAt`.\n";
	}
	const lines = [
		"## Workflow",
		"",
		`- Outcome: **${metadata.outcome ?? "—"}**`,
		`- Branch: **${metadata.branch ?? "—"}**`,
		`- Base branch: ${metadata.baseBranch ?? "—"}`,
		`- Final step: **${metadata.finalStep ?? "—"}**`,
		`- Archived: ${metadata.archivedAt}`,
		metadata.commit ? `- Commit: \`${metadata.commit}\`` : "- Commit: —",
	];
	if (metadata.reason) lines.push(`- Reason: ${metadata.reason}`);
	return lines.join("\n") + "\n";
}

/**
 * Second-token completions for `/piflux history <TAB>`. Returns items whose
 * `value` is the FULL argument text (`history done`), because pi's argument
 * autocomplete replaces the entire argument text — a bare `done` value would
 * clobber the `history ` prefix (see pi-tui's `applyCompletion`; same
 * pattern as `viewArgumentCompletions`).
 *
 * Returns null when the argument text is not a history invocation (the
 * caller falls back to first-token completion) — never throws, so it is
 * safe on every keystroke.
 */
export function historyArgumentCompletions(
	argumentText: string,
	cwd: string,
): Array<{ value: string; label: string; description: string }> | null {
	if (argumentText !== "history" && !argumentText.startsWith("history ")) return null;
	const targetPrefix = argumentText.slice("history ".length);
	const historyRoot = historyRootFor(cwd);
	return HISTORY_OUTCOMES.filter((outcome) => outcome.startsWith(targetPrefix)).map((outcome) => ({
		value: `history ${outcome}`,
		label: outcome,
		description: `${listArchiveEntries(historyRoot, outcome).length} archived`,
	}));
}

// ------------------------------------------------------------------
// Viewer screens (TUI-only — manual verification)
// ------------------------------------------------------------------

/** Max rows shown at once in the archive list (longer histories scroll inside the SelectList). */
const ARCHIVE_LIST_HEIGHT = 10;

/**
 * The deps-free factory. Returns the async `/piflux history` handler:
 * guards mode, then runs the nested screen loops — outcome → archive →
 * artifact → pager — re-reading the listings on every visit. Esc backs out
 * one level per screen; Esc on the outcome selector closes the viewer. A
 * direct `outcome` argument skips screen 1 (an empty outcome notifies
 * outcome-specifically and falls through to the full flow).
 */
export function createHistoryViewer(): (ctx: ExtensionCommandContext, outcome?: HistoryOutcome) => Promise<void> {
	return async (ctx: ExtensionCommandContext, outcome?: HistoryOutcome): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/piflux history is only available in the interactive TUI.", "error");
			return;
		}
		const historyRoot = historyRootFor(ctx.cwd);

		// The pending outcome: a direct argument starts the loop one screen
		// deep; Esc on the archive list returns here (null = show the
		// outcome selector).
		let pending: HistoryOutcome | null = outcome ?? null;

		while (true) {
			if (pending) {
				const entries = listArchiveEntries(historyRoot, pending);
				if (entries.length === 0) {
					ctx.ui.notify(`No ${pending} workflows archived yet.`, "info");
					pending = null;
					continue;
				}
				const selectedName = await archiveScreen(ctx, pending, entries);
				if (!selectedName) {
					pending = null; // esc → outcome selector
					continue;
				}
				const selected = entries.find((e) => e.name === selectedName);
				if (selected) await artifactLoop(ctx, selected);
				continue; // back to the archive list (re-read on arrival)
			}

			// Outcome selector. An entirely empty archive (history root
			// missing, or both outcomes empty) notifies and closes.
			const total = HISTORY_OUTCOMES.reduce((sum, o) => sum + listArchiveEntries(historyRoot, o).length, 0);
			if (total === 0) {
				ctx.ui.notify("No archived workflows yet.", "info");
				return;
			}
			const picked = await outcomeScreen(ctx, historyRoot);
			if (!picked) return; // esc on the outcome selector closes the viewer
			pending = picked;
		}
	};

	/** Artifact selector → pager, until Esc on the selector returns to the archive list. */
	async function artifactLoop(ctx: ExtensionCommandContext, entry: ArchiveEntry): Promise<void> {
		const title = (artifact: string) => `${artifact} — ${entry.metadata?.branch ?? entry.name} (archived)`;
		while (true) {
			const artifact = await artifactScreen(ctx, entry);
			if (!artifact) return; // esc → archive list
			if (artifact === "workflow") {
				await openContentPager(ctx, { title: title("workflow"), content: renderWorkflowMetadata(entry.metadata), escLabel: "back" });
				continue;
			}
			const path = join(entry.dir, `${artifact}.md`);
			if (!existsSync(path)) {
				// The selector only lists existing artifacts — this is a
				// between-renders deletion, not a reachable steady state.
				ctx.ui.notify(`No ${artifact} artifact in this archive.`, "warning");
				continue;
			}
			// Snapshot semantics: read once when the pager opens. Archived
			// artifacts may carry frontmatter — strip it if present.
			await openContentPager(ctx, { title: title(artifact), content: stripFrontmatter(readFileSync(path, "utf-8")), escLabel: "back" });
		}
	}

	function outcomeScreen(ctx: ExtensionCommandContext, historyRoot: string): Promise<HistoryOutcome | null> {
		return ctx.ui.custom<HistoryOutcome | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Workflow history")), 1, 0));

			const list = new SelectList(buildOutcomeItems(historyRoot), HISTORY_OUTCOMES.length, selectListTheme(theme));
			list.onSelect = (item) => done(item.value as HistoryOutcome);
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(new Text(theme.fg("dim", "enter: browse · esc: close"), 1, 0));
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

	function archiveScreen(ctx: ExtensionCommandContext, outcome: HistoryOutcome, entries: ArchiveEntry[]): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`Workflow history — ${outcome}`)), 1, 0));

			const items = buildArchiveItems(entries);
			const list = new SelectList(items, Math.min(items.length, ARCHIVE_LIST_HEIGHT), selectListTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(new Text(theme.fg("dim", "enter: view · esc: back"), 1, 0));
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

	function artifactScreen(ctx: ExtensionCommandContext, entry: ArchiveEntry): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`Workflow history — ${entry.metadata?.branch ?? entry.name}`)), 1, 0));

			const items = buildArtifactItems(entry);
			const list = new SelectList(items, items.length, selectListTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(new Text(theme.fg("dim", "enter: view · esc: back"), 1, 0));
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
}
