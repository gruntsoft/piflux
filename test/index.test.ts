/**
 * Unit tests for the workflow orchestrator extension.
 *
 * Runs with `npm test` (node's built-in test runner + type stripping — no
 * dependencies). The `@earendil-works/pi-coding-agent` import is mapped to
 * `./pi-coding-agent-stub.ts` via `./hooks.mjs`, and the extension is driven
 * through a fake `pi` API + fake session contexts, so the full state machine,
 * session lifecycle, template expansion, and model/effort logic are exercised
 * without a TUI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

register(new URL("./hooks.mjs", import.meta.url));

const extensionModule = await import("../extensions/index.ts");
const { substituteArgs, mergeStepSettings, serializeSettings, setStepInFile, unsetStepInFile, levelsForModel, parsePlanMetadata } = extensionModule;

const pathsModule = await import("../extensions/paths.ts");
const { encodeSessionDirName, workflowRootFor } = pathsModule;

const viewModule = await import("../extensions/view.ts");
const { formatRelativeTime, buildSelectorItems, renderStateSummary, artifactPath, clampScrollTop, keyToScrollDelta, parseWheelEvent, scrollPercent, createWorkflowViewer, VIEW_TARGETS, isViewTarget, viewArgumentCompletions } = viewModule;

// ---------------------------------------------------------------------------
// Harness: fake pi + fake session contexts in a throwaway project directory
// ---------------------------------------------------------------------------

// The step templates are read from the package's own workflow-templates
// directory (resolved from the extension file), not from the project — pi's
// auto-discovery is intentionally bypassed, so the harness injects no templates.

interface Harness {
	projectDir: string;
	globalDir: string;
	stateFile: string;
	settingsFile: string;
	globalSettingsFile: string;
	commands: Map<
		string,
		{
			description?: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
			handler: (args: string, ctx: unknown) => Promise<void> | void;
		}
	>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
	baseCtx: unknown;
	commandCtx: () => unknown;
	sentMessages: string[];
	notifications: Array<{ msg: string; type: string }>;
	thinkingLevels: string[];
	modelCalls: Array<{ provider: string; id: string }>;
	sessionName: () => string | undefined;
	currentSessionFile: () => string | undefined;
	setCurrentSessionFile: (file: string | undefined) => void;
	readState: () => { step: string; branch: string; sessions: Record<string, string> };
	/** When true, the next newSession call returns { cancelled: true }. */
	setCancelNewSession: (cancel: boolean) => void;
	/** When true, the next switchSession call returns { cancelled: true }. */
	setCancelSwitchSession: (cancel: boolean) => void;
	/** "ok" (default) | "no-key" (setModel returns false) | "throw" (setModel throws). */
	setModelBehavior: (behavior: "ok" | "no-key" | "throw") => void;
	/** Result the fake ui.confirm returns (default false = cancel). */
	setConfirmResult: (result: boolean) => void;
	/** Title/body pairs the fake confirm was invoked with, in call order. */
	confirmCalls: () => string[];
	/** Run mode for ctx.mode (default "tui"). */
	setMode: (mode: "tui" | "print") => void;
	/** Number of times the fake ui.custom was invoked. */
	customCalls: () => number;
	destroy: () => void;
}

function createHarness(): Harness {
	const projectDir = mkdtempSync(join(tmpdir(), "piflux-test-"));
	const globalDir = mkdtempSync(join(tmpdir(), "piflux-global-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = globalDir;
	// The repo-level workflow root, mirroring the old harness default that
	// created the start dir under the project: it exists (empty) so /plan's
	// "empty start directory" case is distinguishable from a never-created root.
	mkdirSync(join(globalDir, "piflux", "workflows", encodeSessionDirName(projectDir)), { recursive: true });
	mkdirSync(join(projectDir, ".pi", "piflux"), { recursive: true });
	mkdirSync(join(globalDir, "piflux"), { recursive: true });

	const stateFile = join(workflowRootFor(projectDir), "workflow-orchestration.json");
	const settingsFile = join(projectDir, ".pi", "piflux", "settings.json");
	const globalSettingsFile = join(globalDir, "piflux", "settings.json");

	let currentSessionFile: string | undefined = join(projectDir, "sessions", "root.jsonl");
	let nextSessionId = 0;
	let capturedSessionName: string | undefined;
	let cancelNewSession = false;
	let cancelSwitchSession = false;
	let modelBehavior: "ok" | "no-key" | "throw" = "ok";
	let confirmResult = false;
	let mode: "tui" | "print" = "tui";
	let customCalls = 0;
	// Session-replacement generation: incremented on every successful
	// newSession/switchSession. Each ui captures the generation at creation
	// and throws the real stale-ctx error when used after a later
	// replacement — mirroring pi's session-replacement footgun so the harness
	// would have caught the /done summary bug.
	let generation = 0;
	const confirmInputs: string[] = [];
	const sentMessages: string[] = [];
	const notifications: Array<{ msg: string; type: string }> = [];
	const thinkingLevels: string[] = [];
	const modelCalls: Array<{ provider: string; id: string }> = [];
	const commands = new Map<
		string,
		{
			description?: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
			handler: (args: string, ctx: unknown) => Promise<void> | void;
		}
	>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>();

	const availableModels = [
		{ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true },
		{ provider: "openai", id: "gpt-4o", reasoning: false },
	];

	// Session model/thinking-level state, mimicking pi: setModel resets the
	// level to the new model's default, setThinkingLevel clamps to the current
	// model's capabilities.
	let currentModel = availableModels[0];
	let currentThinkingLevel = "medium";

	// A fresh ui captures the generation at creation: notify throws the real
	// stale-ctx error when the session was replaced since. Event and handler
	// invocations receive a freshly minted ui (via the baseCtx getter), so
	// only ctxs captured across a session replacement go stale.
	function makeUi() {
		const gen = generation;
		return {
			notify: (msg: string, type = "info") => {
				if (gen < generation) {
					throw new Error("This extension ctx is stale after session replacement — use the ctx passed to withSession instead.");
				}
				notifications.push({ msg, type });
			},
			// No-op overlay: the settings overlay is manual-verification only.
			// Returning null simulates an immediate close with nothing selected.
			custom: async () => {
				customCalls++;
				return null;
			},
			confirm: async (title: string, body: string) => {
				confirmInputs.push(`${title} ${body}`);
				return confirmResult;
			},
		};
	}

	const baseCtx = {
		cwd: projectDir,
		get mode() {
			return mode;
		},
		scopedModels: [],
		// A getter, not a static object: every access mints a fresh ui that
		// captures the current generation. Intentional — command/session ctxs
		// built from baseCtx capture their own generation (so they go stale on
		// replacement), while event/handler ctxs stay fresh. Not lazy init.
		get ui() {
			return makeUi();
		},
		modelRegistry: {
			find: (provider: string, id: string) => availableModels.find((m) => m.provider === provider && m.id === id),
			getAvailable: () => availableModels,
		},
		sessionManager: { getSessionFile: () => currentSessionFile },
		isIdle: () => true,
	};

	function sessionCtx() {
		return {
			...baseCtx,
			sessionManager: { getSessionFile: () => currentSessionFile },
			sendUserMessage: async (text: string) => sentMessages.push(text),
		};
	}

	function commandCtx(): unknown {
		const ctx = {
			...baseCtx,
			newSession: async (opts: {
				parentSession?: string;
				setup?: (sm: { appendSessionInfo: (name: string) => void }) => Promise<void>;
				withSession?: (sctx: unknown) => Promise<void>;
			}) => {
				if (cancelNewSession) return { cancelled: true };
				generation++;
				currentSessionFile = join(projectDir, "sessions", `new-${nextSessionId++}.jsonl`);
				mkdirSync(join(projectDir, "sessions"), { recursive: true });
				writeFileSync(currentSessionFile, "");
				if (opts.setup) {
					await opts.setup({
						appendSessionInfo: (name: string) => {
							capturedSessionName = name;
							// Simulate the start template, which writes the start artifact
							// for the (sanitized) branch after /start runs.
							const match = name.match(/^piflux: start (.+)$/);
							if (match) writeStartArtifact(projectDir, match[1]);
						},
					});
				}
				if (opts.withSession) {
					await opts.withSession(sessionCtx());
				}
				return { cancelled: false };
			},
			switchSession: async (targetPath: string, opts: { withSession?: (sctx: unknown) => Promise<void> }) => {
				if (cancelSwitchSession) return { cancelled: true };
				generation++;
				currentSessionFile = targetPath;
				if (opts.withSession) {
					await opts.withSession(sessionCtx());
				}
				return { cancelled: false };
			},
		};
		return ctx;
	}

	const pi = {
		registerCommand: (name: string, opts: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
			handler: (args: string, ctx: unknown) => Promise<void> | void;
		}) => commands.set(name, opts),
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		setThinkingLevel: (level: string) => {
			thinkingLevels.push(level);
			currentThinkingLevel = currentModel.reasoning ? level : "off";
		},
		setModel: async (model: { provider: string; id: string; reasoning?: boolean }) => {
			modelCalls.push(model);
			if (modelBehavior === "no-key") return false;
			if (modelBehavior === "throw") throw new Error("no auth for test");
			currentModel = model as { provider: string; id: string; reasoning: boolean };
			// setModel resets the thinking level to the new model's default.
			currentThinkingLevel = currentModel.reasoning ? "medium" : "off";
			return true;
		},
		getThinkingLevel: () => currentThinkingLevel,
	};

	extensionModule.default(pi as unknown as ExtensionAPI);

	return {
		projectDir,
		globalDir,
		stateFile,
		settingsFile,
		globalSettingsFile,
		commands,
		handlers,
		baseCtx,
		commandCtx,
		sentMessages,
		notifications,
		thinkingLevels,
		thinkingLevelNow: () => currentThinkingLevel,
		modelCalls,
		sessionName: () => capturedSessionName,
		currentSessionFile: () => currentSessionFile,
		setCurrentSessionFile: (file: string | undefined) => (currentSessionFile = file),
		setCancelNewSession: (cancel: boolean) => (cancelNewSession = cancel),
		setCancelSwitchSession: (cancel: boolean) => (cancelSwitchSession = cancel),
		setModelBehavior: (behavior: "ok" | "no-key" | "throw") => (modelBehavior = behavior),
		setConfirmResult: (result: boolean) => (confirmResult = result),
		confirmCalls: () => confirmInputs,
		setMode: (m: "tui" | "print") => (mode = m),
		customCalls: () => customCalls,
		readState: () => JSON.parse(readFileSync(stateFile, "utf-8")),
		destroy: () => {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(globalDir, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCommand(h: Harness, name: string, args = ""): Promise<void> {
	const command = h.commands.get(name);
	assert.ok(command, `command /${name} registered`);
	await command.handler(args, h.commandCtx());
}

async function fireEvent(h: Harness, event: string, eventData: unknown = {}): Promise<void> {
	for (const handler of h.handlers.get(event) ?? []) {
		await handler(eventData, { ...(h.baseCtx as object) });
	}
}

async function fireInput(h: Harness, text: string, source: "interactive" | "extension"): Promise<{ action: string; text?: string }> {
	let result: { action: string; text?: string } = { action: "continue" };
	for (const handler of h.handlers.get("input") ?? []) {
		const r = (await handler({ type: "input", text, source }, h.baseCtx)) as { action: string; text?: string };
		if (r?.action) result = r;
	}
	return result;
}

async function fireBeforeAgentStart(h: Harness): Promise<void> {
	for (const handler of h.handlers.get("before_agent_start") ?? []) {
		await handler({ type: "before_agent_start" }, { ...(h.baseCtx as object) });
	}
}

function errorNotifications(h: Harness): string[] {
	return h.notifications.filter((n) => n.type === "error").map((n) => n.msg);
}

function writeStartArtifact(dir: string, branch: string): void {
	const branchDir = join(workflowRootFor(dir), branch);
	mkdirSync(branchDir, { recursive: true });
	writeFileSync(join(branchDir, "start.md"), `# Start: ${branch}\n`);
}

/** Writes a start artifact with the Feature branch/Base branch metadata pair the template produces. */
function writeStartArtifactWithMetadata(dir: string, branch: string, base: string): void {
	const branchDir = join(workflowRootFor(dir), branch);
	mkdirSync(branchDir, { recursive: true });
	writeFileSync(
		join(branchDir, "start.md"),
		`# Start: ${branch}\n\n## Metadata\n- Feature branch: ${branch}\n- Base branch: ${base}\n`,
	);
}

// ---------------------------------------------------------------------------
// Git helpers for the /done teardown tests (real temp repos)
// ---------------------------------------------------------------------------

/** Runs git synchronously in the given cwd (null = process cwd); throws on nonzero exit. */
function git(cwd: string | null, args: string[]): string {
	return execFileSync("git", args, { cwd: cwd ?? undefined, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Initializes a git repo in the harness project dir: base branch "master"
 * with one commit, feature branch "my-feature" checked out, and origin
 * pointing at a fresh local bare repo (master pushed; the feature branch
 * only when requested). Returns the bare repo path — the test must remove it.
 */
function setupGitRepo(h: Harness, opts: { remoteBranch?: boolean } = {}): string {
	const repo = h.projectDir;
	const bare = mkdtempSync(join(tmpdir(), "piflux-remote-"));
	git(null, ["init", "--bare", bare]);
	git(repo, ["init", "-b", "master"]);
	// Mirror the real repo: the fake session files are gitignored, so the
	// /done tree-state check reports a clean tree. Workflow artifacts live
	// outside the repo now, so no ignore entry is needed for them. A tracked
	// file is committed so tests can dirty it and assert the discard.
	writeFileSync(join(repo, ".gitignore"), "sessions/\n");
	writeFileSync(join(repo, "tracked.txt"), "base\n");
	git(repo, ["add", ".gitignore", "tracked.txt"]);
	git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
	git(repo, ["checkout", "-b", "my-feature"]);
	git(repo, ["remote", "add", "origin", bare]);
	git(repo, ["push", "origin", "master"]);
	if (opts.remoteBranch) git(repo, ["push", "origin", "my-feature"]);
	return bare;
}

/** Writes a minimal plan file for branch my-feature with the given extra metadata lines. */
function writePlanFile(h: Harness, extra = "- Delete remote branch: true"): void {
	const branchDir = join(workflowRootFor(h.projectDir), "my-feature");
	mkdirSync(branchDir, { recursive: true });
	writeFileSync(join(branchDir, "plan.md"), `# Test plan\n\n## Metadata\n- Base branch: master\n${extra}\n`);
}

/** Reset the recorded sent-messages list so a test can assert on the next command only. */
function clearSent(h: Harness): void {
	h.sentMessages.length = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("registers all workflow step commands plus /piflux", () => {
	const h = createHarness();
	try {
		for (const name of ["start", "plan", "code", "review", "icode", "ireview", "ship", "done", "abandon", "piflux"]) {
			assert.ok(h.commands.has(name), `/${name} registered`);
		}
		assert.ok(!h.commands.has("cleanup"), "/cleanup is no longer a command");
		assert.ok(h.commands.get("done")!.description?.includes("teardown"), "/done description says teardown");
		assert.ok(
			h.commands.get("abandon")!.description?.includes("discard uncommitted changes"),
			"/abandon description mentions the git cleanup",
		);
	} finally {
		h.destroy();
	}
});

test("/plan from idle is blocked with an error", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "plan", "add user auth");
		assert.ok(errorNotifications(h).some((m) => m.includes("no active workflow")), "error mentions no active workflow");
		assert.ok(!existsSync(h.stateFile), "no state file written");
	} finally {
		h.destroy();
	}
});

test("/start from idle creates a workflow: start session, writes state, sends /start", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "My Feature");
		const state = h.readState();
		assert.equal(state.step, "start");
		assert.equal(state.branch, "my-feature");
		assert.ok(state.sessions.start, "start session path recorded");
		assert.deepEqual(h.sentMessages, ["/start my-feature"], "sanitized branch name forwarded to the start template");
		assert.equal(h.sessionName(), "piflux: start my-feature");
	} finally {
		h.destroy();
	}
});

test("/start without a branch shows usage", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /start")), "usage notification");
		assert.ok(!existsSync(h.stateFile), "no state file");
	} finally {
		h.destroy();
	}
});

test("/piflux bare shows step, branch, and next commands; idle when no workflow", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "piflux", "");
		assert.ok(h.notifications.some((n) => n.msg.includes("No active workflow")), "idle reported");

		h.notifications.length = 0;
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "piflux", "");
		const shown = h.notifications.map((n) => n.msg).join("\n");
		assert.ok(shown.includes("my-feature"), "branch shown");
		assert.ok(shown.includes("/plan"), "next command shown");

		h.notifications.length = 0;
		await runCommand(h, "piflux", "state");
		assert.ok(h.notifications.some((n) => n.msg.includes("start")), "/piflux state shows step");
		assert.ok(
			h.notifications.some((n) => n.msg.includes("Run /abandon to destroy the workflow, discard uncommitted changes, and return to the base branch.")),
			"/piflux state hint reflects the git cleanup",
		);
	} finally {
		h.destroy();
	}
});

