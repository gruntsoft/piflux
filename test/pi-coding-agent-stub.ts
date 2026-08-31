/**
 * Test-only stand-in for the `@earendil-works/pi-coding-agent` package.
 *
 * The extension imports three runtime values from the package: `CONFIG_DIR_NAME`,
 * `getAgentDir`, and `stripFrontmatter`. Tests map the bare specifier to this
 * file via `test/hooks.mjs` (a node module resolve hook), so the extension can
 * be imported directly with `node --test` — no build step, no installed deps.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".pi";

/** Mirrors the real implementation: honors $PI_CODING_AGENT_DIR, falls back to ~/.pi/agent. */
export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function stripFrontmatter(content: string): string {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	return match ? content.slice(match[0].length) : content;
}

/** No-op stand-in for the DynamicBorder overlay component (overlay rendering is manual-verification only). */
export class DynamicBorder {
	constructor(_colorFn: (text: string) => string) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return [];
	}
}
