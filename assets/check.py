"""Measure the README's images, so that nobody has to look at one to know that it is broken.

`python3 assets/check.py [NAME ...] [--dir DIR] [--expect kind=N,...] [--at T,T,...]`. With no NAME it checks every
NAME that has a NAME-light.svg and a NAME-dark.svg in DIR, which defaults to the folder this file is in.

For each image it reads the light and the dark file and prints a FAIL line for what is wrong with
- the document: the canvas size, the role and label, a script, SMIL, an external reference, a missing rule for
  reduced motion, a paint that is not a colour, light and dark files that differ in more than colours;
- the animation, by the rules of kit.py: an animation that is not on a group made by a Stage helper, a passing group
  that would show at rest, an appearing group that would be missing at rest;
- the layout: a text or a shape off the canvas, a text that leaves its card or crosses the edge of another one, two
  texts that overlap (at rest, or at a time when both show), a line through a text or through a card, cards that
  overlap in part.
Then it prints the timeline (every animated group, the second it starts, its kind, what it holds), the number of
groups of each kind, compared with --expect, and the image's verdict. `--at 2,7.5` adds the texts that are visible at
those seconds. The exit status is 1 when any image has a problem.

A text's width is its textLength, else 0.6 em per character in the monospace class `m`, else the sum of Helvetica's
advance widths with ROOM for the fonts of other readers. What is in flight (inside a travel group), in a clipPath or
in a mask is not measured.
"""
import pathlib
import re
import sys
import xml.dom.minidom as minidom

MARGIN = 12
ROOM = 1.15  # a sans text is measured this much wider than Helvetica sets it, because readers have other fonts
PASSING = ("blink", "travel", "type")  # kinds that only pass through: hidden at rest, so they carry opacity="0"

WIDTHS = {**dict.fromkeys(" !,./:;I[]\\ft·", 278), **dict.fromkeys("ijl", 222), "'": 191, '"': 355, "|": 260,
          **dict.fromkeys("()-`r", 333), "*": 389, **dict.fromkeys("cksvxyzJ", 500),
          **dict.fromkeys("abdeghnopqu0123456789#$L?_–", 556), **dict.fromkeys("+<=>~", 584), **dict.fromkeys("FTZ", 611),
          **dict.fromkeys("ABEKPSVXY&", 667), **dict.fromkeys("CDHNRUw", 722), **dict.fromkeys("GOQ", 778),
          **dict.fromkeys("Mm", 833), "%": 889, "W": 944, **dict.fromkeys("—→…", 1000), "@": 1015}


def num(el, name, default=0.0):
    """A numeric attribute, or the default when it is missing or not a number."""
    v = el.getAttribute(name)
    try:
        return float(v) if v else default
    except ValueError:
        return default


def inside(el, kinds):
    """Is the element inside an animated group of one of these kinds?"""
    p = el.parentNode
    while p is not None and p.nodeType == p.ELEMENT_NODE:
        if p.getAttribute("data-k") in kinds:
            return True
        p = p.parentNode
    return False


def under(el, tags):
    """Is the element inside an element with one of these tag names?"""
    p = el.parentNode
    while p is not None and p.nodeType == p.ELEMENT_NODE:
        if p.tagName in tags:
            return True
        p = p.parentNode
    return False


def hidden(el):
    """Is an ancestor group hidden at rest, with an opacity attribute of zero?"""
    p = el.parentNode
    while p is not None and p.nodeType == p.ELEMENT_NODE:
        if p.tagName == "g" and p.getAttribute("opacity") == "0":
            return True
        p = p.parentNode
    return False


def resting(el):
    """Is this element outside the clip paths and masks, and not hidden at rest?"""
    return not under(el, ("clipPath", "mask", "defs")) and not hidden(el)


def resting_and_still(el):
    """Is this element measured by the new checks: at rest, and not in a travelling group?"""
    return resting(el) and not inside(el, ("travel",))


