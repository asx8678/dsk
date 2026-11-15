"""The route: a run moves along its list of providers. One whose slots are taken is skipped; one that answers 429
is retried, and when the retries are used up the next provider takes over in a new series. The report names them."""
import kit

W, H, LOOP = 880, 300, 18
LABEL = ("A run moves along its route of providers: a provider whose slots are taken is skipped, and when the "
         "retries of a 429 are used up the next provider takes over in a new series; the report names the providers "
         "the run left")
RAIL_Y = 78  # the line the providers' stops sit on
CARD_Y, CARD_W, CARD_H = 96, 252, 112  # the three cards, side by side
CARD_X, CARD_STEP = 40, 274  # the left edge of the first card, and of each one after it
SIZE = 11.5  # the cards' and the report's mono text
STATE_X = 234  # where a card's state word ends, counted from the card's left edge
PROVIDERS = (
    ("coralbricks", ("full", "wn", "warn"),
     [("all its slots are taken", "t2"), ("skipped: no request sent", "mu")], ()),
    ("thirdparty", ("429", "wn", "warn"),
     [("turns 1 and 2", "t2"), (["retried after ", "2 s, ", "6 s, ", "18 s"], "mu")], ("cool", "cool", "failed")),
    ("official", ("review", "t2", "warm"),
     [("a new series: turns 3 and 4", "t2"), ("the same conversation, resent", "mu")], ("cool", "cool")),
)


def line(t, points, head=True):
    """A connector through the points, with an arrow head at its end unless `head` is false."""
    d = "M" + " L".join(f"{x:g} {y:g}" for x, y in points)
    out = f'<path d="{d}" fill="none" stroke="{t["line2"]}" stroke-width="1.5"/>'
    if head:
        (px, py), (x, y) = points[-2], points[-1]
        back = -7 if x > px else 7
        out += f'<path d="M{x:g} {y:g} L{x + back:g} {y - 4:g} L{x + back:g} {y + 4:g} Z" fill="{t["line2"]}"/>'
    return out


def highlight(t, x, baseline, s, size):
    """The cool wash behind a run of mono text `s`, wider than the text by 5 px on each side."""
    return (f'<rect x="{x - 5:g}" y="{baseline - 14:g}" width="{len(s) * size * kit.PITCH + 10:g}" height="19" '
            f'rx="5" fill="{t["cool"]}" opacity=".16"/>')


def frame(rect, colour):
    """A card's own outline, in `colour`, to light while the provider is at work: the rect keeps everything before its
    paint, and gets no fill and `colour` for its stroke."""
    return rect.partition(' fill="')[0] + f' fill="none" stroke="{colour}" stroke-opacity=".7"/>'


def stop(t, cx):
    """A provider's stop on the route at x=`cx`: the ring the route meets, and the short connector down to the
    provider's card."""
    return [line(t, [(cx, RAIL_Y + 6), (cx, CARD_Y)], head=False),
            f'<circle cx="{cx:g}" cy="{RAIL_Y}" r="6" fill="{t["surface"]}" stroke="{t["line2"]}" stroke-width="1.5"/>']


def ended(t, cx):
    """The inner dot of a stop where the run ended."""
    return f'<circle cx="{cx:g}" cy="{RAIL_Y}" r="3.5" fill="{t["cool"]}"/>'


def square(t, x, y, failed=False):
    """One of a provider's turns, 14 by 14: filled when the provider took it, a hollow warning outline when the turn
    failed and came back for a retry."""
    if failed:  # drawn inset, so that the 1.5 stroke stays inside the 14 by 14 the filled squares take
        return [f'<rect x="{x + .5:g}" y="{y + .5:g}" width="13" height="13" rx="4" fill="none" stroke="{t["warn"]}" '
                f'stroke-width="1.5"/>']
    return [f'<rect x="{x:g}" y="{y:g}" width="14" height="14" rx="4" fill="{t["cool"]}"/>']


def card(t, x, title, state, lines, squares):
    """A provider's card at `x`, as its parts: the rect, the title, the state's dot and word, the two lines as their
    pieces, and a square for each of its turns."""
    word, cls, colour = state
    rect = (f'<rect x="{x + .5:g}" y="{CARD_Y + .5}" width="{CARD_W}" height="{CARD_H}" rx="12" fill="{t["surface"]}" '
            f'stroke="{t["line"]}"/>')
    title_text = f'<text class="d ink" x="{x + 20}" y="{CARD_Y + 30}" font-size="16" font-weight="650">{kit.esc(title)}</text>'
    # the state's dot sits just before the word, 4 px above the word's baseline
    dot = f'<circle cx="{x + STATE_X - len(word) * SIZE * kit.PITCH - 12:g}" cy="{CARD_Y + 25}" r="4" fill="{t[colour]}"/>'
    word_text = kit.mono(x + STATE_X, CARD_Y + 29, word, SIZE, cls, "end")
    rows = []
    for i, (text, cls) in enumerate(lines):
        if isinstance(text, str):
            rows.append([kit.mono(x + 20, CARD_Y + 54 + i * 17, text, SIZE, cls)])
        else:  # pieces side by side, each starting where the one before ends
            at, pieces = x + 20, []
            for piece in text:
                pieces.append(kit.mono(at, CARD_Y + 54 + i * 17, piece, SIZE, cls))
                at += len(piece) * SIZE * kit.PITCH
            rows.append(pieces)
    marks = ["".join(square(t, x + 20 + j * 20, CARD_Y + 84, failed=kind == "failed"))
             for j, kind in enumerate(squares)]
    return rect, title_text, dot, word_text, rows, marks


