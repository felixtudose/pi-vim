# pi-vim-mode

Vim-style modal editing for the [pi](https://pi.dev) prompt editor.

Insert mode stays the core pi editor, so autocomplete, prompt history, bracketed
paste collapsing, image paste and every pi keybinding keep working while you type.
`escape` switches to a normal mode backed by a small vim engine: motions,
operators, text objects, registers, undo/redo and `.` repeat.

## Install

```bash
pi install git:github.com/RaresFelix/pi-vim
```

Or load it for a single run:

```bash
pi -e /path/to/pi-vim/index.ts
```

## Usage

The editor starts in insert mode. Press `escape` to get to normal mode; press
`escape` again in normal mode to interrupt pi as usual. The current mode is shown
in the editor's top border (`NORMAL`, `VISUAL`, `V-LINE`, plus any pending keys
such as `2d` or `/query`).

Run `/vim` to toggle vim mode on and off without restarting pi.

## Supported keys

| Area | Keys |
|---|---|
| Modes | `escape` (insert → normal), `i` `a` `I` `A` `o` `O` (insert), `v` (visual), `V` (visual line), `o` (swap ends) |
| Motions | `h` `j` `k` `l` `w` `W` `b` `B` `e` `E` `0` `^` `$` `gg` `G` `{` `}` `f` `F` `t` `T` `;` `,` |
| Operators | `d` `c` `y` with any motion, doubled forms (`dd` `cc` `yy`), counts (`d2w`, `2dd`, `2d3w`) |
| Text objects | `iw` `aw` `iW` `aW` `i(` `a(` `i{` `a{` `i[` `a[` `i<` `a<` `i"` `a"` `i'` `a'` `` i` `` `` a` `` |
| Editing | `x` `X` `D` `C` `s` `S` `r` `J` `~` `p` `P` |
| History | `u`, `ctrl+r` |
| Repeat | `.` (repeats the last change, including insertions) |
| Search | `/text`, `?text`, `n`, `N` |
| Counts | Any prefix count on motions and operators |

Arrow keys, `home` and `end` work as `h` `j` `k` `l` `0` `$` in normal mode.
Unsupported vim features (macros, marks, named registers, `>>`, `ctrl+d`/`ctrl+u`
scrolling) are intentionally left out; control keys fall through to pi's own
keybindings.

## How it works

`src/engine.ts` is a self-contained vim engine over a plain string plus a cursor
offset — no terminal code, so it is covered by `node --test`. `src/editor.ts` is
the adapter: it extends pi's `CustomEditor`, forwards keys to the engine outside
insert mode, and writes the engine's buffer and cursor back into the core editor.
Placement of the cursor and buffer writes go through the core editor's private
`state`/`setCursorCol`, which is the only way to control the prompt cursor today.

## Development

```bash
npm install          # typescript, @types/node
npm test             # engine + editor tests
npm run typecheck
```

## License

MIT