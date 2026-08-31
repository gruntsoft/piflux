/**
 * Path resolution for piflux's workflow artifacts and state.
 *
 * Artifacts and state live under the global config dir, mirroring Pi's own
 * session layout: `~/.pi/agent/piflux/workflows/--<encoded-cwd>--/` with one
 * repo-level dir per repository (named after Pi's session-dir encoding of
 * the raw cwd) and one `<branch>/` subdir per branch. Nothing lives inside
 * the repo — no .gitignore entry, no git-status clutter, no second workflow
 * root when pi starts in a subdirectory.
 *
 * This module exists because `view.ts` must not import from `index.ts`
 * (deps injection), so the shared path helpers live in a third module both
 * import.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The workflow state file name — one per repo, at the repo level. */
export const STATE_FILE_NAME = "workflow-orchestration.json";

/**
 * Package-namespaced config subdir name, derived once at load from the
 * package's own `package.json` `name` (read one level up from this file —
 * the same pattern as WORKFLOW_TEMPLATES_DIR in index.ts). Sanitized:
 * lowercase, `@scope/` prefix stripped, runs of non-alphanumerics → `-`,
 * trimmed — an identity mapping for the current name `piflux`,
 * auto-tracking across forks. Falls back to the literal `"piflux"` if the
 * package.json read ever fails, so the extension still loads.
 */
export const PACKAGE_CONFIG_DIR = (() => {
	try {
		const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")) as {
			name?: unknown;
		};
		if (typeof pkg.name === "string" && pkg.name) {
			const sanitized = pkg.name
				.toLowerCase()
				.replace(/^@[^/]+\//, "")
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "");
			if (sanitized) return sanitized;
		}
	} catch {
		// fall through to the literal fallback
	}
	return "piflux";
})();

/**
 * Replicates Pi's session-dir encoding (`getDefaultSessionDir` in
 * dist/core/session-manager.js): resolve the cwd, strip one leading `/` (or
 * `\`), then map `/`, `\`, and `:` to `-`, wrapped in `--…--`. The artifact
 * dir and the session dir share a name per repo — that name-sharing is the
 * point. Verified byte-for-byte against the installed package.
 */
export function encodeSessionDirName(cwd: string): string {
	const resolved = resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Repo-level workflow root for a cwd: `<agentDir>/<pkg>/workflows/--<encoded-cwd>--`. */
export function workflowRootFor(cwd: string): string {
	return join(getAgentDir(), PACKAGE_CONFIG_DIR, "workflows", encodeSessionDirName(cwd));
}

/** The workflow state file for a cwd — sits at the repo level, next to the branch dirs. */
export function stateFilePath(cwd: string): string {
	return join(workflowRootFor(cwd), STATE_FILE_NAME);
}

/** A branch's artifact file: `<workflowRoot>/<branch>/<step>.md`. */
export function artifactPath(cwd: string, branch: string, step: string): string {
	return join(workflowRootFor(cwd), branch, `${step}.md`);
}
