"""What the README's images share: the two themes, the fonts, and a Stage that collects one image's markup and the
CSS of its animations.

GitHub shows an SVG in a README as an image: no scripts, no web fonts, no other files. So the images keep three rules.
- Every animation is CSS, and the frame at rest is the finished picture: an element that appears is visible when no
  animation runs, and an element that only passes through (a dot in flight, a spinner) carries opacity="0".
- An animation sits on a <g> that the Stage wraps around the markup, never on the element itself: a CSS transform
  replaces an element's own `transform` attribute, and a group keeps the classes of what is inside it apart.
- prefers-reduced-motion stops everything at the frame at rest.
"""
import html
import math

SANS = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
PITCH = 0.6  # a monospace character is pinned to this share of the font size, whatever font the viewer has
EASE = "cubic-bezier(.2,.8,.2,1)"  # a fast start and a soft landing
SPRING = "cubic-bezier(.3,1.5,.5,1)"  # a small overshoot, for things that pop

# Two identity colours: `cool` is the worker, `warm` is the lead. As marks they were checked as a pair against both
# surfaces of each theme (lightness band, chroma, colour-blind separation, 3:1 contrast). `ok` and `warn` are states
# and always come with a word or an icon. `gray` is the mark that steps back, at 3:1 on `bg`. `code` and `grad` are
# for text and for the wordmark, where the lighter steps read better on the dark theme.
THEMES = {
    "light": dict(bg="#ffffff", surface="#f6f7fb", line="#e4e6f0", line2="#c8ccdc", muted="#6a7088", text2="#434960",
                  ink="#0e1122", cool="#4f46e5", warm="#ea580c", ok="#15803d", warn="#b45309", gray="#8b91a8",
                  code="#4f46e5", grad=("#4f46e5", "#9333ea", "#f97316"), glow=(0.13, 0.10)),
    "dark": dict(bg="#0b0e18", surface="#141829", line="#262b45", line2="#3e4568", muted="#9097b6", text2="#c4c9de",
                 ink="#f3f4fc", cool="#6366f1", warm="#ea580c", ok="#4ade80", warn="#fbbf24", gray="#5b6386",
                 code="#a5b4fc", grad=("#818cf8", "#c084fc", "#fb923c"), glow=(0.22, 0.14)),
}
# The classes every image has: a font (`d` and `t` sans, `m` mono) and a fill by role.
FILLS = {"ink": "ink", "t2": "text2", "mu": "muted", "co": "cool", "wa": "warm", "ok": "ok", "wn": "warn",
         "cd": "code", "gr": "gray", "l2": "line2"}


def esc(s):
    """A text for an SVG text node, with quotes left alone."""
    return html.escape(s, quote=False)


def mono(x, y, s, size, cls, anchor="start"):
    """Monospace text pinned to PITCH per character, so that what is placed by counting characters lines up on any
    font. `cls` is its fill class."""
    length = len(s) * size * PITCH
    return (f'<text class="m {cls}" x="{x:g}" y="{y:g}" font-size="{size:g}" textLength="{length:g}" '
            f'text-anchor="{anchor}" xml:space="preserve">{esc(s)}</text>')


def check(cx, cy, r=7):
    """The path of a check mark that fits a ring of radius `r` around (cx, cy), and its length in px."""
    down, up = (0.33 * r, 0.34 * r), (0.60 * r, -0.70 * r)
    d = f"M{cx - 0.45 * r:.2f} {cy + 0.02 * r:.2f} l{down[0]:.2f} {down[1]:.2f} l{up[0]:.2f} {up[1]:.2f}"
    return d, math.hypot(*down) + math.hypot(*up)


