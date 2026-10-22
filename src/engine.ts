/**
 * A small vim text engine: modes, motions, operators, text objects, registers,
 * undo/redo and search, over a plain string buffer.
 *
 * The engine owns text and cursor as a single offset. The TUI adapter converts
 * that offset into line/column for the pi editor and hands insert-mode typing to
 * the core editor, so this file stays free of terminal concerns and is testable
 * with plain `node --test`.
 */

export type Mode = "insert" | "normal" | "visual" | "visual-line";
export type Direction = "forward" | "backward";
export type Operator = "d" | "c" | "y";

interface Snapshot {
	text: string;
	offset: number;
}

/** A resolved motion: the cursor target plus the range an operator applies to. */
export interface Motion {
	/** Inclusive start offset. */
	start: number;
	/** Exclusive end offset. */
	end: number;
	/** Where the cursor lands. */
	target: number;
	linewise: boolean;
}

type Awaiting =
	| { kind: "g"; count: number }
	| { kind: "f" | "F" | "t" | "T"; count: number }
	| { kind: "r"; count: number }
	| { kind: "textobject"; prefix: "i" | "a" };

interface FindState {
	char: string;
	forward: boolean;
	till: boolean;
}

const WHITESPACE = /\s/;
const WORD_CHARACTER = /[A-Za-z0-9_]/;

/** Vim's three character classes: 0 space, 1 word, 2 punctuation (merged into 1 for W/B/E). */
function charClass(char: string | undefined, bigWord: boolean): 0 | 1 | 2 {
	if (char === undefined || WHITESPACE.test(char)) return 0;
	if (bigWord) return 1;
	return WORD_CHARACTER.test(char) ? 1 : 2;
}

export function lineStartAt(text: string, offset: number): number {
	return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset of the line break ending the line at `offset`, or text length. */
export function lineEndAt(text: string, offset: number): number {
	const index = text.indexOf("\n", offset);
	return index < 0 ? text.length : index;
}

export function lineOf(text: string, offset: number): number {
	let line = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") line++;
	}
	return line;
}

export function columnOf(text: string, offset: number): number {
	return offset - lineStartAt(text, offset);
}

export function lineCountOf(text: string): number {
	let count = 1;
	for (const char of text) {
		if (char === "\n") count++;
	}
	return count;
}

export function lineLengthOf(text: string, line: number): number {
	const start = offsetOf(text, line, 0);
	return lineEndAt(text, start) - start;
}

export function offsetOf(text: string, line: number, column: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) {
		const breakIndex = text.indexOf("\n", offset);
		if (breakIndex < 0) return text.length;
		offset = breakIndex + 1;
	}
	return Math.min(offset + Math.max(0, column), lineEndAt(text, offset));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function exclusiveMotion(offset: number, target: number): Motion {
	return target >= offset
		? { start: offset, end: target, target, linewise: false }
		: { start: target, end: offset, target, linewise: false };
}

function inclusiveMotion(offset: number, target: number): Motion {
	return target >= offset
		? { start: offset, end: target + 1, target, linewise: false }
		: { start: target, end: offset + 1, target, linewise: false };
}

function wordForward(text: string, offset: number, bigWord: boolean, count: number): number {
	let index = offset;
	for (let step = 0; step < count; step++) {
		if (index >= text.length) break;
		const current = charClass(text[index], bigWord);
		while (index < text.length && charClass(text[index], bigWord) === current) index++;
		while (index < text.length && charClass(text[index], bigWord) === 0) index++;
	}
	return Math.min(index, text.length);
}

function wordBackward(text: string, offset: number, bigWord: boolean, count: number): number {
	let index = offset;
	for (let step = 0; step < count; step++) {
		if (index <= 0) break;
		index--;
		while (index > 0 && charClass(text[index], bigWord) === 0) index--;
		const current = charClass(text[index], bigWord);
		if (current === 0) break;
		while (index > 0 && charClass(text[index - 1], bigWord) === current) index--;
	}
	return index;
}

function wordEnd(text: string, offset: number, bigWord: boolean, count: number): number {
	let index = offset;
	for (let step = 0; step < count; step++) {
		index++;
		while (index < text.length && charClass(text[index], bigWord) === 0) index++;
		if (index >= text.length) return Math.max(0, text.length - 1);
		const current = charClass(text[index], bigWord);
		while (index + 1 < text.length && charClass(text[index + 1], bigWord) === current) index++;
	}
	return Math.max(0, index);
}

