/**
 * Workflow orchestrator extension for piflux.
 *
 * Intercepts the plan→code→review workflow commands (/start, /plan, /code,
 * /review, /icode, /ireview, /ship, /done) and manages the session lifecycle
 * automatically: each step runs in its own named session with the model and
 * thinking effort configured in the single global settings file
 * `~/.pi/agent/piflux/settings.json` (managed in-app through the
 * `/piflux settings` overlay: step → model → level), and a strict state
 * machine blocks out-of-order commands.
 *
 * Architecture notes (verified against the pi extension API):
 * - Step commands are registered as extension commands, not intercepted in
 *   the `input` event: session creation/switching (newSession, switchSession)
 *   is only available on the extension-command context, not on the input-event
 *   context. Extension commands run before prompt templates, so the raw
 *   command never reaches the template in the *current* session.
 * - The raw command text (e.g. `/plan add user auth`) is forwarded to the new
 *   session via sendUserMessage, which always skips template expansion
 *   (`expandPromptTemplates: false`). The `input` event handler therefore
 *   expands the matching prompt template itself (frontmatter stripped, $@ / $1
 *   placeholders substituted) for extension-sourced messages, so the existing
 *   templates run unchanged in the step session.
 * - Model and thinking effort are applied in `before_agent_start` of the step
 *   session, once per session (first turn). The step is identified by matching
 *   the current session file against the state file.
 * - The state file (workflow-orchestration.json, stored with the workflow
 *   artifacts under the global config dir — see paths.ts) is the single
 *   source of truth for the current step, branch, and session paths. All
 *   reads and writes are synchronous. `/done` marks it `step: "done"` before
 *   its git teardown begins (a failed or interrupted `/done` leaves a retryable
 *   state) and removes it — together with the workflow's sessions and
 *   artifacts — on success. `/abandon` (any step) removes it too.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DynamicBorder,
	getAgentDir,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { createWorkflowViewer, isViewTarget, viewArgumentCompletions } from "./view.ts";

type StepName = "start" | "plan" | "code" | "review" | "icode" | "ireview" | "ship" | "done" | "abandon";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** All thinking levels, in ascending order — used by the level picker. */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const WORKFLOW_COMMANDS: StepName[] = ["start", "plan", "code", "review", "icode", "ireview", "ship", "done", "abandon"];

/**
 * Matches `/plan add user auth` → ["plan", "add user auth"]. Only the steps
 * with prompt templates are listed: `/done` (extension teardown) and
 * `/abandon` have no templates, so their raw command text must never be
 * template-expanded.
 */
const WORKFLOW_COMMAND_RE = /^\/(start|plan|code|review|icode|ireview|ship)(?:\s+([\s\S]*))?$/;

// Resolved relative to this extension file (extensions/), NOT relative
// to the cwd: the templates live in the package itself, not the project.
const WORKFLOW_TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "workflow-templates");

const SETTINGS_FILE_NAME = "settings.json";

// Workflow artifacts and state live outside the repo, under the global
// config dir (see paths.ts) — nothing is written inside the repository.
import { PACKAGE_CONFIG_DIR, artifactPath, stateFilePath, workflowRootFor } from "./paths.ts";

/** Valid next commands per state. "done" is a retryable terminal step: a failed or interrupted `/done` can be re-run. */
const NEXT_COMMANDS: Record<StepName, string[]> = {
	start: ["/plan"],
	plan: ["/code"],
	code: ["/review"],
	review: ["/icode", "/ship"],
	icode: ["/ireview"],
	ireview: ["/icode", "/ship"],
	ship: ["/done"],
	done: ["/done"],
	// /abandon bypasses the state machine (valid from any step), so it has no entry here.
	abandon: [],
};

interface StepSettings {
	model?: string | null;
	thinkingLevel?: ThinkingLevel | null;
}

interface WorkflowSettings {
	steps: Partial<Record<StepName, StepSettings>>;
}

/**
 * Built-in defaults used when the settings file is absent or a step entry
 * is missing. `model: null` means "leave the session's model untouched";
 * only a configured model is applied. Thinking levels default to "high" for
 * the thinking-heavy steps and "low" for the mechanical git steps. `/done`
 * has no entry: it is pure extension code, never a session, so model/effort
 * settings cannot apply to it. A stale user-settings entry for `done` (or
 * the removed `cleanup`) is inert — merged but never applied.
 */
const DEFAULT_SETTINGS: WorkflowSettings = {
	steps: {
		start: { model: null, thinkingLevel: "low" },
		plan: { model: null, thinkingLevel: "high" },
		code: { model: null, thinkingLevel: "high" },
		review: { model: null, thinkingLevel: "high" },
		icode: { model: null, thinkingLevel: "high" },
		ireview: { model: null, thinkingLevel: "high" },
		ship: { model: null, thinkingLevel: "low" },
		abandon: { model: null, thinkingLevel: "low" },
	},
};

interface WorkflowState {
	step: StepName;
	branch: string;
	sessions: Partial<Record<StepName, string>>;
}

// ------------------------------------------------------------------
// Prompt template helpers (pure, module-level — unit-testable)
// ------------------------------------------------------------------

/** Replicates pi's parseCommandArgs (quote-aware argument splitting). */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	for (const char of argsString) {
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

/**
 * Replicates pi's substituteArgs: $@, $ARGUMENTS, $1…, ${N:-default}, ${@:N}, ${@:N:L}.
 * Exported for unit tests (test/index.test.ts), which exercise
 * the placeholder forms against synthetic template bodies.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget: string | undefined, defaultValue: string | undefined, sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined) => {
			if (defaultTarget) {
				const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
				return value ? value : defaultValue ?? "";
			}
			if (sliceStart) {
				let start = parseInt(sliceStart, 10) - 1;
				if (start < 0) start = 0;
				if (sliceLength) {
					const length = parseInt(sliceLength, 10);
					return args.slice(start, start + length).join(" ");
				}
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			const index = parseInt(simple as string, 10) - 1;
			return args[index] ?? "";
		},
	);
}

// ------------------------------------------------------------------
// Thinking level helpers (module-level, exported — unit-testable)
// ------------------------------------------------------------------

interface OverlayModel {
	provider: string;
	id: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel | "off", string | null>>;
}

/**
 * Levels a model supports, mirroring pi's getSupportedThinkingLevels: a
 * non-reasoning model offers only "off"; a reasoning model offers all levels
 * except those mapped to `null` in thinkingLevelMap — and `xhigh`/`max`
 * additionally require an explicit map entry, since a missing entry means the
 * provider clamps them down (e.g. mimo-v2.5-pro tops out at "high").
 */
export function levelsForModel(model: OverlayModel): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

// ------------------------------------------------------------------
// Settings helpers (module-level, exported — unit-testable)
// ------------------------------------------------------------------

function readJsonFile<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

/**
 * Merges file step settings over the built-in defaults, per step
 * (`DEFAULT_SETTINGS ← file steps`). Explicit `null`s in the file are kept:
 * `model: null` means "leave the session's model untouched" and a null
 * thinking level falls back to pi's own default, so legacy files written by
 * 1.1.0 (full-defaults shape) parse and apply identically.
 */
export function mergeStepSettings(fileSteps: Partial<Record<StepName, StepSettings>>): Record<StepName, StepSettings> {
	const merged = {} as Record<StepName, StepSettings>;
	for (const step of WORKFLOW_COMMANDS) {
		merged[step] = { ...DEFAULT_SETTINGS.steps[step], ...fileSteps[step] };
	}
	return merged;
}

/** Serializes a steps map to the settings file shape (`{ steps }`, pretty-printed, trailing newline). */
export function serializeSettings(steps: Partial<Record<StepName, StepSettings>>): string {
	return JSON.stringify({ steps }, null, 2) + "\n";
}

/**
 * Writes one step into the settings file, preserving all other steps
 * (read-modify-write). Creates the parent directory and file on first write.
 * Returns false when an existing file is corrupt — its other steps cannot be
 * preserved, so it is left untouched for manual repair.
 */
export function setStepInFile(file: string, step: StepName, settings: StepSettings): boolean {
	const current = readJsonFile<WorkflowSettings>(file);
	if (existsSync(file) && current === null) return false;
	const steps = { ...(current?.steps ?? {}) };
	steps[step] = settings;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, serializeSettings(steps), "utf-8");
	return true;
}