def report(t):
    """The report's card, the wash behind the providers it names, the label of its first line, and the text of the
    line itself."""
    text = "dsk 7f3a · review · official after coralbricks, thirdparty · 4 turns"
    left = "official after coralbricks, thirdparty"
    x = 232
    return (f'<rect x="{CARD_X + .5:g}" y="222.5" width="800" height="36" rx="9" fill="{t["surface"]}" '
            f'stroke="{t["line"]}"/>',
            highlight(t, x + text.index(left) * SIZE * kit.PITCH, 245, left, SIZE),
            kit.mono(58, 245, "the report's first line", 11, "mu"),
            text)


def draw(t):
    """The route for the theme `t`."""
    st = kit.Stage(W, H, t, LOOP, LABEL)
    st.add('<text class="m mu" x="40" y="46" font-size="11" letter-spacing=".06em">THE ROUTE · THE NEXT PROVIDER TAKES OVER</text>',
           kit.mono(840, 46, '"route": ["coralbricks", "thirdparty", "official"]', 10.5, "cd", "end"),
           line(t, [(40, RAIL_Y), (840, RAIL_Y)]))
    cards = [card(t, CARD_X + i * CARD_STEP, title, state, lines, squares)
             for i, (title, state, lines, squares) in enumerate(PROVIDERS)]

    # coralbricks is full, so the run skips it and sends no request.
    rect, title, dot, word, rows, marks = cards[0]
    x = CARD_X
    st.add(*stop(t, x + CARD_W / 2), rect, st.blink(0.9, 2.3, frame(rect, t["warn"])), title,
           st.show(1.1, dot + word, dx=6, dy=0),
           st.show(1.3, "".join(rows[0]), dx=-6, dy=0), st.show(1.6, "".join(rows[1]), dx=-6, dy=0))

    # thirdparty serves two turns, then answers 429 through every retry.
    rect, title, dot, word, rows, marks = cards[1]
    x = CARD_X + CARD_STEP
    st.add(*stop(t, x + CARD_W / 2), rect, st.blink(2.9, 5.2, frame(rect, t["cool"])), title,
           st.show(3.1, "".join(rows[0]), dx=-6, dy=0), st.pop(3.5, marks[0]), st.pop(4.4, marks[1]),
           st.pop(5.2, marks[2]), st.blink(5.2, 8.2, frame(rect, t["warn"])),
           st.show(5.2, dot + word, dx=6, dy=0))
    st.add(*[st.show(at, piece, dx=0, dy=4) for at, piece in zip((5.6, 5.9, 6.5, 7.3), rows[1])])
    st.add(st.ripple([5.9, 6.5, 7.3], marks[2], swell=1.7))

    # official takes over in a new series, and the run ends there in review.
    rect, title, dot, word, rows, marks = cards[2]
    x = CARD_X + 2 * CARD_STEP
    st.add(*stop(t, x + CARD_W / 2), st.pop(8.9, ended(t, x + CARD_W / 2)),
           rect, st.blink(8.8, 12.0, frame(rect, t["cool"])), title,
           st.show(9.0, "".join(rows[0]), dx=-6, dy=0), st.show(9.3, "".join(rows[1]), dx=-6, dy=0),
           st.pop(9.8, marks[0]), st.pop(10.7, marks[1]),
           st.show(11.4, st.ambient("0%,100%{opacity:1}50%{opacity:.35}", 1.6, dot) + word, dx=6, dy=0))

    card_rect, wash, label, text = report(t)
    # The cover and the caret run to the end of the line, however long its text is.
    cover = f'<rect x="231" y="234" width="{len(text) * 11.5 * kit.PITCH + 2:g}" height="15" fill="{t["surface"]}"/>'
    caret = f'<rect x="0" y="0" width="6" height="13" rx="1.5" fill="{t["cool"]}"/>'
    st.add(card_rect, st.pop(13.6, wash), st.show(12.0, label, dx=-6, dy=0), kit.mono(232, 245, text, SIZE, "ink"),
           st.type(12.2, 1.0, len(text), cover),
           st.travel([(232, 234.5), (232 + len(text) * 11.5 * kit.PITCH, 234.5)], 12.2, 1.0, caret, steps=len(text)))
    st.add('<text class="m mu" x="40" y="280" font-size="10.5">it also moves on after a 402, a network failure, a 408 '
           'or a 5xx that outlasts the retries, or a worker stuck in a loop</text>')

    # The run's dot rides the route; it goes last, so that it lies on top of the stops.
    rider = f'<circle r="9" fill="{t["cool"]}" opacity=".18"/><circle r="4.5" fill="{t["cool"]}"/>'
    st.add(st.travel([(40, RAIL_Y), (166, RAIL_Y)], 0.4, 0.5, rider, hold=1.3),
           st.travel([(166, RAIL_Y), (440, RAIL_Y)], 2.3, 0.6, rider, hold=5.2),
           st.travel([(440, RAIL_Y), (714, RAIL_Y)], 8.2, 0.6, rider, hold=0.4))
    return st.svg()
