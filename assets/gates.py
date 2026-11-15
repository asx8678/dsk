"""The gates: after every script dsk undoes what it changed outside --allow, then dsk runs the check itself, and
then the work waits in review until the lead accepts or rejects it."""
import kit

W, H, LOOP = 880, 316, 18
LABEL = ("After every script dsk undoes what it changed outside --allow; then dsk runs the check itself; then the "
         "work waits in review until the lead accepts or rejects it")
CARD_X, CARD_W = 88, 752
COLUMNS = (128, 268, 404, 548)  # the left edge of each of a row's four cells


def card(t, y, h, label, flag):
    """A card with its caps label, its flag at the right edge and the hairline under them."""
    return [f'<rect x="{CARD_X + .5}" y="{y + .5}" width="{CARD_W}" height="{h}" rx="12" fill="{t["surface"]}" stroke="{t["line"]}"/>',
            f'<text class="m mu" x="{CARD_X + 18}" y="{y + 21}" font-size="10.5" letter-spacing=".04em">{kit.esc(label)}</text>',
            kit.mono(822, y + 21, flag, 10.5, "cd", "end"),
            f'<line x1="{CARD_X}" y1="{y + 32.5:g}" x2="{CARD_X + CARD_W}" y2="{y + 32.5:g}" stroke="{t["line"]}"/>']


def row(t, baseline, icon, cells, last=""):
    """One row: the mark centred at x=112, the four cells in their columns, and `last`, a word that ends at x=822.
    A cell or `last` may carry a third item, a list of elements to draw under its text, such as a highlight."""
    out = list(icon)
    for x, cell in zip(COLUMNS, cells):
        text, cls, *under = cell
        out += [s for u in under for s in u] + [kit.mono(x, baseline, text, 11.5, cls)]
    if last:
        text, cls, *under = last
        out += [s for u in under for s in u] + [kit.mono(822, baseline, text, 11.5, cls, "end")]
    return out


def ticked(t, cx, cy):
    """A ring with a check mark in it: a gate that has done its part."""
    d, _ = kit.check(cx, cy, 7)
    return [f'<circle cx="{cx:g}" cy="{cy:g}" r="7" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>',
            f'<path d="{d}" fill="none" stroke="{t["ok"]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>']


def undone(t, cx, cy):
    """A ring with a bar in it: a change that was undone."""
    return [f'<circle cx="{cx:g}" cy="{cy:g}" r="7" fill="none" stroke="{t["warn"]}" stroke-width="1.5"/>',
            f'<path d="M{cx - 3.5:g} {cy:g} H{cx + 3.5:g}" fill="none" stroke="{t["warn"]}" stroke-width="1.6" stroke-linecap="round"/>']


def node(t, y, number):
    """A numbered stop on the rail at the left, centred at x=58 and level with its card."""
    return [f'<circle cx="58" cy="{y:g}" r="10" fill="{t["surface"]}" stroke="{t["line2"]}" stroke-width="1.5"/>',
            f'<circle cx="58" cy="{y:g}" r="10" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>',
            f'<text class="m mu" x="58" y="{y + 4:g}" font-size="11" text-anchor="middle">{number}</text>']


def link(t, points):
    """A plain connector through the points, without an arrow head."""
    d = "M" + " L".join(f"{x:g} {y:g}" for x, y in points)
    return f'<path d="{d}" fill="none" stroke="{t["line2"]}" stroke-width="1.5"/>'


def dot(cx, cy, colour):
    """A small dot in the identity colour of whoever acts."""
    return [f'<circle cx="{cx:g}" cy="{cy:g}" r="4" fill="{colour}"/>']


def highlight(t, x, baseline, s, size):
    """The cool wash behind a word of mono text, wider than the word by 5 px on each side."""
    return [f'<rect x="{x - 5:g}" y="{baseline - 14:g}" width="{len(s) * size * kit.PITCH + 10:g}" height="19" rx="5" '
            f'fill="{t["cool"]}" opacity=".16"/>']


def frame(rect, colour):
    """A card's own outline, in `colour`, to light while its gate is at work: the rect keeps everything before its
    paint, and gets no fill and `colour` for its stroke."""
    return rect.partition(' fill="')[0] + f' fill="none" stroke="{colour}" stroke-opacity=".7"/>'


def ping(cy, colour):
    """A ring around a node on the rail, in `colour`, for the ripple that marks its gate starting."""
    return f'<circle cx="58" cy="{cy:g}" r="10" fill="none" stroke="{colour}" stroke-width="1.5"/>'


def runner(t):
    """The mark that travels down the rail from one gate to the next."""
    return f'<circle r="4.5" fill="{t["cool"]}"/>'


