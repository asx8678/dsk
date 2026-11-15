"""The hero: what dsk is, one turn's script, and three workers whose turns light up one by one."""
import kit

W, H, LOOP = 880, 394, 15
LABEL = "dsk: Claude Code plans, reviews and decides; a DeepSeek worker scouts the code and writes it"
SCRIPT = [  # one turn of a worker, as the tokens of each line: (text, fill class)
    [("src = ", "ink"), ("read", "cd"), ('("durations.py")', "t2")],
    [("write", "cd"), ('("test_durations.py", tests)', "t2")],
    [("sh", "cd"), ('("python3 -m unittest")', "t2")],
    [("done", "ok"), ('("12 tests pass")', "t2")],
]
LANES = [  # id, brief, turns, how it ended. The first is the run the terminal image shows.
    ("054a", "Add unit tests for durations.py", 4, "accepted"),
    ("c41e", "Where is the retry backoff decided? file:line", 2, "done"),
    ("2a6f", "Rename Config to Settings across src/", 5, "review"),
]
TIMES = [  # per lane: when it starts, when its lit squares pop, when it ends
    (1.0, (1.6, 2.5, 3.4, 4.3), 4.9),
    (1.4, (2.0, 3.0), 3.6),
    (1.8, (2.4, 3.4, 4.4, 5.4, 6.4), 7.0),
]


def header(st):
    """The line above the name, the name in the gradient of the two identity colours, and what dsk is."""
    t = st.t
    stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in zip((0, 0.55, 1), t["grad"]))
    word = '<text class="d" x="36" y="128" font-size="76" font-weight="800" letter-spacing="-.035em" fill="url(#word)">dsk</text>'
    st.defs(f'<linearGradient id="word" x1="0" y1="0" x2="1" y2="0">{stops}</linearGradient>',
            '<clipPath id="word-clip"><text class="d" x="36" y="128" font-size="76" font-weight="800" '
            'letter-spacing="-.035em">dsk</text></clipPath>',
            '<linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">'
            '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>'
            '<stop offset=".5" stop-color="#ffffff" stop-opacity=".55"/>'
            '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>')
    lead, worker = "Claude Code plugin", "DeepSeek V4.1 Flash"
    second = 56 + len(lead) * 12.5 * kit.PITCH + 22  # where the worker's dot sits, after the lead's words
    st.add(st.ambient("0%,100%{opacity:1}50%{opacity:.3}", 2.4, f'<circle cx="44" cy="47" r="4" fill="{t["warm"]}"/>'),
           kit.mono(56, 51.5, lead, 12.5, "mu"),
           st.ambient("0%,100%{opacity:.3}50%{opacity:1}", 2.4, f'<circle cx="{second:g}" cy="47" r="4" fill="{t["cool"]}"/>'),
           kit.mono(second + 12, 51.5, worker, 12.5, "mu"),
           word,
           '<g clip-path="url(#word-clip)">' + st.ambient(
               "0%{transform:translateX(0px)}35%,100%{transform:translateX(300px)}", 6,
               '<rect x="-70" y="60" width="70" height="80" fill="url(#shine)"/>', timing="ease-in") + '</g>',
           '<text class="t ink" x="40" y="166" font-size="19">Claude Code plans, reviews and decides.</text>',
           '<text class="t t2" x="40" y="192" font-size="19">A DeepSeek worker scouts the code and writes it.</text>')


def script(st):
    """A card with one turn's script: what the worker sends, and all that it sends."""
    t, x, y, w, h, size = st.t, 548, 40, 292, 150, 11.5
    card = f'<rect x="{x + .5}" y="{y + .5}" width="{w}" height="{h}" rx="12" fill="{t["surface"]}" stroke="{t["line"]}"/>'
    frame = f'<rect x="{x + .5}" y="{y + .5}" width="{w}" height="{h}" rx="12" fill="none" stroke="{t["cool"]}" stroke-opacity=".7"/>'
    st.add(card, st.blink(0.5, 4.1, frame),
           f'<circle cx="{x + 18}" cy="{y + 18}" r="3.5" fill="{t["cool"]}"/>',
           f'<text class="m mu" x="{x + 30}" y="{y + 22}" font-size="10.5" letter-spacing=".04em">ONE TURN · ONE PYTHON SCRIPT</text>',
           f'<line x1="{x}" y1="{y + 34.5}" x2="{x + w}" y2="{y + 34.5}" stroke="{t["line"]}"/>')
    for i, line in enumerate(SCRIPT):
        base, col = y + 62 + i * 21, 0
        st.add(f'<text class="m l2" x="{x + 16}" y="{base}" font-size="10">{i + 1}</text>')
        for text, cls in line:
            st.add(kit.mono(x + 36 + col * size * kit.PITCH, base, text, size, cls))
            col += len(text)
        n = sum(len(text) for text, _ in line)
        cover = f'<rect x="{x + 35:g}" y="{base - 11:g}" width="{n * size * kit.PITCH + 2:g}" height="15" fill="{t["surface"]}"/>'
        st.add(st.type(0.5 + i * 0.9, 0.7, n, cover))
        caret = f'<rect x="0" y="0" width="6" height="13" rx="1.5" fill="{t["cool"]}"/>'
        st.add(st.travel([(x + 36, base - 10.5), (x + 36 + n * size * kit.PITCH, base - 10.5)], 0.5 + i * 0.9, 0.7, caret,
                         hold=1.0 if i == 3 else 0, steps=n))