/**
 * Removes one step from the settings file, preserving all other steps.
 * Returns false when the step wasn't there (file absent or step unset) or the
 * file is corrupt (left untouched for manual repair).
 */
export function unsetStepInFile(file: string, step: StepName): boolean {
	if (!existsSync(file)) return false;
	const current = readJsonFile<WorkflowSettings>(file);
	if (current === null) return false;
	const steps = { ...current.steps };
	if (!(step in steps)) return false;
	delete steps[step];
	writeFileSync(file, serializeSettings(steps), "utf-8");
	return true;
}

// ------------------------------------------------------------------
// Plan metadata parser (pure, module-level — unit-testable)
// ------------------------------------------------------------------

/**
 * The plan metadata `/done` acts on. Absent lines parse to `null` — the
 * callers decide the fallback (`Delete remote branch` absent → delete;
 * `Tag release` absent → no tag).
 */
export interface PlanMetadata {
	baseBranch: string | null;
	deleteRemoteBranch: boolean | null;
	newVersion: string | null;
	tagRelease: boolean | null;
}

/**
 * Deterministic regex extraction of the `## Metadata` list items from the
 * plan file (`- Base branch: master`), same style as the templates' own
 * grep/sed extraction. `[ \\t]*$` keeps the match on one line.
 */
export function parsePlanMetadata(content: string): PlanMetadata {
	const line = (pattern: RegExp) => content.match(pattern)?.[1] ?? null;
	const bool = (pattern: RegExp) => {
		const value = line(pattern);
		return value === "true" ? true : value === "false" ? false : null;
	};
	return {
		baseBranch: line(/^\s*-\s*Base branch:\s*(\S+)[ \t]*$/m),
		deleteRemoteBranch: bool(/^\s*-\s*Delete remote branch:\s*(true|false)[ \t]*$/m),
		newVersion: line(/^\s*-\s*New version:\s*(\S+)[ \t]*$/m),
		tagRelease: bool(/^\s*-\s*Tag release:\s*(true|false)[ \t]*$/m),
	};
}

// ------------------------------------------------------------------
// Git helpers (module-level — exercised through /done's and /abandon's tests)
// ------------------------------------------------------------------

interface GitResult {
	ok: boolean;
	/** stdout (trimmed) on success; always empty on failure. */
	output: string;
	/** exit code on failure; null when git itself could not be spawned. */
	status: number | null;
	/** stderr (trimmed) on failure; never empty (falls back to a summary). */
	stderr: string;
}

/**
 * Runs a git command synchronously and classifies the outcome by exit code.
 * Never throws: failures come back as `{ ok: false, status, stderr }`.
 */
function gitCommand(cwd: string, args: string[]): GitResult {
	try {
		const output = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, output: output.trim(), status: 0, stderr: "" };
	} catch (err) {
		const e = err as { status?: number; stderr?: string | Buffer };
		const stderr = (e.stderr ?? "").toString().trim();
		return {
			ok: false,
			output: "",
			status: typeof e.status === "number" ? e.status : null,
			stderr: stderr || "git command failed to run",
		};
	}
}

/**
 * Best-effort remote feature-branch deletion, shared by /done and /abandon.
 * The subtle exit-code semantics live here, in one place: `ls-remote
 * --exit-code` distinguishes "absent" (exit 2 — the common case, the
 * workflow never pushed the branch) from real failures (e.g. no origin
 * remote); a branch present on origin is deleted via `git push origin
 * --delete`. Never throws, never aborts — returns the summary outcome
 * string plus the warning message to surface on real failures (null when
 * none). `continuation` is the caller's tail for that warning, so each
 * command keeps its own phrasing.
 */
function deleteRemoteBranch(cwd: string, branch: string, continuation: string): { outcome: string; warning: string | null } {
	const exists = gitCommand(cwd, ["ls-remote", "--exit-code", "--heads", "origin", branch]);
	if (exists.ok) {
		const del = gitCommand(cwd, ["push", "origin", "--delete", branch]);
		if (del.ok) return { outcome: "deleted from origin", warning: null };
		return {
			outcome: "deletion failed (see warning)",
			warning: `Could not delete the remote branch ${branch} — ${del.stderr}. ${continuation}`,
		};
	}
	if (exists.status === 2) {
		return { outcome: "absent on origin (never pushed)", warning: null };
	}
	return {
		outcome: "unverified (see warning)",
		warning: `Could not check whether the remote branch ${branch} exists — ${exists.stderr}. ${continuation}`,
	};
}

/** Switches to the given branch. Returns the git result for the caller's failure handling. */
function checkoutBranch(cwd: string, branch: string): GitResult {
	return gitCommand(cwd, ["checkout", branch]);
}

/**
 * Deletes the local branch with -D. An already-gone branch (git's "not
 * found" error, exit 1) is the ENOENT-equivalent — a previous run deleted
 * it — and counts as success. Returns `{ ok: false, stderr }` on real
 * failures, with the stderr for the caller's message.
 *
 * Return-shape note: deliberately different from deleteRemoteBranch (which
 * returns `{ outcome, warning }` because both its callers report the
 * outcome string verbatim). Here the raw ok/stderr pair comes back because
 * the callers phrase failures differently (/done aborts with a retry hint,
 * /abandon warns and degrades) — the data is theirs to word.
 */
function deleteLocalBranch(cwd: string, branch: string): { ok: boolean; stderr: string } {
	const del = gitCommand(cwd, ["branch", "-D", branch]);
	if (del.ok || (del.status === 1 && del.stderr.includes("not found"))) return { ok: true, stderr: "" };
	return { ok: false, stderr: del.stderr };
}