def draw_scope(st):
    """Add the scope gate: the script wrote two files, so the one inside --allow is kept and the one outside undone."""
    t = st.t
    rect, label, flag, rule = card(t, 36, 92, "SCOPE · AFTER EVERY SCRIPT", "--allow 'test_*.py'")
    st.add(rect, st.blink(0.4, 5.2, frame(rect, t["cool"])), label, flag, rule)
    outer, green, number = node(t, 82, 1)
    st.add(outer, st.draw(5.0, 63, green, dur=0.5), number, st.ripple([0.4], ping(82, t["cool"]), swell=1.8),
           link(t, [(68, 82), (88, 82)]))
    keep_ring, keep_tick, file_in, write_in, inside, kept, plus = row(
        t, 90, ticked(t, 112, 86),
        [("test_durations.py", "ink"), ("write()", "cd"), ("inside --allow", "t2"), ("kept", "ok")], ("+70", "ok"))
    undo_ring, undo_bar, file_out, sh_out, outside, undone_word = row(
        t, 114, undone(t, 112, 110),
        [("durations.py", "ink"), ('sh("black .")', "cd"), ("outside --allow", "t2"), ("undone · a copy is kept", "wn")])
    band = f'<rect x="98" y="99" width="732" height="21" rx="5" fill="{t["warn"]}" opacity=".12"/>'
    st.add(st.show(0.9, file_in + write_in, dx=-6, dy=0), st.pop(1.3, plus))
    # The band of row 2 goes on before the row's texts, and the file that was there before stays still.
    st.add(st.blink(1.9, 4.5, band), file_out, st.show(1.9, sh_out, dx=-6, dy=0))
    st.add(st.show(2.9, inside, dx=-6, dy=0), st.show(3.3, outside, dx=-6, dy=0))
    st.add(st.draw(3.9, 44, keep_ring + keep_tick, dur=0.6), st.show(3.9, kept, dx=-6, dy=0))
    st.add(st.draw(4.5, 44, undo_ring + undo_bar, dur=0.6), st.show(4.5, undone_word, dx=-6, dy=0))
    st.add(st.travel([(58, 92), (58, 165)], 5.2, 0.4, runner(t)))


def draw_check(st):
    """Add the check gate: dsk runs the command itself, and its result is the only word on whether the work passed."""
    t = st.t
    rect, label, flag, rule = card(t, 142, 66, "CHECK · RUN BY DSK ITSELF", "--check 'python3 -m unittest'")
    st.add(rect, st.blink(5.6, 8.4, frame(rect, t["cool"])), label, flag, rule)
    outer, green, number = node(t, 175, 2)
    st.add(outer, st.draw(8.1, 63, green, dur=0.5), number, st.ripple([5.6], ping(175, t["cool"]), swell=1.8),
           link(t, [(68, 175), (88, 175)]))
    ring, tick, command, zero, passed, note = row(
        t, 196, ticked(t, 112, 192),
        [("python3 -m unittest", "ink"), ("→ 0", "ok"), ("passed", "t2"), ("a failure goes back to the worker", "mu")])
    cover = f'<rect x="127" y="185" width="{19 * 11.5 * kit.PITCH + 2:g}" height="15" fill="{t["surface"]}"/>'
    caret = f'<rect x="0" y="0" width="6" height="13" rx="1.5" fill="{t["cool"]}"/>'
    spinner = st.ambient("0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}", 0.9,
                         f'<circle cx="112" cy="192" r="5.5" fill="none" stroke="{t["cool"]}" stroke-width="1.8" '
                         f'stroke-dasharray="18 17" stroke-linecap="round"/>',
                         css="transform-box:fill-box;transform-origin:center;", timing="linear")
    st.add(command, note)
    st.add(st.type(5.9, 0.8, 19, cover),
           st.travel([(128, 185.5), (128 + 19 * 11.5 * kit.PITCH, 185.5)], 5.9, 0.8, caret, steps=19))
    st.add(st.blink(6.7, 7.6, spinner))
    st.add(st.draw(7.7, 44, ring + tick, dur=0.6), st.pop(7.7, zero), st.show(7.9, passed, dx=-6, dy=0))
    st.add(st.travel([(58, 185), (58, 245)], 8.3, 0.4, runner(t)))


def draw_review(st):
    """Add the review gate: the lead decides, and the work is accepted or sent back with its defects named."""
    t = st.t
    rect, label, flag, rule = card(t, 222, 66, "REVIEW · HELD UNTIL THE LEAD DECIDES", "Stop hook: exit 2")
    st.add(rect, st.blink(8.8, 12.6, frame(rect, t["warm"])), label, flag, rule)
    outer, green, number = node(t, 255, 3)
    st.add(outer, st.draw(12.6, 63, green, dur=0.5), number, st.ripple([8.8], ping(255, t["warm"]), swell=1.8),
           link(t, [(68, 255), (88, 255)]))
    ring_x = 822 - len("accepted") * 11.5 * kit.PITCH - 12  # the centre of the ring that goes before `accepted`
    dot_mark, review_word, decides, wash, accept, reject, ring, tick, accepted = row(
        t, 276, dot(112, 272, t["warm"]),
        [("review", "ink"), ("the lead decides:", "t2"),
         ("dsk accept", "ink", highlight(t, 404, 276, "dsk accept", 11.5)), ('dsk reject "defects"', "t2")],
        ("accepted", "t2", ticked(t, ring_x, 272)))
    st.add(st.show(9.0, review_word + st.ambient("0%,100%{opacity:1}50%{opacity:.35}", 1.6, dot_mark), dx=-6, dy=0))
    st.add(st.show(9.5, decides, dx=-6, dy=0), st.pop(11.6, wash), st.show(9.9, accept, dx=-6, dy=0),
           st.show(10.2, reject, dx=-6, dy=0))
    st.add(st.draw(12.2, 44, ring + tick, dur=0.6), st.show(12.2, accepted, dx=6, dy=0),
           st.ripple([12.5], f'<circle cx="{ring_x:g}" cy="272" r="7" fill="none" stroke="{t["ok"]}" stroke-width="1.5"/>'))


def draw(t):
    """The three gates for the theme `t`."""
    st = kit.Stage(W, H, t, LOOP, LABEL)
    # The rail joins the three gates: its plain connectors go down first, so the runner and the pings pass over them.
    st.add(link(t, [(58, 96), (58, 161)]), link(t, [(58, 189), (58, 241)]))
    draw_scope(st)
    draw_check(st)
    draw_review(st)
    return st.svg()
