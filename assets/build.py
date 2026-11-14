"""Generate the README's images. `python3 assets/build.py` writes every SVG beside itself, in a light and a dark
theme; `python3 assets/build.py hero flow` writes only those.

Each image is a module with a `draw(t)` that returns the SVG for the theme `t`. kit.py has what the images share
and the rules they keep.

The approach (a stdlib generator, light and dark, animation without scripts) follows monotykamary/supercomputer's
assets/build.py.
"""
import importlib
import pathlib
import sys

import kit

IMAGES = ("hero", "run", "flow", "cache", "stats")


def main():
    """Write each named image, or all of them, in both themes, and print the names."""
    here = pathlib.Path(__file__).resolve().parent
    wrote = []
    for name in sys.argv[1:] or IMAGES:
        draw = importlib.import_module(name).draw
        for theme, t in kit.THEMES.items():
            (here / f"{name}-{theme}.svg").write_text(draw(t), encoding="utf-8")
            wrote.append(f"{name}-{theme}.svg")
    print("wrote", " ".join(wrote))


if __name__ == "__main__":
    main()