test("/plan from start creates the plan session and the template expands for extension-sourced messages", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		clearSent(h);
		await runCommand(h, "plan", "add user auth");
		const state = h.readState();
		assert.equal(state.step, "plan");
		assert.ok(state.sessions.plan, "plan session path recorded");
		assert.deepEqual(h.sentMessages, ["/plan add user auth"]);
		assert.equal(h.sessionName(), "piflux: plan my-feature");

		// The new session receives the raw command with source "extension";
		// the input handler must expand the plan template (resolved from the
		// package's workflow-templates directory, not pi's auto-discovery).
		const result = await fireInput(h, "/plan add user auth", "extension");
		assert.equal(result.action, "transform");
		assert.ok(result.text.includes("**add user auth**"), "description substituted into the template body");
		assert.ok(!result.text.includes("description:"), "frontmatter stripped");

		// Interactive input is not transformed by the extension.
		const interactive = await fireInput(h, "/plan add user auth", "interactive");
		assert.equal(interactive.action, "continue");
	} finally {
		h.destroy();
	}
});

test("/plan without a start artifact is blocked", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		rmSync(join(workflowRootFor(h.projectDir), "my-feature"), { recursive: true, force: true });
		await runCommand(h, "plan", "desc");
		assert.ok(errorNotifications(h).some((m) => m.includes("No start artifact")), "artifact error shown");
	} finally {
		h.destroy();
	}
});

test("branch name for /plan comes from the most recent start artifact", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "old-feature");
		const newArtifact = join(workflowRootFor(h.projectDir), "new-feature", "start.md");
		mkdirSync(join(workflowRootFor(h.projectDir), "new-feature"), { recursive: true });
		writeFileSync(newArtifact, "# Start: new-feature\n");
		// Ensure the new artifact is strictly newer (mtime), not just created later.
		const future = new Date(Date.now() + 5000);
		utimesSync(newArtifact, future, future);
		await runCommand(h, "plan", "desc");
		assert.equal(h.sessionName(), "piflux: plan new-feature");
	} finally {
		h.destroy();
	}
});

test("full chain: code → review → icode → ireview → ship, with session reuse", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "plan", "desc");
		await runCommand(h, "code");
		assert.equal(h.readState().step, "code");
		assert.equal(h.sessionName(), "piflux: code my-feature");

		await runCommand(h, "review");
		assert.equal(h.readState().step, "review");

		const codePath = h.readState().sessions.code;
		clearSent(h);
		await runCommand(h, "icode");
		let state = h.readState();
		assert.equal(state.step, "icode");
		assert.equal(state.sessions.icode, codePath, "icode reuses the code session path");
		assert.equal(h.currentSessionFile(), codePath, "switched back to the code session");
		assert.deepEqual(h.sentMessages, ["/icode"]);

		const reviewPath = h.readState().sessions.review;
		await runCommand(h, "ireview");
		state = h.readState();
		assert.equal(state.step, "ireview");
		assert.equal(state.sessions.ireview, reviewPath, "ireview reuses the review session path");
		assert.equal(h.currentSessionFile(), reviewPath, "switched back to the review session");

		await runCommand(h, "ship");
		assert.equal(h.readState().step, "ship");
	} finally {
		h.destroy();
	}
});

test("invalid transitions are blocked with the valid next commands", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "plan", "desc");

		h.notifications.length = 0;
		await runCommand(h, "ship");
		const msg = errorNotifications(h).find((m) => m.includes("/ship"));
		assert.ok(msg, "/ship from plan blocked");
		assert.ok(msg.includes("/code"), "error lists valid next commands");

		h.notifications.length = 0;
		await runCommand(h, "start", "other");
		assert.ok(errorNotifications(h).some((m) => m.includes("already active")), "/start while active blocked");

		h.notifications.length = 0;
		await runCommand(h, "piflux", "start other");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /piflux")), "/piflux start is an unknown subcommand");
	} finally {
		h.destroy();
	}
});

test("/done is gated behind ship (retryable from done) and blocked from idle", async () => {
	const h = createHarness();
	try {
		// Idle: no workflow → blocked.
		await runCommand(h, "done");
		assert.ok(errorNotifications(h).some((m) => m.includes("no active workflow")), "blocked from idle");

		// Mid-workflow: only valid from "ship" (or "done" for a retry).
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "plan", "desc");
		await runCommand(h, "code");
		await runCommand(h, "review");
		h.notifications.length = 0;
		await runCommand(h, "done");
		const msg = errorNotifications(h).find((m) => m.includes("/done"));
		assert.ok(msg, "/done blocked mid-workflow");
		assert.ok(msg.includes("/icode"), "error lists the valid next commands");
		assert.ok(existsSync(h.stateFile), "state file untouched");
		assert.equal(h.readState().step, "review", "state unchanged");
	} finally {
		h.destroy();
	}
});

test("/done from ship tears down git, sessions, artifacts, and state, landing in Clean slate", async () => {
	const h = createHarness();
	let bare = "";
	try {
		// Real repo: origin exists, feature branch never pushed (the common case).
		bare = setupGitRepo(h);
		writePlanFile(h);

		// Workflow state at "ship" with real session files.
		const sessions = { start: join(h.projectDir, "sessions", "start.jsonl") };
		mkdirSync(join(h.projectDir, "sessions"), { recursive: true });
		writeFileSync(sessions.start, "");
		writeFileSync(h.stateFile, JSON.stringify({ step: "ship", branch: "my-feature", sessions }));

		// The branch's artifacts; other branches' artifacts and untracked
		// session files must survive. The plan artifact is the real plan file
		// (written above — the loop must not clobber it, /done reads it).
		const workflowRoot = workflowRootFor(h.projectDir);
		const branchDir = join(workflowRoot, "my-feature");
		mkdirSync(branchDir, { recursive: true });
		for (const step of ["start", "code", "review"]) {
			writeFileSync(join(branchDir, `${step}.md`), `# ${step}\n`);
		}
		mkdirSync(join(workflowRoot, "other-branch"), { recursive: true });
		writeFileSync(join(workflowRoot, "other-branch", "plan.md"), "# other\n");
		writeFileSync(join(h.projectDir, "sessions", "unrelated.jsonl"), "");

		h.notifications.length = 0;
		await runCommand(h, "done");

		assert.equal(h.sessionName(), "Clean slate", "lands in a fresh session");
		assert.ok(!existsSync(h.stateFile), "state file deleted");
		assert.ok(!existsSync(sessions.start), "session file deleted");
		assert.ok(!existsSync(branchDir), "branch dir deleted");
		assert.ok(existsSync(join(workflowRoot, "other-branch", "plan.md")), "other branch's artifact survives");
		assert.ok(existsSync(join(workflowRoot, "other-branch")), "other branch's dir survives");
		assert.ok(existsSync(join(h.projectDir, "sessions", "unrelated.jsonl")), "untracked session file survives");

		// Git state: on base, local and remote feature branches gone.
		assert.equal(git(h.projectDir, ["branch", "--show-current"]), "master");
		assert.throws(
			() => git(h.projectDir, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]),
			"local feature branch deleted",
		);
		assert.throws(
			() => git(bare, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]),
			"remote feature branch never existed",
		);

		// The final summary reports all the facts.
		const summary = h.notifications.find((n) => n.msg.includes("torn down"));
		assert.ok(summary, "summary notification shown");
		assert.ok(summary.msg.includes("Remote branch: absent on origin"), "remote outcome reported");
		assert.ok(summary.msg.includes("Local branch my-feature: deleted"), "local deletion reported");
		assert.ok(summary.msg.includes("Current branch: master"), "current branch reported");
		assert.ok(summary.msg.includes("Working tree: clean"), "tree state reported");
		assert.ok(summary.msg.includes("Release tag: none"), "tag outcome reported");
		assert.ok(summary.msg.includes("sessions and artifacts: removed"), "artifacts reported");
		assert.ok(summary.msg.includes("Session: Clean slate"), "clean slate reported");
		assert.ok(h.notifications.some((n) => n.msg.includes("Workflow cleaned up")), "cleanup notification shown");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/done deletes the remote feature branch when it exists on origin", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h, { remoteBranch: true });
		writePlanFile(h);
		writeFileSync(h.stateFile, JSON.stringify({ step: "ship", branch: "my-feature", sessions: {} }));

		h.notifications.length = 0;
		await runCommand(h, "done");

		assert.throws(
			() => git(bare, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]),
			"remote branch deleted from origin",
		);
		const summary = h.notifications.find((n) => n.msg.includes("torn down"));
		assert.ok(summary.msg.includes("Remote branch: deleted from origin"), "remote deletion reported");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/done honors Delete remote branch: false and keeps the remote branch", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h, { remoteBranch: true });
		writePlanFile(h, "- Delete remote branch: false");
		writeFileSync(h.stateFile, JSON.stringify({ step: "ship", branch: "my-feature", sessions: {} }));

		h.notifications.length = 0;
		await runCommand(h, "done");

		assert.doesNotThrow(
			() => git(bare, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]),
			"remote branch kept on origin",
		);
		assert.ok(
			h.notifications.some((n) => n.msg.includes("intentionally kept on origin")),
			"keep note shown",
		);
		const summary = h.notifications.find((n) => n.msg.includes("torn down"));
		assert.ok(summary.msg.includes("Remote branch: kept per plan"), "keep outcome reported");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/done re-run from the done state after a partial failure completes the teardown", async () => {
	const h = createHarness();
	let bare = "";
	try {
		// Simulated partial failure: the state file says "done" (a previous
		// /done aborted), the git teardown never ran — still on the feature
		// branch, branch and sessions intact.
		bare = setupGitRepo(h);
		writePlanFile(h);
		const sessions = { start: join(h.projectDir, "sessions", "start.jsonl") };
		mkdirSync(join(h.projectDir, "sessions"), { recursive: true });
		writeFileSync(sessions.start, "");
		writeFileSync(h.stateFile, JSON.stringify({ step: "done", branch: "my-feature", sessions }));

		h.notifications.length = 0;
		await runCommand(h, "done");

		assert.equal(h.sessionName(), "Clean slate", "retry lands in a fresh session");
		assert.ok(!existsSync(h.stateFile), "state file deleted on the retry");
		assert.ok(!existsSync(sessions.start), "session file deleted on the retry");
		assert.equal(git(h.projectDir, ["branch", "--show-current"]), "master", "on the base branch after the retry");
		assert.throws(
			() => git(h.projectDir, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]),
			"local feature branch deleted on the retry",
		);
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/done aborts on a failed checkout, leaving state intact for a retry", async () => {
	const h = createHarness();
	try {
		// Repo where the checkout is guaranteed to fail: the feature branch
		// has an uncommitted change to a file whose content differs on master.
		const repo = h.projectDir;
		git(repo, ["init", "-b", "master"]);
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, ["add", "tracked.txt"]);
		git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
		git(repo, ["checkout", "-b", "my-feature"]);
		writeFileSync(join(repo, "tracked.txt"), "feature\n");
		git(repo, ["add", "tracked.txt"]);
		git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature change"]);
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");

		writePlanFile(h);
		writeFileSync(h.stateFile, JSON.stringify({ step: "ship", branch: "my-feature", sessions: {} }));

		h.notifications.length = 0;
		await runCommand(h, "done");

		const msg = errorNotifications(h).find((m) => m.includes("Could not switch"));
		assert.ok(msg, "checkout failure reported");
		assert.ok(msg.includes("can be re-run"), "error points at the retry");
		assert.equal(h.readState().step, "done", "state marked done for the retry");
		assert.ok(existsSync(h.stateFile), "state file intact");
		assert.equal(git(repo, ["branch", "--show-current"]), "my-feature", "still on the feature branch");
		assert.doesNotThrow(
			() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]),
			"local branch still exists",
		);
		assert.ok(!h.notifications.some((n) => n.msg.includes("torn down")), "no success summary");
		assert.ok(!h.notifications.some((n) => n.msg.includes("Workflow cleaned up")), "no cleanup");
	} finally {
		h.destroy();
	}
});

