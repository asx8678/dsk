"""The flow: a brief goes to dsk, dsk and the worker trade a request for a script turn by turn, each script changes
the repository, the check runs, and the report goes back to the lead."""
import kit

W, H, LOOP = 880, 404, 17
LABEL = ("Claude Code sends a brief to dsk; dsk and a DeepSeek worker trade a request for a script each turn; each "
         "script changes only the allowed paths of your repository; dsk runs the check and reports back for review")
GATES = ["runs each script", "undoes stray edits", "runs each --check", "holds it for review"]
# The run is the one the terminal image shows: four turns. The first starts at FIRST seconds, each takes EVERY.
TURNS, FIRST, EVERY = 4, 1.4, 1.6
# The times at which each gate in GATES ticks, on the loop.
TICKS = (2.9, 4.5, 8.0, 8.5)
# The lines between the boxes, as the points a dot travels along.
BRIEF = [(216, 184), (296, 184)]
REPORT = [(296, 222), (216, 222)]
ASK = [(516, 124), (556, 124), (556, 86), (596, 86)]
NEXT = [(516, 194), (596, 194)]
EDIT = [(516, 272), (556, 272), (556, 310), (596, 310)]


def box(t, x, y, w, h, title, subs, dot=None, dashed=False, stroke=None):
    """A box with a title, the lines under it, and a dot in the identity colour of who it stands for."""
    frame = f'stroke="{stroke or t["line"]}"' + (' stroke-dasharray="4 4"' if dashed else "")
    out = [f'<rect x="{x + .5}" y="{y + .5}" width="{w}" height="{h}" rx="12" fill="{t["surface"]}" {frame}/>']
    tx = x + 20
    if dot:
        out.append(f'<circle cx="{x + 24}" cy="{y + 25}" r="4" fill="{dot}"/>')
        tx = x + 36
    out.append(f'<text class="d {"t2" if dashed else "ink"}" x="{tx}" y="{y + 30}" font-size="16" font-weight="650">{kit.esc(title)}</text>')
    for i, sub in enumerate(subs):
        out.append(f'<text class="m mu" x="{x + 20}" y="{y + 52 + i * 17}" font-size="11.5">{kit.esc(sub)}</text>')
    return "".join(out)


def line(t, points, dashed=False, head=True):
    """A line through the points, with an arrow head at its end."""
    d = "M" + " L".join(f"{x} {y}" for x, y in points)
    out = f'<path d="{d}" fill="none" stroke="{t["line2"]}" stroke-width="1.5"' + (' stroke-dasharray="4 5"' if dashed else "") + "/>"
    if head:
        (px, py), (x, y) = points[-2], points[-1]
        back = -7 if x > px else 7
        out += f'<path d="M{x} {y} L{x + back} {y - 4} L{x + back} {y + 4} Z" fill="{t["line2"]}"/>'
    return out


def ticked(t, cx, cy):
    """A ring with a check mark in it: a gate that has done its part."""
    d, _ = kit.check(cx, cy, 7)
    return (f'<circle cx="{cx}" cy="{cy}" r="7" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>'
            f'<path d="{d}" fill="none" stroke="{t["ok"]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')