def describe(g):
    """What an animated group holds: its first element, by tag, place and text."""
    for child in g.childNodes:
        if child.nodeType != child.ELEMENT_NODE:
            continue
        if child.tagName == "g":
            return "g > " + describe(child)
        if child.tagName == "text":
            return f'text "{text_value(child)[:34]}" at x={child.getAttribute("x")} y={child.getAttribute("y")}'
        where = " ".join(f"{k}={child.getAttribute(k)}" for k in ("x", "y", "cx", "cy", "r", "width", "height") if child.hasAttribute(k))
        extra = sum(1 for c in g.childNodes if c.nodeType == c.ELEMENT_NODE) - 1
        return f"{child.tagName} {where}" + (f" (+{extra} more)" if extra else "")
    return "(empty)"


def keyframes(text, name):
    """The body of one @keyframes rule, with balanced braces."""
    start = text.find("@keyframes " + name + "{")
    if start < 0:
        return ""
    start += len("@keyframes " + name + "{")
    depth, out = 0, []
    for ch in text[start:]:
        if ch == "{":
            depth += 1
        elif ch == "}":
            if depth == 0:
                break
            depth -= 1
        out.append(ch)
    return "".join(out)


def stylesheet(text):
    """The <style> parsed once per file: class name -> (loop seconds, [(percent, opacity), ...])."""
    style = re.search(r"<style>(.*?)</style>", text, re.S)
    sheet, css = style.group(1) if style else "", {}
    for rule in re.finditer(r"\.([\w-]+)\{([^}]*)\}", sheet):
        anim = re.search(r"animation:\s*([\w-]+)\s+([\d.]+)s", rule.group(2))
        if not anim:
            continue
        stops = []
        for frame in re.finditer(r"([\d.]+)%(?:,([\d.]+)%)?\{([^}]*)\}", keyframes(sheet, anim.group(1))):
            op = re.search(r"(?:^|;)opacity:([\d.]+)", frame.group(3).replace(" ", ""))
            if op:
                stops += [(float(p), float(op.group(1))) for p in frame.groups()[:2] if p is not None]
        css[rule.group(1)] = (float(anim.group(2)), sorted(stops))
    return css


def group_opacity(g, t, css):
    """The opacity an animated group's keyframes give at t seconds."""
    rule = next((css[cls] for cls in reversed(g.getAttribute("class").split()) if cls in css), None)
    if not rule or not rule[1]:
        return num(g, "opacity", 1.0)
    period, stops = rule
    pct = (t % period) / period * 100
    if pct <= stops[0][0]:
        return stops[0][1]
    for (p0, v0), (p1, v1) in zip(stops, stops[1:]):
        if pct <= p1:
            return v0 + (v1 - v0) * (pct - p0) / (p1 - p0)
    return stops[-1][1]


def text_opacity(el, t, css):
    """The product of the opacities keyframes give a text's ancestor groups at t seconds."""
    op, p = 1.0, el.parentNode
    while p is not None and p.nodeType == p.ELEMENT_NODE:
        if p.tagName == "g" and p.getAttribute("data-k") != "ambient":
            op *= group_opacity(p, t, css)
        p = p.parentNode
    return op


def text_value(el):
    """All character data below a text element."""
    return "".join(n.data for n in el.childNodes if n.nodeType == n.TEXT_NODE)


def inherited(el, name, default=""):
    """An attribute's value from the element or its nearest ancestor that has it."""
    p = el
    while p is not None and p.nodeType == p.ELEMENT_NODE:
        if p.hasAttribute(name):
            return p.getAttribute(name)
        p = p.parentNode
    return default


