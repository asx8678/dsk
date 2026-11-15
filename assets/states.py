"""The states: a run of dsk stops as review, done, question, stuck, limit or error; the report's last line names the
commands that are valid next, and answer, reject and continue send the same session back to work."""
import kit

W, H, LOOP = 880, 350, 18
LABEL = ("A dsk run stops as review, done, question, stuck, limit or error; its report names the commands that are "
         "valid next, and answer, reject and continue send the same session back to work")
# The left column: the run at the top, the worker under it, and the line between them.
RUN_TOP, RUN_H = 78, 64
WORKER_TOP, WORKER_H = 159, 82
# The six squares of the worker's turns, and how many of them ran. Each turn's square pops as the turn is taken.
SQUARES = (60, 80, 100, 120, 140, 160)
TURNS_RUN = 5
TURN_TIMES = (1.8, 2.6, 6.6, 7.4, 11.4)
# The rows on the right, one per status, and the x of the spine they hang off.
ROW_TOP, ROW_EVERY, ROW_X, ROW_W, ROW_H = 78, 42, 376, 464, 34
SPINE_X = 352
# The two rows the worker stops at, and the middles that its travel reaches.
QUESTION_MID = ROW_TOP + 2 * ROW_EVERY + ROW_H / 2  # 179
REVIEW_MID = ROW_TOP + ROW_H / 2  # 95
# Each row: its status, the theme key of its dot, its exit code, and the commands that are valid next.
ROWS = [
    ("review", "warm", "exit 0", ["accept", 'reject "defects"']),
    ("done", "muted", "exit 0", ['continue "next task"']),
    ("question", "warm", "exit 2", ['answer "..."']),
    ("stuck", "warn", "exit 3", ["accept", 'reject "guidance"', "reject --drop"]),
    ("limit", "warn", "exit 3", ["accept", 'reject "guidance"', "reject --drop"]),
    ("error", "warn", "exit 1", ["reject --drop"]),
]


def line(t, points):
    """A plain connector through the points, without an arrow head: a line of the spine."""
    d = "M" + " L".join(f"{x:g} {y:g}" for x, y in points)
    return f'<path d="{d}" fill="none" stroke="{t["line2"]}" stroke-width="1.5"/>'


def frame(x, y, w, h, rx, colour):
    """A card's or a row's own outline, redrawn in a status colour: what an animation lights up."""
    return (f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx:g}" fill="none" '
            f'stroke="{colour}" stroke-opacity=".7"/>')


def mark(colour):
    """A haloed dot drawn around the origin, for a travel to carry."""
    return f'<circle r="9" fill="{colour}" opacity=".18"/><circle r="4.5" fill="{colour}"/>'


def ping(cx, cy, r, colour):
    """A ring that a ripple swells from a dot or a check mark."""
    return f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="none" stroke="{colour}" stroke-width="1.5"/>'


def down(m):
    """The way from the worker to the row whose middle is at y = m."""
    return [(290, 200), (352, 200), (352, m), (376, m)]


def up(m):
    """The way from the row whose middle is at y = m back to the worker."""
    return [(376, m), (352, m), (352, 200), (290, 200)]


def highlight(t, x, y, cmd):
    """The wash behind a command of a row, sized to the command it names."""
    return (f'<rect x="{x - 5:g}" y="{y + 7:g}" width="{len(cmd) * 11 * kit.PITCH + 10:g}" height="19" rx="5" '
            f'fill="{t["cool"]}" opacity=".16"/>')


def ticked(t, cx, cy):
    """A ring with a check mark in it: the review row's work is accepted."""
    d, _ = kit.check(cx, cy, 7)
    return (f'<circle cx="{cx:g}" cy="{cy:g}" r="7" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>'
            f'<path d="{d}" fill="none" stroke="{t["ok"]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')


def run_card(st, t):
    """The `dsk run` that started the run, and the line from it down to the worker."""
    return [f'<rect x="{40.5}" y="{RUN_TOP + .5:g}" width="250" height="{RUN_H}" rx="12" fill="{t["surface"]}" stroke="{t["line"]}"/>',
            st.blink(0.4, 1.4, frame(40.5, RUN_TOP + .5, 250, RUN_H, 12, t["warm"])),
            f'<circle cx="64" cy="103" r="4" fill="{t["warm"]}"/>',
            st.ripple([0.4], ping(64, 103, 4, t["warm"]), swell=2.6),
            f'<text class="d ink" x="76" y="108" font-size="16" font-weight="650">{kit.esc("dsk run")}</text>',
            kit.mono(60, 130, "a brief · --allow · --check", 11.5, "mu"),
            line(t, [(165, 142), (165, 159)]),
            f'<path d="M165 159 L161 152 L169 152 Z" fill="{t["line2"]}"/>']


def worker_card(st, t):
    """The worker: one square per turn, filled for the turns that ran."""
    out = [f'<rect x="{40.5}" y="{WORKER_TOP + .5:g}" width="250" height="{WORKER_H}" rx="12" fill="{t["surface"]}" stroke="{t["line"]}"/>',
           st.blink(1.3, 3.4, frame(40.5, WORKER_TOP + .5, 250, WORKER_H, 12, t["cool"])),
           st.blink(6.2, 8.2, frame(40.5, WORKER_TOP + .5, 250, WORKER_H, 12, t["cool"])),
           st.blink(11.0, 12.2, frame(40.5, WORKER_TOP + .5, 250, WORKER_H, 12, t["cool"])),
           f'<circle cx="64" cy="184" r="4" fill="{t["cool"]}"/>',
           f'<text class="d ink" x="76" y="189" font-size="16" font-weight="650">{kit.esc("the worker")}</text>']
    for x in SQUARES:
        out.append(f'<rect x="{x + .5:g}" y="207.5" width="13" height="13" rx="4" fill="none" stroke="{t["line"]}"/>')
    for x, at in zip(SQUARES[:TURNS_RUN], TURN_TIMES):
        out.append(st.pop(at, f'<rect x="{x:g}" y="207" width="14" height="14" rx="4" fill="{t["cool"]}"/>'))
    out.append(st.show(11.6, kit.mono(270, 218, "5 turns", 11, "mu", "end"), dy=0))
    return out