def draw(t):
    """The flow for the theme `t`."""
    st = kit.Stage(W, H, t, LOOP, LABEL)
    st.defs(f'<linearGradient id="hinge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{t["warm"]}"/>'
            f'<stop offset="1" stop-color="{t["cool"]}"/></linearGradient>')
    # The dots march along the dashed line, one dash every 1.6 s.
    st.add(line(t, BRIEF), line(t, REPORT), line(t, ASK, head=False),
           st.ambient("0%{stroke-dashoffset:0}100%{stroke-dashoffset:-18}", 1.6, line(t, NEXT, dashed=True), timing="linear"),
           line(t, EDIT),
           '<text class="m mu" x="256" y="175" font-size="10.5" text-anchor="middle">brief</text>',
           '<text class="m mu" x="256" y="240" font-size="10.5" text-anchor="middle">report</text>')
    # the lead
    st.add(box(t, 36, 146, 180, 112, "Claude Code", ["plans · briefs", "reviews · decides"], dot=t["warm"]),
           st.blink(9.4, 10.3, f'<rect x="36.5" y="146.5" width="180" height="112" rx="12" fill="none" stroke="{t["warm"]}" stroke-width="3" stroke-opacity=".4"/>'),
           st.draw(9.6, 44, ticked(t, 63, 239), dur=0.6),
           st.show(9.6, kit.mono(76, 243, "dsk accept", 11.5, "t2"), dx=6, dy=0))
    # dsk, the hinge between the two
    st.add(f'<rect x="296.5" y="92.5" width="220" height="220" rx="12" fill="{t["surface"]}" stroke="url(#hinge)" stroke-width="1.5"/>',
           st.blink(1.2, 2.0, f'<rect x="296.5" y="92.5" width="220" height="220" rx="12" fill="none" stroke="{t["cool"]}" stroke-width="3" stroke-opacity=".4"/>'),
           '<text class="d ink" x="318" y="126" font-size="19" font-weight="750" letter-spacing="-.01em">dsk</text>')
    for i, (gate, at) in enumerate(zip(GATES, TICKS)):
        y = 158 + i * 30
        st.add(st.draw(at, 44, ticked(t, 327, y), dur=0.6), kit.mono(344, y + 4, gate, 12, "t2"))
    st.add('<text class="m mu" x="318" y="292" font-size="10.5">one Python file · stdlib only</text>')
    # the worker, the next provider, the repository
    st.add(box(t, 596, 36, 248, 100, "DeepSeek worker", ["one run_code script per turn", "reads · edits · runs · searches"], dot=t["cool"]))
    for j in range(TURNS):  # the turn count: each number passes through, the last one stays
        count, at = kit.mono(828, 66, f"turn {j + 1}", 11, "mu", "end"), FIRST + j * EVERY
        st.add(st.blink(at, at + EVERY, count) if j < TURNS - 1 else st.show(at, count, dy=0))
    st.add(box(t, 596, 152, 248, 84, "next provider", ["after a 402, used-up retries", "or a worker stuck in a loop"], dashed=True),
           box(t, 596, 252, 248, 116, "your repository", ["only --allow paths change", "the rest is undone"]),
           st.blink(10.0, 11.0, f'<rect x="596.5" y="252.5" width="248" height="116" rx="12" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>'),
           st.show(7.7, kit.mono(616, 348, "+ test_durations.py", 11.5, "ok") + kit.mono(828, 348, "+70", 11.5, "ok", "end"), dy=4))
    # the marks that travel, drawn around the origin and drawn on top of every box
    # Each has a soft halo in its own colour, so that the eye can follow it along a thin line.
    request = f'<circle r="9" fill="{t["cool"]}" opacity=".18"/><circle r="4.5" fill="{t["cool"]}"/>'
    script = (f'<circle r="9" fill="{t["cool"]}" opacity=".18"/>'
              f'<rect x="-4.5" y="-4.5" width="9" height="9" rx="2.5" fill="{t["cool"]}"/>')
    letter = f'<circle r="10" fill="{t["warm"]}" opacity=".2"/><circle r="5" fill="{t["warm"]}"/>'
    st.add(st.travel(BRIEF, 0.5, 0.7, letter), st.travel(REPORT, 8.7, 0.7, letter))
    for j in range(TURNS):  # a turn: the request goes out, the script comes back, the script runs against the repository
        b = FIRST + j * EVERY
        st.add(st.travel(ASK, b, 0.5, request),
               st.travel(ASK[::-1], b + 0.6, 0.5, script),
               st.travel(EDIT, b + 1.1, 0.4, script))
    return st.svg()