test("/done with cancelled clean-slate creation reports the git teardown and the cancellation", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		writePlanFile(h);
		writeFileSync(h.stateFile, JSON.stringify({ step: "ship", branch: "my-feature", sessions: {} }));
		h.setCancelNewSession(true);

		h.notifications.length = 0;
		await runCommand(h, "done");

		assert.ok(h.notifications.some((n) => n.msg.includes("Session creation cancelled")), "cancellation warned");
		assert.equal(git(h.projectDir, ["branch", "--show-current"]), "master", "git teardown still completed");
		assert.throws(
			() => git(h.projectDir, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]),
			"local feature branch deleted",
		);
		assert.equal(h.readState().step, "done", "state stays done — the workflow is retryable");
		const summary = h.notifications.find((n) => n.msg.includes("torn down"));
		assert.ok(summary, "summary still reported");
		assert.ok(summary.msg.includes("cleanup cancelled"), "summary reports the cancelled cleanup");
		assert.ok(summary.msg.includes("not created"), "summary reports the missing clean slate session");
		assert.ok(!summary.msg.includes("sessions and artifacts: removed"), "summary does not claim removal");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/done with no plan file aborts before touching anything", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, JSON.stringify({ step: "ship", branch: "my-feature", sessions: {} }));
		h.notifications.length = 0;
		await runCommand(h, "done");
		assert.ok(errorNotifications(h).some((m) => m.includes("No plan file")), "plan-missing error");
		assert.equal(h.readState().step, "ship", "state untouched (not even marked done)");
		assert.ok(!h.notifications.some((n) => n.msg.includes("torn down")), "no summary");
	} finally {
		h.destroy();
	}
});

test("/done with a plan missing Base branch metadata aborts as corrupt", async () => {
	const h = createHarness();
	try {
		writePlanFile(h);
		// Strip the Base branch line to simulate a corrupt plan.
		const planPath = join(workflowRootFor(h.projectDir), "my-feature", "plan.md");
		writeFileSync(planPath, readFileSync(planPath, "utf-8").replace("- Base branch: master\n", ""));
		writeFileSync(h.stateFile, JSON.stringify({ step: "ship", branch: "my-feature", sessions: {} }));

		h.notifications.length = 0;
		await runCommand(h, "done");

		const msg = errorNotifications(h).find((m) => m.includes("Base branch"));
		assert.ok(msg, "corrupt-plan error reported");
		assert.equal(h.readState().step, "ship", "state untouched");
		assert.ok(!h.notifications.some((n) => n.msg.includes("torn down")), "no summary");
	} finally {
		h.destroy();
	}
});

test("/abandon with no active workflow shows nothing to abandon", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "abandon");
		assert.ok(h.notifications.some((n) => n.msg.includes("nothing to abandon")), "idle message shown");
		assert.equal(h.confirmCalls().length, 0, "no confirmation prompt when idle");
	} finally {
		h.destroy();
	}
});