def text_width(el, s):
    """The width of a text by textLength, or by its class, characters and letter spacing."""
    if el.hasAttribute("textLength"):
        return num(el, "textLength")
    size = num(el, "font-size", 16)
    spacing = inherited(el, "letter-spacing", "")
    extra = 0.0
    if spacing.endswith("em"):
        extra = float(spacing[:-2]) * size * len(s)
    elif spacing.endswith("px"):
        extra = float(spacing[:-2]) * len(s)
    if "m" in el.getAttribute("class").split():
        return len(s) * size * 0.6 + extra
    width = sum(WIDTHS.get(ch, 556) for ch in s) * size / 1000
    weight = inherited(el, "font-weight", "")
    if weight in ("bold", "bolder") or (weight.isdigit() and int(weight) >= 600):
        width *= 1.06
    return width * ROOM + extra


def text_place(el):
    """(left, right, top, bottom) of a text's rectangle."""
    s = text_value(el)
    size = num(el, "font-size", 16)
    width = text_width(el, s)
    x, y = num(el, "x"), num(el, "y")
    anchor = inherited(el, "text-anchor", "start")
    left = x - width if anchor == "end" else x - width / 2 if anchor == "middle" else x
    return left, left + width, y - 0.8 * size, y + 0.25 * size


def holding_start(box, el):
    """Does a box hold the start point of a text?"""
    x, y = num(el, "x"), num(el, "y") - num(el, "font-size", 16) / 3
    return box["l"] <= x <= box["r"] and box["t"] <= y <= box["b"]


def path_segments(d):
    """The drawn segments of a path of M L H V l h v commands, or None for another command.

    An M starts a new stretch without drawing; a second coordinate pair after it is an L.
    """
    clean = re.sub(r"[eE][-+]?\d+", "", d)
    if any(c not in "MLHVmlhv" for c in re.findall(r"[A-Za-z]", clean)):
        return None
    tokens = re.findall(r"[MLHVmlhv]|[-+]?(?:\d*\.\d+|\d+\.?)", clean)
    out, cur, cmd, i = [], (0.0, 0.0), None, 0
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd, i = tokens[i], i + 1
            continue
        nums = []
        while i < len(tokens) and not tokens[i].isalpha():
            nums.append(float(tokens[i])); i += 1
        if cmd in ("M", "L", "m", "l"):
            for j in range(0, len(nums) - 1, 2):
                pt = (nums[j], nums[j + 1]) if cmd in ("M", "L") else (cur[0] + nums[j], cur[1] + nums[j + 1])
                if cmd in ("L", "l") or j > 0:  # the first pair after an M only moves
                    out.append((cur, pt))
                cur = pt
        else:
            for v in nums:
                pt = ((v, cur[1]) if cmd == "H" else (cur[0] + v, cur[1]) if cmd == "h" else
                      (cur[0], v) if cmd == "V" else (cur[0], cur[1] + v))
                out.append((cur, pt))
                cur = pt
    return out


def segments(doc):
    """The resting lines and simple fill=none paths, as point pairs."""
    out = []
    for el in doc.getElementsByTagName("line"):
        if resting_and_still(el):
            out.append(((num(el, "x1"), num(el, "y1")), (num(el, "x2"), num(el, "y2")), el))
    for el in doc.getElementsByTagName("path"):
        if not resting_and_still(el) or el.getAttribute("fill") != "none":
            continue
        for a, b in path_segments(el.getAttribute("d")) or []:
            out.append((a, b, el))
    return out


def segment_hits(seg, l, t, r, b):
    """Does this segment have a positive length inside a rectangle?"""
    (x1, y1), (x2, y2) = seg
    dx, dy = x2 - x1, y2 - y1
    lo, hi = 0.0, 1.0
    for p, q in ((-dx, x1 - l), (dx, r - x1), (-dy, y1 - t), (dy, b - y1)):
        if p == 0:
            if q < 0:
                return False
        else:
            u = q / p
            if p < 0:
                lo = max(lo, u)
            else:
                hi = min(hi, u)
            if lo > hi:
                return False
    return lo < hi


def overlap(a, b, amount=0.0):
    """Do these rectangles intersect by more than amount in both directions?"""
    return min(a["r"], b["r"]) - max(a["l"], b["l"]) > amount and min(a["b"], b["b"]) - max(a["t"], b["t"]) > amount


