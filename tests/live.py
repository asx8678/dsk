#!/usr/bin/env python3
"""Live acceptance runs for dsk: real toy tasks against the real providers.

    python3 tests/live.py                      three tasks, three runs each, on every profile in the route
    python3 tests/live.py --profile official --runs 4 --table
    python3 tests/live.py --task all           also the two tasks that stress quoting and backslashes

It uses your config and the keys in your environment, and costs a few cents. Each run gets a throwaway
repository and the sessions go to a temp state directory, so nothing is left behind. Every run carries a unique
token in its attached file and its brief: without it, identical runs would hit each other's cache entries and
the cached share would look better than a real task's.
Targets: a median of 6 turns or fewer, a cached share of 0.9 from turn 3 on, failed turns under 3%.
"""
import argparse, concurrent.futures, json, os, secrets, shutil, statistics, subprocess, sys, tempfile, time

DSK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skill", "scripts", "dsk.py")
IGNORE = "__pycache__/\n*.pyc\n"
DURATIONS = '''import re

_UNITS = {"h": 3600, "m": 60, "s": 1}


def parse_duration(text):
    """Turn '1h30m', '45s' or '2h' into seconds. Raise ValueError for anything else."""
    if not isinstance(text, str) or not text:
        raise ValueError("empty duration")
    parts = re.findall(r"(\\d+)([hms])", text)
    if "".join(n + u for n, u in parts) != text:
        raise ValueError(f"bad duration: {text!r}")
    return sum(int(n) * _UNITS[u] for n, u in parts)


def format_duration(seconds):
    """Inverse of parse_duration for non-negative ints: 5400 -> '1h30m', 0 -> '0s'."""
    if seconds < 0:
        raise ValueError("negative duration")
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    out = "".join(f"{v}{u}" for v, u in ((h, "h"), (m, "m"), (s, "s")) if v)
    return out or "0s"
'''
TEXT = '''def split_lines(text):
    """Split on newline characters; a trailing newline does not add an empty item."""
    return text.split("\\n")[:-1] if text.endswith("\\n") else text.split("\\n")


def show_tabs(text):
    """Make tabs visible: each tab character becomes the two characters backslash and t."""
    return text.replace("\\t", "\\\\t")
'''
CHECK_EDIT = '''import importlib, pathlib, sys
sys.path.insert(0, ".")
settings = importlib.import_module("pkg.settings")
assert hasattr(settings, "load_config") and not hasattr(settings, "get_cfg"), "settings.py not renamed"
for n in range(9):
    assert importlib.import_module(f"pkg.mod_{n}").run() == f"mod_{n}:prod", n
left = [p.name for p in pathlib.Path("pkg").glob("*.py") if "get_cfg" in p.read_text()]
assert not left, f"get_cfg still in {left}"
print("ok")
'''
CHECK_GUIDE = '''import pathlib
text = pathlib.Path("docs/guide.md").read_text()
need = ["```python", "C:\\\\temp\\\\new", '"""', "parse_duration"]
missing = [n for n in need if n not in text]
assert not missing, f"missing from docs/guide.md: {missing}"
assert 15 <= len(text.splitlines()) <= 90, len(text.splitlines())
print("ok")
'''


def module_repo(module, source, extra=()):
    facts = (f"# Project\nLayout: {module} is the only module; tests live in tests/.\n"
             "Run tests: python3 -m unittest discover -s tests\nStyle: stdlib unittest only.\n")
    return {module: source, ".gitignore": IGNORE, "tests/.keep": "", "DSK.md": facts, **dict(extra)}


def edit_repo():
    files = {".gitignore": IGNORE, "check.py": CHECK_EDIT, "pkg/__init__.py": "",
             "pkg/settings.py": 'def get_cfg():\n    """Return the active configuration."""\n    return {"env": "prod"}\n',
             "DSK.md": "# Project\nLayout: pkg/ holds settings.py and mod_0..mod_8.\nCheck: python3 check.py\n"}
    for n in range(9):
        files[f"pkg/mod_{n}.py"] = (f'from pkg.settings import get_cfg\n\n\ndef run():\n    """Tag for mod_{n}."""\n'
                                    f'    cfg = get_cfg()  # get_cfg is cheap\n    return "mod_{n}:" + cfg["env"]\n')
    return files


UNITTEST = "python3 -m unittest discover -s tests"
TASKS = {  # name: (files of the throwaway repository, or None for a plain directory; dsk run arguments)
    "tests": (module_repo("durations.py", DURATIONS),
              ["--file", "durations.py", "--allow", "tests/**", "--check", UNITTEST,
               "Write unittest tests for durations.py in tests/test_durations.py: valid input, edge cases, and the "
               "ValueError cases of both functions."]),
    "edit": (edit_repo(),
             ["--allow", "pkg/*.py", "--check", "python3 check.py",
              "Rename the function get_cfg to load_config everywhere under pkg/: its definition in pkg/settings.py and "
              "every import, call and comment in the other modules. Change nothing else."]),
    "web": (None,
            ["--web", "What is the longest query that DeepSeek's web search tool API accepts, and what does one "
                      "search request cost? Answer in two sentences and cite the page you opened."]),
    "guide": (module_repo("durations.py", DURATIONS, {"check_guide.py": CHECK_GUIDE}.items()),
              ["--file", "durations.py", "--allow", "docs/**", "--check", "python3 check_guide.py",
               "Write docs/guide.md, a guide of about 30 lines to durations.py. It must contain a fenced python example "
               "that calls parse_duration, a docstring example in triple double quotes, and the literal Windows path "
               "C:\\temp\\new (single backslashes) as an example of invalid input."]),
    "escapes": (module_repo("text.py", TEXT),
                ["--file", "text.py", "--allow", "tests/**", "--check", UNITTEST,
                 "--check", "grep -q show_tabs tests/test_text.py",
                 "Write unittest tests for text.py in tests/test_text.py covering both functions, including inputs with "
                 "newlines, tabs, a trailing newline and literal backslashes."]),
}