test("/abandon prompts and cancel keeps everything", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		const repo = h.projectDir;
		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		const sessions = { start: join(repo, "sessions", "start.jsonl") };
		mkdirSync(join(repo, "sessions"), { recursive: true });
		writeFileSync(sessions.start, "");
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions }));
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		writeFileSync(join(repo, "untracked.txt"), "untracked\n");
		const sessionBefore = h.currentSessionFile();

		h.setConfirmResult(false);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		assert.equal(h.confirmCalls().length, 1, "confirmation prompt shown");
		const confirm = h.confirmCalls()[0];
		assert.ok(confirm.includes("my-feature"), "prompt names the branch");
		assert.ok(confirm.includes("discard all uncommitted changes on `my-feature`"), "on-feature prompt warns about the discard");
		assert.ok(confirm.includes("delete `my-feature` locally and on origin"), "prompt names the branch deletion");

		// Nothing happened.
		assert.ok(existsSync(h.stateFile), "state file kept on cancel");
		assert.ok(existsSync(sessions.start), "session files kept on cancel");
		assert.equal(h.currentSessionFile(), sessionBefore, "no session switch on cancel");
		assert.equal(git(repo, ["branch", "--show-current"]), "my-feature", "still on the feature branch");
		assert.equal(readFileSync(join(repo, "tracked.txt"), "utf-8"), "dirty\n", "dirty tree untouched");
		assert.ok(existsSync(join(repo, "untracked.txt")), "untracked file untouched");
		assert.doesNotThrow(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "local branch kept");
		assert.ok(!h.notifications.some((n) => n.msg.includes("Workflow cleaned up")), "no cleanup notification");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon from the feature branch discards the dirty tree, returns to base, and removes branches and artifacts", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		const repo = h.projectDir;

		// Committed files on both branches: tracked.txt (to dirty and revert)
		// and the ignore rule (it must apply on the branch where reset+clean
		// run, and still apply on the base branch after the checkout back —
		// otherwise the surviving ignored file would show up as untracked).
		for (const branch of ["my-feature", "master"]) {
			git(repo, ["checkout", branch]);
			writeFileSync(join(repo, "tracked.txt"), "base\n");
			writeFileSync(join(repo, ".gitignore"), "sessions/\nignored.txt\n");
			git(repo, ["add", "tracked.txt", ".gitignore"]);
			git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", `setup on ${branch}`]);
		}
		git(repo, ["checkout", "my-feature"]);

		// Dirty the tree on the feature branch: staged + unstaged + untracked
		// + ignored. All but the ignored file must be discarded.
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		writeFileSync(join(repo, "staged.txt"), "staged\n");
		git(repo, ["add", "staged.txt"]);
		writeFileSync(join(repo, "untracked.txt"), "untracked\n");
		writeFileSync(join(repo, "ignored.txt"), "ignored\n");

		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		// Abandon mid-workflow (step "plan"), where /done would be blocked:
		// /abandon must not be state-machine-gated.
		const sessions = { start: join(repo, "sessions", "start.jsonl") };
		mkdirSync(join(repo, "sessions"), { recursive: true });
		writeFileSync(sessions.start, "");
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions }));

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		// The confirm reflects the destructiveness of the on-feature path.
		const confirm = h.confirmCalls()[0];
		assert.ok(confirm.includes("discard all uncommitted changes on `my-feature`"), "confirm warns about the discard");
		assert.ok(confirm.includes("switch to `master`"), "confirm names the base branch");
		assert.ok(confirm.includes("delete `my-feature` locally and on origin"), "confirm names the branch deletion");

		// No state-machine gate: mid-workflow abandon succeeded.
		assert.ok(!errorNotifications(h).some((m) => m.includes("not valid")), "abandon not transition-blocked");

		// Git: on base, clean tree, feature branch gone locally and on origin
		// (never pushed), ignored file survives.
		assert.equal(git(repo, ["branch", "--show-current"]), "master");
		assert.equal(git(repo, ["status", "--porcelain"]), "", "tree clean after the discard");
		assert.equal(readFileSync(join(repo, "tracked.txt"), "utf-8"), "base\n", "tracked modification reverted");
		assert.ok(!existsSync(join(repo, "staged.txt")), "staged file removed");
		assert.ok(!existsSync(join(repo, "untracked.txt")), "untracked file removed");
		assert.ok(existsSync(join(repo, "ignored.txt")), "ignored file survives clean -fd");
		assert.throws(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "local feature branch deleted");
		assert.throws(() => git(bare, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "remote feature branch never existed");

		// Workflow teardown.
		assert.equal(h.sessionName(), "Clean slate", "lands in a fresh session");
		assert.ok(!existsSync(h.stateFile), "state file deleted");
		assert.ok(!existsSync(sessions.start), "session file deleted");

		// Summary reports the outcomes.
		const summary = h.notifications.find((n) => n.msg.includes("abandoned"));
		assert.ok(summary, "summary notification shown");
		assert.ok(summary.msg.includes("Remote branch: absent on origin"), "remote outcome reported");
		assert.ok(summary.msg.includes("Local branch my-feature: deleted"), "local deletion reported");
		assert.ok(summary.msg.includes("Current branch: master"), "current branch reported");
		assert.ok(summary.msg.includes("Working tree: discarded"), "tree discard reported");
		assert.ok(summary.msg.includes("sessions and artifacts: removed"), "artifacts reported");
		assert.ok(summary.msg.includes("Session: Clean slate"), "clean slate reported");
		assert.ok(!summary.msg.includes("Git cleanup incomplete"), "no incomplete line on full success");
		assert.ok(h.notifications.some((n) => n.msg.includes("Workflow cleaned up")), "cleanup notification shown");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon outside the feature branch keeps the tree and position, deleting only the feature branch", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		const repo = h.projectDir;
		git(repo, ["checkout", "master"]);
		writeFileSync(join(repo, "untracked.txt"), "keep me\n");
		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		const writeState = () => {
			// The previous abandon's cleanup removed the branch's artifacts,
			// so the start artifact must be rewritten for the next phase.
			writeStartArtifactWithMetadata(repo, "my-feature", "master");
			writeFileSync(h.stateFile, JSON.stringify({ step: "code", branch: "my-feature", sessions: {} }));
		};
		const abandon = async () => {
			h.setConfirmResult(true);
			h.notifications.length = 0;
			await runCommand(h, "abandon");
		};

		// Row 2: on the base branch, feature exists → feature deleted, stay on base, tree untouched.
		writeState();
		await abandon();
		assert.ok(h.confirmCalls()[0].includes("you stay on `master`"), "row 2: off-feature confirm says the position is kept");
		assert.equal(git(repo, ["branch", "--show-current"]), "master", "row 2: stays on base");
		assert.throws(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "row 2: feature branch deleted");
		assert.ok(existsSync(join(repo, "untracked.txt")), "row 2: tree untouched");
		assert.ok(
			h.notifications.find((n) => n.msg.includes("abandoned"))!.msg.includes("Working tree: left untouched"),
			"row 2: tree outcome reported",
		);

		// Row 3: on the base branch, feature already gone → cleanup only, stay on base.
		writeState();
		await abandon();
		assert.equal(git(repo, ["branch", "--show-current"]), "master", "row 3: stays on base");
		assert.ok(existsSync(join(repo, "untracked.txt")), "row 3: tree untouched");
		assert.ok(!existsSync(h.stateFile), "row 3: state removed");

		// Row 5: on an unrelated branch (feature recreated) → feature deleted, stay put.
		git(repo, ["checkout", "-b", "other-branch"]);
		git(repo, ["checkout", "-b", "my-feature"]);
		git(repo, ["checkout", "other-branch"]);
		writeState();
		await abandon();
		assert.equal(git(repo, ["branch", "--show-current"]), "other-branch", "row 5: stays put");
		assert.throws(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "row 5: feature branch deleted");
		assert.ok(existsSync(join(repo, "untracked.txt")), "row 5: tree untouched");

		// Row 6: on the unrelated branch, feature gone → cleanup only, stay put.
		writeState();
		await abandon();
		assert.equal(git(repo, ["branch", "--show-current"]), "other-branch", "row 6: stays put");
		assert.ok(existsSync(join(repo, "untracked.txt")), "row 6: tree untouched");
		assert.ok(!existsSync(h.stateFile), "row 6: state removed");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon with a missing base branch warns, keeps the branch, and reports incomplete git cleanup", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		const repo = h.projectDir;
		// The start artifact names a base branch that does not exist — the
		// checkout must fail, mid-sequence.
		writeStartArtifactWithMetadata(repo, "my-feature", "no-such-base");
		// Dirty the committed tracked file: the discard must revert it before
		// the doomed checkout runs.
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		// Checkout failure: warned with git's stderr, still on the feature
		// branch (reset ran first, so the dirty change is gone), local branch
		// kept because it is still checked out.
		const warn = h.notifications.find((n) => n.type === "warning" && n.msg.includes("Could not switch to the base branch no-such-base"));
		assert.ok(warn, "checkout failure warned");
		assert.equal(git(repo, ["branch", "--show-current"]), "my-feature", "still on the feature branch");
		assert.equal(readFileSync(join(repo, "tracked.txt"), "utf-8"), "base\n", "dirty change discarded before the checkout");
		assert.doesNotThrow(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "local branch kept");

		// Artifact teardown still ran.
		assert.equal(h.sessionName(), "Clean slate", "lands in a fresh session");
		assert.ok(!existsSync(h.stateFile), "state file deleted");

		// The summary reports the incomplete git cleanup.
		const summary = h.notifications.find((n) => n.msg.includes("abandoned"));
		assert.ok(summary, "summary shown");
		assert.ok(summary.msg.includes("Local branch my-feature: kept — still checked out"), "local branch outcome reported");
		assert.ok(summary.msg.includes("Current branch: my-feature (could not switch to no-such-base)"), "current branch outcome reported");
		assert.ok(summary.msg.includes("Git cleanup incomplete — finish manually."), "incomplete line reported");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon reports a partial discard when reset or clean fails", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		const repo = h.projectDir;
		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		// A dirty tracked file plus an untracked file in a read-only
		// directory: reset succeeds (tracked change discarded), clean fails
		// to remove the untracked file (permission denied), and the checkout
		// still succeeds — the exact "partial discard" edge case.
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		const readOnlyDir = join(repo, "sub");
		mkdirSync(readOnlyDir);
		writeFileSync(join(readOnlyDir, "u.txt"), "untracked\n");
		chmodSync(readOnlyDir, 0o555);
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		const warn = h.notifications.find((n) => n.type === "warning" && n.msg.includes("Could not remove untracked files"));
		assert.ok(warn, "clean failure warned");
		assert.equal(git(repo, ["branch", "--show-current"]), "master", "checkout still succeeded");
		assert.throws(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "local branch deleted");
		assert.equal(readFileSync(join(repo, "tracked.txt"), "utf-8"), "base\n", "tracked change discarded by reset");
		assert.ok(existsSync(join(readOnlyDir, "u.txt")), "untracked file survived the failed clean");

		const summary = h.notifications.find((n) => n.msg.includes("abandoned"));
		assert.ok(
			summary!.msg.includes("Working tree: partially discarded (clean failed — see warning)"),
			"summary reports the partial discard instead of a full one",
		);
		assert.ok(summary!.msg.includes("Git cleanup incomplete — finish manually."), "incomplete line reported");
	} finally {
		// Restore permissions so the harness can remove the project dir.
		try {
			chmodSync(join(h.projectDir, "sub"), 0o755);
		} catch {
			// already gone — nothing to restore
		}
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon with cancelled clean-slate creation completes the git teardown and reports the cancellation", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		const repo = h.projectDir;
		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));
		h.setCancelNewSession(true);

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		assert.ok(h.notifications.some((n) => n.msg.includes("Session creation cancelled")), "cancellation warned");
		assert.equal(git(repo, ["branch", "--show-current"]), "master", "git teardown still completed");
		assert.throws(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "local feature branch deleted");
		assert.ok(existsSync(h.stateFile), "state file stays — cleanup never ran");
		const summary = h.notifications.find((n) => n.msg.includes("abandoned"));
		assert.ok(summary, "summary still reported");
		assert.ok(summary.msg.includes("cleanup cancelled"), "summary reports the cancelled cleanup");
		assert.ok(summary.msg.includes("not created"), "summary reports the missing clean slate session");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon deletes the remote feature branch when it exists on origin (no plan → delete)", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h, { remoteBranch: true });
		const repo = h.projectDir;
		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		// No plan file: remote deletion defaults to delete.
		writeFileSync(h.stateFile, JSON.stringify({ step: "code", branch: "my-feature", sessions: {} }));

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		assert.throws(() => git(bare, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "remote branch deleted from origin");
		const summary = h.notifications.find((n) => n.msg.includes("abandoned"));
		assert.ok(summary!.msg.includes("Remote branch: deleted from origin"), "remote deletion reported");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon honors Delete remote branch: false and keeps the remote branch", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h, { remoteBranch: true });
		const repo = h.projectDir;
		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		writePlanFile(h, "- Delete remote branch: false");
		writeFileSync(h.stateFile, JSON.stringify({ step: "code", branch: "my-feature", sessions: {} }));

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		assert.doesNotThrow(() => git(bare, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "remote branch kept on origin");
		assert.ok(h.notifications.some((n) => n.msg.includes("intentionally kept on origin")), "keep note shown");
		const summary = h.notifications.find((n) => n.msg.includes("abandoned"));
		assert.ok(summary!.msg.includes("Remote branch: kept per plan"), "keep outcome reported");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/abandon with a start artifact missing Base branch metadata warns and leaves git untouched", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h, { remoteBranch: true });
		const repo = h.projectDir;
		// start.md exists but carries no metadata (a pre-metadata artifact or
		// a hand-edited one) — git must be left completely untouched.
		writeStartArtifact(repo, "my-feature");
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		writeFileSync(join(repo, "untracked.txt"), "untracked\n");
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon");

		assert.ok(h.confirmCalls()[0].includes("git state will be left untouched"), "confirm says git is untouched");
		assert.ok(
			h.notifications.some((n) => n.type === "warning" && n.msg.includes("Could not determine the base branch")),
			"warning shown",
		);

		// Git untouched: still on the feature branch, dirty tree intact,
		// local and remote branches intact.
		assert.equal(git(repo, ["branch", "--show-current"]), "my-feature");
		assert.equal(readFileSync(join(repo, "tracked.txt"), "utf-8"), "dirty\n", "tracked change kept");
		assert.ok(existsSync(join(repo, "untracked.txt")), "untracked file kept");
		assert.doesNotThrow(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "local branch kept");
		assert.doesNotThrow(() => git(bare, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "remote branch kept");

		// Artifacts cleaned, summary reports git untouched.
		assert.ok(!existsSync(h.stateFile), "state file deleted");
		assert.equal(h.sessionName(), "Clean slate", "lands in a fresh session");
		const summary = h.notifications.find((n) => n.msg.includes("abandoned"));
		assert.ok(summary!.msg.includes("Git state: untouched"), "summary reports untouched git state");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/piflux start is removed: unknown subcommand shows usage and runs nothing", async () => {
	const h = createHarness();
	try {
		h.notifications.length = 0;
		await runCommand(h, "piflux", "start another-branch");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /piflux")), "usage shown");
		assert.ok(!existsSync(h.stateFile), "no workflow started");
		assert.equal(h.sentMessages.length, 0, "no command sent");
	} finally {
		h.destroy();
	}
});

test("/icode and /ireview without their session are blocked", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, JSON.stringify({ step: "review", branch: "my-feature", sessions: {} }));
		await runCommand(h, "icode");
		assert.ok(errorNotifications(h).some((m) => m.includes("No code session found")), "missing code session error");

		writeFileSync(h.stateFile, JSON.stringify({ step: "icode", branch: "my-feature", sessions: {} }));
		await runCommand(h, "ireview");
		assert.ok(errorNotifications(h).some((m) => m.includes("No review session found")), "missing review session error");
	} finally {
		h.destroy();
	}
});

test("model and thinking level are applied from settings once per session", async () => {
	const h = createHarness();
	try {
		writeFileSync(
			h.globalSettingsFile,
			JSON.stringify({ steps: { start: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" } } }),
		);
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);

		await fireBeforeAgentStart(h);
		assert.deepEqual(h.thinkingLevels, ["high"]);
		assert.deepEqual(h.modelCalls.map((m) => m.id), ["claude-sonnet-4-5"]);

		await fireBeforeAgentStart(h);
		assert.equal(h.thinkingLevels.length, 1, "not re-applied on later turns");
	} finally {
		h.destroy();
	}
});

test("bare model ids resolve across providers", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.globalSettingsFile, JSON.stringify({ steps: { start: { model: "claude-sonnet-4-5" } } }));
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.deepEqual(h.modelCalls.map((m) => m.id), ["claude-sonnet-4-5"]);
	} finally {
		h.destroy();
	}
});

test("default settings apply when the settings file is absent", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.deepEqual(h.thinkingLevels, ["low"], "start defaults to low thinking");
		assert.equal(h.modelCalls.length, 0, "no model override by default");
	} finally {
		h.destroy();
	}
});

