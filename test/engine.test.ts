import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VimEngine, columnOf, lineOf } from "../src/engine.ts";

/** Feed keys one by one; a string of length 1 is a printable key, otherwise use an array. */
function keys(engine: VimEngine, sequence: Array<string> | string): VimEngine {
	const list = typeof sequence === "string" ? [...sequence] : sequence;
	for (const key of list) engine.feed(key);
	return engine;
}

function createEngine(text: string, mode: "normal" | "insert" = "normal"): VimEngine {
	const engine = new VimEngine();
	engine.sync(text, 0);
	engine.mode = mode;
	return engine;
}

/** Type text in insert mode through the engine's replay path, mimicking the editor adapter. */
function insert(engine: VimEngine, text: string): void {
	for (const char of text) engine.feed(char);
}

test("h l move within a line and stop at its edges", () => {
	const engine = createEngine("hello world");
	keys(engine, "ll");
	assert.equal(engine.offset, 2);
	keys(engine, "hhh");
	assert.equal(engine.offset, 0);
	keys(engine, "999l");
	assert.equal(engine.offset, 10);
});

test("j and k keep the column across lines", () => {
	const engine = createEngine("abcdef\nab\nabcdef");
	keys(engine, "llllj");
	assert.deepEqual([lineOf(engine.text, engine.offset), columnOf(engine.text, engine.offset)], [1, 1]);
	keys(engine, "k");
	assert.deepEqual([lineOf(engine.text, engine.offset), columnOf(engine.text, engine.offset)], [0, 4]);
});

test("w b e walk words", () => {
	const engine = createEngine("foo bar baz qux");
	keys(engine, "w");
	assert.equal(engine.offset, 4);
	keys(engine, "w");
	assert.equal(engine.offset, 8);
	keys(engine, "b");
	assert.equal(engine.offset, 4);
	keys(engine, "0e");
	assert.equal(engine.offset, 2);
	keys(engine, "e");
	assert.equal(engine.offset, 6);
});

test("w stops at punctuation, W does not", () => {
	const engine = createEngine("foo bar-baz qux");
	keys(engine, "ww");
	assert.equal(engine.offset, 7);
	keys(engine, "0W");
	assert.equal(engine.offset, 4);
	keys(engine, "W");
	assert.equal(engine.offset, 12);
});

test("W treats punctuation as part of a big word", () => {
	const engine = createEngine("foo bar-baz qux");
	keys(engine, "W");
	assert.equal(engine.offset, 4);
	keys(engine, "W");
	assert.equal(engine.offset, 12);
});

test("x deletes characters and fills the register", () => {
	const engine = createEngine("hello");
	keys(engine, "x");
	assert.equal(engine.text, "ello");
	keys(engine, "2x");
	assert.equal(engine.text, "lo");
	assert.equal(engine.register.text, "el");
});

test("dd removes a line and yy p restores it", () => {
	const engine = createEngine("one\ntwo\nthree");
	keys(engine, "dd");
	assert.equal(engine.text, "two\nthree");
	keys(engine, "yy");
	assert.equal(engine.register.text, "two");
	keys(engine, "p");
	assert.equal(engine.text, "two\ntwo\nthree");
	assert.equal(lineOf(engine.text, engine.offset), 1);
});

test("dd on the last line does not leave a blank line", () => {
	const engine = createEngine("one\ntwo");
	keys(engine, ["j", "d", "d"]);
	assert.equal(engine.text, "one");
	assert.equal(engine.offset, 0);
});

test("dw stops at the line break", () => {
	const engine = createEngine("foo bar\nbaz");
	keys(engine, "wdw");
	assert.equal(engine.text, "foo \nbaz");
});

test("cw changes only the word", () => {
	const engine = createEngine("foo bar");
	keys(engine, ["c", "w"]);
	assert.equal(engine.mode, "insert");
	insert(engine, "X");
	keys(engine, ["escape"]);
	assert.equal(engine.text, "X bar");
	assert.equal(engine.offset, 0);
});

test("diw deletes the word under the cursor", () => {
	const engine = createEngine("foo bar baz");
	keys(engine, "wdiw");
	assert.equal(engine.text, "foo  baz");
});

test("da( deletes the parenthesised group including brackets", () => {
	const engine = createEngine("call(alpha, beta) end");
	keys(engine, ["f", "(", "d", "a", "("]);
	assert.equal(engine.text, "call end");
});

test("di( keeps the brackets", () => {
	const engine = createEngine("call(alpha)");
	keys(engine, [..."fedi("]);
	assert.equal(engine.text, "call()");
});

