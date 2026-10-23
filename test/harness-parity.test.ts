/**
 * Version-parity test: the repo's type-checking copies of the
 * `@earendil-works` packages must match the Pi harness actually running on
 * this machine — types checked against a different version than the runtime
 * are worse than useless. Compares the installed `node_modules` versions of
 * `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` against
 * `pi --version`.
 *
 * The `pi` lookup excludes the repo's own node_modules/.bin: `npm test`
 * prepends that directory to PATH, and the npm-shipped `pi` there tracks the
 * lockfile — the very versions under test — so without the exclusion the test
 * would compare node_modules against itself and pass while drift exists.
 *
 * Skips when no `pi` remains reachable after the exclusion (nothing to
 * compare against); a version mismatch is a hard failure with the exact
 * refresh command. Respawn tests cover all three behaviors: two re-run this
 * file with `pi` made unreachable (every PATH entry providing `pi` stripped;
 * then *only* the repo's node_modules/.bin on PATH — the exact `npm test`
 * shadowing scenario) and assert the child skips rather than fails; a third
 * runs a stub `pi` outside the repo reporting a mismatched version and
 * asserts the child hard-fails with the refresh message, pinning that the
 * exclusion drops only the repo's own bin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const;

function installedVersion(pkg: string): string {
	const manifestPath = join(packageRoot, "node_modules", pkg, "package.json");
	let manifest: { version?: unknown };
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`node_modules is missing or incomplete — ${manifestPath} not found. The parity test reads the installed @earendil-works packages; run \`npm install\` before testing.`,
				{ cause: error },
			);
		}
		throw error;
	}
	if (typeof manifest.version !== "string") {
		throw new Error(`node_modules/${pkg}/package.json has no version field`);
	}
	return manifest.version;
}

function realpathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * Drops every PATH entry whose realpath is the repo's own node_modules/.bin.
 * `npm test` prepends that directory to PATH, and the npm-shipped `pi` living
 * there tracks the lockfile — without the exclusion the parity test would
 * compare node_modules against itself and pass while drift exists. When the
 * repo has no node_modules/.bin the PATH is returned untouched.
 */
function pathWithoutRepoBins(pathValue: string): string {
	const repoBin = realpathOrNull(join(packageRoot, "node_modules", ".bin"));
	if (repoBin === null) {
		return pathValue;
	}
	return pathValue
		.split(delimiter)
		.filter((entry) => entry !== "" && realpathOrNull(entry) !== repoBin)
		.join(delimiter);
}

/** Extracts the first semver token from `pi --version` output, however decorated. */
function runningPiVersion(): string {
	// Look `pi` up with the repo's own node_modules/.bin excluded (see
	// pathWithoutRepoBins) so an npm-shadowing binary can never be mistaken for
	// the harness. With that entry dropped and nothing else providing `pi`,
	// execFileSync throws ENOENT and the caller skips.
	const filteredPath = pathWithoutRepoBins(process.env.PATH ?? "");
	if (filteredPath === "") {
		// Nothing survives the exclusion. Bail explicitly instead of handing an
		// empty PATH to execFileSync: glibc's execvp treats an empty PATH as "."
		// and would run a ./pi from the cwd rather than fail to find `pi` — the
		// documented skip path must not depend on the cwd.
		throw Object.assign(new Error("pi not found: PATH is empty after excluding the repo's node_modules/.bin"), {
			code: "ENOENT",
		});
	}
	const output = execFileSync("pi", ["--version"], {
		encoding: "utf-8",
		env: { ...process.env, PATH: filteredPath },
	});
	const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
	if (!match) {
		throw new Error(`Cannot parse a semver from \`pi --version\` output: ${JSON.stringify(output)}`);
	}
	return match[0];
}

test("installed @earendil-works harness packages match the running pi version", (t) => {
	let piVersion: string;
	try {
		piVersion = runningPiVersion();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			t.skip("pi is not on PATH — nothing to compare the installed harness versions against");
			return;
		}
		throw error;
	}

	for (const pkg of HARNESS_PACKAGES) {
		const installed = installedVersion(pkg);
		assert.equal(
			installed,
			piVersion,
			`${pkg} is installed at ${installed} but pi is running ${piVersion} — refresh the dev-time harness (npm install ${pkg}@${piVersion})`,
		);
	}
});