test("settings from the global file apply to workflow sessions", async () => {
	const h = createHarness();
	try {
		writeFileSync(
			h.globalSettingsFile,
			JSON.stringify({ steps: { start: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" } } }),
		);
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.deepEqual(h.thinkingLevels, ["high"], "global level applied");
		assert.deepEqual(h.modelCalls.map((m) => m.id), ["claude-sonnet-4-5"], "global model applied");
		assert.ok(!existsSync(h.settingsFile), "no local file created");
	} finally {
		h.destroy();
	}
});

test("mergeStepSettings fills defaults: absent file, partial file, explicit nulls", () => {
	// Absent file: everything falls back to built-in defaults.
	assert.equal(mergeStepSettings({}).plan.thinkingLevel, "high");
	assert.equal(mergeStepSettings({}).ship.thinkingLevel, "low");
	assert.equal(mergeStepSettings({}).start.model, null, "default model is null (leave session model untouched)");

	// Partial file: the default level fills in next to a configured model.
	const partial = mergeStepSettings({ code: { model: "anthropic/claude-sonnet-4-5" } });
	assert.equal(partial.code.model, "anthropic/claude-sonnet-4-5");
	assert.equal(partial.code.thinkingLevel, "high", "default level fills in");
	assert.equal(partial.plan.thinkingLevel, "high", "untouched step uses defaults");

	// Explicit nulls (legacy 1.1.0 full-defaults shape) apply identically.
	const legacy = mergeStepSettings({ start: { model: null, thinkingLevel: null }, plan: { model: null, thinkingLevel: "high" } });
	assert.equal(legacy.start.model, null, "explicit null model kept");
	assert.equal(legacy.start.thinkingLevel, null, "explicit null level kept (pi default applies at runtime)");
	assert.equal(legacy.plan.thinkingLevel, "high");

	// Stale settings entries for removed/sessionless steps are inert: /done
	// never becomes a session (no model/effort applied to it) and /cleanup is
	// not a workflow step anymore — neither entry can crash anything.
	assert.equal(mergeStepSettings({}).done.thinkingLevel, undefined, "done has no default level");
	const stale = mergeStepSettings({ done: { model: "x/y", thinkingLevel: "max" }, cleanup: { model: "x/y" } });
	assert.equal(stale.done.model, "x/y", "a stale done entry is merged but harmless");
	assert.equal(stale.done.thinkingLevel, "max");
	assert.ok(!("cleanup" in stale), "cleanup is not a workflow step anymore");
});

test("parsePlanMetadata: Base branch and Delete remote branch, null when absent", () => {
	const full = parsePlanMetadata("# T\n\n## Metadata\n- Base branch: master\n- Merge strategy: squash\n- Delete remote branch: true\n");
	assert.equal(full.baseBranch, "master");
	assert.equal(full.deleteRemoteBranch, true);

	const keep = parsePlanMetadata("## Metadata\n- Base branch: master\n- Delete remote branch: false\n");
	assert.equal(keep.deleteRemoteBranch, false);

	const noDelete = parsePlanMetadata("## Metadata\n- Base branch: main\n");
	assert.equal(noDelete.baseBranch, "main");
	assert.equal(noDelete.deleteRemoteBranch, null, "absent Delete remote branch is null (caller defaults to true)");

	// The start artifact's Feature branch line (added alongside Base branch)
	// must not disturb Base branch extraction — consumers are regex-per-line.
	const start = parsePlanMetadata("# Start: my-feature\n\n## Metadata\n- Feature branch: my-feature\n- Base branch: master\n");
	assert.equal(start.baseBranch, "master", "Feature branch line does not disturb Base branch extraction");

	// Whitespace tolerance; no accidental prefix matches ("Base branchless"
	// must not match "Base branch").
	const spaced = parsePlanMetadata("-   Base branch:   master   \n- Base branchless: x\n");
	assert.equal(spaced.baseBranch, "master");

	const none = parsePlanMetadata("# no metadata here\n");
	assert.equal(none.baseBranch, null);
	assert.equal(none.deleteRemoteBranch, null);
});

test("parsePlanMetadata: New version and Tag release, absent Tag release means no tag", () => {
	const tagged = parsePlanMetadata("## Metadata\n- Old version: 1.3.0\n- New version: 1.4.0\n- Tag release: true\n");
	assert.equal(tagged.newVersion, "1.4.0");
	assert.equal(tagged.tagRelease, true);

	const notTagged = parsePlanMetadata("## Metadata\n- New version: 2.0.0\n- Tag release: false\n");
	assert.equal(notTagged.tagRelease, false);

	const oldStyle = parsePlanMetadata("## Metadata\n- New version: 1.4.0\n");
	assert.equal(oldStyle.newVersion, "1.4.0");
	assert.equal(oldStyle.tagRelease, null, "absent Tag release means no tag");
});

test("serializeSettings emits only the given steps with a trailing newline", () => {
	const out = serializeSettings({ code: { model: "x/y", thinkingLevel: "low" } });
	assert.ok(out.endsWith("\n"), "trailing newline");
	assert.deepEqual(JSON.parse(out), { steps: { code: { model: "x/y", thinkingLevel: "low" } } });
});

test("setStepInFile creates the file on first write, replaces a step, preserves others", () => {
	const h = createHarness();
	try {
		const file = join(h.globalDir, "piflux", "nested", "settings.json");
		assert.ok(!existsSync(file), "file absent before the first write");

		// First write: parent dir + file created, exactly that step serialized.
		assert.equal(setStepInFile(file, "code", { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" }), true);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), {
			steps: { code: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" } },
		});
		assert.ok(readFileSync(file, "utf-8").endsWith("\n"), "trailing newline");

		// Later writes: replace the step in place, keep the other steps.
		assert.equal(setStepInFile(file, "code", { model: "openai/gpt-4o", thinkingLevel: "off" }), true);
		assert.equal(setStepInFile(file, "plan", { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" }), true);
		const updated = JSON.parse(readFileSync(file, "utf-8"));
		assert.deepEqual(updated.steps.code, { model: "openai/gpt-4o", thinkingLevel: "off" }, "step replaced");
		assert.deepEqual(updated.steps.plan, { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" }, "other step preserved");
		assert.equal(Object.keys(updated.steps).length, 2, "only explicitly-set steps are serialized");
	} finally {
		h.destroy();
	}
});

test("unsetStepInFile removes only the requested step and no-ops on absent files", () => {
	const h = createHarness();
	try {
		writeFileSync(
			h.globalSettingsFile,
			JSON.stringify({ steps: { plan: { thinkingLevel: "max" }, code: { model: "openai/gpt-4o" } } }),
		);
		assert.equal(unsetStepInFile(h.globalSettingsFile, "plan"), true, "step removed");
		assert.deepEqual(JSON.parse(readFileSync(h.globalSettingsFile, "utf-8")).steps, { code: { model: "openai/gpt-4o" } });

		assert.equal(unsetStepInFile(h.globalSettingsFile, "plan"), false, "already unset");
		assert.equal(unsetStepInFile(join(h.globalDir, "missing.json"), "plan"), false, "absent file");
	} finally {
		h.destroy();
	}
});

test("setStepInFile and unsetStepInFile refuse to touch a corrupt file", () => {
	const h = createHarness();
	try {
		writeFileSync(h.globalSettingsFile, "{ not json");
		assert.equal(
			setStepInFile(h.globalSettingsFile, "code", { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" }),
			false,
			"set refused on corrupt file",
		);
		assert.equal(unsetStepInFile(h.globalSettingsFile, "code"), false, "unset refused on corrupt file");
		assert.equal(readFileSync(h.globalSettingsFile, "utf-8"), "{ not json", "corrupt file left untouched for manual repair");
	} finally {
		h.destroy();
	}
});

test("a corrupt state file is treated as idle with a warning, and /abandon --force removes it", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, "{ not json");
		await runCommand(h, "piflux");
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.msg.includes("corrupt")), "corrupt warning shown");
		assert.ok(h.notifications.some((n) => n.msg.includes("/abandon --force")), "warning points at the force flag");
		assert.ok(h.notifications.some((n) => n.msg.includes("No active workflow")), "treated as idle");

		h.notifications.length = 0;
		await runCommand(h, "plan", "desc");
		assert.ok(errorNotifications(h).some((m) => m.includes("no active workflow")), "/plan still blocked");

		// Plain /abandon cannot read the corrupt file, so it stays in place.
		h.notifications.length = 0;
		await runCommand(h, "abandon");
		assert.ok(h.notifications.some((n) => n.msg.includes("nothing to abandon")), "abandon sees no workflow");
		assert.ok(existsSync(h.stateFile), "corrupt state file left in place");
		assert.equal(h.confirmCalls().length, 0, "no prompt for plain abandon");

		// /abandon --force prompts, and cancel keeps the file.
		h.notifications.length = 0;
		h.setConfirmResult(false);
		await runCommand(h, "abandon", "--force");
		assert.equal(h.confirmCalls().length, 1, "prompt shown for --force");
		assert.ok(h.confirmCalls()[0].includes("Git state is untouched"), "prompt states git is untouched");
		assert.ok(existsSync(h.stateFile), "file kept on cancel");

		// Accept removes the corrupt file and nothing else.
		h.notifications.length = 0;
		h.setConfirmResult(true);
		await runCommand(h, "abandon", "--force");
		assert.ok(!existsSync(h.stateFile), "corrupt state file removed");
		assert.ok(h.notifications.some((n) => n.msg.includes("removed")), "removal notification shown");
	} finally {
		h.destroy();
	}
});

test("/abandon --force without a state file is a no-op", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "abandon", "--force");
		assert.ok(h.notifications.some((n) => n.msg.includes("nothing to abandon")), "no-op without a state file");
		assert.equal(h.confirmCalls().length, 0, "no prompt");
	} finally {
		h.destroy();
	}
});

test("/abandon --force with a valid state behaves like plain /abandon", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		const repo = h.projectDir;
		writeStartArtifactWithMetadata(repo, "my-feature", "master");
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));

		h.setConfirmResult(true);
		h.notifications.length = 0;
		await runCommand(h, "abandon", "--force");
		assert.equal(h.confirmCalls().length, 1, "branch prompt still shown");
		assert.ok(h.confirmCalls()[0].includes("my-feature"), "prompt names the branch");
		assert.ok(!existsSync(h.stateFile), "full cleanup performed");
		assert.equal(h.sessionName(), "Clean slate", "lands in a fresh session");
		assert.equal(git(repo, ["branch", "--show-current"]), "master", "git cleanup performed like plain abandon");
		assert.throws(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/my-feature"]), "feature branch deleted like plain abandon");
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("levelsForModel mirrors pi: no thinkingLevelMap means no xhigh/max", () => {
	// mimo-v2.5-pro and claude-sonnet-4-5: reasoning, no thinkingLevelMap →
	// xhigh/max are clamped by the provider, so the picker tops out at high.
	assert.deepEqual(levelsForModel({ provider: "xiaomi", id: "mimo-v2.5-pro", reasoning: true }), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
	]);
	assert.deepEqual(levelsForModel({ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true }), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
	]);
});

test("levelsForModel: non-reasoning models offer only off", () => {
	assert.deepEqual(levelsForModel({ provider: "openai", id: "gpt-4o", reasoning: false }), ["off"]);
});

test("levelsForModel: explicit map entries gate xhigh/max; null-mapped levels are excluded", () => {
	// Fully explicit map → all seven levels.
	const full = levelsForModel({
		provider: "anthropic",
		id: "claude-sonnet-5",
		reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	});
	assert.equal(full.length, 7, "explicit xhigh/max entries are offered");

	// xhigh/max missing from the map → excluded; minimal mapped to null → excluded.
	const partial = levelsForModel({
		provider: "x",
		id: "y",
		reasoning: true,
		thinkingLevelMap: { minimal: null, high: "high" },
	});
	assert.deepEqual(partial, ["off", "low", "medium", "high"]);

	// Pathological: everything mapped to null → empty (same as pi's own picker).
	const none = levelsForModel({
		provider: "x",
		id: "y",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null },
	});
	assert.deepEqual(none, []);
});

test("a corrupt settings file falls back to defaults with a warning", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.globalSettingsFile, "{ not json");
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.msg.includes("corrupt")), "corrupt warning shown");
		assert.deepEqual(h.thinkingLevels, ["low"], "defaults used");
	} finally {
		h.destroy();
	}
});

test("corrupt settings are warned once at session_start with the full path", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.globalSettingsFile, "{ not json");
		await fireEvent(h, "session_start");
		const warnings = h.notifications.filter((n) => n.type === "warning" && n.msg.includes("corrupt"));
		assert.equal(warnings.length, 1, "warned exactly once");
		assert.ok(warnings[0].msg.includes(h.globalSettingsFile), "warning names the full path");

		// A second session-start event does not re-warn.
		h.notifications.length = 0;
		await fireEvent(h, "session_start");
		assert.ok(!h.notifications.some((n) => n.type === "warning"), "not re-warned on later sessions");

		// Settings fall back to built-in defaults for the session.
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.deepEqual(h.thinkingLevels, ["low"], "defaults apply");
	} finally {
		h.destroy();
	}
});

test("every workflow step template expands from workflow-templates", async () => {
	const h = createHarness();
	try {
		// The templates were moved out of pi's auto-discovered prompts directory;
		// the extension must still find and expand each of them via its own
		// filesystem lookup. All step templates open with "You are …".
		for (const name of ["start", "plan", "code", "review", "icode", "ireview", "ship"]) {
			const result = await fireInput(h, `/${name}`, "extension");
			assert.equal(result.action, "transform", `/${name} expands`);
			assert.ok(result.text.startsWith("You are"), `/${name} expands to a real template body`);
			assert.ok(!result.text.includes("description:"), `/${name} frontmatter stripped`);
		}
	} finally {
		h.destroy();
	}
});

test("template expansion edge cases: empty args, whitespace-only args, no-placeholder templates", async () => {
	const h = createHarness();
	try {
		// Empty description: $@ expands to nothing (no placeholder leftovers).
		let result = await fireInput(h, "/plan", "extension");
		assert.equal(result.action, "transform");
		assert.ok(!result.text.includes("$@"), "no placeholder leftover with empty args");
		assert.ok(!result.text.includes("description:"), "frontmatter stripped");

		// Whitespace-only description is treated as empty.
		result = await fireInput(h, "/plan   ", "extension");
		assert.equal(result.action, "transform");
		assert.ok(!result.text.includes("$@"), "no placeholder leftover with whitespace-only args");

		// Template without placeholders expands to its body unchanged.
		result = await fireInput(h, "/code", "extension");
		assert.equal(result.action, "transform");
		assert.ok(result.text.startsWith("You are an implementation agent"), "code template body expanded");

		// Non-workflow commands are left alone.
		result = await fireInput(h, "/something-else", "extension");
		assert.equal(result.action, "continue");

		// /done, /cleanup, and /abandon have no prompt templates — extension-
		// sourced messages matching them fall through harmlessly.
		for (const name of ["done", "cleanup", "abandon"]) {
			result = await fireInput(h, `/${name}`, "extension");
			assert.equal(result.action, "continue");
		}
	} finally {
		h.destroy();
	}
});

