/**
 * Version-parity test: the repo's type-checking copies of the
 * `@earendil-works` packages must match the Pi harness actually running on
 * this machine — types checked against a different version than the runtime
 * are worse than useless. Compares the installed `node_modules` versions of
 * `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` against
 * `pi --version`.
 *
 * Skips only when `pi` is not on PATH (nothing to compare against); a version
 * mismatch is a hard failure with the exact refresh command. The skip path is
 * itself covered: a respawn test re-runs this file with every PATH entry that
 * provides `pi` stripped and asserts the child skips rather than fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Extracts the first semver token from `pi --version` output, however decorated. */
function runningPiVersion(): string {
	const output = execFileSync("pi", ["--version"], { encoding: "utf-8" });
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

test("parity skip path: with pi stripped from PATH the run skips rather than fails", (t) => {
	// Respawn guard: without it the child would run this test too and fork-bomb.
	if (process.env.PIFUX_PARITY_CHILD) {
		t.skip("child run of the parity file — the main test above carries the assertion");
		return;
	}

	// Re-spawn this file under node --test with every PATH entry that provides
	// `pi` removed, then assert the child exits 0 with no failures and the
	// intended skip message. Node itself is spawned by absolute path, so a
	// stripped PATH is safe.
	const strippedPath = (process.env.PATH ?? "")
		.split(":")
		.filter((entry) => entry !== "" && !existsSync(join(entry, "pi")))
		.join(":");
	// NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID must be stripped: the outer
	// runner sets them and the child would otherwise refuse to start its own
	// test run ("run() is being called recursively").
	const childEnv: NodeJS.ProcessEnv = { ...process.env, PATH: strippedPath, PIFUX_PARITY_CHILD: "1" };
	delete childEnv.NODE_TEST_CONTEXT;
	delete childEnv.NODE_TEST_WORKER_ID;
	const result = spawnSync(process.execPath, ["--test", fileURLToPath(import.meta.url)], {
		encoding: "utf-8",
		env: childEnv,
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

	assert.equal(result.status, 0, `child run should exit 0 (skips only), got ${result.status}:\n${output}`);
	assert.ok(!output.includes("✖"), `child run should have no failing tests:\n${output}`);
	assert.match(output, /pi is not on PATH/, `child run should report the intended skip message:\n${output}`);
});
