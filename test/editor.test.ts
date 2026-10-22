import { strict as assert } from "node:assert";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { VimEditor } from "../src/editor.ts";

const THEME = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
const TUI_STUB = { requestRender() {} } as unknown as TUI;

// pi adds its own app keybindings on top of the TUI defaults; the editor relies on
// `app.interrupt` to abort a run when escape is pressed outside a pending command.
const KEYBINDINGS = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"app.interrupt": { defaultKeys: "escape" },
});

function createEditor(): VimEditor {
	const keybindings = KEYBINDINGS as unknown as ConstructorParameters<typeof VimEditor>[2];
	return new VimEditor(TUI_STUB, THEME, keybindings, (text) => text);
}

function press(editor: VimEditor, ...sequences: string[]): void {
	for (const sequence of sequences) editor.handleInput(sequence);
}

const ESCAPE = "\x1b";

test("typing goes to the editor in insert mode", () => {
	const editor = createEditor();
	press(editor, ..."hello");
	assert.equal(editor.getText(), "hello");
});

test("escape switches to normal mode and hjkl moves without inserting", () => {
	const editor = createEditor();
	press(editor, ..."hello", ESCAPE);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
	press(editor, "h", "h", "x");
	assert.equal(editor.getText(), "helo");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
});

test("i enters insert mode at the cursor", () => {
	const editor = createEditor();
	press(editor, ..."abc", ESCAPE, "0", "i", "X", ESCAPE);
	assert.equal(editor.getText(), "Xabc");
});

test("dd deletes the line through the core editor buffer", () => {
	const editor = createEditor();
	editor.setText("one\ntwo");
	press(editor, ESCAPE, "k", "d", "d");
	assert.equal(editor.getText(), "two");
});

test("escape in normal mode is forwarded so it can abort a run", () => {
	const editor = createEditor();
	let escaped = false;
	editor.onEscape = () => {
		escaped = true;
	};
	press(editor, ..."text", ESCAPE);
	assert.equal(escaped, false, "first escape only leaves insert mode");
	press(editor, ESCAPE);
	assert.equal(escaped, true);
});

test("search prompt accepts enter", () => {
	const editor = createEditor();
	editor.setText("alpha beta alpha");
	press(editor, ESCAPE, "0", ..."/alpha", "\r");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 11 });
	press(editor, "n");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("u undoes a normal-mode change", () => {
	const editor = createEditor();
	editor.setText("one\ntwo");
	press(editor, ESCAPE, "k", "d", "d");
	assert.equal(editor.getText(), "two");
	press(editor, "u");
	assert.equal(editor.getText(), "one\ntwo");
});

test("submit clears the buffer and the engine resyncs instead of resurrecting it", () => {
	const editor = createEditor();
	press(editor, ..."hi", ESCAPE);
	editor.setText("");
	assert.equal(editor.getText(), "");
	press(editor, "x");
	assert.equal(editor.getText(), "");
});