export class VimEngine {
	mode: Mode = "insert";
	text = "";
	offset = 0;
	readonly register = { text: "", linewise: false };
	searchQuery = "";
	searchDirection: Direction = "forward";

	private count = "";
	private operator: Operator | undefined;
	private operatorCount = 1;
	private awaiting: Awaiting | undefined;
	private searchInput: string | undefined;
	private searchInputDirection: Direction = "forward";
	private undoStack: Snapshot[] = [];
	private redoStack: Snapshot[] = [];
	/** Keys of the command in progress, used to record `.` repeats. */
	private keys: string[] = [];
	private lastChange: string[] | undefined;
	private changeHappened = false;
	private replaying = false;
	private visualAnchor = 0;
	private preferredColumn: number | undefined;
	private lastFind: FindState | undefined;
	private insertStartText = "";

	/** Adopt the core editor's buffer and cursor, e.g. when leaving insert mode. */
	sync(text: string, offset: number): void {
		this.text = text;
		this.offset = clamp(offset, 0, text.length);
	}

	get statusLabel(): string {
		if (this.mode === "insert") return "";
		const name = this.mode === "visual-line" ? "V-LINE" : this.mode === "visual" ? "VISUAL" : "NORMAL";
		const pending = this.pendingLabel;
		return pending ? `${name} ${pending}` : name;
	}

	get pendingLabel(): string {
		if (this.searchInput !== undefined) {
			return `${this.searchInputDirection === "forward" ? "/" : "?"}${this.searchInput}`;
		}
		let label = this.count;
		if (this.operator) label += this.operator;
		if (this.awaiting) {
			label += this.awaiting.kind === "textobject" ? this.awaiting.prefix : this.awaiting.kind;
		}
		return label;
	}

	hasPendingKeys(): boolean {
		return this.count !== "" || this.operator !== undefined || this.awaiting !== undefined || this.searchInput !== undefined;
	}

	/** Cancel a half-typed command (escape in normal mode). Returns true if something was cancelled. */
	cancelPending(): boolean {
		const hadPending = this.hasPendingKeys();
		this.count = "";
		this.operator = undefined;
		this.operatorCount = 1;
		this.awaiting = undefined;
		this.searchInput = undefined;
		this.resetCommand();
		return hadPending;
	}

	exitVisualMode(): void {
		if (this.mode !== "visual" && this.mode !== "visual-line") return;
		this.mode = "normal";
		this.clampNormal();
		this.resetCommand();
	}

	/** Record a key typed in insert mode so `.` can replay the insertion. */
	recordInsertKey(key: string): void {
		this.keys.push(key);
	}

	/**
	 * Leave insert mode after the adapter synced the editor buffer: step the cursor
	 * back one character as vim does, then close out the command for `.`.
	 */
	leaveInsertMode(): void {
		this.mode = "normal";
		if (this.text !== this.insertStartText) this.changeHappened = true;
		const start = lineStartAt(this.text, this.offset);
		if (this.offset > start) this.offset--;
		this.clampNormal();
		this.finishCommand();
	}

	/** Feed one logical key (printable character or a name such as "escape"). */
	feed(key: string): void {
		this.keys.push(key);
		if (this.mode === "insert") {
			this.feedInsertKey(key);
			return;
		}
		if (this.searchInput !== undefined) {
			this.feedSearchKey(key);
			return;
		}
		if (this.mode === "visual" || this.mode === "visual-line") {
			this.handleVisualKey(key);
		} else {
			this.handleNormalKey(key);
		}
		this.finishCommand();
	}

	private feedInsertKey(key: string): void {
		if (key === "escape") {
			this.leaveInsertMode();
			return;
		}
		if (key === "enter") {
			this.insertText("\n");
			return;
		}
		if (key === "backspace") {
			if (this.offset === 0) return;
			this.text = this.text.slice(0, this.offset - 1) + this.text.slice(this.offset);
			this.offset--;
			this.changeHappened = true;
			return;
		}
		if (key.length !== 1) return;
		this.insertText(key);
	}

	private insertText(value: string): void {
		this.text = this.text.slice(0, this.offset) + value + this.text.slice(this.offset);
		this.offset += value.length;
		this.changeHappened = true;
	}

