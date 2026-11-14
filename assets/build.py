"""Generate the README's six SVG images: hero, flow and run, each in a light and a dark theme.

Run `python3 assets/build.py` from anywhere; it writes the six files beside itself and prints their names.
GitHub shows an SVG in a README as an image, so the files carry no scripts, no web fonts and no external files:
they animate with CSS keyframes in their own <style>, or with SMIL.
The resting state is the final frame: with every animation removed an image shows all of its content, so a CSS
animation only hides a thing for the first part of its loop. Only the moving dots of the flow image have opacity="0"
as an attribute, so that they stay hidden where SMIL does not run.
The light and the dark file of an image differ in colours only.

The approach (a stdlib generator, light and dark, CSS and SMIL only) follows monotykamary/supercomputer's assets/build.py.
"""
import html
import pathlib
import textwrap

THEMES = {
    "light": dict(bg="#ffffff", surface="#f4f5f5", line="#e1e4e4", line2="#c2c8c8", muted="#6f7878", text2="#475050",
                  ink="#0a0f0f", accent="#0f766e", accent_soft="#dcf1ee", warn="#9a5b00"),
    "dark": dict(bg="#0b0f0f", surface="#161c1c", line="#283030", line2="#465050", muted="#94a0a0", text2="#c0caca",
                 ink="#f4f7f7", accent="#2dd4bf", accent_soft="#0d2a27", warn="#e0a64a"),
}
SANS = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"

CLASSES = (
    f".d{{font-family:{SANS}}}.t{{font-family:{SANS}}}.m{{font-family:{MONO}}}"
    ".ink{fill:ink}.t2{fill:text2}.mu{fill:muted}.ac{fill:accent}.wa{fill:warn}"
)
REDUCED = "@media (prefers-reduced-motion: reduce){*{animation:none!important}}"


def esc(s):
    """Escape a text for an SVG text node, leaving quotes alone."""
    return html.escape(s, quote=False)


def svg(w, h, t, body, css, label):
    """Build one SVG document: root element, style, background and body."""
    classes = CLASSES
    for name in ("ink", "text2", "muted", "accent", "warn"):
        classes = classes.replace("fill:" + name, "fill:" + t[name])
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        f'role="img" aria-label="{html.escape(label, quote=True)}">\n'
        f"<style>{classes}{css}{REDUCED}</style>\n"
        f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="14" fill="{t["bg"]}" stroke="{t["line"]}"/>\n'
        f"{body}</svg>\n"
    )


JOBS = [
    (0, "7f3a", 3, "review", "ac", 7.0),
    (1, "c41e", 4, "accepted", "ac", 8.5),
    (2, "90bd", 2, "done", "mu", 6.0),
    (3, "2a6f", 5, "review", "ac", 9.0),
    (4, "e803", 3, "question", "wa", 7.5),
    (5, "51d7", 6, "review", "ac", 10.0),
]


def card(t, L, jid, turns, status, sclass, dur):
    """One job card of the hero: its frame, id, turn squares and status, with their keyframes."""
    x = 40 + (L % 3) * 272
    y = 214 if L < 3 else 266
    body = [f'<rect x="{x + .5}" y="{y + .5}" width="255" height="39" rx="7" fill="{t["surface"]}" stroke="{t["line"]}"/>',
            f'<text class="m t2" x="{x + 14}" y="{y + 25}" font-size="12.5">{jid}</text>']
    css = []
    for i in range(turns):
        sx = x + 62 + i * 17
        body.append(f'<rect x="{sx}" y="{y + 14}" width="12" height="12" rx="3" fill="{t["line"]}"/>')
        body.append(f'<rect class="q{L}_{i}" x="{sx}" y="{y + 14}" width="12" height="12" rx="3" fill="{t["accent"]}"/>')
        p = 10 + i * 60 / turns
        css.append(f"@keyframes q{L}_{i}{{0%,{p:g}%{{opacity:0}}{p + .1:g}%,100%{{opacity:1}}}}"
                   f".q{L}_{i}{{animation:q{L}_{i} {dur:g}s infinite}}")
    body.append(f'<text class="m {sclass} st{L}" x="{x + 242}" y="{y + 25}" text-anchor="end" font-size="11.5">{status}</text>')
    css.append(f"@keyframes st{L}{{0%,75%{{opacity:0}}75.1%,100%{{opacity:1}}}}.st{L}{{animation:st{L} {dur:g}s infinite}}")
    return "\n".join(body), "".join(css)


