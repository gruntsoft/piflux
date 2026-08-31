/**
 * Node module-resolve hook used by the tests: maps the bare
 * `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` specifiers to
 * the local test stubs. Registered from the test file via `module.register()`
 * before the extension is imported.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubDir = dirname(fileURLToPath(import.meta.url));
const agentStubUrl = pathToFileURL(join(stubDir, "pi-coding-agent-stub.ts"));
const tuiStubUrl = pathToFileURL(join(stubDir, "pi-tui-stub.ts"));

export async function resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-coding-agent") {
		return { url: agentStubUrl.href, shortCircuit: true };
	}
	if (specifier === "@earendil-works/pi-tui") {
		return { url: tuiStubUrl.href, shortCircuit: true };
	}
	return next(specifier, context);
}