	private feedSearchKey(key: string): void {
		if (key === "escape") {
			this.searchInput = undefined;
			this.resetCommand();
			return;
		}
		if (key === "backspace") {
			this.searchInput = (this.searchInput ?? "").slice(0, -1);
			return;
		}
		if (key === "enter") {
			const query = this.searchInput ?? "";
			this.searchInput = undefined;
			if (query !== "") {
				this.searchQuery = query;
				this.searchDirection = this.searchInputDirection;
				this.searchFrom(0, this.searchInputDirection === "backward");
			}
			return;
		}
		if (key.length === 1) this.searchInput = (this.searchInput ?? "") + key;
	}

	private handleNormalKey(key: string): void {
		// Normal mode moves down on enter, but the search prompt needs enter itself.
		if (key === "enter") key = "j";
		if (this.awaiting) {
			this.handleAwaiting(key);
			return;
		}
		if (/^[0-9]$/.test(key) && (key !== "0" || this.count !== "")) {
			this.count += key;
			return;
		}
		if (key === "d" || key === "c" || key === "y") {
			this.handleOperatorKey(key);
			return;
		}
		if (this.operator) {
			this.handleOperatorMotion(key);
			return;
		}

		switch (key) {
			case "/":
			case "?":
				this.searchInput = "";
				this.searchInputDirection = key === "/" ? "forward" : "backward";
				return;
			case "n":
			case "N":
				this.takeCount();
				this.searchFrom(0, (key === "n") !== (this.searchDirection === "backward"));
				return;
			case "g":
				this.awaiting = { kind: "g", count: this.takeCount() };
				return;
			case "f":
			case "F":
			case "t":
			case "T":
				this.awaiting = { kind: key, count: this.takeCount() };
				return;
			case "r":
				this.awaiting = { kind: "r", count: this.takeCount() };
				return;
			case "i":
			case "a":
			case "I":
			case "A":
			case "o":
			case "O":
				this.enterInsert(key);
				return;
			case "v":
			case "V":
				this.startVisual(key === "V" ? "visual-line" : "visual");
				return;
			case "escape":
				this.cancelPending();
				return;
			case "x":
				this.deleteCharacters(this.takeCount(), true);
				return;
			case "X":
				this.deleteCharacters(this.takeCount(), false);
				return;
			case "D":
				this.takeCount();
				this.applyOperator("d", { start: this.offset, end: lineEndAt(this.text, this.offset), target: this.offset, linewise: false });
				return;
			case "C":
				this.takeCount();
				this.applyOperator("c", { start: this.offset, end: lineEndAt(this.text, this.offset), target: this.offset, linewise: false });
				return;
			case "s":
				this.deleteCharacters(this.takeCount(), true, "c");
				return;
			case "S":
				this.applyOperatorToLines("c", this.takeCount());
				return;
			case "p":
				this.put(false, this.takeCount());
				return;
			case "P":
				this.put(true, this.takeCount());
				return;
			case "u":
				this.takeCount();
				this.undo();
				return;
			case "ctrl+r":
				this.takeCount();
				this.redo();
				return;
			case "~":
				this.toggleCase(this.takeCount());
				return;
			case "J":
				this.joinLines(this.takeCount());
				return;
			case ".":
				this.repeatLastChange(this.takeCount());
				return;
			case ";":
			case ",": {
				const count = this.takeCount();
				this.repeatFind(key === ";", count);
				return;
			}
		}

		const motion = this.computeMotion(key, this.takeCount());
		if (motion) {
			this.offset = motion.target;
			this.clampNormal();
			return;
		}
		this.resetCommand();
	}

	private handleOperatorKey(operator: Operator): void {
		const count = this.takeCount();
		if (this.operator === operator) {
			this.applyOperatorToLines(operator, this.operatorCount * count);
			this.resetCommand();
			return;
		}
		if (this.operator) {
			this.resetCommand();
			return;
		}
		this.operator = operator;
		this.operatorCount = count;
	}