def hero(t):
    """The hero image: what dsk is, and six job cards whose turn squares light up one by one."""
    body = [
        f'<circle class="pulse" cx="44" cy="45" r="4" fill="{t["accent"]}"/>',
        '<text class="m mu" x="56" y="49.5" font-size="13" letter-spacing=".02em">Claude Code · DeepSeek V4.1 Flash</text>',
        '<text class="d ink" x="38" y="112" font-size="56" font-weight="650" letter-spacing="-.025em">dsk</text>',
        '<text class="t t2" x="40" y="148" font-size="18">Claude Code plans, reviews and decides. A DeepSeek worker scouts the code</text>',
        '<text class="t t2" x="40" y="173" font-size="18">and writes it: one Python script per turn, about three turns per task.</text>',
        '<text class="m mu" x="40" y="200" font-size="11.5" letter-spacing=".04em">THE WORKERS · ONE SCRIPT PER TURN</text>',
        '<text class="m mu" x="840" y="200" text-anchor="end" font-size="11.5" letter-spacing=".04em">a square lit = a turn</text>',
    ]
    css = ["@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}.pulse{animation:pulse 2.4s ease-in-out infinite}"]
    for job in JOBS:
        b, c = card(t, *job)
        body.append(b)
        css.append(c)
    return svg(880, 330, t, "\n".join(body), "".join(css),
               "dsk: Claude Code plans, reviews and decides; a DeepSeek worker scouts the code and writes it")


BOXES = [
    (30, 140, 170, 80, "Claude Code", ["plans · briefs", "reviews · decides"], False),
    (262, 110, 200, 140, "dsk", ["one Python file", "runs each script", "scope gate · checks", "review gate"], True),
    (560, 34, 290, 92, "DeepSeek worker", ["the first provider in the route", "one run_code script per turn"], False),
    (560, 144, 290, 84, "next provider", ["after a 402, used-up retries", "or a worker stuck in a loop"], False),
    (560, 250, 290, 80, "your repository", ["only --allow paths change", "the rest is undone"], False),
]

PATHS = [
    ("p-brief", "M200 180 L262 180", "accent", None, 2, 2.4),
    ("p-worker", "M462 150 C512 150 512 80 560 80", "accent", None, 3, 2.0),
    ("p-next", "M462 181 L560 181", "line2", "4 5", 1, 9.0),
    ("p-repo", "M462 212 C512 212 512 290 560 290", "accent", None, 2, 2.6),
]


def box(t, x, y, w, h, title, subs, strong=False):
    """One labelled box of the flow diagram."""
    if strong:
        frame = f'fill="{t["accent_soft"]}" stroke="{t["accent"]}" stroke-width="1.5"'
    else:
        frame = f'fill="{t["surface"]}" stroke="{t["line"]}"'
    out = [f'<rect x="{x + .5}" y="{y + .5}" width="{w}" height="{h}" rx="10" {frame}/>',
           f'<text class="d ink" x="{x + 16}" y="{y + 28}" font-size="17" font-weight="600">{esc(title)}</text>']
    for i, s in enumerate(subs):
        out.append(f'<text class="m mu" x="{x + 16}" y="{y + 49 + i * 17}" font-size="11.5">{esc(s)}</text>')
    return "\n".join(out)


def flow(t):
    """The flow image: Claude Code briefs dsk, dsk drives a worker with failover, the repository is scoped."""
    body = []
    for pid, d, colour, dash, n, dur in PATHS:
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        body.append(f'<path id="{pid}" d="{d}" fill="none" stroke="{t[colour]}" stroke-width="1.5"{dash_attr}/>')
    for b in BOXES:
        body.append(box(t, *b))
    body.append('<text class="m mu" x="231" y="170" text-anchor="middle" font-size="10.5">brief</text>')
    body.append('<text class="m mu" x="30" y="268" font-size="11.5">the report comes back:</text>')
    body.append('<text class="m mu" x="30" y="285" font-size="11.5">dsk accept · dsk reject</text>')
    for pid, d, colour, dash, n, dur in PATHS:
        for k in range(n):
            begin = -k * dur / n
            if pid == "p-next":
                inner = (f'<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.62;.66;.95;1" '
                         f'dur="{dur:g}s" begin="{begin:g}s" repeatCount="indefinite"/>')
            else:
                inner = '<set attributeName="opacity" to="1" begin="0s"/>'
            dot = t["muted"] if pid == "p-next" else t[colour]  # the dashed path is faint; its dot must still be seen
            body.append(f'<circle r="3.6" fill="{dot}" opacity="0">{inner}'
                        f'<animateMotion dur="{dur:g}s" begin="{begin:g}s" repeatCount="indefinite">'
                        f'<mpath href="#{pid}"/></animateMotion></circle>')
    return svg(880, 360, t, "\n".join(body), "",
               "Claude Code sends a brief to dsk; dsk talks to a DeepSeek worker, fails over to the next provider, "
               "and lets each script change only the allowed paths of your repository")


STYLE_CLASS = {"ink": "ink", "ok": "ac", "mu": "mu", "": "t2"}


