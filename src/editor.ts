/**
 * TUI adapter: a `CustomEditor` that delegates normal/visual mode keys to the
 * vim engine and hands insert-mode typing to the core pi editor, so completion,
 * history, paste handling and app keybindings keep working while typing.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
import { VimEngine, columnOf, lineOf, offsetOf } from "./engine.ts";

/**
 * The pi editor keeps its buffer and cursor in these members. They are declared
 * private but are the only way to place the cursor and edit the buffer, so the
 * adapter reaches them through one narrow, documented cast.
 */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	setCursorCol(column: number): void;
	cancelAutocomplete(): void;
}

const KEY_ALIASES: Array<[KeyId, string]> = [
	["escape", "escape"],
	["up", "k"],
	["down", "j"],
	["left", "h"],
	["right", "l"],
	["home", "0"],
	["end", "$"],
	["enter", "enter"],
	["ctrl+r", "ctrl+r"],
];

/** Single printable character in `data`, ignoring control sequences and multi-key pastes. */
function printableOf(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data);
	if (decoded !== undefined) return decoded;
	if (data.includes("\x1b") || data.length === 0) return undefined;
	for (const char of data) {
		if (char.charCodeAt(0) < 32) return undefined;
	}
	const characters = [...data];
	return characters.length === 1 ? characters[0] : undefined;
}

function toCommandKey(data: string): string | undefined {
	for (const [keyId, engineKey] of KEY_ALIASES) {
		if (matchesKey(data, keyId)) return engineKey;
	}
	return printableOf(data);
}

function toInsertLogKey(data: string): string | undefined {
	if (matchesKey(data, "enter")) return "enter";
	if (matchesKey(data, "backspace")) return "backspace";
	return printableOf(data);
}

export class VimEditor extends CustomEditor {
	private engine = new VimEngine();
	private readonly labelColor: (text: string) => string;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, labelColor: (text: string) => string) {
		super(tui, theme, keybindings);
		this.labelColor = labelColor;
		this.syncEngineFromEditor();
		this.engine.mode = "insert";
	}

	handleInput(data: string): void {
		if (this.engine.mode === "insert") {
			if (matchesKey(data, "escape")) {
				this.syncEngineFromEditor();
				this.engine.recordInsertKey("escape");
				this.engine.leaveInsertMode();
				this.writeEditor();
				return;
			}
			const logged = toInsertLogKey(data);
			if (logged !== undefined) this.engine.recordInsertKey(logged);
			super.handleInput(data);
			return;
		}

		this.adoptExternalChanges();

		const key = toCommandKey(data);
		if (key === undefined) {
			super.handleInput(data);
			return;
		}
		if (key === "escape" && !this.engine.hasPendingKeys()) {
			if (this.engine.mode !== "normal") {
				this.engine.exitVisualMode();
				this.writeEditor();
				return;
			}
			super.handleInput(data);
			return;
		}

		this.engine.feed(key);
		this.writeEditor();
	}

	renderTopBorder(width: number, hiddenLineCount: number): string {
		const border = super.renderTopBorder(width, hiddenLineCount);
		const label = this.engine.statusLabel;
		if (label === "") return border;
		const styled = this.labelColor(` ${label} `);
		const labelWidth = visibleWidth(styled);
		if (labelWidth + 4 > width) return border;
		return truncateToWidth(border, width - labelWidth, "") + styled;
	}

	/** Pick up buffer changes the core editor made, such as a submit clearing it. */
	private adoptExternalChanges(): void {
		const internals = this.internals();
		if (internals.state.lines.join("\n") !== this.engine.text) this.syncEngineFromEditor();
	}

	private syncEngineFromEditor(): void {
		const internals = this.internals();
		const text = internals.state.lines.join("\n");
		const offset = offsetOf(text, internals.state.cursorLine, internals.state.cursorCol);
		this.engine.sync(text, offset);
	}

	private writeEditor(): void {
		const internals = this.internals();
		const { text, offset } = this.engine;
		if (internals.state.lines.join("\n") !== text) {
			internals.cancelAutocomplete();
			internals.state.lines = text.split("\n");
			this.onChange?.(this.getText());
		}
		internals.state.cursorLine = Math.min(lineOf(text, offset), internals.state.lines.length - 1);
		internals.setCursorCol(columnOf(text, offset));
		this.tui.requestRender();
	}

	private internals(): EditorInternals {
		return this as unknown as EditorInternals;
	}
}

export function createVimEditorFactory(labelColor: (text: string) => string) {
	return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
		new VimEditor(tui, theme, keybindings, labelColor);
}