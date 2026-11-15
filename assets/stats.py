"""The numbers: four figures that were measured, each with where it comes from and each counting up to what it
shows."""
import kit

W, H, LOOP = 880, 136, 20
LABEL = ("3 turns per task at the bench's median; 85 to 92% of a code task's input read from the cache; "
         "132 tests; no dependencies")
TILES = [  # the figure, what it counts, and where it was measured
    ("3", "turns per task", "the bench's median"),
    ("85–92%", "of input from cache", "code tasks, official API"),
    ("132", "tests", "on a scripted API server"),
    ("0", "dependencies", "one file, stdlib only"),
]
STEPS = [("1", "2"), ("22–29%", "51–58%", "73–80%"), ("27", "61", "94", "118", "129"), ("3", "2", "1")]
NOTE = "docs/build-notes.md · tests/test_dsk.py · v0.6.1"


def figure(x, value):
    """The figure's text, at `x`, showing `value`: the tile's own figure and each number it counts through."""
    return (f'<text class="t ink" x="{x:g}" y="62" font-size="30" font-weight="650" letter-spacing="-.02em">'
            f'{kit.esc(value)}</text>')


def draw(t):
    """The numbers for the theme `t`."""
    st = kit.Stage(W, H, t, LOOP, LABEL, glow=False)
    cell = (W - 40) / len(TILES)
    for i, (value, what, where) in enumerate(TILES):
        x = 20 + i * cell
        a = 0.4 + i * 0.35  # the tile's turn on the loop, in seconds
        if i:
            st.add(f'<line x1="{x:g}" y1="26" x2="{x:g}" y2="{H - 34}" stroke="{t["line"]}"/>')
        cx, cy = x + 32, 52
        d, _ = kit.check(cx, cy, 12)
        ring = f'<circle cx="{cx:g}" cy="{cy}" r="12" fill="none" stroke="{t["cool"]}" stroke-width="1.6"/>'
        st.add(st.ripple([a + 0.7, 6 + i * 0.3, 11 + i * 0.3, 16 + i * 0.3], ring),
               st.draw(a, 76, ring +
                       f'<path d="{d}" fill="none" stroke="{t["cool"]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
                       dur=0.7))
        steps = STEPS[i]
        for k, step in enumerate(steps):
            st.add(st.blink(a + 0.15 + k * 0.12, a + 0.15 + (k + 1) * 0.12, figure(x + 56, step), fade=0.03))
        st.add(st.show(a + 0.15 + len(steps) * 0.12, figure(x + 56, value), dur=0.2, dy=0),
               st.show(a + 0.3, f'<text class="t t2" x="{x + 57:g}" y="84" font-size="13">{kit.esc(what)}</text>'
                                f'<text class="t mu" x="{x + 57:g}" y="101" font-size="11.5">{kit.esc(where)}</text>',
                       dy=4))
    st.add(f'<text class="m mu" x="{W - 20}" y="{H - 12}" font-size="10.5" text-anchor="end">{kit.esc(NOTE)}</text>')
    return st.svg()