def row(st, t, y, status, dot, code, commands):
    """One status as a row: its dot, its name, its exit code, and the commands the report says are valid next."""
    out = [f'<rect x="{ROW_X + .5:g}" y="{y + .5:g}" width="{ROW_W}" height="{ROW_H}" rx="9" fill="{t["surface"]}" stroke="{t["line"]}"/>']
    if status == "question":
        out.append(st.blink(4.0, 5.6, frame(ROW_X + .5, y + .5, ROW_W, ROW_H, 9, t["warm"])))
    elif status == "review":
        out.extend([st.blink(8.8, 10.4, frame(ROW_X + .5, y + .5, ROW_W, ROW_H, 9, t["warm"])),
                    st.blink(12.8, 14.6, frame(ROW_X + .5, y + .5, ROW_W, ROW_H, 9, t["warm"]))])
    out.append(f'<circle cx="394" cy="{y + 17:g}" r="4" fill="{t[dot]}"/>')
    if status == "question":
        out.append(st.ripple([4.0], ping(394, y + 17, 4, t["warm"]), swell=2.6))
    elif status == "review":
        out.append(st.ripple([8.8, 12.8], ping(394, y + 17, 4, t["warm"]), swell=2.6))
    out.extend([kit.mono(406, y + 21.5, status, 12.5, "ink"),
                kit.mono(480, y + 21, code, 11, "mu")])
    x = 536
    for i, cmd in enumerate(commands):
        if status == "question" and cmd == 'answer "..."':
            out.append(st.blink(4.6, 5.7, highlight(t, x, y, cmd)))
        elif status == "review" and cmd == "accept":  # the highlight marks the command the reader is told to take
            out.append(st.pop(13.4, highlight(t, x, y, cmd)))
        elif status == "review" and cmd == 'reject "defects"':
            out.append(st.blink(9.4, 10.5, highlight(t, x, y, cmd)))
        out.append(kit.mono(x, y + 21, cmd, 11, "t2"))
        if i < len(commands) - 1:
            out.append(kit.mono(x + len(cmd) * 11 * kit.PITCH, y + 21, " · ", 11, "mu"))
        x += (len(cmd) + 3) * 11 * kit.PITCH
    if status == "review":
        word_x = 822 - len("accepted") * 11 * kit.PITCH
        cx, cy = round(word_x) - 12, y + 17
        out.append(st.draw(14.0, 44, ticked(t, cx, cy), dur=0.6))
        out.append(st.ripple([14.3], ping(cx, cy, 7, t["ok"])))
        out.append(st.show(14.0, kit.mono(822, y + 21, "accepted", 11, "t2", "end"), dx=6, dy=0))
    return out


def spine(t):
    """The line the six rows hang off, and the worker's line into it."""
    last = ROW_TOP + (len(ROWS) - 1) * ROW_EVERY + ROW_H / 2
    out = [line(t, [(SPINE_X, ROW_TOP + ROW_H / 2), (SPINE_X, last)])]
    for i in range(len(ROWS)):
        y = ROW_TOP + i * ROW_EVERY + ROW_H / 2
        out.append(line(t, [(SPINE_X, y), (ROW_X, y)]))
    out.append(line(t, [(290, 200), (SPINE_X, 200)]))
    return out


def draw(t):
    """The states for the theme `t`."""
    st = kit.Stage(W, H, t, LOOP, LABEL)
    st.add(f'<text class="m mu" x="40" y="46" font-size="11" letter-spacing=".06em">{kit.esc("A RUN STOPS IN ONE OF SIX WAYS")}</text>',
           kit.mono(840, 46, "the report's last line names what is valid next", 10.5, "mu", "end"))
    st.add(*run_card(st, t), *worker_card(st, t),
           kit.mono(40, 268, "answer, reject and continue", 10.5, "mu"),
           kit.mono(40, 284, "send the same session back to work", 10.5, "mu"))
    st.add(*spine(t))
    for i, (status, dot, code, commands) in enumerate(ROWS):
        st.add(*row(st, t, ROW_TOP + i * ROW_EVERY, status, dot, code, commands))
    # The marks go on last, above every card and row, so that no border cuts the trip they make.
    st.add(st.travel([(165, 142), (165, 159)], 0.9, 0.3, mark(t["warm"])))
    st.add(st.travel(down(QUESTION_MID), 3.4, 0.6, mark(t["cool"])))
    st.add(st.travel(up(QUESTION_MID), 5.6, 0.6, mark(t["warm"])))
    st.add(st.travel(down(REVIEW_MID), 8.2, 0.6, mark(t["cool"])))
    st.add(st.travel(up(REVIEW_MID), 10.4, 0.6, mark(t["warm"])))
    st.add(st.travel(down(REVIEW_MID), 12.2, 0.6, mark(t["cool"])))
    return st.svg()