	private handleOperatorMotion(key: string): void {
		const operator = this.operator as Operator;
		const motionCount = this.takeCount();
		const total = this.operatorCount * motionCount;

		if (key === "i" || key === "a") {
			this.awaiting = { kind: "textobject", prefix: key };
			return;
		}
		if (key === "g") {
			this.awaiting = { kind: "g", count: total };
			return;
		}
		if (key === "f" || key === "F" || key === "t" || key === "T") {
			this.awaiting = { kind: key, count: total };
			return;
		}

		// `cw` changes to the end of the word instead of its trailing whitespace.
		const motionKey = operator === "c" && key === "w" ? "e" : operator === "c" && key === "W" ? "E" : key;
		const motion = this.computeMotion(motionKey, total);
		if (!motion) {
			this.resetCommand();
			return;
		}
		let { start, end } = motion;
		// `dw` at the end of a line stops before the line break, as in vim.
		if (
			!motion.linewise &&
			(motionKey === "w" || motionKey === "W") &&
			motion.target > this.offset &&
			lineOf(this.text, motion.target) > lineOf(this.text, this.offset)
		) {
			end = lineEndAt(this.text, this.offset);
		}
		this.applyOperator(operator, { start, end, target: motion.target, linewise: motion.linewise });
		this.resetCommand();
	}

	private handleAwaiting(key: string): void {
		const awaiting = this.awaiting as Awaiting;
		this.awaiting = undefined;
		if (key === "escape") {
			this.resetCommand();
			return;
		}

		switch (awaiting.kind) {
			case "g": {
				if (key !== "g") {
					this.resetCommand();
					return;
				}
				const line = awaiting.count > 1 ? awaiting.count - 1 : 0;
				this.applyGotoLine(line);
				this.resetCommand();
				return;
			}
			case "f":
			case "F":
			case "t":
			case "T": {
				if (key.length !== 1) {
					this.resetCommand();
					return;
				}
				const forward = awaiting.kind === "f" || awaiting.kind === "t";
				this.lastFind = { char: key, forward, till: awaiting.kind === "t" || awaiting.kind === "T" };
				this.applyFind(this.lastFind, awaiting.count);
				this.resetCommand();
				return;
			}
			case "r": {
				if (key.length === 1) this.replaceCharacters(key, awaiting.count);
				this.resetCommand();
				return;
			}
			case "textobject": {
				this.applyTextObject(awaiting.prefix, key);
				this.resetCommand();
				return;
			}
		}
	}

	private handleVisualKey(key: string): void {
		if (/^[0-9]$/.test(key) && (key !== "0" || this.count !== "")) {
			this.count += key;
			return;
		}
		const count = this.takeCount();
		switch (key) {
			case "escape":
				this.exitVisualMode();
				return;
			case "v":
				this.mode = this.mode === "visual" ? "normal" : "visual";
				if (this.mode === "normal") this.clampNormal();
				return;
			case "V":
				this.mode = this.mode === "visual-line" ? "normal" : "visual-line";
				if (this.mode === "normal") this.clampNormal();
				return;
			case "o":
				this.swapVisualEnds();
				return;
			case "d":
			case "x":
				this.applyVisualOperator("d");
				return;
			case "y":
				this.applyVisualOperator("y");
				return;
			case "c":
				this.applyVisualOperator("c");
				return;
			case "~":
				this.applyVisualOperator("d", true);
				return;
			default: {
				const motion = this.computeMotion(key, count);
				if (motion) {
					this.offset = motion.target;
					this.clampVisual();
				}
				return;
			}
		}
	}

	private startVisual(mode: "visual" | "visual-line"): void {
		this.visualAnchor = this.offset;
		this.mode = mode;
		this.takeCount();
	}

	private swapVisualEnds(): void {
		const anchor = this.visualAnchor;
		this.visualAnchor = this.offset;
		this.offset = anchor;
	}

	private applyVisualOperator(operator: Operator, toggleCaseOnly = false): void {
		const motion = this.visualRange();
		if (toggleCaseOnly) {
			this.toggleCaseRange(motion.start, motion.end);
		} else {
			this.applyOperator(operator, motion);
		}
		this.mode = "normal";
		this.clampNormal();
		this.resetCommand();
	}

	private visualRange(): Motion {
		const low = Math.min(this.visualAnchor, this.offset);
		const high = Math.max(this.visualAnchor, this.offset);
		if (this.mode === "visual-line") {
			return this.lineRange(lineOf(this.text, low), lineOf(this.text, high));
		}
		return { start: low, end: high + 1, target: low, linewise: false };
	}

	private lineRange(firstLine: number, lastLine: number): Motion {
		const start = offsetOf(this.text, firstLine, 0);
		const lastLineEnd = lineEndAt(this.text, offsetOf(this.text, lastLine, 0));
		const end = lastLineEnd < this.text.length ? lastLineEnd + 1 : this.text.length;
		return { start, end, target: start, linewise: true };
	}

