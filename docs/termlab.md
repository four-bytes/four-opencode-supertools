# termlab — terminal lab module

Headless TUI driving and an independent terminal-emulator oracle for
turbo-tui-style applications. Six tools: `term_run`, `trace_decode`,
`trace_replay`, `cell_history`, `width_check`, `term_checksum`.

## What it is / why

A TUI renderer's own tests usually replay the app's output through the app's own
VT model. That proves internal consistency and nothing else — the turbo-tui #68
lesson: green tests with the dev's own VT model prove nothing. The same bytes
can render differently in a second, independent implementation.

`termlab` adds that second implementation. Recorded frames are replayed through
tmux — a VT emulator written by someone else — and the rendered screen is
compared cell by cell against what the app recorded. Divergences are returned as
data (`ok: true, matched: false`), never as a crash.

## Requirements

- **tmux (Linux/WSL)** for `term_run`, `trace_replay` and the `tmux` width
  model. Without it those return `available: false` with
  `error: "tmux not found"` and `hint: "Install tmux (Linux/WSL)"`
  (`width_check` reports `tmux: { available: false, hint: … }` instead).
- `trace_decode`, `cell_history`, `term_checksum` and the `unicode`/`wcwidth`
  width models are pure TypeScript and need nothing.
- Traces come from a turbo-tui app run with the `TURBO_TUI_TRACE` environment
  variable, e.g. `TURBO_TUI_TRACE=/tmp/demo.trace cargo run --example demo`.

## Trace format v1

`TURBO_TUI_TRACE 1` — produced by turbo-tui. Exact grammar (one frame shown;
the file is a sequence of frames):

```
TURBO_TUI_TRACE 1
=== turbo-tui frame <n> <label> <byteCount> bytes <W>x<H> ===
<byteCount raw bytes, then one newline>
--- back ---
<H lines of W tab-separated cells>
--- mods ---
<H lines of W space-separated 4-hex-digit masks>
--- links ---
<H lines of W space-separated link ids or ->
=== end frame <n> ===
```

- Magic line is exactly `TURBO_TUI_TRACE 1` (a trailing CR is tolerated).
  Blank lines between frames are skipped.
- `<label>` is everything between the frame number and the byte count and may
  contain spaces (e.g. `flush`).
- The raw block is exactly `byteCount` bytes followed by one newline
  (CR LF tolerated) — byte-transparent, never re-encoded by the parser.
- `--- back ---`: each row is W cells separated by tabs (a cell may be empty
  for the continuation of a wide grapheme). Missing trailing cells pad with
  spaces, extras beyond W are dropped. Lines decode as UTF-8, falling back to
  latin1 on invalid UTF-8.
- `--- mods ---`: modifier bitmask per cell as 4 hex digits, whitespace-separated
  (missing/unparsable tokens are `0`):

  | Bit | Value  | Name         |
  | --- | ------ | ------------ |
  | 0   | `0x001` | `BOLD`       |
  | 1   | `0x002` | `DIM`        |
  | 2   | `0x004` | `ITALIC`     |
  | 3   | `0x008` | `UNDERLINED` |
  | 4   | `0x010` | `SLOW_BLINK` |
  | 5   | `0x020` | `RAPID_BLINK` |
  | 6   | `0x040` | `REVERSED`   |
  | 7   | `0x080` | `HIDDEN`     |
  | 8   | `0x100` | `CROSSED_OUT` |

  e.g. `0001` = BOLD, `0009` = BOLD + UNDERLINED.
- `--- links ---`: OSC 8 link id per cell, or `-` for no link.
- End marker `=== end frame <n> ===` is mandatory; any structural error aborts
  with `frame <n>: …` and never yields partial frames.

