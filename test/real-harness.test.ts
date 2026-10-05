/**
 * Real-harness smoke test: unlike index.test.ts, this file registers **no**
 * module resolve hook, so the extension's bare `@earendil-works/pi-coding-agent`
 * and `@earendil-works/pi-tui` specifiers resolve through `node_modules` — the
 * actual installed packages, not the test stubs. It then invokes the
 * extension's default factory with a minimal stub `ExtensionAPI` and asserts
 * that everything the extension registers survives contact with the real
 * package surface (a renamed or removed export fails the import loudly).
 *
 * This test intentionally does not skip when `node_modules` is missing: a
 * silent skip would recreate the drift blind spot it exists to close. Run
 * `npm install` first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(packageRoot, "node_modules"))) {
	throw new Error(
		"node_modules is missing — the real-harness smoke test resolves the actual installed @earendil-works packages. Run `npm install` before testing.",
	);
}

let extensionModule: typeof import("../extensions/index.ts");
try {
	extensionModule = await import("../extensions/index.ts");
} catch (error) {
	const detail = error instanceof Error ? error.stack ?? error.message : String(error);
	throw new Error(
		`Failed to import the extension against the real installed @earendil-works packages — run \`npm install\` and retry (installed copies may be missing or drifted).\n${detail}`,
	);
}

interface RecordedCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

test("real harness: the extension registers all 10 commands and 3 events against the installed pi packages", () => {
	const commands = new Map<string, RecordedCommand>();
	const events = new Map<string, unknown[]>();

	const fakePi = {
		registerCommand(name: string, options: RecordedCommand) {
			commands.set(name, options);
		},
		on(event: string, handler: unknown) {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
	} as unknown as ExtensionAPI;

	extensionModule.default(fakePi);

	assert.deepEqual(
		[...commands.keys()].sort(),
		["abandon", "code", "done", "icode", "ireview", "piflux", "plan", "review", "ship", "start"],
		"the extension must register exactly the 10 workflow commands",
	);
	for (const [name, options] of commands) {
		assert.equal(typeof options.handler, "function", `command /${name} must have a handler function`);
	}

	assert.deepEqual(
		[...events.keys()].sort(),
		["before_agent_start", "input", "session_start"],
		"the extension must register exactly the 3 lifecycle events",
	);
	for (const [event, handlers] of events) {
		assert.equal(handlers.length, 1, `event ${event} must be registered exactly once`);
		for (const handler of handlers) {
			assert.equal(typeof handler, "function", `event ${event} must have a handler function`);
		}
	}
});