def terminal(t, cmd, out):
    """The run image: a terminal that types the command, then prints the run's output line by line."""
    top, rh, cw = 74, 22, 8.4
    rows = []  # (style, text, x): a wrapped row starts nine columns in, under the text that follows the label
    for style, text in out:
        parts = textwrap.wrap(text, 92, subsequent_indent=" " * 9, break_long_words=False, break_on_hyphens=False)
        rows.append((style, parts[0], 28))
        # The indent is an x offset and not nine spaces, because some renderers drop the spaces that open a text.
        rows.extend((style, part[9:], 28 + 9 * cw) for part in parts[1:])
    h = top + len(rows) * rh + 40
    typed = len(cmd) * cw
    body = [
        f'<rect x="0.5" y="0.5" width="879" height="38" rx="14" fill="{t["surface"]}"/>',
        f'<rect x="0.5" y="24" width="879" height="15" fill="{t["surface"]}"/>',
        f'<line x1="0" y1="38.5" x2="880" y2="38.5" stroke="{t["line"]}"/>',
    ]
    for cx in (24, 42, 60):
        body.append(f'<circle cx="{cx}" cy="19.5" r="5" fill="{t["line2"]}"/>')
    body.append('<text class="m mu" x="440" y="24" text-anchor="middle" font-size="12">~/my-repo</text>')
    body.append(f'<text class="m ac" x="28" y="{top}" font-size="14">$</text>')
    # textLength pins every row to cw per character, whatever monospace font the viewer has: the cover, the caret
    # and the indent of wrapped rows are placed by that width.
    body.append(f'<text class="m ink" x="46" y="{top}" font-size="14" textLength="{typed:g}" xml:space="preserve">{esc(cmd)}</text>')
    # The command is typed by a cover in the background colour that shrinks to its right edge, a character a step.
    # At rest the cover has no width: by the attribute where CSS transforms are not applied, by the rule elsewhere.
    body.append(f'<rect class="cover" x="46" y="{top - 16}" width="{typed:g}" height="22" fill="{t["bg"]}" transform="scale(0 1)"/>')
    body.append(f'<g class="caret"><rect class="cur" x="{46 + len(cmd) * cw + 3:g}" y="{top - 13}" width="8" height="16" fill="{t["accent"]}"/></g>')
    css = [f"@keyframes cover{{0%{{transform:scaleX(1)}}21.7%,100%{{transform:scaleX(0)}}}}"
           f".cover{{transform:scaleX(0);transform-box:fill-box;transform-origin:100% 50%;animation:cover 12s steps({len(cmd)}) infinite}}",
           "@keyframes blink{50%{opacity:0}}.cur{animation:blink 1s steps(1) infinite}",
           f"@keyframes caret{{0%{{transform:translateX(-{typed:g}px)}}21.7%,100%{{transform:translateX(0)}}}}"
           f".caret{{animation:caret 12s steps({len(cmd)}) infinite}}"]
    for i, (style, text, x) in enumerate(rows):
        a = 3.1 if i == 0 else 5.2 + (i - 1) * 0.35
        p = a / 12 * 100
        css.append(f"@keyframes l{i}{{0%,{p:g}%{{opacity:0}}{p + .1:g}%,96%{{opacity:1}}100%{{opacity:0}}}}.l{i}{{animation:l{i} 12s infinite}}")
        body.append(f'<text class="m {STYLE_CLASS[style]} l{i}" x="{x:g}" y="{top + (i + 1) * rh}" font-size="14" '
                    f'textLength="{len(text) * cw:g}" xml:space="preserve">{esc(text)}</text>')
    return svg(880, h, t, "\n".join(body), "".join(css), "a terminal running: " + cmd)


# The terminal shows a real run's output, verbatim: a repository with one 24-line module (2026-11-14, dsk 0.6.1).
RUN_CMD = "dsk run --allow 'test_*.py' --check 'python3 -m unittest' \"Add unit tests for durations.py\""
RUN_OUT = [
    ("mu", "dsk 054a · running · coralbricks"),
    ("ink", "dsk 054a · review · thirdparty after coralbricks · 4 turns · in 7.7k (78% cached) · out 1.1k"),
    ("", "summary: Added test_durations.py with 12 unittest cases covering parse_duration (single/compound units, whitespace and case, zero, repeated units, invalid inputs), format_duration (zero, single/compound, skipped units, negative) and a format/parse round trip. Ran `python3 -m unittest`: all 12 tests pass."),
    ("ok", "checks:  python3 -m unittest → 0"),
    ("", "changed: test_durations.py (+70)"),
    ("", "cache:   low (62% cached after turn 3)"),
    ("", "context: 3.1k of 24.0k"),
    ("mu", "next:    dsk show 054a --review | dsk accept 054a | dsk reject 054a \"defects\""),
]


def main():
    """Write the six SVGs beside this file and print their names."""
    here = pathlib.Path(__file__).resolve().parent
    names = []
    for kind, draw in (("hero", hero), ("flow", flow), ("run", lambda t: terminal(t, RUN_CMD, RUN_OUT))):
        for theme, t in THEMES.items():
            name = f"{kind}-{theme}.svg"
            (here / name).write_text(draw(t), encoding="utf-8")
            names.append(name)
    print("wrote", " ".join(names))


if __name__ == "__main__":
    main()