def held_by(outer, inner):
    """Does outer hold inner, allowing a pixel of slack?"""
    return outer["l"] <= inner["l"] + 1 and outer["t"] <= inner["t"] + 1 and outer["r"] >= inner["r"] - 1 and outer["b"] >= inner["b"] - 1


def box_text(box):
    """Where to call a box in a FAIL line."""
    return f"x={box['l']:g} y={box['t']:g}"


def box_size(box):
    """The size of a box, for a FAIL line."""
    return f"width={box['w']:g} height={box['h']:g}"


def measured_texts(doc):
    """Every text the new checks measure: all but those in flight or inside a clipPath, mask or defs."""
    out = []
    for el in doc.getElementsByTagName("text"):
        if under(el, ("clipPath", "mask", "defs")) or inside(el, ("travel",)):
            continue
        l, r, t, b = text_place(el)
        out.append({"el": el, "s": text_value(el), "l": l, "r": r, "t": t, "b": b, "rest": not hidden(el)})
    return out


def outside_its_box(texts, boxes):
    """Check 1: a text stays inside the smallest box that holds its start point."""
    bad = []
    for tx in texts:
        box = smallest_holding(boxes, tx["el"])
        if box and (tx["l"] < box["l"] + 6 or tx["r"] > box["r"] - 6 or tx["t"] < box["t"] + 3 or tx["b"] > box["b"] - 3):
            bad.append(f"text {tx['s']!r} spans x {tx['l']:g}..{tx['r']:g} y {tx['t']:g}..{tx['b']:g}, outside its box x {box['l']:g}..{box['r']:g} y {box['t']:g}..{box['b']:g}")
    return bad


def across_a_box_edge(texts, boxes):
    """Check 2: a text stays off the edge of every box that does not hold its start point."""
    bad, seen = [], set()
    for tx in texts:
        for box in boxes:
            if holding_start(box, tx["el"]) or not overlap(tx, box):
                continue
            if (id(tx["el"]), id(box["el"])) not in seen:
                seen.add((id(tx["el"]), id(box["el"])))
                bad.append(f"text {tx['s']!r} crosses the edge of the box at {box_text(box)}")
    return bad


def sample_times(loop):
    """The times at which two texts are compared: 0, 0.1, 0.2 ... up to one loop."""
    return [k * 0.1 for k in range(round(loop * 10) + 1)]


def texts_over_each_other(texts, css):
    """Check 3: two texts never overlap, at rest or at a sampled time when both are shown."""
    bad = []
    times = sample_times(max([period for period, _ in css.values()] or [17.0]))
    for i, a in enumerate(texts):
        for b in texts[i + 1:]:
            if not overlap(a, b, 1):
                continue
            if a["rest"] and b["rest"]:
                bad.append(f"texts {a['s']!r} and {b['s']!r} overlap at rest")
                continue
            shown = next((t for t in times if text_opacity(a["el"], t, css) >= 0.7 and text_opacity(b["el"], t, css) >= 0.7), None)
            if shown is not None:
                bad.append(f"texts {a['s']!r} and {b['s']!r} overlap at t={shown:.1f}s")
    return bad


def lines_through_texts(texts, segs):
    """Check 4: no resting line or path crosses a text that has no paint-order."""
    bad = []
    for tx in texts:
        if tx["el"].hasAttribute("paint-order"):
            continue
        inner = (tx["l"] + 1, tx["t"] + 1, tx["r"] - 1, tx["b"] - 1)
        if any(segment_hits((p1, p2), *inner) for (p1, p2, _) in segs):
            bad.append(f"a line crosses the text {tx['s']!r}")
    return bad


def text_checks(doc, css):
    """Checks 1 to 4: texts in their boxes, off other boxes' edges, off each other and off lines."""
    texts, boxes = measured_texts(doc), boxes_of(doc)
    return (outside_its_box(texts, boxes) + across_a_box_edge(texts, boxes)
            + texts_over_each_other(texts, css) + lines_through_texts(texts, segments(doc)))