/**
 * Re-spawns this file under node --test with `childPath` as the child's PATH
 * and asserts it exits 0 having skipped the parity test with the intended
 * message rather than failing. Node itself is spawned by absolute path, so a
 * hostile PATH is safe.
 */
function respawnAndAssertSkip(childPath: string, description: string): void {
	// NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID must be stripped: the outer
	// runner sets them and the child would otherwise refuse to start its own
	// test run ("run() is being called recursively").
	const childEnv: NodeJS.ProcessEnv = { ...process.env, PATH: childPath, PIFUX_PARITY_CHILD: "1" };
	delete childEnv.NODE_TEST_CONTEXT;
	delete childEnv.NODE_TEST_WORKER_ID;
	const result = spawnSync(process.execPath, ["--test", fileURLToPath(import.meta.url)], {
		encoding: "utf-8",
		env: childEnv,
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

	assert.equal(result.status, 0, `child run (${description}) should exit 0 (skips only), got ${result.status}:\n${output}`);
	assert.ok(!output.includes("✖"), `child run (${description}) should have no failing tests:\n${output}`);
	assert.match(output, /pi is not on PATH/, `child run (${description}) should report the intended skip message:\n${output}`);
}

test("parity skip path: with pi stripped from PATH the run skips rather than fails", (t) => {
	// Respawn guard: without it the child would run this test too and fork-bomb.
	if (process.env.PIFUX_PARITY_CHILD) {
		t.skip("child run of the parity file — the main tests above carry the assertions");
		return;
	}

	// Re-spawn this file under node --test with every PATH entry that provides
	// `pi` removed, then assert the child exits 0 with no failures and the
	// intended skip message.
	const strippedPath = (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => entry !== "" && !existsSync(join(entry, "pi")))
		.join(delimiter);
	respawnAndAssertSkip(strippedPath, "with pi stripped from PATH");
});

test("parity skip path: with only the repo's node_modules/.bin on PATH the run skips rather than self-compares", (t) => {
	// Respawn guard: without it the child would run this test too and fork-bomb.
	if (process.env.PIFUX_PARITY_CHILD) {
		t.skip("child run of the parity file — the main tests above carry the assertions");
		return;
	}

	// `npm test` puts the repo's node_modules/.bin at the head of PATH; re-spawn
	// with *only* that entry (absolute) to reproduce the shadowing worst case.
	// runningPiVersion() must exclude it, `pi` then resolves to nothing, and the
	// child must take the skip path instead of comparing node_modules against
	// the shadow binary it would otherwise find there.
	respawnAndAssertSkip(join(packageRoot, "node_modules", ".bin"), "with only the repo's node_modules/.bin on PATH");
});

test("parity failure path: a pi outside the repo with a mismatched version hard-fails with the refresh message", (t) => {
	// Respawn guard: without it the child would run this test too and fork-bomb.
	if (process.env.PIFUX_PARITY_CHILD) {
		t.skip("child run of the parity file — the main tests above carry the assertions");
		return;
	}

	// A stub `pi` in a temp dir must survive the node_modules/.bin exclusion —
	// only the repo's own bin is filtered. With the stub reporting a mismatched
	// version, the child must hard-fail with the refresh message: proof that
	// the filter drops exactly the repo bin and that genuine drift is neither
	// silently skipped nor masked by the shadow binary.
	const stubDir = mkdtempSync(join(tmpdir(), "piflux-parity-stub-"));
	try {
		writeFileSync(join(stubDir, "pi"), "#!/bin/sh\necho 0.0.0\n", { mode: 0o755 });
		const childPath = `${stubDir}${delimiter}${join(packageRoot, "node_modules", ".bin")}`;
		const childEnv: NodeJS.ProcessEnv = { ...process.env, PATH: childPath, PIFUX_PARITY_CHILD: "1" };
		delete childEnv.NODE_TEST_CONTEXT;
		delete childEnv.NODE_TEST_WORKER_ID;
		const result = spawnSync(process.execPath, ["--test", fileURLToPath(import.meta.url)], {
			encoding: "utf-8",
			env: childEnv,
		});
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

		assert.notEqual(result.status, 0, `child run should hard-fail on the version mismatch, got exit 0:\n${output}`);
		assert.match(output, /refresh the dev-time harness/, `child run should fail with the refresh message:\n${output}`);
	} finally {
		rmSync(stubDir, { recursive: true, force: true });
	}
});