	private computeMotion(key: string, count: number): Motion | undefined {
		const text = this.text;
		const offset = this.offset;
		if (text.length === 0) return { start: 0, end: 0, target: 0, linewise: false };

		switch (key) {
			case "h": {
				this.preferredColumn = undefined;
				return exclusiveMotion(offset, Math.max(lineStartAt(text, offset), offset - count));
			}
			case "l": {
				this.preferredColumn = undefined;
				return exclusiveMotion(offset, Math.min(lineEndAt(text, offset), offset + count));
			}
			case "j":
			case "k": {
				const delta = key === "j" ? count : -count;
				const line = clamp(lineOf(text, offset) + delta, 0, lineCountOf(text) - 1);
				const column = this.preferredColumn ?? columnOf(text, offset);
				this.preferredColumn = column;
				const target = offsetOf(text, line, Math.min(column, lineLengthOf(text, line)));
				return { ...this.lineRange(lineOf(text, offset), line), target };
			}
			case "0": {
				this.preferredColumn = undefined;
				return exclusiveMotion(offset, lineStartAt(text, offset));
			}
			case "^": {
				this.preferredColumn = undefined;
				const start = lineStartAt(text, offset);
				const end = lineEndAt(text, start);
				let target = start;
				while (target < end && (text[target] === " " || text[target] === "\t")) target++;
				return exclusiveMotion(offset, target);
			}
			case "$": {
				this.preferredColumn = undefined;
				const line = clamp(lineOf(text, offset) + count - 1, 0, lineCountOf(text) - 1);
				const start = offsetOf(text, line, 0);
				const target = Math.max(start, lineEndAt(text, start) - 1);
				return inclusiveMotion(offset, target);
			}
			case "w":
			case "W": {
				this.preferredColumn = undefined;
				return exclusiveMotion(offset, wordForward(text, offset, key === "W", count));
			}
			case "b":
			case "B": {
				this.preferredColumn = undefined;
				return exclusiveMotion(offset, wordBackward(text, offset, key === "B", count));
			}
			case "e":
			case "E": {
				this.preferredColumn = undefined;
				return inclusiveMotion(offset, wordEnd(text, offset, key === "E", count));
			}
			case "G": {
				this.preferredColumn = undefined;
				const line = count > 1 ? clamp(count - 1, 0, lineCountOf(text) - 1) : lineCountOf(text) - 1;
				return { ...this.lineRange(lineOf(text, offset), line), target: offsetOf(text, line, 0) };
			}
			case "{":
			case "}": {
				this.preferredColumn = undefined;
				return exclusiveMotion(offset, paragraphMotion(text, offset, count, key === "}"));
			}
		}
		return undefined;
	}

	/** Apply an operator to whole lines starting at the cursor line. */
	private applyOperatorToLines(operator: Operator, count: number): void {
		const firstLine = lineOf(this.text, this.offset);
		const lastLine = clamp(firstLine + count - 1, 0, lineCountOf(this.text) - 1);
		this.applyOperator(operator, this.lineRange(firstLine, lastLine));
	}

	private applyOperator(operator: Operator, motion: Motion): void {
		const removed = this.text.slice(motion.start, motion.end);
		this.register.text = motion.linewise ? removed.replace(/\n$/, "") : removed;
		this.register.linewise = motion.linewise;

		if (operator === "y") {
			this.offset = motion.start;
			this.clampNormal();
			return;
		}

		this.pushUndo();
		let start = motion.start;
		const end = motion.end;
		// Deleting the final line must consume the preceding line break, not leave a blank line.
		const trimmedLineBreak = motion.linewise && end === this.text.length && start > 0;
		if (trimmedLineBreak) start--;
		this.text = this.text.slice(0, start) + this.text.slice(end);
		this.offset = trimmedLineBreak ? lineStartAt(this.text, Math.min(start, this.text.length)) : start;
		this.changeHappened = true;
		if (operator === "c") {
			this.mode = "insert";
			this.insertStartText = this.text;
			this.clampInsert();
			return;
		}
		this.clampNormal();
	}