test("$WORKFLOW_DIR is substituted with the repo's workflow root in expanded templates", async () => {
	const h = createHarness();
	try {
		const result = await fireInput(h, "/plan desc", "extension");
		assert.equal(result.action, "transform");
		assert.ok(result.text.includes(`${workflowRootFor(h.projectDir)}/<branch>/plan.md`), "artifact paths point at the absolute workflow root");
		assert.ok(!result.text.includes("$WORKFLOW_DIR"), "no placeholder leftover");
		assert.ok(result.text.includes("**desc**"), "$@ still substitutes alongside $WORKFLOW_DIR");
	} finally {
		h.destroy();
	}
});

test("the model/effort settings do not apply to non-workflow sessions", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		// A session that is not tracked in the state file.
		h.setCurrentSessionFile(join(h.projectDir, "sessions", "unrelated.jsonl"));
		await fireBeforeAgentStart(h);
		assert.equal(h.thinkingLevels.length, 0, "no settings applied outside workflow sessions");
	} finally {
		h.destroy();
	}
});

test("branch sanitization: special chars, separator runs, leading/trailing hyphens, numeric, empty result", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "Fix #123 — bug!");
		assert.equal(h.readState().branch, "fix-123-bug");

		rmSync(h.stateFile);
		await runCommand(h, "start", "---FOO---");
		assert.equal(h.readState().branch, "foo");

		rmSync(h.stateFile);
		await runCommand(h, "start", "12345");
		assert.equal(h.readState().branch, "12345");

		rmSync(h.stateFile);
		h.notifications.length = 0;
		await runCommand(h, "start", "!!!");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /start")), "empty after sanitization shows usage");
		assert.ok(!existsSync(h.stateFile), "no state written");
	} finally {
		h.destroy();
	}
});

test("/start Fix login forwards the sanitized name so the template needs no sanitization", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "Fix login");
		const state = h.readState();
		assert.equal(state.branch, "fix-login", "extension sanitizes the branch name");
		assert.deepEqual(h.sentMessages, ["/start fix-login"], "template receives the pre-sanitized name as-is");
		assert.equal(h.sessionName(), "piflux: start fix-login");

		// The step session's input expansion also uses the sanitized name.
		const result = await fireInput(h, "/start fix-login", "extension");
		assert.equal(result.action, "transform");
		assert.ok(result.text.includes("$@") === false, "no placeholder leftover");
	} finally {
		h.destroy();
	}
});

test("quoted and multi-word arguments parse like pi's command args", async () => {
	const h = createHarness();
	try {
		let result = await fireInput(h, '/plan "two words"', "extension");
		assert.ok(result.text.includes("**two words**"), "quoted phrase substituted as one argument");

		result = await fireInput(h, '/plan one "two words" three', "extension");
		assert.ok(result.text.includes("**one two words three**"), "mixed quoted and bare arguments joined");

		result = await fireInput(h, "/plan ''", "extension");
		assert.ok(!result.text.includes("$@"), "empty quoted argument expands to nothing");

		result = await fireInput(h, '/plan "unclosed', "extension");
		assert.ok(result.text.includes("**unclosed**"), "unclosed quote keeps the raw text");
	} finally {
		h.destroy();
	}
});

test("positional, default, and slice placeholders expand correctly", () => {
	// The real step templates only use $@, so the other placeholder forms are
	// exercised directly against the exported substituteArgs helper.
	const body = "$1 / $2 / ${1:-fb} / ${2:-fb2} / ${@:2} / ${@:2:1} / ${@:-fallback-all} / $@";
	assert.equal(
		substituteArgs(body, ["alpha", "beta", "gamma"]),
		"alpha / beta / alpha / beta / beta gamma / beta / alpha beta gamma / alpha beta gamma",
	);
	assert.equal(substituteArgs(body, ["alpha"]), "alpha /  / alpha / fb2 /  /  / alpha / alpha");
	assert.equal(substituteArgs(body, []), " /  / fb / fb2 /  /  / fallback-all / ");
});

test("unknown model specs warn and do not switch, and skip the thinking level", async () => {
	const h = createHarness();
	try {
		writeFileSync(
			h.globalSettingsFile,
			JSON.stringify({
				steps: { start: { model: "nonexistent/provider", thinkingLevel: "low" }, plan: { model: "no-such-model" } },
			}),
		);
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.msg.includes("unknown model")), "unknown provider/model warned");
		assert.equal(h.modelCalls.length, 0, "no model switch attempted");
		assert.equal(h.thinkingLevels.length, 0, "thinking level not applied when the model is unknown");

		await runCommand(h, "plan", "desc");
		h.setCurrentSessionFile(h.readState().sessions.plan);
		await fireBeforeAgentStart(h);
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.msg.includes("unknown model")), "unknown bare id warned");
	} finally {
		h.destroy();
	}
});

test("setModel returning false or throwing warns instead of failing", async () => {
	const h = createHarness();
	try {
		writeFileSync(
			h.globalSettingsFile,
			JSON.stringify({
				steps: {
					start: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" },
					plan: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" },
				},
			}),
		);
		await runCommand(h, "start", "my-feature");

		h.setModelBehavior("no-key");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.msg.includes("no API key")), "no-key warning");
		assert.equal(h.modelCalls.length, 1, "model switch attempted");
		// The model didn't change, but the configured level is still applied
		// (applying it against the current model is harmless).
		assert.deepEqual(h.thinkingLevels, ["high"], "thinking level applied despite the failed switch");
		assert.equal(h.thinkingLevelNow(), "high", "effective level is the configured one");

		h.setModelBehavior("throw");
		await runCommand(h, "plan", "desc");
		h.setCurrentSessionFile(h.readState().sessions.plan);
		await fireBeforeAgentStart(h);
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.msg.includes("could not switch")), "throw warning");
		assert.equal(h.modelCalls.length, 2, "model switch attempted again");
		assert.deepEqual(h.thinkingLevels, ["high", "medium"], "each step's level applied despite the throwing switch");
		assert.equal(h.thinkingLevelNow(), "medium", "effective level is the second step's configured one");
	} finally {
		h.destroy();
	}
});

test("configured thinking level survives the model switch (model applied first)", async () => {
	const h = createHarness();
	try {
		writeFileSync(
			h.globalSettingsFile,
			JSON.stringify({ steps: { plan: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "max" } } }),
		);
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "plan", "desc");
		h.setCurrentSessionFile(h.readState().sessions.plan);
		await fireBeforeAgentStart(h);
		// setModel resets the level to the model's default ("medium"); the
		// configured level is applied afterwards and sticks.
		assert.equal(h.thinkingLevelNow(), "max", "configured level is the effective level");
		assert.deepEqual(h.thinkingLevels, ["max"], "configured level applied once, after the model switch");
		assert.ok(
			!h.notifications.some((n) => n.type === "warning" && n.msg.includes("thinking level")),
			"no mismatch warning when the level sticks",
		);
	} finally {
		h.destroy();
	}
});

test("a non-reasoning model clamps the thinking level and warns", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.globalSettingsFile, JSON.stringify({ steps: { plan: { model: "openai/gpt-4o", thinkingLevel: "max" } } }));
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "plan", "desc");
		h.setCurrentSessionFile(h.readState().sessions.plan);
		await fireBeforeAgentStart(h);
		assert.equal(h.thinkingLevelNow(), "off", "non-reasoning model clamps to off");
		const warning = h.notifications.find((n) => n.type === "warning" && n.msg.includes("thinking level"));
		assert.ok(warning, "clamping warning shown");
		assert.ok(warning.msg.includes('"max"'), "warning names the configured level");
		assert.ok(warning.msg.includes('"off"'), "warning names the effective level");
	} finally {
		h.destroy();
	}
});

test("a matching configured level with a model switch produces no warning", async () => {
	const h = createHarness();
	try {
		writeFileSync(
			h.globalSettingsFile,
			JSON.stringify({ steps: { plan: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" } } }),
		);
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "plan", "desc");
		h.setCurrentSessionFile(h.readState().sessions.plan);
		await fireBeforeAgentStart(h);
		assert.equal(h.thinkingLevelNow(), "medium");
		assert.ok(
			!h.notifications.some((n) => n.type === "warning" && n.msg.includes("thinking level")),
			"no warning when configured level equals the effective level",
		);
	} finally {
		h.destroy();
	}
});

test("steps missing from the settings file fall back to defaults", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.globalSettingsFile, JSON.stringify({ steps: { plan: { thinkingLevel: "medium" } } }));
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(h.readState().sessions.start);
		await fireBeforeAgentStart(h);
		assert.deepEqual(h.thinkingLevels, ["low"], "start falls back to the default level");

		await runCommand(h, "plan", "desc");
		h.setCurrentSessionFile(h.readState().sessions.plan);
		await fireBeforeAgentStart(h);
		assert.deepEqual(h.thinkingLevels, ["low", "medium"], "configured step uses its own level");
	} finally {
		h.destroy();
	}
});

test("corrupt state file warning is emitted only once per session instance", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, "{ bad");
		await runCommand(h, "piflux");
		await runCommand(h, "piflux", "state");
		await runCommand(h, "plan", "x");
		const corruptWarnings = h.notifications.filter((n) => n.msg.includes("corrupt"));
		assert.equal(corruptWarnings.length, 1, "warning deduplicated");
	} finally {
		h.destroy();
	}
});

test("/plan with an empty start directory is blocked", async () => {
	const h = createHarness();
	try {
		// The repo-level workflow root exists (harness default) but contains no
		// branch dirs with a start.md.
		writeFileSync(h.stateFile, JSON.stringify({ step: "start", branch: "my-feature", sessions: {} }));
		await runCommand(h, "plan", "desc");
		assert.ok(errorNotifications(h).some((m) => m.includes("No start artifact")), "blocked with no artifacts");
	} finally {
		h.destroy();
	}
});

test("/ship and /icode from ireview; /done is a retryable terminal step", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		await runCommand(h, "plan", "desc");
		await runCommand(h, "code");
		await runCommand(h, "review");
		const codePath = h.readState().sessions.code;
		const reviewPath = h.readState().sessions.review;

		// review -> icode -> ireview, then /icode loops back again.
		await runCommand(h, "icode");
		assert.equal(h.readState().step, "icode");
		assert.equal(h.currentSessionFile(), codePath, "back in the code session");
		await runCommand(h, "ireview");
		assert.equal(h.readState().step, "ireview");
		assert.equal(h.currentSessionFile(), reviewPath, "back in the review session");

		clearSent(h);
		await runCommand(h, "icode");
		assert.equal(h.readState().step, "icode", "/icode valid from ireview");
		assert.equal(h.currentSessionFile(), codePath, "looped back to the code session");
		assert.deepEqual(h.sentMessages, ["/icode"]);

		// /ship is valid from ireview (the second valid path).
		await runCommand(h, "ireview");
		await runCommand(h, "ship");
		assert.equal(h.readState().step, "ship");

		// /done is valid from ship, but without a plan file the harness cannot
		// complete the teardown — it aborts before the state write.
		clearSent(h);
		h.notifications.length = 0;
		await runCommand(h, "done");
		assert.equal(h.readState().step, "ship", "aborted before the state write — no plan file");
		assert.ok(errorNotifications(h).some((m) => m.includes("No plan file")), "plan-missing error");

		// Re-running from the "done" state is a valid retry, not a transition
		// error — /done is the retryable terminal step.
		writeFileSync(h.stateFile, JSON.stringify({ step: "done", branch: "my-feature", sessions: h.readState().sessions }));
		h.notifications.length = 0;
		await runCommand(h, "done");
		assert.ok(!errorNotifications(h).some((m) => m.includes("not valid")), "re-run from done is not transition-blocked");
		assert.equal(h.readState().step, "done", "state intact for the retry");
		assert.equal(h.sentMessages.length, 0, "no command sent");
	} finally {
		h.destroy();
	}
});

test("cancelled session creation and switching warn without sending the command", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");

		h.setCancelNewSession(true);
		h.notifications.length = 0;
		clearSent(h);
		await runCommand(h, "plan", "desc");
		assert.ok(h.notifications.some((n) => n.msg.includes("Session creation cancelled")), "creation cancelled warning");
		assert.equal(h.readState().step, "start", "state unchanged");
		assert.equal(h.sentMessages.length, 0, "no command sent");
		h.setCancelNewSession(false);

		await runCommand(h, "plan", "desc");
		await runCommand(h, "code");
		await runCommand(h, "review");
		h.setCancelSwitchSession(true);
		h.notifications.length = 0;
		clearSent(h);
		await runCommand(h, "icode");
		assert.ok(h.notifications.some((n) => n.msg.includes("Session switch cancelled")), "switch cancelled warning");
		assert.equal(h.readState().step, "review", "state unchanged");
		assert.equal(h.sentMessages.length, 0, "no command sent");
	} finally {
		h.destroy();
	}
});