def chip(t, right, mid, status):
    """How a run ended, as a pair (icon, word), ending at x = `right` on the line `mid`."""
    icon_x = right - len(status) * 11.5 * kit.PITCH - 12
    word = kit.mono(right, mid + 4.5, status, 11.5, "t2", "end")
    if status == "accepted":
        d, _ = kit.check(icon_x, mid, 7)
        icon = (f'<circle cx="{icon_x:g}" cy="{mid}" r="7" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>'
                f'<path d="{d}" fill="none" stroke="{t["ok"]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')
    else:
        icon = f'<circle cx="{icon_x:g}" cy="{mid}" r="4" fill="{t["warm"] if status == "review" else t["muted"]}"/>'
    return icon, word


def lanes(st):
    """Three workers: the brief each was given, a square per turn it took, and how it ended."""
    t, x = st.t, 40

    def pulse(dot):
        """A review dot, pulsing while the run waits for a decision."""
        return st.ambient("0%,100%{opacity:1}50%{opacity:.35}", 1.6, dot)

    st.add('<text class="m mu" x="40" y="226" font-size="11" letter-spacing=".06em">WORKERS · ONE SCRIPT PER TURN</text>',
           '<text class="m mu" x="840" y="226" font-size="11" text-anchor="end" letter-spacing=".02em">a square lit = a turn</text>')
    for k, (run, brief, turns, status) in enumerate(LANES):
        y = 240 + k * 46
        start, pops, end = TIMES[k]
        lane = f'<rect x="{x + .5}" y="{y + .5}" width="799" height="37" rx="9" fill="{t["surface"]}" stroke="{t["line"]}"/>'
        st.add(lane)
        st.add(st.blink(start, end, f'<rect x="{x + .5}" y="{y + .5}" width="799" height="37" rx="9" fill="none" stroke="{t["cool"]}" stroke-opacity=".7"/>'))
        st.add(kit.mono(x + 16, y + 24, run, 12.5, "mu"),
               f'<text class="t ink" x="{x + 64}" y="{y + 24}" font-size="13.5">{kit.esc(brief)}</text>')
        for i in range(6):  # six places, so that the lanes line up; the turns taken are lit
            px = x + 440 + i * 20
            st.add(f'<rect x="{px + .5}" y="{y + 12.5}" width="13" height="13" rx="4" fill="none" stroke="{t["line"]}"/>')
            if i < turns:
                st.add(st.pop(pops[i], f'<rect x="{px}" y="{y + 12}" width="14" height="14" rx="4" fill="{t["cool"]}"/>'))
        sx = x + 784 - 7 * 11.5 * kit.PITCH - 12
        circle = f'<circle cx="{sx:g}" cy="{y + 19}" r="5.5" fill="none" stroke="{t["cool"]}" stroke-width="1.8" stroke-dasharray="18 17" stroke-linecap="round"/>'
        spinner = st.ambient("0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}", 0.9, circle, css="transform-box:fill-box;transform-origin:center;", timing="linear")
        word = kit.mono(x + 784, y + 23.5, "running", 11.5, "t2", "end")
        st.add(st.blink(start, end, spinner + word))
        if status == "accepted":
            review_icon, review_word = chip(t, x + 784, y + 19, "review")
            accepted_icon, accepted_word = chip(t, x + 784, y + 19, "accepted")
            icon_x = x + 784 - len("accepted") * 11.5 * kit.PITCH - 12
            frame = lane.replace(f'fill="{t["surface"]}" stroke="{t["line"]}"',
                                 f'fill="none" stroke="{t["ok"]}" stroke-opacity=".8"')
            ring = f'<circle cx="{icon_x:g}" cy="{y + 19}" r="7" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>'
            st.add(st.blink(end, 6.6, pulse(review_icon) + review_word),
                   st.draw(6.6, 44, accepted_icon, dur=0.6),
                   st.show(6.6, accepted_word, dx=6, dy=0),
                   st.blink(6.6, 7.8, frame),
                   st.ripple([6.9], ring))
        elif status == "done":
            done_icon, done_word = chip(t, x + 784, y + 19, "done")
            icon_x = x + 784 - len("done") * 11.5 * kit.PITCH - 12
            ring = f'<circle cx="{icon_x:g}" cy="{y + 19}" r="4" fill="none" stroke="{t["muted"]}" stroke-width="1.5"/>'
            st.add(st.show(end, done_icon + done_word, dx=6, dy=0),
                   st.ripple([end + 0.2], ring, swell=2.6))
        else:
            review_icon, review_word = chip(t, x + 784, y + 19, "review")
            icon_x = x + 784 - len("review") * 11.5 * kit.PITCH - 12
            ring = f'<circle cx="{icon_x:g}" cy="{y + 19}" r="4" fill="none" stroke="{t["warm"]}" stroke-width="1.5"/>'
            st.add(st.show(end, pulse(review_icon) + review_word, dx=6, dy=0),
                   st.ripple([end + 0.2], ring, swell=2.6))


def draw(t):
    """The hero for the theme `t`."""
    st = kit.Stage(W, H, t, LOOP, LABEL)
    header(st)
    script(st)
    lanes(st)
    return st.svg()