	private applyTextObject(prefix: "i" | "a", key: string): void {
		const range =
			key === "w" || key === "W" ? this.wordObjectRange(prefix, key === "W") : this.textObjectRange(prefix, key);
		if (!range) {
			this.resetCommand();
			return;
		}
		if (!this.operator) {
			this.offset = range.start;
			this.clampNormal();
			return;
		}
		this.applyOperator(this.operator, range);
		this.resetCommand();
	}

	private wordObjectRange(prefix: "i" | "a", bigWord: boolean): Motion | undefined {
		const text = this.text;
		const offset = this.offset;
		if (offset >= text.length) return undefined;
		const cls = (index: number) => charClass(text[index], bigWord);
		const current = cls(offset);
		let start = offset;
		let end = offset;
		if (current === 0) {
			while (start > 0 && cls(start - 1) === 0 && text[start - 1] !== "\n") start--;
			while (end < text.length && cls(end) === 0 && text[end] !== "\n") end++;
		} else {
			while (start > 0 && cls(start - 1) === current) start--;
			while (end < text.length && cls(end) === current) end++;
		}
		if (prefix === "a") {
			let trailing = end;
			while (trailing < text.length && cls(trailing) === 0 && text[trailing] !== "\n") trailing++;
			if (trailing === end) {
				while (start > 0 && cls(start - 1) === 0 && text[start - 1] !== "\n") start--;
			}
			end = trailing;
		}
		return { start, end, target: start, linewise: false };
	}

	private textObjectRange(prefix: "i" | "a", key: string): Motion | undefined {
		const pairs: Record<string, [string, string]> = {
			"(": ["(", ")"],
			")": ["(", ")"],
			b: ["(", ")"],
			"{": ["{", "}"],
			"}": ["{", "}"],
			B: ["{", "}"],
			"[": ["[", "]"],
			"]": ["[", "]"],
			"<": ["<", ">"],
			">": ["<", ">"],
		};
		if (key === '"' || key === "'" || key === "`") return this.quoteRange(prefix, key);
		const pair = pairs[key];
		if (!pair) return undefined;
		const [open, close] = pair;
		const bounds = this.bracketBounds(open, close);
		if (!bounds) return undefined;
		return prefix === "i"
			? { start: bounds.open + 1, end: bounds.close, target: bounds.open + 1, linewise: false }
			: { start: bounds.open, end: bounds.close + 1, target: bounds.open, linewise: false };
	}

	private quoteRange(prefix: "i" | "a", quote: string): Motion | undefined {
		const text = this.text;
		const start = lineStartAt(text, this.offset);
		const end = lineEndAt(text, this.offset);
		const positions: number[] = [];
		for (let i = start; i < end; i++) {
			if (text[i] === quote && text[i - 1] !== "\\") positions.push(i);
		}
		for (let i = 0; i + 1 < positions.length; i += 2) {
			const open = positions[i] as number;
			const close = positions[i + 1] as number;
			if (open <= this.offset && this.offset <= close) {
				return prefix === "i"
					? { start: open + 1, end: close, target: open, linewise: false }
					: { start: open, end: close + 1, target: open, linewise: false };
			}
		}
		return undefined;
	}

	private bracketBounds(open: string, close: string): { open: number; close: number } | undefined {
		const text = this.text;
		let depth = 0;
		let openIndex = -1;
		for (let i = this.offset; i >= 0; i--) {
			const char = text[i];
			if (char === close) depth++;
			else if (char === open) {
				if (depth === 0) {
					openIndex = i;
					break;
				}
				depth--;
			}
		}
		// Outside any pair, vim targets the next group after the cursor.
		if (openIndex < 0) {
			const nextOpen = text.indexOf(open, this.offset);
			if (nextOpen < 0) return undefined;
			openIndex = nextOpen;
		}
		depth = 0;
		for (let i = openIndex; i < text.length; i++) {
			if (text[i] === open) depth++;
			else if (text[i] === close) {
				depth--;
				if (depth === 0) return { open: openIndex, close: i };
			}
		}
		return undefined;
	}

	private applyGotoLine(line: number): void {
		const target = offsetOf(this.text, clamp(line, 0, lineCountOf(this.text) - 1), 0);
		if (this.operator) {
			this.applyOperator(this.operator, this.lineRange(lineOf(this.text, this.offset), lineOf(this.text, target)));
			this.resetCommand();
			return;
		}
		this.offset = target;
		this.clampNormal();
	}