export default function workflowOrchestrator(pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// State and settings helpers (synchronous — no races in handlers)
	// ------------------------------------------------------------------

	const warnedCorruptFiles = new Set<string>();

	function warnCorrupt(file: string, message: string, ctx: ExtensionContext): void {
		if (warnedCorruptFiles.has(file)) return;
		warnedCorruptFiles.add(file);
		ctx.ui.notify(message, "warning");
	}

	function globalSettingsFilePath(): string {
		return join(getAgentDir(), PACKAGE_CONFIG_DIR, SETTINGS_FILE_NAME);
	}

	function readState(cwd: string, ctx?: ExtensionContext): WorkflowState | null {
		const file = stateFilePath(cwd);
		if (!existsSync(file)) return null;
		const parsed = readJsonFile<WorkflowState>(file);
		if (
			parsed &&
			typeof parsed.step === "string" &&
			typeof parsed.branch === "string" &&
			parsed.sessions !== null &&
			typeof parsed.sessions === "object"
		) {
			return parsed;
		}
		if (ctx) {
			warnCorrupt(
				file,
				`Ignoring corrupt ${basename(file)} — treating as no active workflow. Fix or delete the file (e.g. /abandon --force) to start fresh.`,
				ctx,
			);
		}
		return null;
	}

	function writeState(cwd: string, state: WorkflowState): void {
		const file = stateFilePath(cwd);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
	}

	/**
	 * Reads the settings file; a corrupt file is warned-once (with its full
	 * path, so it can be fixed manually) and treated as absent (no steps).
	 */
	function readSettingsTier(file: string, ctx?: ExtensionContext): Partial<Record<StepName, StepSettings>> {
		if (!existsSync(file)) return {};
		const parsed = readJsonFile<WorkflowSettings>(file);
		if (parsed && typeof parsed === "object" && typeof parsed.steps === "object" && parsed.steps !== null) {
			return parsed.steps;
		}
		if (ctx) {
			warnCorrupt(
				file,
				`Ignoring corrupt workflow settings file — ${file}. Built-in defaults apply for this session; fix or delete the file to persist settings.`,
				ctx,
			);
		}
		return {};
	}

	/**
	 * Reads the single global settings tier and merges it over the built-in
	 * defaults. applyModelAndEffort consumes the result directly — no re-merge
	 * with DEFAULT_SETTINGS needed.
	 */
	function readSettings(ctx: ExtensionContext): WorkflowSettings {
		const fileSteps = readSettingsTier(globalSettingsFilePath(), ctx);
		return { steps: mergeStepSettings(fileSteps) };
	}

	// ------------------------------------------------------------------
	// Branch helpers
	// ------------------------------------------------------------------

	/** Canonical branch name sanitization — lowercase, non-alphanumeric → hyphens. */
	function sanitizeBranchName(raw: string): string {
		return raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	/**
	 * Branch name comes from the most recently written start artifact: scan
	 * the repo-level workflow root's branch dirs for `start.md`, newest
	 * mtime wins.
	 */
	function findBranchFromStartArtifacts(cwd: string): string | null {
		const root = workflowRootFor(cwd);
		if (!existsSync(root)) return null;
		let entries: string[];
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			return null;
		}
		let best: { branch: string; mtimeMs: number } | null = null;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const start = join(root, entry.name, "start.md");
			if (!existsSync(start)) continue;
			try {
				const mtimeMs = statSync(start).mtimeMs;
				if (!best || mtimeMs > best.mtimeMs) best = { branch: entry.name, mtimeMs };
			} catch {
				// unreadable start artifact — skip
			}
		}
		return best?.branch ?? null;
	}

	// ------------------------------------------------------------------
	// Prompt template expansion (sendUserMessage skips template expansion)
	// ------------------------------------------------------------------

	function templatePathFor(command: StepName): string | null {
		const path = join(WORKFLOW_TEMPLATES_DIR, `${command}.md`);
		return existsSync(path) ? path : null;
	}

	/**
	 * Expand a workflow command into its prompt template body, or null if the
	 * template is unavailable. `$WORKFLOW_DIR` is substituted with the repo's
	 * workflow root here — the templates stay path-agnostic and this function
	 * is the single place that owns path knowledge. Safe ordering:
	 * substituteArgs' regex only matches $@/$ARGUMENTS/$N forms, so
	 * $WORKFLOW_DIR passes through untouched — substitute the literal before
	 * or after arg substitution.
	 */
	function expandWorkflowTemplate(command: StepName, args: string, cwd: string): string | null {
		const path = templatePathFor(command);
		if (!path) return null;
		try {
			const content = stripFrontmatter(readFileSync(path, "utf-8"));
			return substituteArgs(content, parseCommandArgs(args)).replaceAll("$WORKFLOW_DIR", () => workflowRootFor(cwd));
		} catch {
			return null;
		}
	}

	// ------------------------------------------------------------------
	// State machine
	// ------------------------------------------------------------------

	function validateTransition(state: WorkflowState | null, command: StepName): { ok: true } | { ok: false; message: string } {
		if (command === "start") {
			if (state) {
				return {
					ok: false,
					message: `A workflow is already active (step "${state.step}" on branch "${state.branch}"). Run /abandon to destroy it before starting a new one.`,
				};
			}
			return { ok: true };
		}
		if (!state) {
			return {
				ok: false,
				message: `/${command} is not valid now — no active workflow. Run /start <branch> to begin.`,
			};
		}
		const allowed = NEXT_COMMANDS[state.step];
		if (!allowed.includes(`/${command}`)) {
			return {
				ok: false,
				message: `/${command} is not valid from step "${state.step}". Valid next commands: ${allowed.join(", ")}.`,
			};
		}
		return { ok: true };
	}

	// ------------------------------------------------------------------
	// Session lifecycle
	// ------------------------------------------------------------------

	async function runStep(command: StepName, args: string, ctx: ExtensionCommandContext): Promise<void> {
		const cwd = ctx.cwd;
		const state = readState(cwd, ctx);
		const check = validateTransition(state, command);
		if (!check.ok) {
			ctx.ui.notify(check.message, "error");
			return;
		}

		// Resolve the branch name for the step session.
		let branch: string;
		if (command === "start") {
			branch = sanitizeBranchName(args);
			if (!branch) {
				ctx.ui.notify("Usage: /start <branch-name>", "warning");
				return;
			}
			// The extension is the single source of truth for the branch name:
			// forward the sanitized name so the start template operates on the
			// same name (no template-side sanitization, no re-derivation).
			args = branch;
		} else if (command === "plan") {
			// The start artifact is the source of truth for the branch name.
			const found = findBranchFromStartArtifacts(cwd);
			if (!found) {
				ctx.ui.notify(`No start artifact found under ${workflowRootFor(cwd)}. Run /start <branch> first.`, "error");
				return;
			}
			branch = found;
		} else {
			branch = state!.branch;
		}

		const parentSession = ctx.sessionManager.getSessionFile();
		const commandText = `/${command}${args ? " " + args : ""}`;

		if (command === "icode" || command === "ireview") {
			// Session reuse: switch back to the code/review session.
			const reuseStep: StepName = command === "icode" ? "code" : "review";
			const targetPath = state!.sessions[reuseStep];
			if (!targetPath || !existsSync(targetPath)) {
				ctx.ui.notify(`No ${reuseStep} session found for branch "${state!.branch}". Run /${reuseStep} first.`, "error");
				return;
			}
			const nextState: WorkflowState = {
				step: command,
				branch: state!.branch,
				sessions: { ...state!.sessions, [command]: targetPath },
			};
			const result = await ctx.switchSession(targetPath, {
				withSession: async (sctx) => {
					writeState(sctx.cwd, nextState);
					await sctx.sendUserMessage(commandText);
				},
			});
			if (result.cancelled) {
				ctx.ui.notify(`Session switch cancelled — /${command} not sent.`, "warning");
			}
			return;
		}

		// New session per step, named "piflux: <step> <branch>".
		const sessionName = `piflux: ${command} ${branch}`;
		const result = await ctx.newSession({
			parentSession,
			setup: async (sm) => {
				sm.appendSessionInfo(sessionName);
			},
			withSession: async (sctx) => {
				// The new session's path is only available here.
				const sessionPath = sctx.sessionManager.getSessionFile();
				const sessions = { ...(state?.sessions ?? {}) };
				if (sessionPath) sessions[command] = sessionPath;
				const nextState: WorkflowState = {
					step: command,
					branch,
					sessions,
				};
				writeState(sctx.cwd, nextState);
				await sctx.sendUserMessage(commandText);
			},
		});
		if (result.cancelled) {
			ctx.ui.notify(`Session creation cancelled — /${command} not sent.`, "warning");
		}
	}

	// ------------------------------------------------------------------
	// Input interception: template expansion for extension-sent commands
	// ------------------------------------------------------------------

	// Interactive workflow commands are handled by the extension commands above
	// (they run before the input event and own the session lifecycle). The input
	// event only handles messages the extension itself sends into the step
	// session: sendUserMessage skips template expansion, so expand the matching
	// prompt template here to make it run unchanged.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") return { action: "continue" };
		const match = event.text.match(WORKFLOW_COMMAND_RE);
		if (!match) return { action: "continue" };
		const expanded = expandWorkflowTemplate(match[1] as StepName, (match[2] ?? "").trim(), ctx.cwd);
		if (expanded === null) return { action: "continue" };
		return { action: "transform", text: expanded };
	});

	// ------------------------------------------------------------------
	// Model / thinking effort
	// ------------------------------------------------------------------

	function resolveModel(ctx: ExtensionContext, spec: string) {
		const slash = spec.indexOf("/");
		if (slash > 0) {
			return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
		}
		return ctx.modelRegistry.getAvailable().find((m) => m.id === spec);
	}

	async function applyModelAndEffort(ctx: ExtensionContext, step: StepName): Promise<void> {
		const settings = readSettings(ctx);
		// readSettings already returns the fully merged step (defaults filled
		// in from the single global tier), so no re-merge with DEFAULT_SETTINGS
		// is needed here.
		const stepSettings = settings.steps[step] ?? {};

		// Model first: setModel resets the thinking level to the new model's
		// default, so applying the configured level before it would be
		// overwritten.
		const modelSpec = stepSettings.model;
		let modelResolved = true;
		if (modelSpec) {
			const model = resolveModel(ctx, modelSpec);
			if (!model) {
				ctx.ui.notify(`Workflow settings: unknown model "${modelSpec}" for step "${step}".`, "warning");
				modelResolved = false;
			} else {
				try {
					const ok = await pi.setModel(model);
					if (!ok) {
						ctx.ui.notify(`Workflow settings: no API key available for model "${modelSpec}".`, "warning");
					}
				} catch (err) {
					ctx.ui.notify(
						`Workflow settings: could not switch to model "${modelSpec}" — ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			}
		}

		// A bogus model spec is a user error: skip the thinking level too, so
		// an effort level is never applied against an unswitched model. Only
		// resolution failure returns here — setModel failing for auth reasons
		// (no key / throw) falls through, since the model didn't change and
		// applying the configured level is harmless. Anything added below this
		// guard is automatically skipped on model failure too.
		if (!modelResolved) return;

		const thinkingLevel = stepSettings.thinkingLevel;
		if (thinkingLevel) {
			pi.setThinkingLevel(thinkingLevel as ThinkingLevel);
			// setThinkingLevel clamps to the model's capabilities; warn when the
			// effective level differs from the configured one (e.g. a
			// non-reasoning model clamps everything to "off").
			const effective = pi.getThinkingLevel();
			if (effective !== thinkingLevel) {
				ctx.ui.notify(
					`Workflow settings: thinking level "${thinkingLevel}" for step "${step}" was clamped to "${effective}" by the model.`,
					"warning",
				);
			}
		}
	}

	// One-time per-session-start notice about a corrupt global settings file
	// (warned with its full path, so it can be fixed manually). Dedupes per process.
	pi.on("session_start", async (_event, ctx) => {
		readSettingsTier(globalSettingsFilePath(), ctx);
	});

	// Applied once per step session (first turn). In-memory per session instance,
	// so a user's manual model change later in the session is not overridden.
	const configuredSessionFiles = new Set<string>();

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = readState(ctx.cwd, ctx);
		if (!state) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		if (state.sessions[state.step] !== sessionFile) return;
		if (configuredSessionFiles.has(sessionFile)) return;
		configuredSessionFiles.add(sessionFile);
		await applyModelAndEffort(ctx, state.step);
	});

	// ------------------------------------------------------------------
	// /done and /abandon → destroy sessions and artifacts
	// ------------------------------------------------------------------

	/**
	 * Deletes everything the workflow owns: its session files (from
	 * `state.sessions`), the branch's artifact files, and the state file.
	 * Best-effort throughout — ENOENT (already gone) is silently ignored,
	 * anything else is reported as a warning without aborting.
	 * @returns true when the cleanup fully completed (state file removed or
	 * already absent), false when it failed and the state file survives.
	 */
	function performCleanup(state: WorkflowState, ctx: ExtensionCommandContext): boolean {
		const cwd = ctx.cwd;

		// Session files. Dedupe: /icode and /ireview reuse the code/review paths.
		for (const sessionFile of new Set(Object.values(state.sessions).filter((f): f is string => typeof f === "string"))) {
			try {
				unlinkSync(sessionFile);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					ctx.ui.notify(`Could not delete session file "${sessionFile}" — ${err instanceof Error ? err.message : String(err)}`, "warning");
				}
			}
		}

		// The branch's artifact dir — all of this branch's artifacts
		// (start/plan/code/review) live in one directory, so a single
		// recursive delete removes them all. force: true makes rmSync
		// ENOENT-silent; anything else it throws is reported.
		const workflowRoot = workflowRootFor(cwd);
		const branchDir = join(workflowRoot, state.branch);
		try {
			rmSync(branchDir, { recursive: true, force: true });
		} catch (err) {
			ctx.ui.notify(`Could not remove workflow directory "${branchDir}" — ${err instanceof Error ? err.message : String(err)}`, "warning");
		}

		// The repo-level dir, when it is now empty. rmdir only removes a
		// directory when it is empty, so ENOENT (never created) and ENOTEMPTY
		// (other branches' dirs remain) are the expected outcomes; anything
		// else is reported.
		try {
			rmdirSync(workflowRoot);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY") {
				ctx.ui.notify(`Could not remove workflow directory "${workflowRoot}" — ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		}

		// The state file last — nothing else can mark this workflow as gone.
		// The success notification only fires when the state file is actually
		// gone (deleted, or already absent); a failed unlink means the cleanup
		// is incomplete and the warnings above already said why.
		let stateFileRemoved = false;
		try {
			unlinkSync(stateFilePath(cwd));
			stateFileRemoved = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				stateFileRemoved = true;
			} else {
				ctx.ui.notify(`Could not delete the workflow state file — ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		}

		if (stateFileRemoved) {
			ctx.ui.notify("Workflow cleaned up.", "info");
		}
		return stateFileRemoved;
	}

	/**
	 * Leaves the current session (it is one of the tracked workflow sessions,
	 * so its file cannot be unlinked while in use) and runs the cleanup from
	 * the fresh "Clean slate" session. Returns true when the cleanup fully
	 * completed (state file removed), false when it failed, and null when the
	 * session creation was cancelled (cleanup never ran).
	 *
	 * `after` runs inside `withSession` after the cleanup, with the fresh
	 * session ctx and the cleanup result — the documented pattern for work
	 * that must happen after the session replacement: the old command ctx is
	 * stale there, so anything that reports on the outcome must use `sctx`.
	 */
	async function switchToCleanSlate(
		state: WorkflowState,
		ctx: ExtensionCommandContext,
		command: string,
		after?: (sctx: ExtensionCommandContext, cleanupResult: boolean) => void | Promise<void>,
	): Promise<boolean | null> {
		const parentSession = ctx.sessionManager.getSessionFile();
		let cleanupResult = false;
		const result = await ctx.newSession({
			parentSession,
			setup: async (sm) => {
				sm.appendSessionInfo("Clean slate");
			},
			withSession: async (sctx) => {
				cleanupResult = performCleanup(state, sctx);
				if (after) await after(sctx, cleanupResult);
			},
		});
		if (result.cancelled) {
			ctx.ui.notify(`Session creation cancelled — /${command} not performed.`, "warning");
			return null;
		}
		return cleanupResult;
	}

	/**
	 * /done is pure extension teardown — no agent session. In order:
	 * validate the transition (ship or done state), read the plan metadata
	 * (Base branch required; Delete remote branch defaults to true), mark the
	 * state `step: "done"` so a failed run is retryable, then the git work:
	 * remote branch deletion (plan-gated, best-effort — absent is detected
	 * via `git ls-remote` exit code 2 and skipped silently), checkout of the
	 * base branch (failure aborts with the state intact), local branch
	 * deletion with `-D` (already-gone counts as success). On success the
	 * clean-slate teardown (switchToCleanSlate → performCleanup) removes
	 * sessions and artifacts, then the final summary is reported — so the
	 * summary reflects what actually happened, including a failed cleanup.
	 *
	 * The summary is emitted from the replacement "Clean slate" session (via
	 * the switchToCleanSlate `after` callback): everything it reports — the
	 * remote/tag/tree outcomes, the branch names — is plain data computed
	 * before the switch, and the notify itself runs inside `withSession` on
	 * the fresh `sctx`. The old command ctx is stale after the replacement
	 * and must not be used for the summary. Only the cancellation path keeps
	 * its notify on the old ctx — no replacement occurred there, so it is
	 * still valid.
	 */
	async function runDone(ctx: ExtensionCommandContext): Promise<void> {
		const cwd = ctx.cwd;
		const state = readState(cwd, ctx);
		const check = validateTransition(state, "done");
		if (!check.ok) {
			ctx.ui.notify(check.message, "error");
			return;
		}
		const branch = state!.branch;

		// Plan metadata first — everything below depends on the base branch.
		// A missing or corrupt plan aborts before any state or git change.
		const planPath = artifactPath(cwd, branch, "plan");
		if (!existsSync(planPath)) {
			ctx.ui.notify(`No plan file found at ${planPath} — cannot determine the base branch. /done aborted, nothing destroyed.`, "error");
			return;
		}
		let metadata: PlanMetadata;
		try {
			metadata = parsePlanMetadata(readFileSync(planPath, "utf-8"));
		} catch {
			ctx.ui.notify(`Could not read the plan file at ${planPath} — /done aborted, nothing destroyed.`, "error");
			return;
		}
		if (!metadata.baseBranch) {
			ctx.ui.notify(`The plan file at ${planPath} has no \"Base branch\" metadata — it may be corrupt. /done aborted, nothing destroyed.`, "error");
			return;
		}
		const baseBranch = metadata.baseBranch;
		const deleteRemote = metadata.deleteRemoteBranch ?? true;

		// Mark the workflow "done" before any git work: a failed or
		// interrupted /done leaves a retryable state.
		writeState(cwd, { step: "done", branch, sessions: state!.sessions });

		// (a) Remote branch deletion is plan-gated.
		let remoteOutcome: string;
		if (!deleteRemote) {
			remoteOutcome = "kept per plan (Delete remote branch: false)";
			ctx.ui.notify(`The plan declares Delete remote branch: false — the remote branch ${branch} is intentionally kept on origin.`, "info");
		} else {
			const remote = deleteRemoteBranch(cwd, branch, "Continuing, the local teardown is unaffected.");
			remoteOutcome = remote.outcome;
			if (remote.warning) ctx.ui.notify(remote.warning, "warning");
		}

		// (b) Switch to the base branch. Failure aborts before anything is
		// destroyed — the state file (step "done") stays for a retry.
		const co = checkoutBranch(cwd, baseBranch);
		if (!co.ok) {
			ctx.ui.notify(
				`Could not switch to the base branch ${baseBranch} — ${co.stderr}. /done aborted; nothing was destroyed and the workflow state is intact — /done can be re-run.`,
				"error",
			);
			return;
		}

		// (c) Delete the local feature branch. A branch that is already gone
		// (git's "not found" error, exit 1) is the ENOENT-equivalent — a
		// previous run deleted it — and counts as success. Anything else
		// aborts with the state intact.
		const del = deleteLocalBranch(cwd, branch);
		if (!del.ok) {
			ctx.ui.notify(
				`Could not delete the local branch ${branch} — ${del.stderr}. /done aborted; nothing was destroyed and the workflow state is intact — /done can be re-run.`,
				"error",
			);
			return;
		}

		// (f) Success: the tag outcome is reported, not performed — /ship creates
		// and pushes the tag; /done only verifies the local tag's existence.
		let tagOutcome: string;
		if (metadata.tagRelease === true && metadata.newVersion) {
			const tagName = metadata.newVersion;
			const tag = gitCommand(cwd, ["tag", "--list", tagName]);
			if (tag.ok && tag.output) {
				tagOutcome = `${tagName} — created by /ship (see the ship session's report for the push outcome)`;
			} else if (tag.ok) {
				tagOutcome = `${tagName} — not found locally; /ship may have skipped or failed it (see the ship session's report)`;
			} else {
				tagOutcome = `unverifiable — ${tag.stderr}`;
			}
		} else if (metadata.tagRelease === true) {
			tagOutcome = "declared but no New version in the plan — see the ship session's report";
		} else {
			tagOutcome = "none (the plan declares no tag)";
		}

		const tree = gitCommand(cwd, ["status", "--porcelain"]);
		const treeState = tree.ok ? (tree.output ? `not clean:\n${tree.output}` : "clean") : "unknown";

		// The summary lines are built here, before the session replacement:
		// plain strings/ids, explicitly safe to capture across it. Only the
		// cleanup-dependent outcomes are derived in the callback (from the
		// cleanup result) and in the cancellation branch below.
		const summary = (artifactsOutcome: string, sessionOutcome: string) =>
			[
				`Workflow \"${branch}\" torn down.`,
				`- Remote branch: ${remoteOutcome}`,
				`- Local branch ${branch}: deleted`,
				`- Current branch: ${baseBranch}`,
				`- Working tree: ${treeState}`,
				`- Release tag: ${tagOutcome}`,
				`- Workflow sessions and artifacts: ${artifactsOutcome}`,
				`- Session: ${sessionOutcome}`,
			].join("\n");

		// (f) Success: the clean-slate teardown runs first, then the final
		// summary — the summary reports what actually happened (a failed
		// cleanup is reflected in the artifacts line, not contradicted by it).
		// The summary is emitted from the replacement session via `after`;
		// the old ctx is stale once the replacement happened.
		const cleanupResult = await switchToCleanSlate(state!, ctx, "done", (sctx, result) => {
			const artifactsOutcome = result ? "removed" : "cleanup incomplete — see the warnings above";
			sctx.ui.notify(summary(artifactsOutcome, "Clean slate"), "info");
		});
		if (cleanupResult === null) {
			// Cancellation path: no replacement occurred, so the old ctx is
			// still valid here.
			ctx.ui.notify(summary("cleanup cancelled (session creation cancelled)", "not created (creation cancelled)"), "info");
		}
	}


	/**
	 * /abandon bypasses the state machine: valid from any step, with a
	 * confirmation prompt. Unlike /done (fail-closed at a known-good
	 * checkpoint), /abandon runs mid-chaos and degrades instead of blocking:
	 * the workflow teardown (its primary function) must not depend on git
	 * being fixable, so every git step is best-effort — a failure warns and
	 * the teardown proceeds, and the summary tells the user what to finish
	 * manually.
	 *
	 * Branch behavior matrix (authoritative):
	 * 1. on feature + base exists: reset --hard + clean -fd → checkout base →
	 *    delete feature → remote best-effort → artifact cleanup
	 * 2. on base + feature exists: tree untouched → delete feature → remote
	 *    best-effort → artifact cleanup; stay on base
	 * 3. on base + no feature: remote best-effort → artifact cleanup
	 * 4. on feature + base missing: checkout fails → warn with git's stderr,
	 *    skip the local delete (the checked-out branch cannot be deleted),
	 *    proceed with artifact cleanup; summary reports git cleanup incomplete
	 * 5. on other + feature exists: tree + current branch untouched → delete
	 *    feature → remote best-effort → artifact cleanup; stay put
	 * 6. on other + no feature: remote best-effort → artifact cleanup
	 *
	 * The base branch comes from the start artifact's `Base branch` metadata
	 * (start.md always exists post-/start). Missing/unreadable/metadata-less
	 * → warn, artifact cleanup only, no git ops at all.
	 */
	async function runAbandon(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const cwd = ctx.cwd;
		const state = readState(cwd, ctx);
		if (!state) {
			// --force covers the one case plain /abandon cannot: a corrupt or
			// unreadable state file. Sessions and artifacts can't be located
			// without a readable state (and must not be guessed at), so only
			// the state file itself is removed.
			const force = args.split(/\s+/).includes("--force");
			if (force && existsSync(stateFilePath(cwd))) {
				const confirmed = await ctx.ui.confirm(
					"Delete corrupt workflow state file?",
					"The workflow state cannot be read, so sessions and artifacts cannot be located. Git state is untouched.",
				);
				if (!confirmed) return;
				try {
					unlinkSync(stateFilePath(cwd));
					ctx.ui.notify("Corrupt workflow state file removed. Git state untouched.", "info");
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
						ctx.ui.notify(`Could not delete the workflow state file — ${err instanceof Error ? err.message : String(err)}`, "warning");
					}
				}
				return;
			}
			ctx.ui.notify("No active workflow — nothing to abandon.", "info");
			return;
		}
		const branch = state.branch;

		// Base branch from the start artifact — /abandon is valid from any
		// step, including before /plan exists, so the plan is never consulted
		// for it. Reuse the regex-based parsePlanMetadata: section-agnostic,
		// so start.md's own Metadata block parses the same way as plan.md's.
		const startPath = artifactPath(cwd, branch, "start");
		let baseBranch: string | null = null;
		try {
			baseBranch = parsePlanMetadata(readFileSync(startPath, "utf-8")).baseBranch;
		} catch {
			baseBranch = null;
		}

		// The current branch determines both the confirm text and the git
		// sequence (destructive ops only run on the feature branch). A failed
		// read (not a repo) or detached HEAD (empty output) counts as "other".
		const currentBranch = gitCommand(cwd, ["branch", "--show-current"]).output;

		// Remote deletion is plan-respecting when a plan exists: `Delete
		// remote branch: false` → keep; absent line or no plan → delete.
		let deleteRemote = true;
		const planPath = artifactPath(cwd, branch, "plan");
		if (existsSync(planPath)) {
			try {
				if (parsePlanMetadata(readFileSync(planPath, "utf-8")).deleteRemoteBranch === false) deleteRemote = false;
			} catch {
				// unreadable plan — treat as no plan (delete)
			}
		}

		const confirmTitle = `Abandon workflow on branch ${branch}?`;
		let confirmBody: string;
		if (!baseBranch) {
			confirmBody =
				"Could not determine the base branch — git state will be left untouched. This will delete all workflow sessions and artifacts.";
		} else if (currentBranch === branch) {
			confirmBody = `This will discard all uncommitted changes on \`${branch}\`, switch to \`${baseBranch}\`, delete \`${branch}\` locally and on origin, and remove all workflow sessions and artifacts.`;
		} else {
			const currentLabel = currentBranch === "" ? "detached HEAD" : currentBranch;
			confirmBody = `This will delete feature branch \`${branch}\` locally and on origin; you stay on \`${currentLabel}\`. It removes all workflow sessions and artifacts.`;
		}
		const confirmed = await ctx.ui.confirm(confirmTitle, confirmBody);
		if (!confirmed) return;

		// The static summary lines (plain strings only — safe across the
		// session replacement) plus the shared finish: the artifacts/session
		// outcomes are derived in the `after` callback from the cleanup result
		// (and in the cancellation branch), mirroring /done's summary pattern.
		const finishWithSummary = async (staticLines: string[]) => {
			const summary = (artifactsOutcome: string, sessionOutcome: string) =>
				[`Workflow \"${branch}\" abandoned.`, ...staticLines, `- Workflow sessions and artifacts: ${artifactsOutcome}`, `- Session: ${sessionOutcome}`].join(
					"\n",
				);
			const cleanupResult = await switchToCleanSlate(state, ctx, "abandon", (sctx, result) => {
				const artifactsOutcome = result ? "removed" : "cleanup incomplete — see the warnings above";
				sctx.ui.notify(summary(artifactsOutcome, "Clean slate"), "info");
			});
			if (cleanupResult === null) {
				// Cancellation path: no replacement occurred, so the old ctx is
				// still valid here.
				ctx.ui.notify(summary("cleanup cancelled (session creation cancelled)", "not created (creation cancelled)"), "info");
			}
		};

		if (!baseBranch) {
			// No git ops at all — the workflow teardown never depends on git
			// being usable. The warn names the file so it can be fixed manually.
			ctx.ui.notify(
				`Could not determine the base branch from the start artifact at ${startPath} — git state untouched. Finish any git cleanup manually.`,
				"warning",
			);
			await finishWithSummary(["- Git state: untouched (could not determine the base branch)"]);
			return;
		}

		// (a) Remote branch deletion runs first (mirrors /done's order): if a
		// later step degrades into the warn-and-proceed path, a re-run or
		// manual cleanup is idempotent.
		let remoteOutcome: string;
		let gitIncomplete = false;
		if (!deleteRemote) {
			remoteOutcome = "kept per plan (Delete remote branch: false)";
			ctx.ui.notify(`The plan declares Delete remote branch: false — the remote branch ${branch} is intentionally kept on origin.`, "info");
		} else {
			const remote = deleteRemoteBranch(cwd, branch, "Continuing anyway.");
			remoteOutcome = remote.outcome;
			if (remote.warning) {
				gitIncomplete = true;
				ctx.ui.notify(remote.warning, "warning");
			}
		}

		// (b) Destructive discard only on the feature branch: on any other
		// branch the working tree belongs to the user's deliberate context.
		let checkoutFailed = false;
		let treeOutcome = "left untouched";
		if (currentBranch === branch) {
			const reset = gitCommand(cwd, ["reset", "--hard"]);
			if (!reset.ok) {
				gitIncomplete = true;
				ctx.ui.notify(`Could not discard uncommitted changes (git reset --hard) — ${reset.stderr}. Git cleanup is incomplete — finish manually.`, "warning");
			}
			const clean = gitCommand(cwd, ["clean", "-fd"]);
			if (!clean.ok) {
				gitIncomplete = true;
				ctx.ui.notify(`Could not remove untracked files (git clean -fd) — ${clean.stderr}. Git cleanup is incomplete — finish manually.`, "warning");
			}
			// Reported after both attempts: "discarded" is only truthful when
			// reset and clean both succeeded — a failed reset leaves tracked
			// modifications in place, a failed clean leaves untracked files.
			treeOutcome =
				reset.ok && clean.ok
					? "discarded (uncommitted changes lost)"
					: `partially discarded (${reset.ok ? "clean" : "reset"} failed — see warning)`;
			const co = checkoutBranch(cwd, baseBranch);
			if (!co.ok) {
				checkoutFailed = true;
				gitIncomplete = true;
				ctx.ui.notify(`Could not switch to the base branch ${baseBranch} — ${co.stderr}. Git cleanup is incomplete — finish manually.`, "warning");
			}
		}

		// (c) Local branch deletion. Skipped when the checkout failed: the
		// feature branch is still checked out and cannot be deleted. A branch
		// that is already gone counts as success (deleteLocalBranch).
		let localOutcome = "deleted";
		if (checkoutFailed) {
			localOutcome = `kept — still checked out (could not switch to ${baseBranch})`;
		} else {
			const del = deleteLocalBranch(cwd, branch);
			if (!del.ok) {
				localOutcome = "deletion failed (see warning)";
				gitIncomplete = true;
				ctx.ui.notify(`Could not delete the local branch ${branch} — ${del.stderr}. Git cleanup is incomplete — finish manually.`, "warning");
			}
		}

		const currentLabel = currentBranch === "" ? "detached HEAD" : currentBranch;
		let currentOutcome: string;
		if (checkoutFailed) {
			currentOutcome = `${branch} (could not switch to ${baseBranch})`;
		} else if (currentBranch === branch) {
			currentOutcome = baseBranch;
		} else {
			currentOutcome = `${currentLabel} (unchanged)`;
		}

		await finishWithSummary([
			`- Remote branch: ${remoteOutcome}`,
			`- Local branch ${branch}: ${localOutcome}`,
			`- Current branch: ${currentOutcome}`,
			`- Working tree: ${treeOutcome}`,
			...(gitIncomplete ? ["- Git cleanup incomplete — finish manually."] : []),
		]);
	}

	for (const name of WORKFLOW_COMMANDS) {
		pi.registerCommand(name, {
			description:
				name === "done"
					? "Workflow teardown — delete remote/local feature branch and all workflow sessions and artifacts after /ship"
					: name === "abandon"
						? "Workflow abandon — abort from any step: discard uncommitted changes on the feature branch, delete it locally and on origin, and remove all workflow sessions and artifacts"
						: `Workflow step "${name}" — orchestrates the step session (model/effort, state machine)`,
			handler: async (args, ctx) => {
				if (name === "done") {
					await runDone(ctx);
				} else if (name === "abandon") {
					await runAbandon(args.trim(), ctx);
				} else {
					await runStep(name, args.trim(), ctx);
				}
			},
		});
	}

	// /piflux view — read-only artifact and state viewer (view.ts), built once
	// with the state reader and next-commands table. It can never register as
	// an extension itself: the manifest pins pi.extensions to index.ts and the
	// module only exports the factory plus pure helpers.
	const workflowViewer = createWorkflowViewer({ readState, nextCommands: NEXT_COMMANDS });

	pi.registerCommand("piflux", {
		description: "Workflow orchestrator — state, settings, view",
		getArgumentCompletions: (prefix: string) => {
			// Second-token completion for `/piflux view <TAB>` first. The
			// completion callback has no ctx/cwd, so the state is read from
			// process.cwd() — readState is null-safe (absent file → null), and
			// a null state yields no target suggestions, gracefully degrading
			// to the first-token filter below. Never throws: viewArgumentCompletions
			// returns null on any doubt.
			const viewItems = viewArgumentCompletions(prefix, readState(process.cwd()), process.cwd());
			if (viewItems) return viewItems;
			// First-token filter. The "view" value carries a trailing space:
			// pi's argument completion replaces only the argument text (no
			// space is appended), and the editor never opens the autocomplete
			// popup on a bare space nor via TAB after one — so without it,
			// accepting "view" strands the line at "/piflux view" and the
			// target completions are unreachable without typing a letter
			// anyway. The space restores pi's own /model flow: accept the
			// subcommand, then type the first target letter to pop the list.
			const items = [
				{ value: "state", label: "state" },
				{ value: "settings", label: "settings" },
				{ value: "view ", label: "view" },
			];
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/);
			switch (tokens[0]) {
				case "":
				case "state":
					if (tokens.length === 1) {
						showWorkflowState(ctx);
						return;
					}
					break;
				case "settings":
					if (tokens.length === 1) {
						await runSettingsOverlay(ctx);
						return;
					}
					break;
				case "view":
					if (tokens.length === 1) {
						await workflowViewer(ctx);
						return;
					}
					if (tokens.length === 2 && isViewTarget(tokens[1])) {
						await workflowViewer(ctx, tokens[1]);
						return;
					}
					ctx.ui.notify("Usage: /piflux view [state|start|plan|code|review]", "warning");
					return;
			}
			ctx.ui.notify("Usage: /piflux [state|settings|view]", "warning");
		},
	});

	// ------------------------------------------------------------------
	// /piflux subcommand implementations
	// ------------------------------------------------------------------

	function showWorkflowState(ctx: ExtensionCommandContext): void {
		const state = readState(ctx.cwd, ctx);
		if (!state) {
			ctx.ui.notify("No active workflow. Run /start <branch> to begin.", "info");
			return;
		}
		const sessionSteps = Object.keys(state.sessions).join(", ") || "none";
		ctx.ui.notify(
			[
				`Workflow step: ${state.step}`,
				`Branch: ${state.branch}`,
				`Next: ${NEXT_COMMANDS[state.step].join(", ")}`,
				`Sessions: ${sessionSteps}`,
				`Run /abandon to destroy the workflow, discard uncommitted changes, and return to the base branch.`,
			].join("\n"),
			"info",
		);
	}

	// ------------------------------------------------------------------
	// /piflux settings overlay
	// ------------------------------------------------------------------

	/** Models offered by the picker: scoped models when scoping is active, the full catalogue otherwise. */
	function overlayModels(ctx: ExtensionContext): OverlayModel[] {
		const scoped = ctx.scopedModels;
		if (scoped && scoped.length > 0) return scoped.map((s) => s.model);
		return ctx.modelRegistry.getAvailable();
	}

	function selectListTheme(theme: { fg: (color: string, text: string) => string }) {
		return {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		};
	}

	/** Effective-config summary for a step row: `code — anthropic/claude-sonnet-4-5 · high`, or `unset · default: high`. */
	function stepSummary(step: StepName, fileStep: StepSettings | undefined): string {
		const model = typeof fileStep?.model === "string" ? fileStep.model : "unset";
		const level = fileStep?.thinkingLevel ?? null;
		const defaultLevel = DEFAULT_SETTINGS.steps[step]?.thinkingLevel;
		if (level) return `${model} · ${level}`;
		return defaultLevel ? `${model} · default: ${defaultLevel}` : model;
	}

	/**
	 * Opens the three-screen settings overlay (step → model → level). Only a
	 * completed level pick (or a backspace-unset on the step screen) writes to
	 * the settings file; Esc anywhere walks back a screen with nothing written.
	 * TUI-only: in other modes it notifies an error and returns.
	 */
	async function runSettingsOverlay(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/piflux settings is only available in the interactive TUI.", "error");
			return;
		}
		const file = globalSettingsFilePath();

		const models = overlayModels(ctx);
		if (models.length === 0) {
			ctx.ui.notify("No models available — cannot configure workflow settings.", "error");
			return;
		}

		// Screen 1: pick a step. Backspace unsets the selected step in place
		// (rebuilding the list), Enter opens the model picker, Esc closes.
		const stepPicker = () =>
			ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Workflow settings — step")), 1, 0));

				const buildList = () => {
					const fileSteps = readSettingsTier(file);
					const list = new SelectList(
						WORKFLOW_COMMANDS.map((step) => ({
							value: step,
							label: step,
							description: stepSummary(step, fileSteps[step]),
						})),
						Math.min(WORKFLOW_COMMANDS.length, 10),
						selectListTheme(theme),
					);
					list.onSelect = (item) => done(item.value);
					list.onCancel = () => done(null);
					return list;
				};
				let list = buildList();
				container.addChild(list);

				container.addChild(new Text(theme.fg("dim", "enter: select step · backspace: unset · esc: close"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.backspace)) {
							const item = list.getSelectedItem();
							if (item && unsetStepInFile(file, item.value as StepName)) {
								ctx.ui.notify(`Workflow settings: step "${item.value}" unset — defaults apply again.`, "info");
								container.removeChild(list);
								list = buildList();
								container.addChild(list);
							}
						}
						list.handleInput(data);
						tui.requestRender();
					},
				};
			});

		// Screen 2: pick a model (scoped models, or the full catalogue when
		// nothing is scoped). Esc returns to the step picker.
		const modelPicker = (step: StepName) =>
			ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold(`Workflow settings — model (${step})`)), 1, 0));

				const list = new SelectList(
					models.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` })),
					Math.min(models.length, 10),
					selectListTheme(theme),
				);
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(null);
				container.addChild(list);

				container.addChild(new Text(theme.fg("dim", "enter: select model · esc: back"), 1, 0));
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

		// Screen 3: pick a thinking level for the chosen model. Enter writes the
		// step (model + level atomically) and returns to the step picker; Esc
		// returns to the model picker with nothing written.
		const levelPicker = (step: StepName, model: OverlayModel) =>
			ctx.ui.custom<ThinkingLevel | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(
					new Text(theme.fg("accent", theme.bold(`Workflow settings — level (${model.provider}/${model.id})`)), 1, 0),
				);

				const levels = levelsForModel(model);
				const list = new SelectList(
					levels.map((level) => ({ value: level, label: level })),
					Math.min(levels.length, 10),
					selectListTheme(theme),
				);
				list.onSelect = (item) => done(item.value as ThinkingLevel);
				list.onCancel = () => done(null);
				container.addChild(list);

				container.addChild(new Text(theme.fg("dim", "enter: select level · esc: back"), 1, 0));
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

		// Sequential screens, each overlay replacing the previous one. Esc
		// walks back one screen; only a completed level pick (or a
		// backspace-unset) writes to the file.
		while (true) {
			const step = await stepPicker();
			if (!step) return; // closed
			while (true) {
				const spec = await modelPicker(step);
				if (!spec) break; // back to the step picker
				const model = models.find((m) => `${m.provider}/${m.id}` === spec);
				if (!model) break; // defensive — the picker only lists known models
				const level = await levelPicker(step, model);
				if (!level) continue; // back to the model picker
				if (setStepInFile(file, step, { model: spec, thinkingLevel: level })) {
					ctx.ui.notify(`Workflow settings: ${step} → ${spec} · ${level}`, "info");
				} else {
					ctx.ui.notify(`Workflow settings not saved — ${file} is corrupt. Fix or delete the file first.`, "error");
				}
				break; // back to the step picker
			}
		}
	}

}
