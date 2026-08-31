/**
 * Test-only stand-in for the `@earendil-works/pi-tui` package.
 *
 * The extension imports UI components from pi-tui for the `/piflux settings`
 * overlay. The overlay is manual-verification only (the TUI cannot be driven
 * headlessly), so the stub exports no-op classes that satisfy the imports —
 * tests never render or interact with them.
 */
export class Container {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
	removeChild(child: unknown): void {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return [];
	}
}

export class Text {
	constructor(_text?: string, _paddingX?: number, _paddingY?: number) {}
	setText(_text: string): void {}
	invalidate(): void {}
	render(_width: number): string[] {
		return [];
	}
}

export class SelectList {
	onSelect?: (item: { value: string; label: string; description?: string }) => void;
	onCancel?: () => void;
	constructor(
		_items: Array<{ value: string; label: string; description?: string }>,
		_maxVisible: number,
		_theme: object,
	) {}
	handleInput(_keyData: string): void {}
	setFilter(_filter: string): void {}
	invalidate(): void {}
	render(_width: number): string[] {
		return [];
	}
	getSelectedItem(): { value: string; label: string; description?: string } | null {
		return null;
	}
}

export class Markdown {
	constructor(_text: string, _paddingX?: number, _paddingY?: number, _theme?: object) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return [];
	}
}

export const Key = {
	backspace: "backspace",
	escape: "escape",
	enter: "enter",
	return: "return",
	up: "up",
	down: "down",
	pageUp: "pageUp",
	pageDown: "pageDown",
	home: "home",
	end: "end",
} as const;

export function matchesKey(data: string, keyId: string): boolean {
	return data === keyId;
}