def run_one(task, profile, state):
    files, args = TASKS[task]
    token = secrets.token_hex(4)
    attached = {value for flag, value in zip(args, args[1:]) if flag == "--file"}
    args = [*args[:-1], f"{args[-1]} (Task reference {token}.)"]
    work = tempfile.mkdtemp(prefix="dsk-live-")
    for name, text in (files or {}).items():
        os.makedirs(os.path.dirname(os.path.join(work, name)), exist_ok=True)
        with open(os.path.join(work, name), "w") as f:
            f.write(f"# build {token}\n{text}" if name in attached else text)
    if files:
        for cmd in (["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]):
            subprocess.run(["git", *cmd], cwd=work, check=True, capture_output=True)
    started = time.time()
    done = subprocess.run([sys.executable, DSK, "run", "--profile", profile, *args], cwd=work, capture_output=True,
                          text=True, env={**os.environ, "XDG_STATE_HOME": state})
    shutil.rmtree(work, ignore_errors=True)
    words = done.stdout.split()
    row = {"task": task, "profile": profile, "secs": time.time() - started, "report": done.stdout.strip(), "usage": [], "fails": []}
    log = os.path.join(state, "dsk", words[1] if len(words) > 1 else "-", "log.jsonl")
    if os.path.exists(log):
        with open(log) as f:
            recs = [json.loads(line) for line in f]
        row.update(status=[r for r in recs if r["t"] == "state"][-1]["status"], usage=[r for r in recs if r["t"] == "usage"],
                   fails=[r["fail"] for r in recs if r["t"] == "result" and r["fail"]],
                   sources=next((line for line in done.stdout.splitlines() if line.startswith("sources:")), ""))
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--profile", action="append", help="default: every profile in the route")
    ap.add_argument("--task", action="append", choices=[*TASKS, "all"], help="default: tests, edit, web")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--table", action="store_true", help="print hit and miss tokens for every turn")
    args = ap.parse_args()
    config = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "dsk", "config.json")
    with open(config) as f:
        route = json.load(f)["route"]
    tasks = list(TASKS) if "all" in (args.task or []) else args.task or ["tests", "edit", "web"]
    state = tempfile.mkdtemp(prefix="dsk-live-state-")
    jobs = [(task, profile) for profile in args.profile or route for task in tasks for _ in range(args.runs)]
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        rows = list(pool.map(lambda job: run_one(*job, state), jobs))
    shutil.rmtree(state, ignore_errors=True)
    for profile in dict.fromkeys(r["profile"] for r in rows):
        mine = [r for r in rows if r["profile"] == profile]
        print(f"== {profile}")
        for r in mine:
            u = r["usage"]
            known = [x for x in u if x["hit"] is not None]
            share = sum(x["hit"] for x in known) / max(1, sum(x["prompt"] for x in known))
            print(f"{r['task']:8} {r.get('status', 'no session'):8} {len(u):>2} turns  in {sum(x['prompt'] for x in u):>6} "
                  f"cached {share:4.0%}  out {sum(x['out'] for x in u):>5}  {r['secs']:3.0f}s  {' '.join(r['fails'])} {r.get('sources', '')}")
            if "status" not in r or r["status"] in ("error", "stuck", "limit"):
                print("    " + r["report"].replace("\n", "\n    ")[:600])
            for x in u if args.table else []:
                hit = "?" if x["hit"] is None else x["hit"]
                print(f"    t{x['turn']:<3} in {x['prompt']:>6} hit {hit:>6} miss {x['prompt'] - (x['hit'] or 0):>6} out {x['out']:>5}")
        turns = [len(r["usage"]) for r in mine if r["usage"]]
        def late_share(rows):
            late = [x for r in rows for x in r["usage"] if x["turn"] >= 3 and x["hit"] is not None]
            return f"{sum(x['hit'] for x in late) / max(1, sum(x['prompt'] for x in late)):.2f}"

        code, web = ([r for r in mine if (r["task"] == "web") == flag] for flag in (False, True))
        failed = sum(f in ("malformed", "truncated", "refused") for r in mine for f in r["fails"])
        good = sum(r.get("status") in ("review", "done") for r in mine)
        print(f"-- {profile}: {good} of {len(mine)} runs finished · median {statistics.median(turns or [0])} turns (target 6 or fewer) · "
              f"cached share from turn 3: code tasks {late_share(code)}, web {late_share(web)} (target 0.9) · "
              f"failed turns {failed} of {sum(turns)} ({failed / max(1, sum(turns)):.1%}, target under 3%)")


if __name__ == "__main__":
    main()