	private applyFind(find: FindState, count: number): void {
		const target = this.findTarget(find, count);
		if (target === undefined) {
			this.resetCommand();
			return;
		}
		if (this.operator) {
			this.applyOperator(this.operator, inclusiveMotion(this.offset, target));
			this.resetCommand();
			return;
		}
		this.offset = target;
		this.clampNormal();
	}

	private findTarget(find: FindState, count: number): number | undefined {
		const text = this.text;
		const start = lineStartAt(text, this.offset);
		const end = lineEndAt(text, this.offset);
		let index = this.offset;
		for (let step = 0; step < count; step++) {
			let found = -1;
			if (find.forward) {
				found = text.indexOf(find.char, index + 1);
				if (found >= end) return undefined;
			} else {
				found = text.lastIndexOf(find.char, index - 1);
				if (found < start) return undefined;
			}
			if (found < 0) return undefined;
			index = found;
		}
		if (find.till) return find.forward ? index - 1 : index + 1;
		return index;
	}

	private repeatFind(forward: boolean, count: number): void {
		if (!this.lastFind) return;
		const find: FindState = { ...this.lastFind, forward: forward === this.lastFind.forward };
		this.lastFind = find;
		this.applyFind(find, count);
	}

	private replaceCharacters(char: string, count: number): void {
		const end = Math.min(this.offset + count, lineEndAt(this.text, this.offset));
		if (end <= this.offset) return;
		this.pushUndo();
		const replacement = char.repeat(end - this.offset);
		this.text = this.text.slice(0, this.offset) + replacement + this.text.slice(end);
		this.offset = end - 1;
		this.changeHappened = true;
		this.clampNormal();
	}

	private deleteCharacters(count: number, forward: boolean, operator: Operator = "d"): void {
		if (forward) {
			const end = Math.min(this.offset + count, lineEndAt(this.text, this.offset));
			this.applyOperator(operator, { start: this.offset, end: Math.max(end, this.offset), target: this.offset, linewise: false });
			return;
		}
		const start = Math.max(lineStartAt(this.text, this.offset), this.offset - count);
		this.applyOperator(operator, { start, end: this.offset, target: start, linewise: false });
	}

	private toggleCase(count: number): void {
		const end = Math.min(this.offset + count, lineEndAt(this.text, this.offset));
		this.toggleCaseRange(this.offset, end);
		this.offset = Math.max(this.offset, end);
		this.clampNormal();
	}

	private toggleCaseRange(start: number, end: number): void {
		if (end <= start) return;
		this.pushUndo();
		const toggled = [...this.text.slice(start, end)]
			.map((char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()))
			.join("");
		this.text = this.text.slice(0, start) + toggled + this.text.slice(end);
		this.changeHappened = true;
	}

	private joinLines(count: number): void {
		const firstLine = lineOf(this.text, this.offset);
		const lastLine = clamp(firstLine + count, 0, lineCountOf(this.text) - 1);
		if (lastLine === firstLine) return;
		this.pushUndo();
		const start = lineStartAt(this.text, this.offset);
		const end = lineEndAt(this.text, offsetOf(this.text, lastLine, 0));
		const joined = this.text
			.slice(start, end)
			.split("\n")
			.map((line) => line.replace(/^\s+/, ""))
			.join(" ");
		this.text = this.text.slice(0, start) + joined + this.text.slice(end);
		this.offset = start;
		this.changeHappened = true;
		this.clampNormal();
	}

	private put(before: boolean, count: number): void {
		if (this.register.text === "") return;
		this.pushUndo();
		for (let step = 0; step < count; step++) {
			if (this.register.linewise) {
				const lines = this.text.split("\n");
				const currentLine = lineOf(this.text, this.offset);
				const insertAt = before ? currentLine : currentLine + 1;
				lines.splice(insertAt, 0, ...this.register.text.split("\n"));
				this.text = lines.join("\n");
				this.offset = offsetOf(this.text, insertAt, 0);
				continue;
			}
			const lineEnd = lineEndAt(this.text, this.offset);
			const at = before ? this.offset : Math.min(this.offset + 1, lineEnd);
			this.text = this.text.slice(0, at) + this.register.text + this.text.slice(at);
			this.offset = at + this.register.text.length - 1;
			this.clampNormal();
		}
		this.changeHappened = true;
		this.clampNormal();
	}

