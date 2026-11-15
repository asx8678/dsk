"""The cache: the input of each turn of a real session, split into what the provider read from its cache and what
was new. Every request extends the one before it, so the cached part grows turn by turn. A faint copy of the previous
bar drops into each row, and a tick marks where the previous request ended."""
import kit

W, H, LOOP = 880, 372, 20
LABEL = ("Input tokens per turn of a real session of 7 turns, split into read from the cache and new: "
         "76% of the input came from the cache")
# Session 35d2 wrote the first assets/build.py on 2026-11-14: (input tokens, of them read from the cache) per turn,
# as `dsk show 35d2 --log` prints them. 42,752 of 55,961 input tokens were cache hits.
TURNS = [(5798, 1024), (6297, 5632), (6545, 6144), (6716, 6400), (8216, 6656), (8957, 8192), (13432, 8704)]
NOTES = {  # what to say beside a turn's bar
    1: "a cold start: 18% from the cache",
    2: "89%: turn 1's request, read from the cache",
    4: "95% from the cache",
    7: "65%: turn 6's script is new",
}
X0, SCALE, Y0, STEP, THICK = 104, 0.04, 104, 30, 16


def bar(t, y, tokens, hit):
    """One turn: the cached part from the baseline, a 2 px gap, then the new part with a rounded end; the cached
    rect and the new path come back as a pair, each to be animated on its own."""
    cached, new = hit * SCALE, (tokens - hit) * SCALE
    x1, x2 = X0 + cached + 2, X0 + cached + new
    rect = f'<rect x="{X0}" y="{y}" width="{cached:.1f}" height="{THICK}" fill="{t["cool"]}"/>'
    path = f'<path d="M{x1:.1f} {y} H{x2 - 4:.1f} a4 4 0 0 1 4 4 V{y + THICK - 4} a4 4 0 0 1 -4 4 H{x1:.1f} Z" fill="{t["gray"]}"/>'
    return rect, path


def draw(t):
    """The cache chart for the theme `t`."""
    st = kit.Stage(W, H, t, LOOP, LABEL, glow=False)
    st.add('<text class="t ink" x="40" y="48" font-size="16" font-weight="650">Every request extends the one before it</text>',
           '<text class="t mu" x="40" y="70" font-size="13">Input tokens per turn of a real session. 76% of them were read from the provider\'s cache.</text>',
           f'<rect x="604" y="38" width="10" height="10" rx="2.5" fill="{t["cool"]}"/>',
           '<text class="t t2" x="620" y="47.5" font-size="12">read from the cache</text>',
           f'<rect x="752" y="38" width="10" height="10" rx="2.5" fill="{t["gray"]}"/>',
           '<text class="t t2" x="768" y="47.5" font-size="12">new</text>')
    bottom = Y0 + len(TURNS) * STEP - (STEP - THICK) + 10
    for k, label in enumerate(("0", "5K", "10K", "15K")):
        x = X0 + k * 5000 * SCALE
        st.add(f'<line x1="{x:g}" y1="{Y0 - 8}" x2="{x:g}" y2="{bottom}" stroke="{t["line"]}"/>',
               f'<text class="m mu" x="{x:g}" y="{bottom + 16}" font-size="10.5" text-anchor="middle">{label}</text>')
    st.add(f'<text class="m mu" x="{W - 40}" y="{bottom + 16}" font-size="10.5" text-anchor="end">input tokens</text>')
    for i, (tokens, hit) in enumerate(TURNS, 1):
        y = Y0 + (i - 1) * STEP
        a = 0.6 + (i - 1) * 1.1
        rect, path = bar(t, y, tokens, hit)
        st.add(st.show(a - 0.1, kit.mono(92, y + 12, f"turn {i}", 11.5, "mu", "end"), dx=-6, dy=0))
        if i > 1:
            before = TURNS[i - 2][0]
            end = X0 + before * SCALE
            copy = f'<rect x="0" y="0" width="{before * SCALE:.1f}" height="{THICK}" fill="{t["cool"]}" opacity=".25"/>'
            st.add(st.travel([(X0, y - STEP), (X0, y)], a - 0.35, 0.3, copy, hold=0.5))
        st.add(st.grow(a, rect, dur=0.45), st.grow(a + 0.4, path, dur=0.3))
        if i > 1:
            tick = (f'<line x1="{end:.1f}" y1="{y - STEP + THICK}" x2="{end:.1f}" y2="{y}" stroke="{t["line2"]}" '
                    f'stroke-width="1.5"/>')
            st.add(st.draw(a - 0.35, 14, tick, dur=0.3))
        if i in NOTES:
            # The note sits on a halo in the background colour, so that a gridline does not run through it.
            note = (f'<text class="t mu" x="{X0 + tokens * SCALE + 12:.1f}" y="{y + 12}" font-size="11.5" stroke="{t["bg"]}" '
                    f'stroke-width="5" stroke-linejoin="round" paint-order="stroke">{kit.esc(NOTES[i])}</text>')
            st.add(st.show(a + 0.8, note, dx=6, dy=0))
    st.add(f'<text class="m mu" x="40" y="{H - 20}" font-size="10.5">dsk show 35d2 --log · the session that wrote the first assets/build.py</text>')
    return st.svg()
