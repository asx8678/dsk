"""The run: a terminal that types a real `dsk run`, prints what it printed, and then accepts the work."""
import textwrap

import kit

W, LOOP = 880, 20
SIZE, TOP, ROW = 14, 74, 22
CW = SIZE * kit.PITCH
LIGHTS = ("#ff5f57", "#febc2e", "#28c840")  # the window's three buttons, the same in both themes
# What the terminal shows is real output, verbatim: a repository with one 24-line module (2026-11-14, dsk 0.6.1).
# Each entry is a command and what it printed, as (fill class, text).
SESSION = [
    ("dsk run --allow 'test_*.py' --check 'python3 -m unittest' \"Add unit tests for durations.py\"", [
        ("mu", "dsk 054a · running · coralbricks"),
        ("ink", "dsk 054a · review · thirdparty after coralbricks · 4 turns · in 7.7k (78% cached) · out 1.1k"),
        ("t2", "summary: Added test_durations.py with 12 unittest cases covering parse_duration (single/compound units, whitespace and case, zero, repeated units, invalid inputs), format_duration (zero, single/compound, skipped units, negative) and a format/parse round trip. Ran `python3 -m unittest`: all 12 tests pass."),
        ("ok", "checks:  python3 -m unittest → 0"),
        ("t2", "changed: test_durations.py (+70)"),
        ("t2", "cache:   low (62% cached after turn 3)"),
        ("t2", "context: 3.1k of 24.0k"),
        ("mu", "next:    dsk show 054a --review | dsk accept 054a | dsk reject 054a \"defects\""),
    ]),
    ("dsk accept 054a", [("ok", "dsk 054a · accepted · 1 file already in your working tree")]),
]


def wrapped(text):
    """A line of output as rows of at most 92 characters: (text, x). A row after the first starts nine columns in,
    under the text that follows the label; the indent is an x offset, because some renderers drop leading spaces."""
    parts = textwrap.wrap(text, 92, subsequent_indent=" " * 9, break_long_words=False, break_on_hyphens=False)
    return [(parts[0], 28)] + [(part[9:], 28 + 9 * CW) for part in parts[1:]]


def window(st, h):
    """The terminal's title bar."""
    t = st.t
    st.add(f'<path d="M0.5 38.5 V16.5 a16 16 0 0 1 16 -16 H{W - 16.5} a16 16 0 0 1 16 16 V38.5 Z" fill="{t["surface"]}"/>',
           f'<line x1="0.5" y1="38.5" x2="{W - .5}" y2="38.5" stroke="{t["line"]}"/>')
    for cx, colour in zip((24, 44, 64), LIGHTS):
        st.add(f'<circle cx="{cx}" cy="19.5" r="5.5" fill="{colour}"/>')
    st.add(f'<text class="m mu" x="{W / 2}" y="24" text-anchor="middle" font-size="12">~/my-repo</text>')


def prompt(y):
    """The prompt `$` at `y`, as markup."""
    return kit.mono(28, y, "$", SIZE, "cd")


def typed(st, t, y, cmd, at, dur):
    """The command `cmd` at `y` types itself from `at`: its text, the cover that lifts off it, and its caret."""
    st.add(kit.mono(46, y, cmd, SIZE, "ink"))
    cover = f'<rect x="46" y="{y - 15}" width="{len(cmd) * CW + 2:g}" height="20" fill="{t["bg"]}"/>'
    st.add(st.type(at, dur, len(cmd), cover))
    caret = f'<rect x="0" y="0" width="8" height="16" rx="1.5" fill="{t["cool"]}"/>'
    st.add(st.travel([(46, y - 13), (46 + len(cmd) * CW, y - 13)], at, dur, caret))


def spinner(st, t, x, y, text):
    """The spinner that follows the row `text` at (`x`, `y`), turning on its own short loop."""
    circle = (f'<circle cx="{x + len(text) * CW + 14:g}" cy="{y - 5}" r="5" fill="none" stroke="{t["cool"]}" '
              f'stroke-width="1.8" stroke-dasharray="16 16" stroke-linecap="round"/>')
    return st.ambient("0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}", 0.9, circle,
                      css="transform-box:fill-box;transform-origin:center;", timing="linear")


def draw(t):
    """The run for the theme `t`."""
    lines, y = [], TOP  # (kind, fill class, text, x, y)
    for cmd, out in SESSION:
        lines.append(("cmd", "ink", cmd, 46, y))
        for cls, text in out:
            for part, x in wrapped(text):
                y += ROW
                lines.append(("out", cls, part, x, y))
        y += ROW
    h = y + 34
    st = kit.Stage(W, h, t, LOOP, "a terminal: dsk run, its report after 4 turns, then dsk accept", glow=False)
    window(st, h)
    command, report = 0, -1  # the command's number, and the report row's index outside its ten rows
    for kind, cls, text, x, row_y in lines:
        if kind == "cmd":
            command += 1
            if command == 1:
                st.add(prompt(row_y))
                typed(st, t, row_y, text, 0.4, 2.2)
            else:
                st.add(st.show(8.0, prompt(row_y), dy=0))
                typed(st, t, row_y, text, 8.3, 0.6)
        else:
            if "· review ·" in text:  # the status, picked out
                at = text.index("review")
                row = (f'<rect x="{x + at * CW - 4:g}" y="{row_y - 14}" width="{6 * CW + 8:g}" height="19" rx="5" fill="{t["cool"]}" opacity=".16"/>'
                       + kit.mono(x, row_y, text, SIZE, cls))
            else:
                row = kit.mono(x, row_y, text, SIZE, cls)
            if "· running ·" in text:
                st.add(st.show(3.0, row, dy=4))
                st.add(st.blink(3.0, 5.0, spinner(st, t, x, row_y, text)))
            elif report >= 0 or "· review ·" in text:
                if "· review ·" in text:
                    report = 0
                st.add(st.show(5.2 + report * 0.22, row, dy=4))
                report += 1
                if text.startswith("next:"):
                    report = -1
            else:
                st.add(st.show(9.4, row, dy=4))
    last_caret = f'<rect x="46" y="{y - 13}" width="8" height="16" rx="1.5" fill="{t["cool"]}"/>'
    blinking = st.ambient("0%{opacity:1}50%,100%{opacity:0}", 1.1, last_caret, timing="step-end")
    st.add(st.show(10.0, prompt(y) + blinking, dy=0))
    return st.svg()