test("/piflux settings in non-tui mode errors without opening an overlay", async () => {
	const h = createHarness();
	try {
		h.setMode("print");
		h.notifications.length = 0;
		await runCommand(h, "piflux", "settings");
		assert.ok(errorNotifications(h).some((m) => m.includes("TUI")), "error mentions the interactive TUI");
		assert.equal(h.customCalls(), 0, "no overlay opened");
		assert.ok(!existsSync(h.globalSettingsFile), "no settings file created");
	} finally {
		h.destroy();
	}
});

test("/piflux settings in tui mode opens the overlay and writes nothing when closed", async () => {
	const h = createHarness();
	try {
		// The stub's ui.custom is a no-op that returns null (immediate close).
		h.notifications.length = 0;
		await runCommand(h, "piflux", "settings");
		assert.equal(h.customCalls(), 1, "step picker opened");
		assert.ok(!existsSync(h.globalSettingsFile), "closing the overlay writes nothing");
	} finally {
		h.destroy();
	}
});

test("/piflux settings with a trailing token shows usage instead of opening", async () => {
	const h = createHarness();
	try {
		h.notifications.length = 0;
		await runCommand(h, "piflux", "settings local");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /piflux")), "usage shown for settings local");
		assert.equal(h.customCalls(), 0, "no overlay opened");

		h.notifications.length = 0;
		await runCommand(h, "piflux", "state extra");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /piflux")), "usage shown for state with extra tokens");
	} finally {
		h.destroy();
	}
});

test("/piflux view in non-tui mode errors without opening the viewer", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));
		h.setMode("print");
		h.notifications.length = 0;
		await runCommand(h, "piflux", "view");
		assert.ok(errorNotifications(h).some((m) => m.includes("TUI")), "error mentions the interactive TUI");
		assert.equal(h.customCalls(), 0, "no viewer opened");

		// The direct syntax hits the same mode guard, before any target handling.
		h.notifications.length = 0;
		await runCommand(h, "piflux", "view plan");
		assert.ok(errorNotifications(h).some((m) => m.includes("TUI")), "direct view also errors in non-tui mode");
		assert.equal(h.customCalls(), 0, "no viewer opened");
	} finally {
		h.destroy();
	}
});

test("/piflux view with no active workflow notifies and opens nothing", async () => {
	const h = createHarness();
	try {
		h.notifications.length = 0;
		await runCommand(h, "piflux", "view");
		assert.ok(
			h.notifications.some((n) => n.type === "info" && n.msg.includes("nothing to view")),
			"info about nothing to view",
		);
		assert.equal(h.customCalls(), 0, "no viewer opened");
	} finally {
		h.destroy();
	}
});

test("/piflux view opens the selector and writes nothing", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, JSON.stringify({ step: "review", branch: "my-feature", sessions: {} }));
		const viewRoot = workflowRootFor(h.projectDir);
		mkdirSync(join(viewRoot, "my-feature"), { recursive: true });
		writeFileSync(join(viewRoot, "my-feature", "plan.md"), "# Plan\n");
		const stateBefore = readFileSync(h.stateFile, "utf-8");
		h.notifications.length = 0;
		await runCommand(h, "piflux", "view");
		// The stub's ui.custom is a no-op that returns null (immediate close).
		assert.equal(h.customCalls(), 1, "selector opened");
		assert.equal(readFileSync(h.stateFile, "utf-8"), stateBefore, "state file untouched");
		assert.equal(h.notifications.length, 0, "no notifications — nothing missing was selected");
	} finally {
		h.destroy();
	}
});

test("/piflux view with a trailing token shows usage instead of opening", async () => {
	const h = createHarness();
	try {
		h.notifications.length = 0;
		await runCommand(h, "piflux", "view extra");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /piflux view")), "view usage shown for view with extra tokens");
		assert.equal(h.customCalls(), 0, "no viewer opened");
	} finally {
		h.destroy();
	}
});

test("isViewTarget accepts the five targets and rejects everything else", () => {
	assert.deepEqual(VIEW_TARGETS, ["state", "start", "plan", "code", "review"], "target vocabulary");
	for (const target of VIEW_TARGETS) {
		assert.equal(isViewTarget(target), true, `${target} is a view target`);
	}
	for (const token of ["foo", "settings", "state ", "plan x", "view", "", "State", "PLAN"]) {
		assert.equal(isViewTarget(token), false, `${JSON.stringify(token)} is not a view target`);
	}
});

test("viewArgumentCompletions: existing artifacts only, full-argument values, target-prefix filtering", () => {
	const h = createHarness();
	try {
		const cwd = h.projectDir;
		const state = { step: "code", branch: "my-feature", sessions: {} };
		const now = 1_000_000_000_000;
		const root = workflowRootFor(cwd);
		mkdirSync(join(root, "my-feature"), { recursive: true });
		writeFileSync(join(root, "my-feature", "start.md"), "# Start\n");
		writeFileSync(join(root, "my-feature", "plan.md"), "# Plan\n");

		// Empty typed target ("view" fully typed, no trailing space): state
		// plus the artifacts that exist — missing code/review are not
		// suggested. Values carry the full argument text (pi replaces the
		// whole argument prefix with item.value).
		const all = viewArgumentCompletions("view", state, cwd, now)!;
		assert.deepEqual(all.map((i) => i.value), ["view state", "view start", "view plan"], "full-argument values");
		assert.deepEqual(all.map((i) => i.label), ["state", "start", "plan"]);
		assert.equal(all[0].description, "step: code", "state row keeps its step description");
		assert.equal(all[1].description, "modified just now", "artifact rows keep their mtime description");

		// A typed target prefix filters; no match means no suggestions.
		assert.deepEqual(viewArgumentCompletions("view p", state, cwd, now)!.map((i) => i.value), ["view plan"]);
		assert.deepEqual(viewArgumentCompletions("view plan", state, cwd, now)!.map((i) => i.value), ["view plan"]);
		assert.deepEqual(viewArgumentCompletions("view c", state, cwd, now), [], "code.md missing — nothing suggested");

		// Null state (no active workflow) and non-view argument text → null,
		// so the caller falls back to first-token completion.
		assert.equal(viewArgumentCompletions("view", null, cwd, now), null);
		assert.equal(viewArgumentCompletions("view p", null, cwd, now), null);
		assert.equal(viewArgumentCompletions("", state, cwd, now), null);
		assert.equal(viewArgumentCompletions("settings", state, cwd, now), null);
		assert.equal(viewArgumentCompletions("viewx", state, cwd, now), null, "no space after view — not an argument invocation");
	} finally {
		h.destroy();
	}
});

test("/piflux view with a bogus or extra target shows the view usage", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));
		h.notifications.length = 0;
		await runCommand(h, "piflux", "view bogus");
		assert.ok(
			h.notifications.some((n) => n.msg.includes("Usage: /piflux view [state|start|plan|code|review]")),
			"view usage shown for a bogus target",
		);
		assert.equal(h.customCalls(), 0, "no viewer opened");

		h.notifications.length = 0;
		await runCommand(h, "piflux", "view plan x");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /piflux view")), "view usage shown for extra tokens");
		assert.equal(h.customCalls(), 0, "no viewer opened");
	} finally {
		h.destroy();
	}
});

test("/piflux view plan with no plan artifact warns and opens nothing", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature", sessions: {} }));
		h.notifications.length = 0;
		await runCommand(h, "piflux", "view plan");
		assert.ok(
			h.notifications.some((n) => n.type === "warning" && n.msg.includes("No plan artifact yet")),
			"missing-artifact warning shown",
		);
		assert.equal(h.customCalls(), 0, "no content screen opened");
	} finally {
		h.destroy();
	}
});

test("/piflux view plan and view state open the content screen directly", async () => {
	const h = createHarness();
	try {
		writeFileSync(h.stateFile, JSON.stringify({ step: "review", branch: "my-feature", sessions: {} }));
		const branchDir = join(workflowRootFor(h.projectDir), "my-feature");
		mkdirSync(branchDir, { recursive: true });
		writeFileSync(join(branchDir, "plan.md"), "# Plan\n");

		h.notifications.length = 0;
		await runCommand(h, "piflux", "view plan");
		// The stub overlay closes immediately (null = Esc) — the direct view
		// exits the viewer, so exactly one content screen opens and nothing
		// else happens (no selector, no notifications).
		assert.equal(h.customCalls(), 1, "plan content screen opened directly");
		assert.equal(h.notifications.length, 0, "no notifications");

		h.notifications.length = 0;
		await runCommand(h, "piflux", "view state");
		assert.equal(h.customCalls(), 2, "state content screen opened directly");
		assert.equal(h.notifications.length, 0, "no notifications");
	} finally {
		h.destroy();
	}
});

test("formatRelativeTime: just now, minutes, hours, days, and future mtimes", () => {
	const now = 1_000_000_000_000;
	assert.equal(formatRelativeTime(now, now), "just now");
	assert.equal(formatRelativeTime(now - 30_000, now), "just now");
	assert.equal(formatRelativeTime(now - 59_999, now), "just now");
	assert.equal(formatRelativeTime(now + 5_000, now), "just now", "future mtime (clock skew) counts as just now");
	assert.equal(formatRelativeTime(now - 60_000, now), "1m ago");
	assert.equal(formatRelativeTime(now - 119_000, now), "1m ago");
	assert.equal(formatRelativeTime(now - 120_000, now), "2m ago");
	assert.equal(formatRelativeTime(now - 3_599_000, now), "59m ago");
	assert.equal(formatRelativeTime(now - 3_600_000, now), "1h ago");
	assert.equal(formatRelativeTime(now - 7_200_000, now), "2h ago");
	assert.equal(formatRelativeTime(now - 86_399_000, now), "23h ago");
	assert.equal(formatRelativeTime(now - 86_400_000, now), "1d ago");
	assert.equal(formatRelativeTime(now - 3 * 86_400_000, now), "3d ago");
});

test("clampScrollTop: zero, max, negative, and degenerate viewport heights", () => {
	assert.equal(clampScrollTop(0, 100, 10), 0, "at the top");
	assert.equal(clampScrollTop(90, 100, 10), 90, "at the max scroll");
	assert.equal(clampScrollTop(91, 100, 10), 90, "above max clamps to max");
	assert.equal(clampScrollTop(-5, 100, 10), 0, "negative clamps to 0");
	assert.equal(clampScrollTop(999, 100, 10), 90, "far above max clamps to max");
	assert.equal(clampScrollTop(5, 10, 10), 0, "content fits exactly — no scroll");
	assert.equal(clampScrollTop(5, 9, 10), 0, "content shorter than viewport — no scroll");
	assert.equal(clampScrollTop(3, 0, 10), 0, "empty content — no scroll");
	assert.equal(clampScrollTop(5, 3, 0), 2, "zero viewport clamps to 1 line");
	assert.equal(clampScrollTop(5, 3, -2), 2, "negative viewport clamps to 1 line");
});

test("keyToScrollDelta: arrows, j/k, page keys with overlap, home/end sentinels, non-scroll input", () => {
	assert.equal(keyToScrollDelta("up", 20), -1);
	assert.equal(keyToScrollDelta("k", 20), -1, "k scrolls up");
	assert.equal(keyToScrollDelta("down", 20), 1);
	assert.equal(keyToScrollDelta("j", 20), 1, "j scrolls down");
	assert.equal(keyToScrollDelta("pageUp", 20), -19, "page up = viewport minus 1 overlap line");
	assert.equal(keyToScrollDelta("pageDown", 20), 19, "page down = viewport minus 1 overlap line");
	assert.equal(keyToScrollDelta("pageUp", 1), -1, "degenerate viewport pages by 1");
	assert.equal(keyToScrollDelta("pageDown", 0), 1, "zero viewport pages by 1");
	assert.equal(keyToScrollDelta("home", 20), "home");
	assert.equal(keyToScrollDelta("end", 20), "end");
	assert.equal(keyToScrollDelta("escape", 20), null, "esc is not a scroll key");
	assert.equal(keyToScrollDelta("enter", 20), null);
	assert.equal(keyToScrollDelta("x", 20), null, "unrelated letters do not scroll");
	assert.equal(keyToScrollDelta("", 20), null);
	assert.equal(keyToScrollDelta("\x1b[<64;1;1M", 20), null, "wheel sequences are not scroll keys");
});

test("parseWheelEvent: SGR wheel up/down, terminator variants, and coordinates", () => {
	assert.deepEqual(parseWheelEvent("\x1b[<64;20;5M"), { direction: -1, x: 19, y: 4 }, "SGR wheel up");
	assert.deepEqual(parseWheelEvent("\x1b[<65;20;5M"), { direction: 1, x: 19, y: 4 }, "SGR wheel down");
	assert.deepEqual(parseWheelEvent("\x1b[<64;1;1m"), { direction: -1, x: 0, y: 0 }, "lowercase m terminator accepted");
	assert.deepEqual(parseWheelEvent("\x1b[<65;100;50m"), { direction: 1, x: 99, y: 49 });
});