test("d$ deletes to the end of the line", () => {
	const engine = createEngine("foo bar\nbaz");
	keys(engine, "wd$");
	assert.equal(engine.text, "foo \nbaz");
});

test("V j d deletes whole lines", () => {
	const engine = createEngine("one\ntwo\nthree");
	keys(engine, ["V", "j", "d"]);
	assert.equal(engine.text, "three");
});

test("visual y then P pastes above", () => {
	const engine = createEngine("one\ntwo");
	keys(engine, ["V", "y"]);
	assert.equal(engine.register.text, "one");
	keys(engine, ["j", "P"]);
	assert.equal(engine.text, "one\none\ntwo");
});

test("d2w deletes two words and 2d2w multiplies counts", () => {
	const engine = createEngine("a b c d e");
	keys(engine, "d2w");
	assert.equal(engine.text, "c d e");
	const engine2 = createEngine("a b c d e");
	keys(engine2, "2d2w");
	assert.equal(engine2.text, "e");
});

test("o opens a line below and escape returns to normal mode", () => {
	const engine = createEngine("one");
	keys(engine, "o");
	assert.equal(engine.mode, "insert");
	assert.equal(engine.text, "one\n");
	insert(engine, "two");
	keys(engine, ["escape"]);
	assert.equal(engine.text, "one\ntwo");
	assert.equal(engine.mode, "normal");
	assert.deepEqual([lineOf(engine.text, engine.offset), columnOf(engine.text, engine.offset)], [1, 2]);
});

test("A appends at the end of the line", () => {
	const engine = createEngine("one");
	keys(engine, ["A"]);
	insert(engine, "!");
	keys(engine, ["escape"]);
	assert.equal(engine.text, "one!");
});

test("u undoes a whole insert session and ctrl+r redoes it", () => {
	const engine = createEngine("start");
	keys(engine, ["A"]);
	insert(engine, " more");
	keys(engine, ["escape"]);
	assert.equal(engine.text, "start more");
	keys(engine, "u");
	assert.equal(engine.text, "start");
	keys(engine, ["ctrl+r"]);
	assert.equal(engine.text, "start more");
});

test("dot repeats the last change", () => {
	const engine = createEngine("a b c d");
	keys(engine, "dw");
	assert.equal(engine.text, "b c d");
	keys(engine, ".");
	assert.equal(engine.text, "c d");
});

test("dot replays insertions", () => {
	const engine = createEngine("one two three");
	keys(engine, ["w", "c", "w"]);
	insert(engine, "X");
	keys(engine, ["escape"]);
	assert.equal(engine.text, "one X three");
	keys(engine, "w.");
	assert.equal(engine.text, "one X X");
});

test("search moves to the next match and n repeats", () => {
	const engine = createEngine("alpha beta alpha gamma");
	keys(engine, ["/", "a", "l", "p", "h", "a", "enter"]);
	assert.equal(engine.offset, 11);
	keys(engine, "n");
	assert.equal(engine.offset, 0);
});

test("f jumps to a character on the line", () => {
	const engine = createEngine("abcabc");
	keys(engine, ["f", "c"]);
	assert.equal(engine.offset, 2);
	keys(engine, ";");
	assert.equal(engine.offset, 5);
});

test("r replaces characters without entering insert mode", () => {
	const engine = createEngine("abc");
	keys(engine, ["r", "z"]);
	assert.equal(engine.text, "zbc");
	assert.equal(engine.mode, "normal");
	keys(engine, ["2", "r", "y"]);
	assert.equal(engine.text, "yyc");
});

test("G and gg jump to the buffer edges", () => {
	const engine = createEngine("one\ntwo\nthree");
	keys(engine, "G");
	assert.equal(lineOf(engine.text, engine.offset), 2);
	keys(engine, ["g", "g"]);
	assert.equal(engine.offset, 0);
	keys(engine, "2G");
	assert.equal(lineOf(engine.text, engine.offset), 1);
});

test("escape clears a pending operator", () => {
	const engine = createEngine("abc");
	keys(engine, ["d", "escape", "l"]);
	assert.equal(engine.text, "abc");
	assert.equal(engine.offset, 1);
});

test("J joins lines", () => {
	const engine = createEngine("one\n   two\nthree");
	keys(engine, "J");
	assert.equal(engine.text, "one two\nthree");
});

test("yank and put share a characterwise register", () => {
	const engine = createEngine("abc def");
	keys(engine, "yw");
	assert.equal(engine.register.text, "abc ");
	const engine2 = createEngine("xyz");
	keys(engine2, [..."2yy"]);
	assert.equal(engine2.text, "xyz");
});