def boxes_of(doc):
    """The resting rect boxes of a document."""
    out = []
    for el in doc.getElementsByTagName("rect"):
        if not resting_and_still(el):
            continue
        rw, rh = num(el, "width"), num(el, "height")
        if num(el, "rx") < 6 or rw < 60 or rh < 24:
            continue
        x, y = num(el, "x"), num(el, "y")
        out.append({"el": el, "l": x, "t": y, "r": x + rw, "b": y + rh, "x": x, "y": y, "w": rw, "h": rh})
    return out


def smallest_holding(boxes, el):
    """The smallest box whose inside holds the start point of a text."""
    holding = [b for b in boxes if holding_start(b, el)]
    return min(holding, key=lambda b: (b["r"] - b["l"]) * (b["b"] - b["t"])) if holding else None


def beyond(box, p):
    """Is this point outside the box grown by the one pixel of slack a line gets?"""
    return not (box["l"] - 1 <= p[0] <= box["r"] + 1 and box["t"] - 1 <= p[1] <= box["b"] + 1)


def line_and_box_checks(doc):
    """Checks 5 and 6: lines through boxes, and boxes that overlap in part."""
    bad, boxes = [], boxes_of(doc)
    seen = set()
    for (p1, p2, el) in segments(doc):
        for box in boxes:
            if not segment_hits((p1, p2), box["l"] + 2, box["t"] + 2, box["r"] - 2, box["b"] - 2):
                continue
            if beyond(box, p1) or beyond(box, p2):
                key = (id(box["el"]), id(el))
                if key not in seen:
                    seen.add(key)
                    bad.append(f"a line crosses the box at {box_text(box)}")
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            if overlap(a, b, 1) and not held_by(a, b) and not held_by(b, a):
                bad.append(f"boxes at {box_text(a)} ({box_size(a)}) and {box_text(b)} ({box_size(b)}) overlap in part")
    return bad


def circle_problems(doc, w, h):
    """Circles that leave the canvas, by their centre and radius."""
    bad = []
    for el in doc.getElementsByTagName("circle"):
        if under(el, ("clipPath", "mask")) or inside(el, ("ambient", "travel")):
            continue
        cx, cy, r = num(el, "cx"), num(el, "cy"), num(el, "r")
        if cx - r < 0 or cy - r < 0 or cx + r > w or cy + r > h:
            bad.append(f"circle cx={cx:g} cy={cy:g} r={r:g} leaves the {w:g}x{h:g} canvas")
    return bad


def colour_problems(doc):
    """Paints that are not a colour: a theme key written where its value was meant draws black, in both themes."""
    bad = []
    for el in doc.getElementsByTagName("*"):
        for name in ("fill", "stroke", "stop-color"):
            value = el.getAttribute(name)
            if value and not re.fullmatch(r"none|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|url\(#[\w-]+\)", value):
                bad.append(f'{name}="{value}" on a <{el.tagName}> is not a colour: take it from the theme, as in t["warn"]')
    return bad


def visible_texts(doc, css, t):
    """The texts of the light image whose opacity at t is at least one half, in document order."""
    return [text_value(el) for el in doc.getElementsByTagName("text")
            if not under(el, ("clipPath", "mask")) and not inside(el, ("travel",)) and text_opacity(el, t, css) >= 0.5]


def timeline(doc, text):
    """(start second, kind, period or loop, description) for each animated group."""
    style = re.search(r"<style>(.*?)</style>", text, re.S).group(1)
    out = []
    for g in doc.getElementsByTagName("g"):
        kind = g.getAttribute("data-k")
        if not kind:
            continue
        name = g.getAttribute("class").split()[-1]
        rule = re.search(r"\." + name + r"\{([^}]*)\}", style)
        frames = re.search(r"@keyframes " + name + r"\{(.*?)\}\." + name + r"\{", style, re.S)
        if not rule or not frames:
            out.append((-1.0, kind, 0.0, f"NO CSS RULE for class {name}: " + describe(g)))
            continue
        period = float(re.search(r"animation:" + name + r" ([\d.]+)s", rule.group(1)).group(1))
        first = re.match(r"0%,([\d.]+)%", frames.group(1))
        start = float(first.group(1)) / 100 * period if first and kind != "ambient" else 0.0
        if kind == "travel":  # its first keyframe ends one fade before it starts to move
            second = re.match(r"0%,[\d.]+%\{[^}]*\}([\d.]+)%", frames.group(1))
            start = float(second.group(1)) / 100 * period if second else start
        out.append((start, kind, period, describe(g)))
    return out