	private searchFrom(step: number, backward: boolean): void {
		if (this.searchQuery === "") return;
		const query = this.searchQuery;
		let index: number;
		if (backward) {
			index = this.text.lastIndexOf(query, this.offset - 1 - step);
			if (index < 0) index = this.text.lastIndexOf(query);
		} else {
			index = this.text.indexOf(query, this.offset + 1 + step);
			if (index < 0) index = this.text.indexOf(query);
		}
		if (index < 0) return;
		this.offset = index;
		if (this.mode === "visual" || this.mode === "visual-line") this.clampVisual();
		else this.clampNormal();
	}

	private enterInsert(command: string): void {
		this.pushUndo();
		switch (command) {
			case "i":
				break;
			case "a":
				this.offset = Math.min(this.offset + 1, lineEndAt(this.text, this.offset));
				break;
			case "I": {
				const start = lineStartAt(this.text, this.offset);
				const end = lineEndAt(this.text, start);
				let target = start;
				while (target < end && (this.text[target] === " " || this.text[target] === "\t")) target++;
				this.offset = target;
				break;
			}
			case "A":
				this.offset = lineEndAt(this.text, this.offset);
				break;
			case "o": {
				const end = lineEndAt(this.text, this.offset);
				this.text = `${this.text.slice(0, end)}\n${this.text.slice(end)}`;
				this.offset = end + 1;
				this.changeHappened = true;
				break;
			}
			case "O": {
				const start = lineStartAt(this.text, this.offset);
				this.text = `${this.text.slice(0, start)}\n${this.text.slice(start)}`;
				this.offset = start;
				this.changeHappened = true;
				break;
			}
		}
		this.insertStartText = this.text;
		this.mode = "insert";
	}

	private repeatLastChange(count: number): void {
		if (!this.lastChange || this.lastChange.length === 0) return;
		this.replaying = true;
		this.mode = "normal";
		for (let step = 0; step < count; step++) {
			for (const key of this.lastChange) this.feed(key);
		}
		this.replaying = false;
		this.keys = [];
	}

	private pushUndo(): void {
		this.undoStack.push({ text: this.text, offset: this.offset });
		this.redoStack = [];
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.redoStack.push({ text: this.text, offset: this.offset });
		this.text = snapshot.text;
		this.offset = snapshot.offset;
		this.clampNormal();
		this.changeHappened = true;
	}

	private redo(): void {
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		this.undoStack.push({ text: this.text, offset: this.offset });
		this.text = snapshot.text;
		this.offset = snapshot.offset;
		this.clampNormal();
		this.changeHappened = true;
	}

	private takeCount(): number {
		const count = this.count === "" ? 1 : Number(this.count);
		this.count = "";
		return count;
	}

	private resetCommand(): void {
		this.count = "";
		this.operator = undefined;
		this.operatorCount = 1;
		this.awaiting = undefined;
	}

	private isIdle(): boolean {
		return (
			this.mode === "normal" && this.count === "" && !this.operator && !this.awaiting && this.searchInput === undefined
		);
	}

	/** Close out the current command: remember it for `.` and start a new key log. */
	private finishCommand(): void {
		if (!this.isIdle()) return;
		if (this.changeHappened && !this.replaying) {
			this.lastChange = [...this.keys];
			this.changeHappened = false;
		}
		this.keys = [];
	}

	private clampNormal(): void {
		if (this.text.length === 0) {
			this.offset = 0;
			return;
		}
		this.offset = clamp(this.offset, 0, this.text.length - 1);
		// The cursor never rests on a line break unless the line is empty.
		if (this.text[this.offset] === "\n" && this.offset > lineStartAt(this.text, this.offset)) {
			this.offset--;
		}
	}

	private clampVisual(): void {
		this.offset = clamp(this.offset, 0, Math.max(0, this.text.length - 1));
	}

	private clampInsert(): void {
		this.offset = clamp(this.offset, 0, this.text.length);
	}
}

function paragraphMotion(text: string, offset: number, count: number, forward: boolean): number {
	const total = lineCountOf(text);
	let line = lineOf(text, offset);
	for (let step = 0; step < count; step++) {
		if (forward) {
			line++;
			while (line < total - 1 && lineLengthOf(text, line) !== 0) line++;
		} else {
			line--;
			while (line > 0 && lineLengthOf(text, line) !== 0) line--;
		}
		line = clamp(line, 0, total - 1);
	}
	return offsetOf(text, line, 0);
}