Colours are **not** in the trace — text, modifiers and links only (see
[Limitations](#limitations)).

## Tools

### `term_run`

Drive a headless tmux session and capture the screen after each step. Each run
owns a private tmux server (`tmux -L <socket> -f /dev/null`) and always kills it.

**Args** (defaults in parentheses): `command` (string via shell, or argv array —
required), `steps` (max 100; each step sets exactly one of `send`/`key`/`mouse`,
or only `wait`; `capture: false` skips the capture for that step), `width`
(120), `height` (40), `cwd`, `env` (extra environment variables), `settleMs`
(120, clamped 0…5000 — wait after each step), `timeoutMs` (20000, clamped
1000…300000 — overall), `attributes` (true), `full` (false), `checksum` (false),
`region` (full screen), `directory` (base dir when `cwd` is omitted).

A `mouse` step is `{ action, x, y, button?, shift?, alt?, ctrl? }` with
`action` ∈ `press|release|drag|move|wheel` and `button` ∈
`left|middle|right|wheel-up|wheel-down` (default `left`); coordinates are
0-based cells and are encoded as SGR (1006) mouse events on the wire.

**Output:** `{ ok, width, height, tmux: true, initial: { rows }, steps: [...] }`
with one entry per step: `{ index, action, summary, changed: [{ row, text,
attrs? }], checksum? }`. `attrs` are coalesced attribute runs
`{ from, to, style }` (`style` like `"bold fg=#aabbcc"`) when `attributes` is
on; `checksum` is `{ hex, cells, region, algorithm }` when `checksum` is on.
Compactness: only rows whose text *or* attributes changed since the previous
capture (trailing spaces trimmed) unless `full: true`. Errors return
`{ available, error, hint }`; a timeout returns `available: true, ok: false,
error: "timeout"` with the steps captured so far.

**Example** (drag a window by its title bar):

```jsonc
{
  "command": "cargo run --example demo",
  "cwd": "/home/robby/four-turbo-tui",
  "width": 120,
  "height": 40,
  "steps": [
    { "wait": 1500 },
    { "mouse": { "action": "press",   "x": 20, "y": 3, "button": "left" } },
    { "mouse": { "action": "drag",    "x": 24, "y": 5 } },
    { "mouse": { "action": "drag",    "x": 30, "y": 7 } },
    { "mouse": { "action": "release", "x": 30, "y": 7 } }
  ],
  "settleMs": 120
}
```

### `trace_decode`

Decode a trace into one compact op line per terminal operation, per frame. No
tmux.

**Args:** `path` (exactly one of `path`/`text`), `text` (latin1-safe string),
`fromFrame`/`toFrame` (inclusive, default all frames), `region` (keep only
`TEXT`/`MOVE` ops whose cursor lies inside), `limit` (200 ops per frame, cap
2000), `directory`.

**Output:** `{ ok, version: 1, frameCount, width, height, frames: [{ frame,
label, bytes, ops, truncated }] }`. Op lines: `MOVE x,y`, `TEXT "…" at x,y`,
`SGR 1;4`, `OSC8 id=… url=…`, `CLEAR n`, `ERASE_LINE n`, `ERASE_CHARS n`,
`CURSOR show|hide`, `CR`, `LF`, `BS`, `TAB`, `CSI …`, `ESC …`, `RAW …`.
Printable runs coalesce into one `TEXT` op; the cursor advances by display
width, not code units.

**Example:**

```jsonc
{ "path": "/tmp/demo.trace", "fromFrame": 3, "toFrame": 5, "limit": 50 }
```

### `trace_replay`

Replay recorded frames through an independent tmux emulator (a private session
running `cat` in raw mode; frame bytes are fed binary-safe via
`load-buffer`/`paste-buffer`) and compare the rendered screen against the
recorded back buffer and modifier masks. Needs tmux.

**Args:** `path`/`text` (exactly one), `fromFrame`/`toFrame`, `settleMs` (60,
clamped 0…5000), `timeoutMs` (60000, clamped 1000…300000),
`stopOnFirstDivergence` (true), `limit` (5 divergences when not stopping at the
first, cap 100), `compareMods` (true), `directory`. Frames with a changed
W×H resize the session first; wide graphemes skip their continuation cell; a
cell with a link ignores `UNDERLINED` in the comparison (tmux underlines links).

**Output:** `{ ok: true, oracle: "tmux", frames, compared, divergences,
truncated, matched }`. Each divergence: `{ frame, label, x, y, expected: { char,
mods }, actual: { char, mods }, frameBytesHex }` (first 64 frame bytes as hex).
`ok: true` with `matched: false` is data, not a failure. Colour is never
compared — characters and modifier names only.

**Example:**

```jsonc
{ "path": "/tmp/demo.trace", "stopOnFirstDivergence": true, "compareMods": true }
```

### `cell_history`

Reconstruct which value every screen cell held over a trace: the ordered writes
per cell (character, modifier names + mask, OSC 8 link). The recorded byte
stream is simulated (cursor moves, SGR state, clears/erases, wide graphemes),
so no tmux is needed.

**Args:** `path`/`text` (exactly one), `x`+`y` (one cell — must be given
together), `region` (only cells inside), `fromFrame`/`toFrame`, `limit` (200
cells, sorted top-left → bottom-right), `writesPerCell` (50), `directory`.

**Output:** `{ ok, frames, cells: [{ x, y, writes: [{ frame, label, char, mods,
modsMask, link }] }], truncatedCells, truncatedWrites }`. Wide graphemes are
recorded at their start cell only; zero-width marks merge into the previous
write's `char`.

**Example:**

```jsonc
{ "path": "/tmp/demo.trace", "x": 12, "y": 2, "writesPerCell": 10 }
```

### `width_check`

Display width per grapheme cluster under three models, with the disagreements
flagged so width assumptions can be settled with evidence. Grapheme splitting is
`Intl.Segmenter` (ZWJ sequences and combining marks stay one cluster); input is
capped at 500 graphemes (100 for the tmux probe).

**Args:** `text` (required), `models` (`unicode`, `wcwidth`, `tmux`; default
`["unicode", "wcwidth"]`), `plain` (false — omit codepoints and differs flags).

- `unicode` — Rust unicode-width model: emoji presentation (VS16, inherent
  emoji, ZWJ clusters, flag pairs) is two cells, control characters 0.
- `wcwidth` — classic model: no VS16 promotion (`❤️` stays 1), inherently wide
  clusters two cells, control characters −1 (clamped to 0 when summing).
- `tmux` — measured through an independent emulator: one session echoes
  `${grapheme}|` per row and the sentinel column is the width tmux assigned.
  Needs tmux.
- A probe whose `|` sentinel cannot be located on its row is reported through
  the top-level `tmuxProbeErrors` counter and left out of that grapheme's `tmux`
  value — a failed probe is never reported as width 0.

**Output:** `{ ok, text, totals: { unicode?, wcwidth?, tmux? }, tmuxProbeErrors?,
differs, graphemes: [{ grapheme, unicode?, wcwidth?, tmux?, codepoints?, differs? }],
truncated }`.

**Example:**

```jsonc
{ "text": "— ❤️", "models": ["unicode", "wcwidth", "tmux"] }
```

### `term_checksum`

DECRQCRA-style checksum helper (`algorithm: "utf16-sum-mod-65536"`). Four modes:

- `compute` (default) — checksum a text screen dump (`text`, one line per row,
  short lines padded to the widest row) over `region` (default full grid).
  Sums the UTF-16 code units of every cell, missing/empty cells count as space.
- `trace` — checksum a trace frame back buffer (`path`, `frame` default 1,
  matched by frame number then by index; optional `region`). Uses the same
  `utf16-sum-mod-65536` algorithm as `compute`: the sum of the UTF-16 code units
  of every cell, modulo 65536.
- `query` — emit the DECRQCRA request sequence for a `region` (required; 0-based
  half-open `{x,y,width,height}`): `CSI Pid;Pp;Pt;Pl;Pb;Pr*y` with 1-based
  `top/left/bottom/right` derived from the region. Returns `sequence` (escaped),
  `hex` and `bytes` plus `id` (default 1) and `page` (default 1).
- `parse` — parse a DECCKSR checksum response (`response`): the DCS form
  `DCS Pid!~hhhh ST` (`ESC P <id> ! ~ <4 hex> ESC \`), the BEL-terminated
  variant, or the CSI form `CSI Pid;value*y`. Returns `{ id, checksum, hex }`.

Attributes are **never** included in the checksum — characters only.

**Windows Terminal caveat:** WT implements DECRQCRA and answers with DECCKSR,
which makes `query`/`parse` usable against a live app on WT — but WT's exact
implementation must be validated once by the user (send a known screen, compare
`compute` against the terminal's response) before trusting cross-checks.

**Example:**

```jsonc
{ "mode": "trace", "path": "/tmp/demo.trace", "frame": 1 }
```

## End-to-end walkthroughs

All examples use the tool argument objects shown above. `cargo run --example
demo` refers to the `demo` example of four-turbo-tui (outside this repo).

### (a) Drag a window by its title bar

Run `term_run` with the demo and a press → drag → drag → release sequence (see
the [`term_run` example](#term_run)). The mouse steps are encoded as SGR (1006)
events; each capture returns only the rows that changed. With `attributes: true`
(default) a changed row carries `attrs` runs — e.g.
`{ "from": 4, "to": 28, "style": "reverse" }` on the title bar — so the
highlight moving during the drag is visible as an attribute-only change even
where the row text stays identical. `checksum: true` adds a DECRQCRA-style
checksum per step for a cheap whole-screen equality signal.

### (b) Record, then decode / replay / inspect

```bash
TURBO_TUI_TRACE=/tmp/demo.trace cargo run --example demo
```

1. `trace_decode` — `{ "path": "/tmp/demo.trace" }` → per-frame op lines
   (`MOVE`, `SGR`, `TEXT`, …) to see what the app emitted.
2. `trace_replay` — `{ "path": "/tmp/demo.trace" }` → feeds every frame through
   tmux and compares each frame's rendered screen against its recorded back
   buffer and modifier masks. `matched: true` means tmux agrees with the
   recording; a divergence pinpoints `frame`, `x`, `y`, `expected`, `actual`
   and the frame bytes as hex.
3. `cell_history` — `{ "path": "/tmp/demo.trace", "x": 12, "y": 2 }` → the
   ordered writes to one cell (character, modifiers, link) across all frames,
   e.g. which frame last moved the window over it.
4. `term_checksum` — `{ "mode": "trace", "path": "/tmp/demo.trace", "frame": 1 }`
   → the frame's checksum (`hex`/`checksum`) to compare against a terminal's
   DECRQCRA answer or another capture.

### (c) Width evidence for `—` and `❤️`

`width_check` — `{ "text": "— ❤️", "models": ["unicode", "wcwidth", "tmux"] }`:

| Grapheme | unicode | wcwidth | tmux |
| -------- | ------- | ------- | ---- |
| `—` (U+2014)   | 1 | 1 | 1 |
| `❤️` (U+2764 U+FE0F) | 2 | 1 | 2 |

`differs` lists `❤️`: the classic wcwidth model leaves the VS16 heart at one
cell while unicode-width promotes it to emoji presentation and tmux renders it
wide. Use the row that matches the terminal you actually target.

### (d) Live DECRQCRA round trip on Windows Terminal

1. Pick the screen region to checksum and run `term_checksum` —
   `{ "mode": "query", "region": { "x": 0, "y": 0, "width": 80, "height": 24 } }`
   → `sequence` (e.g. `\x1b[1;1;1;1;24;80*y`).
2. Emit those bytes from the app running in Windows Terminal (they must reach
   the terminal as output).
3. WT answers on the input with a DECCKSR response — `DCS Pid!~hhhh ST`
   (`ESC P 1 ! ~ 4b19 ESC \`), BEL-terminated, or the CSI form
   `CSI Pid;value*y`.
4. `term_checksum` — `{ "mode": "parse", "response": "…" }` → `{ id, checksum,
   hex }`. Cross-check against `compute` on the same screen text or `trace` on a
   capture of it.

The checksum is the sum of the cell characters modulo 65536 (UTF-16 code
units), attributes not included. WT's implementation must be validated once by
you against your build before trusting the numbers.

## Limitations

- **tmux is not Windows Terminal, Kitty or WezTerm.** The oracle is one
  independent VT implementation; terminal-specific rendering bugs of WT, Kitty
  or WezTerm cannot be reproduced or disproven here. A `matched: true` says the
  app's output is interpreted the same way by tmux.
- **Colours are not in the trace** — text, modifiers and links only. Colour
  bugs cannot be replayed or compared from a trace (colour *is* visible in
  `term_run` captures via tmux `capture-pane -e`, but not in traces).
- **Ambiguous-width glyphs may legitimately differ** between the models and
  between terminals; `width_check` reports the difference, it does not declare
  one model wrong.
- **VS16 emoji promotion is an approximation** of `unicode-width`: it covers the
  0x2600–0x27BF symbol blocks plus the emoji-presentation ranges, not the full
  Unicode data table, so uncommon text-presentation emoji may be graded
  differently.
- **`term_run` always kills its private tmux server** when the call ends —
  sessions are ephemeral; capture what you need in the steps.

## The real fixture

`tests/fixtures/termlab/wt-trace-frame1.bin` — one 183×52 frame recorded from
turbo-tui #68 under Windows Terminal (label `flush`). It is exercised in
`tests/termlab-real-trace.test.ts`: `trace_decode` reads the frame,
`term_checksum` (`mode: "trace"`) reproduces `4b19` (19225) over 9516 cells,
`cell_history` shows the first write to cell (1,0) is bold `F`, and
`trace_replay` matches the tmux oracle exactly (`matched: true`, skipped when
tmux is absent). This replay is known to match tmux exactly.

## Follow-up (outside this repo)

- Allow the tools in `~/.personal-config/opencode/agents/*.md` and mention them
  in `ai-shared-rules` developer-rules.