def check(path):
    """(problems, timeline) of one file."""
    bad, text = [], path.read_text()
    doc, css = minidom.parseString(text), stylesheet(text)
    root = doc.documentElement
    w, h = num(root, "width"), num(root, "height")
    if w != 880:
        bad.append(f"root width is {w}, want 880")
    if root.getAttribute("viewBox") != f"0 0 {w:g} {h:g}":
        bad.append(f"viewBox is {root.getAttribute('viewBox')!r}, want '0 0 {w:g} {h:g}'")
    if root.getAttribute("role") != "img" or not root.getAttribute("aria-label"):
        bad.append('root needs role="img" and an aria-label')
    if doc.getElementsByTagName("script"):
        bad.append("a <script> element: GitHub will not run it")
    for tag in ("animate", "animateMotion", "animateTransform", "set"):
        if doc.getElementsByTagName(tag):
            bad.append(f"a <{tag}> element: every animation is CSS here, through kit.Stage")
    if "prefers-reduced-motion" not in text:
        bad.append("no prefers-reduced-motion rule in <style>")
    if re.search(r'(href|src)="https?:', text) or "@import" in text or "url(http" in text:
        bad.append("an external reference: an SVG shown as an image cannot load it")
    for el in doc.getElementsByTagName("text"):
        if el.parentNode.nodeName == "clipPath":
            continue
        s, y, size = text_value(el), num(el, "y"), num(el, "font-size", 16)
        left, right = text_place(el)[:2]
        if left < MARGIN or right > w - MARGIN:
            bad.append(f"text {s[:40]!r} spans x {left:.0f}..{right:.0f}, outside {MARGIN}..{w - MARGIN:.0f}")
        if y < size * 0.8 or y > h - 6:
            bad.append(f"text {s[:40]!r} has baseline y={y:.0f}, outside the canvas of height {h:.0f}")
    for el in doc.getElementsByTagName("rect"):
        if el.parentNode.nodeName in ("clipPath", "mask") or inside(el, ("ambient", "travel")):  # a travelling mark is drawn around the origin
            continue
        x, y, rw, rh = num(el, "x"), num(el, "y"), num(el, "width"), num(el, "height")
        if x < 0 or y < 0 or x + rw > w or y + rh > h:
            bad.append(f"rect x={x:g} y={y:g} width={rw:g} height={rh:g} leaves the {w:g}x{h:g} canvas")
    bad.extend(circle_problems(doc, w, h))
    bad.extend(text_checks(doc, css))
    bad.extend(line_and_box_checks(doc))
    for g in doc.getElementsByTagName("g"):
        kind = g.getAttribute("data-k")
        if kind in PASSING and g.getAttribute("opacity") != "0":
            bad.append(f'a {kind} group without opacity="0": it would show at rest ({describe(g)})')
        if kind and kind not in PASSING and kind != "ambient" and g.getAttribute("opacity") == "0":
            bad.append(f'a {kind} group with opacity="0": it would be missing at rest ({describe(g)})')
        if kind and g.hasAttribute("transform"):
            bad.append(f"an animated group with a transform attribute: CSS replaces it ({describe(g)})")
    for el in doc.getElementsByTagName("*"):
        cls = el.getAttribute("class")
        if el.tagName != "g" and re.search(r"\ba\d+\b", cls or ""):
            bad.append(f"an animation class on a <{el.tagName}>: wrap the element with a kit.Stage helper instead")
    bad.extend(colour_problems(doc))
    return bad, timeline(doc, text)