class Stage:
    """One image while it is drawn: its size and theme, the markup so far, and the CSS of its animations. Every
    animation runs on one loop of `loop` seconds, so the whole picture starts over together."""

    def __init__(self, w, h, t, loop, label, glow=True):
        self.w, self.h, self.t, self.loop, self.label, self.glow = w, h, t, loop, label, glow
        self.body, self.css, self.extra_defs, self.count = [], [], [], 0

    def add(self, *markup):
        """Append markup to the picture."""
        self.body.extend(markup)

    def defs(self, *markup):
        """Append markup to the picture's <defs>."""
        self.extra_defs.extend(markup)

    def pct(self, seconds):
        """A time on the loop as a keyframe percentage."""
        return f"{min(max(seconds, 0), self.loop) / self.loop * 100:.2f}%"

    def wrap(self, kind, frames, css, inner, hidden=False):
        """`inner` in a <g> that runs the keyframes `frames`; `css` is the rest of the group's rule, with `{n}` for
        the animation's name. `kind` names the animation in a data-k attribute, for whoever inspects the SVG.
        `hidden` marks what only passes through: it does not show at rest."""
        self.count += 1
        name = f"a{self.count}"
        self.css.append(f"@keyframes {name}{{{frames}}}.{name}{{{css.format(n=name)}}}")
        return f'<g class="{name}" data-k="{kind}"' + (' opacity="0"' if hidden else "") + f">{inner}</g>"

    def stay(self, more=""):
        """The keyframes every appearing element ends with: it stays to the loop's end and fades out before the
        loop starts over. `more` is what else holds its final value there."""
        return (f"{self.pct(self.loop - 0.9)}{{opacity:1;{more}}}"
                f"{self.pct(self.loop - 0.4)},100%{{opacity:0;{more}}}")

    def show(self, at, inner, dur=0.4, dx=0, dy=6):
        """`inner` appears at `at` seconds: it fades in while it slides (dx, dy) px into place."""
        frames = (f"0%,{self.pct(at)}{{opacity:0;transform:translate({dx}px,{dy}px);animation-timing-function:{EASE}}}"
                  f"{self.pct(at + dur)}{{opacity:1;transform:none}}" + self.stay("transform:none"))
        return self.wrap("show", frames, f"animation:{{n}} {self.loop}s infinite", inner)

    def pop(self, at, inner, dur=0.45):
        """`inner` appears at `at` seconds: it grows from 40% of its size about its own centre, with a small overshoot."""
        frames = (f"0%,{self.pct(at)}{{opacity:0;transform:scale(.4);animation-timing-function:{SPRING}}}"
                  f"{self.pct(at + dur)}{{opacity:1;transform:none}}" + self.stay("transform:none"))
        return self.wrap("pop", frames, f"transform-box:fill-box;transform-origin:center;animation:{{n}} {self.loop}s infinite", inner)

    def grow(self, at, inner, dur=0.5):
        """`inner` appears at `at` seconds: it grows to the right from its own left edge, as a bar does."""
        frames = (f"0%,{self.pct(at)}{{opacity:0;transform:scaleX(0)}}"
                  f"{self.pct(at + 0.01)}{{opacity:1;transform:scaleX(0);animation-timing-function:{EASE}}}"
                  f"{self.pct(at + dur)}{{opacity:1;transform:none}}" + self.stay("transform:none"))
        return self.wrap("grow", frames, f"transform-box:fill-box;transform-origin:0 50%;animation:{{n}} {self.loop}s infinite", inner)

    def draw(self, at, length, inner, dur=0.5):
        """The strokes in `inner`, `length` px long, draw themselves at `at` seconds."""
        frames = (f"0%,{self.pct(at)}{{opacity:0;stroke-dashoffset:{length:.1f}}}"
                  f"{self.pct(at + 0.01)}{{opacity:1;stroke-dashoffset:{length:.1f};animation-timing-function:{EASE}}}"
                  f"{self.pct(at + dur)}{{opacity:1;stroke-dashoffset:0}}" + self.stay("stroke-dashoffset:0"))
        return self.wrap("draw", frames, f"stroke-dasharray:{length:.1f};animation:{{n}} {self.loop}s infinite", inner)

    def blink(self, a, b, inner, fade=0.2):
        """`inner` passes through: it shows only from `a` to `b` seconds, and not at rest."""
        frames = (f"0%,{self.pct(a)}{{opacity:0}}{self.pct(a + fade)}{{opacity:1}}"
                  f"{self.pct(b)}{{opacity:1}}{self.pct(b + fade)},100%{{opacity:0}}")
        return self.wrap("blink", frames, f"animation:{{n}} {self.loop}s infinite", inner, hidden=True)

    def travel(self, points, at, dur, inner, fade=0.12):
        """`inner`, drawn around the origin, passes through: from `at` it moves along the points for `dur` seconds,
        each stretch taking its share of the time by its length."""
        lengths = [math.dist(p, q) for p, q in zip(points, points[1:])]
        total, gone, frames = sum(lengths) or 1, 0.0, []
        (x0, y0), (xn, yn) = points[0], points[-1]
        frames.append(f"0%,{self.pct(at - fade)}{{opacity:0;transform:translate({x0:g}px,{y0:g}px)}}")
        frames.append(f"{self.pct(at)}{{opacity:1;transform:translate({x0:g}px,{y0:g}px)}}")
        for (x, y), length in zip(points[1:], lengths):
            gone += length
            frames.append(f"{self.pct(at + dur * gone / total)}{{opacity:1;transform:translate({x:g}px,{y:g}px)}}")
        frames.append(f"{self.pct(at + dur + fade)},100%{{opacity:0;transform:translate({xn:g}px,{yn:g}px)}}")
        return self.wrap("travel", "".join(frames), f"animation:{{n}} {self.loop}s linear infinite", inner, hidden=True)

    def type(self, at, dur, steps, cover):
        """`cover`, a shape in the background colour over a line of text, passes through: it hides the text until
        `at` seconds, uncovers it from the left in `steps` steps over `dur` seconds, and hides it again just before
        the loop starts over."""
        frames = (f"0%,{self.pct(at)}{{opacity:1;transform:scaleX(1);animation-timing-function:steps({steps})}}"
                  f"{self.pct(at + dur)}{{opacity:1;transform:scaleX(0);animation-timing-function:step-end}}"
                  f"{self.pct(at + dur + 0.01)}{{opacity:0;transform:scaleX(0);animation-timing-function:step-end}}"
                  f"{self.pct(self.loop - 0.9)}{{opacity:0;transform:scaleX(1);animation-timing-function:linear}}"
                  f"{self.pct(self.loop - 0.4)},100%{{opacity:1;transform:scaleX(1)}}")
        return self.wrap("type", frames, f"transform-box:fill-box;transform-origin:100% 50%;animation:{{n}} {self.loop}s infinite",
                         cover, hidden=True)

    def ambient(self, frames, dur, inner, css="", timing="ease-in-out", alternate=False, hidden=False):
        """`inner` in a <g> with an endless animation of its own period, such as a pulse or a spinner. `css` is
        anything else the group's rule needs, such as a transform-origin."""
        back = " alternate" if alternate else ""
        return self.wrap("ambient", frames, f"{css}animation:{{n}} {dur:g}s {timing} infinite{back}", inner, hidden)

    def svg(self):
        """The finished SVG document."""
        t, w, h = self.t, self.w, self.h
        card = f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="16"'
        defs = [f'<clipPath id="card">{card}/></clipPath>']
        back = [f'{card} fill="{t["bg"]}" stroke="{t["line"]}"/>']
        if self.glow:  # two soft lights behind everything, one in each identity colour, drifting slowly
            blobs = ""
            for name, role, opacity, cx, cy, r, dx, dy, dur in (("glow-cool", "cool", t["glow"][0], w - 180, 20, 330, -36, 14, 17),
                                                               ("glow-warm", "warm", t["glow"][1], 60, h + 10, 300, 30, -16, 21)):
                defs.append(f'<radialGradient id="{name}"><stop offset="0" stop-color="{t[role]}" stop-opacity="{opacity}"/>'
                            f'<stop offset="1" stop-color="{t[role]}" stop-opacity="0"/></radialGradient>')
                drift = f"0%{{transform:translate(0px,0px)}}100%{{transform:translate({dx}px,{dy}px)}}"
                blobs += self.ambient(drift, dur, f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#{name})"/>', alternate=True)
            back.append(f'<g clip-path="url(#card)">{blobs}</g>')
        fills = "".join(f".{cls}{{fill:{t[role]}}}" for cls, role in FILLS.items())
        style = (f".d,.t{{font-family:{SANS}}}.m{{font-family:{MONO}}}{fills}" + "".join(self.css)
                 + "@media (prefers-reduced-motion: reduce){*{animation:none!important}}")
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" '
                f'aria-label="{html.escape(self.label, quote=True)}">\n<style>{style}</style>\n'
                f'<defs>{"".join(defs + self.extra_defs)}</defs>\n' + "\n".join(back + self.body) + "\n</svg>\n")