test("parseWheelEvent: legacy X10 encoding", () => {
	assert.deepEqual(parseWheelEvent("\x1b[M`AB"), { direction: -1, x: 32, y: 33 }, "legacy wheel up");
	assert.deepEqual(parseWheelEvent("\x1b[MaAB"), { direction: 1, x: 32, y: 33 }, "legacy wheel down");
	assert.deepEqual(parseWheelEvent("\x1b[M`\x05\x06"), { direction: -1, x: -28, y: -27 }, "raw low bytes decode by offset");
});

test("parseWheelEvent: non-wheel sequences return null", () => {
	assert.equal(parseWheelEvent("\x1b[<0;10;10M"), null, "button press");
	assert.equal(parseWheelEvent("\x1b[<32;10;10M"), null, "button drag");
	assert.equal(parseWheelEvent("\x1b[<35;20;5m"), null, "button release");
	assert.equal(parseWheelEvent("\x1b[<66;10;10M"), null, "horizontal wheel right");
	assert.equal(parseWheelEvent("\x1b[<67;10;10M"), null, "horizontal wheel left");
	assert.equal(parseWheelEvent("\x1b[M \x10\x10"), null, "legacy button press");
	assert.equal(parseWheelEvent("\x1b[A"), null, "arrow key sequence");
	assert.equal(parseWheelEvent("hello"), null, "plain text");
	assert.equal(parseWheelEvent(""), null, "empty input");
});

test("scrollPercent: null when content fits, 0 at top, 100 at the end, rounding", () => {
	assert.equal(scrollPercent(0, 10, 10), null, "content fits exactly");
	assert.equal(scrollPercent(5, 5, 10), null, "content shorter than viewport");
	assert.equal(scrollPercent(0, 0, 10), null, "empty content");
	assert.equal(scrollPercent(0, 100, 10), 0, "at the top");
	assert.equal(scrollPercent(45, 100, 10), 50, "mid-scroll");
	assert.equal(scrollPercent(90, 100, 10), 100, "exactly at the end");
	assert.equal(scrollPercent(5, 10, 5), 100, "at the end with a 5-line max scroll");
	assert.equal(scrollPercent(0, 10, 5), 0, "at the top with a 5-line max scroll");
	assert.equal(scrollPercent(1, 11, 5), 17, "rounded to the nearest percent");
	assert.equal(scrollPercent(3, 11, 5), 50);
});

test("artifactPath resolves <workflowRoot>/<branch>/<step>.md under the encoded cwd", () => {
	const h = createHarness();
	try {
		assert.equal(
			artifactPath(h.projectDir, "my-feature", "plan"),
			join(workflowRootFor(h.projectDir), "my-feature", "plan.md"),
		);
	} finally {
		h.destroy();
	}
});

test("encodeSessionDirName mirrors pi's session-dir encoding", () => {
	// Leading slash stripped, then /, \, and : all map to -.
	assert.equal(encodeSessionDirName("/home/user/proj"), "--home-user-proj--");
	assert.equal(encodeSessionDirName("/a:b/c"), "--a-b-c--", "colon maps to dash");
	assert.equal(encodeSessionDirName("/a\\b/c"), "--a-b-c--", "backslash maps to dash");

	// resolve() is applied first: relative paths encode as their resolved
	// absolute form, and a trailing slash is normalized away.
	assert.equal(encodeSessionDirName("a/b"), encodeSessionDirName(resolve("a/b")), "relative path resolves");
	assert.equal(encodeSessionDirName("/x/y/"), encodeSessionDirName("/x/y"), "trailing slash normalized");
});

test("workflowRootFor nests under getAgentDir()/piflux/workflows with the encoded cwd", () => {
	const h = createHarness();
	try {
		assert.equal(
			workflowRootFor(h.projectDir),
			join(h.globalDir, "piflux", "workflows", encodeSessionDirName(h.projectDir)),
		);
	} finally {
		h.destroy();
	}
});

test("buildSelectorItems: state first, artifacts with relative mtime or missing", () => {
	const h = createHarness();
	try {
		const cwd = h.projectDir;
		const state = { step: "code", branch: "my-feature", sessions: {} };
		const now = 1_000_000_000_000;
		const root = workflowRootFor(cwd);

		// start artifact, 10 minutes old; plan artifact, 2 hours old.
		mkdirSync(join(root, "my-feature"), { recursive: true });
		writeFileSync(join(root, "my-feature", "start.md"), "# Start\n");
		utimesSync(join(root, "my-feature", "start.md"), new Date(now - 600_000), new Date(now - 600_000));
		writeFileSync(join(root, "my-feature", "plan.md"), "# Plan\n");
		utimesSync(join(root, "my-feature", "plan.md"), new Date(now - 7_200_000), new Date(now - 7_200_000));

		const items = buildSelectorItems(state, cwd, now);
		assert.deepEqual(
			items.map((i) => i.value),
			["state", "start", "plan", "code", "review"],
			"state first, then the four artifacts",
		);
		assert.equal(items[0].label, "state");
		assert.equal(items[0].description, "step: code");
		assert.equal(items[1].description, "modified 10m ago");
		assert.equal(items[2].description, "modified 2h ago");
		assert.equal(items[3].description, "missing", "code artifact not written yet");
		assert.equal(items[4].description, "missing", "review artifact not written yet");
	} finally {
		h.destroy();
	}
});

test("renderStateSummary: step, branch, next commands, and session table", () => {
	const h = createHarness();
	try {
		const cwd = h.projectDir;
		const nextCommands = { review: ["/icode", "/ship"], abandon: [] };
		const sessionFile = join(cwd, "sessions", "review.jsonl");
		const missingFile = join(cwd, "sessions", "code.jsonl");
		mkdirSync(join(cwd, "sessions"), { recursive: true });
		writeFileSync(sessionFile, "");

		const rendered = renderStateSummary({ step: "review", branch: "my-feature", sessions: { code: missingFile, review: sessionFile } }, nextCommands, cwd);
		assert.ok(rendered.includes("Step: **review**"), "step shown");
		assert.ok(rendered.includes("Branch: **my-feature**"), "branch shown");
		assert.ok(rendered.includes("`/icode`, `/ship`"), "next commands shown");
		assert.ok(rendered.includes(`code: \`${missingFile}\` — missing`), "missing session flagged");
		assert.ok(rendered.includes(`review: \`${sessionFile}\` — exists`), "existing session flagged");

		// No next commands (terminal step) renders a dash; empty sessions render "None recorded yet".
		const terminal = renderStateSummary({ step: "abandon", branch: "my-feature", sessions: {} }, nextCommands, cwd);
		assert.ok(terminal.includes("Next: —"), "no next commands");
		assert.ok(terminal.includes("None recorded yet."), "empty session table");

		// The retryable terminal done step renders its own command as next.
		const done = renderStateSummary(
			{ step: "done", branch: "my-feature", sessions: {} },
			{ done: ["/done"], ship: ["/done"] },
			cwd,
		);
		assert.ok(done.includes("`/done`"), "done renders /done as the retryable next command");
	} finally {
		h.destroy();
	}
});

test("createWorkflowViewer returns an async handler that closes over its deps", async () => {
	const h = createHarness();
	try {
		let readCalls = 0;
		const viewer = createWorkflowViewer({
			readState: () => {
				readCalls++;
				return null;
			},
			nextCommands: {},
		});
		h.notifications.length = 0;
		await viewer(h.baseCtx as never);
		assert.equal(readCalls, 1, "state read through the injected readState");
		assert.ok(h.notifications.some((n) => n.msg.includes("nothing to view")), "idle notify");
	} finally {
		h.destroy();
	}
});

test("/piflux with an unknown subcommand shows usage", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "piflux", "foobar");
		assert.ok(h.notifications.some((n) => n.msg.includes("Usage: /piflux")), "usage shown");
	} finally {
		h.destroy();
	}
});

test("agent_settled is gone: /done tolerates a state file that cannot be deleted", async () => {
	const h = createHarness();
	let bare = "";
	try {
		bare = setupGitRepo(h);
		writePlanFile(h);
		const sessions = { start: join(h.projectDir, "sessions", "start.jsonl") };
		mkdirSync(join(h.projectDir, "sessions"), { recursive: true });
		writeFileSync(sessions.start, "");
		// State already at "done": the state write happens before the git work,
		// so a read-only workflow dir must not be written to during /done.
		writeFileSync(h.stateFile, JSON.stringify({ step: "done", branch: "my-feature", sessions }));
		// One artifact (start) is enough — the plan file must stay intact
		// (the read-only dir only blocks deletion, not reads). The branch-dir
		// delete fails the same way the per-artifact deletes used to.
		const workflowRoot = workflowRootFor(h.projectDir);
		mkdirSync(join(workflowRoot, "my-feature"), { recursive: true });
		writeFileSync(join(workflowRoot, "my-feature", "start.md"), "# start\n");

		// Make the state file undeletable by removing write permission on the repo-level workflow dir.
		chmodSync(workflowRoot, 0o555);
		try {
			h.notifications.length = 0;
			await runCommand(h, "done");
			assert.ok(existsSync(h.stateFile), "state file survives the failed unlink");
			assert.ok(h.notifications.some((n) => n.type === "warning"), "warnings shown for failed deletions");
			assert.ok(h.notifications.some((n) => n.msg.includes("workflow directory")), "branch-dir removal failure reported, not swallowed");
			assert.ok(!h.notifications.some((n) => n.msg.includes("Workflow cleaned up")), "no success notification");
			// The summary comes after the cleanup and must not claim removal.
			const summary = h.notifications.find((n) => n.msg.includes("torn down"));
			assert.ok(summary, "summary still reported");
			assert.ok(!summary.msg.includes("sessions and artifacts: removed"), "summary does not claim removal");
			assert.ok(summary.msg.includes("cleanup incomplete"), "summary reports the incomplete cleanup");
		} finally {
			chmodSync(workflowRoot, 0o755);
		}
	} finally {
		if (bare) rmSync(bare, { recursive: true, force: true });
		h.destroy();
	}
});

test("/piflux argument completions offer state, settings, and view", () => {
	const h = createHarness();
	try {
		const completions = h.commands.get("piflux")!.getArgumentCompletions!;
		// "view " carries the trailing space in its value: pi's argument
		// completion never appends a space, and without one the target
		// completions are unreachable (space never auto-triggers, TAB after
		// a space is file completion).
		assert.deepEqual(completions("")!.map((i) => i.value), ["state", "settings", "view "]);
		assert.deepEqual(completions("s")!.map((i) => i.value), ["state", "settings"]);
		assert.deepEqual(completions("st")!.map((i) => i.value), ["state"]);
		assert.deepEqual(completions("v")!.map((i) => i.value), ["view "]);
		assert.deepEqual(completions("c"), []);
		assert.deepEqual(completions("x"), []);
		// No second-token subcommands anymore.
		assert.deepEqual(completions("settings "), []);
		assert.deepEqual(completions("settings g"), []);
		// Second-token view completion: no workflow at process.cwd() (the
		// completion callback has no ctx) → viewArgumentCompletions returns
		// null → the first-token filter runs, which matches nothing here.
		assert.deepEqual(completions("view ")!.map((i) => i.value), ["view "], "trailing-space value re-matches its own prefix");
		assert.deepEqual(completions("view p"), []);
	} finally {
		h.destroy();
	}
});

test("before_agent_start with no session file is a no-op", async () => {
	const h = createHarness();
	try {
		await runCommand(h, "start", "my-feature");
		h.setCurrentSessionFile(undefined);
		await fireBeforeAgentStart(h);
		assert.equal(h.thinkingLevels.length, 0, "nothing applied");
	} finally {
		h.destroy();
	}
});

test("the $ARGUMENTS placeholder alias expands like $@", () => {
	const body = "$ARGUMENTS / ${ARGUMENTS:-fallback}";
	assert.equal(substituteArgs(body, ["alpha", "beta"]), "alpha beta / alpha beta");
	assert.equal(substituteArgs(body, []), " / fallback");
});

test("a state file without a sessions field is rejected as corrupt", async () => {
	const h = createHarness();
	try {
		// Hand-edited state file: valid JSON, valid step/branch, but no sessions.
		writeFileSync(h.stateFile, JSON.stringify({ step: "plan", branch: "my-feature" }));
		await runCommand(h, "piflux");
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.msg.includes("corrupt")), "corrupt warning shown");
		assert.ok(h.notifications.some((n) => n.msg.includes("No active workflow")), "treated as idle");

		// No crash on the malformed file — subsequent commands see idle.
		h.notifications.length = 0;
		await runCommand(h, "plan", "desc");
		assert.ok(errorNotifications(h).some((m) => m.includes("no active workflow")), "blocked as idle, no TypeError");
	} finally {
		h.destroy();
	}
});