def shape(path):
    """The file's elements and geometry, without colours: the light and dark files must agree on it."""
    doc = minidom.parseString(path.read_text())
    return [(el.nodeName, tuple((k, el.getAttribute(k)) for k in ("x", "y", "width", "height", "cx", "cy", "r", "d", "font-size", "data-k")
                                if el.hasAttribute(k))) for el in doc.getElementsByTagName("*")]


def parse_args(args):
    """Names, directory, expected counts and times from the command line."""
    names, folder, expect, at, i = [], pathlib.Path(__file__).resolve().parent, {}, [], 0
    while i < len(args):
        a = args[i]
        if a in ("--dir", "--expect", "--at"):
            if i + 1 >= len(args):
                raise SystemExit(f"{a} needs a value")
            if a == "--dir":
                folder = pathlib.Path(args[i + 1])
            elif a == "--at":
                at = [float(x) for x in args[i + 1].split(",") if x.strip()]
            else:
                expect = {k: int(v) for k, v in (pair.split("=") for pair in args[i + 1].split(",") if pair)}
            i += 2
        else:
            names.append(a)
            i += 1
    if not names:
        names = sorted(p.name[:-len("-light.svg")] for p in folder.glob("*-light.svg") if (folder / (p.name[:-len("-light.svg")] + "-dark.svg")).exists())
    return names, folder, expect, at


def check_image(name, folder, expect, at):
    """Check one image: print its FAIL lines, timeline, counts and verdict; return its number of problems."""
    problems, light, dark = 0, folder / f"{name}-light.svg", folder / f"{name}-dark.svg"
    lines = {}
    for path in (light, dark):
        if not path.exists():
            print(f"FAIL {path.name}: missing (run python3 assets/build.py {name})")
            problems += 1
            lines[path.name] = []
            continue
        try:
            bad, lines[path.name] = check(path)
        except Exception as e:  # not well-formed XML, or CSS this script cannot read
            bad, lines[path.name] = [f"cannot be read: {type(e).__name__}: {e}"], []
        for b in bad:
            print(f"FAIL {path.name}: {b}")
        problems += len(bad)
    if light.exists() and dark.exists():
        try:
            if shape(light) != shape(dark):
                print("FAIL: the light and dark files differ in more than colours")
                problems += 1
        except Exception as e:
            print(f"FAIL: cannot compare {light.name} and {dark.name}: {type(e).__name__}: {e}")
            problems += 1
    tl = sorted(lines.get(light.name, []), key=lambda r: (r[0], r[1]))
    print(f"timeline of {light.name} ({len(tl)} animated groups):")
    for start, kind, period, what in tl:
        when = f"every {period:g}s" if kind == "ambient" else f"{start:6.2f}s"
        print(f"  {when:>10}  {kind:<7} {what}")
        if start < 0:
            problems += 1
    counts = {}
    for _, kind, _, _ in tl:
        counts[kind] = counts.get(kind, 0) + 1
    print("counts: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    for kind, want in expect.items():
        if counts.get(kind, 0) != want:
            print(f"FAIL: {counts.get(kind, 0)} {kind} groups, the plan has {want}")
            problems += 1
    if at and light.exists():
        text = light.read_text()
        doc, css = minidom.parseString(text), stylesheet(text)
        for t in at:
            print(f"visible at {t:g}s: " + " | ".join(repr(s) for s in visible_texts(doc, css, t)))
    print(f"{name}: " + ("OK" if not problems else f"{problems} problem(s)"))
    return problems


def main():
    """Check the named or every light/dark pair, print their timelines and verdicts; 1 on a problem."""
    names, folder, expect, at = parse_args(sys.argv[1:])
    failed = sum(check_image(name, folder, expect, at) for name in names)
    print("OK" if not failed else f"{failed} problem(s)")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
