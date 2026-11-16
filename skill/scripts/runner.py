#!/usr/bin/env python3
"""dsk's worker side: the part of dsk that runs the worker's Python scripts.

dsk itself (dsk.ts) spawns this file with `python3 -I`, so it must stay one file, standard library only, Python 3.13+:
  runner.py exec FD        run one script against the function API, reporting every call over the socket FD
  runner.py gate           read a script on stdin; print why it is refused, one line, or nothing
  runner.py gates          the same for many scripts: one JSON string per line in, one JSON answer per line out
  runner.py locks REQ RES  serve flock requests for dsk on systems without O_EXLOCK, where Node cannot take one:
                           each line `N lock|wait|unlock PATH` appended to REQ is answered by `N held|busy|ok` in RES.
                           It exits, and the kernel frees every lock, as soon as the process that started it is gone.
"""
import ast, builtins, fcntl, json, os, re, signal, socket, subprocess, sys, tempfile, traceback, types
from glob import translate as glob_regex

IMPORTS = ("re", "json", "math", "itertools", "functools", "collections", "textwrap", "difflib", "datetime",
           "hashlib", "base64", "csv", "io", "string", "statistics", "fnmatch", "ast")
GIT_READ_ONLY = ("status", "diff", "log", "show", "grep", "ls-files", "blame", "rev-parse")
OUTSIDE = '{} is outside the working directory; for throwaway files use "@scratch/name", or $DSK_SCRATCH in sh()'
BANNED = {"open": "read() or write()", "exec": "plain code", "eval": "plain code", "compile": "plain code",
          "__import__": "an import statement", "input": "ask()"}
HINTS = {"os": "sh(), glob() and read()", "sys": "print() and done()", "subprocess": "sh()", "shutil": "sh()",
         "pathlib": "read(), write() and glob()", "glob": "glob()", "time": "sh('sleep 1')", "urllib": "fetch()",
         "requests": "fetch()"}


def gate(script):
    """Refuse a script that would act outside the function API. Returns a one-line reason, or None."""
    try:
        tree = ast.parse(script)
    except SyntaxError as e:
        return f"SyntaxError on line {e.lineno}: {e.msg}"
    for node in ast.walk(tree):
        names = [node.id] if isinstance(node, ast.Name) else [node.attr] if isinstance(node, ast.Attribute) else []
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imported = [a.name for a in node.names]
            for module in imported if isinstance(node, ast.Import) else [node.module or "."]:
                if module.split(".")[0] not in IMPORTS + ("glob",):  # glob is our function: `import glob` is harmless
                    hint = HINTS.get(module.split(".")[0], "sh('python3 ...') to run the project's own code")
                    return f"import {module} is not allowed; use {hint}"
            names = imported if isinstance(node, ast.ImportFrom) else []
        for name in names:
            if name.startswith("__"):
                return f"{name} is not allowed: no names starting with __; write plain top-level code"
            if name in BANNED and (not isinstance(node, ast.Attribute) or name == "open"):
                return f"{name}() is not allowed; use {BANNED[name]}"
    return None


def matcher(globs):
    """The one path matcher, for --allow and glob(): `*` stays inside a directory, `**` crosses them."""
    patterns = [re.compile(glob_regex(g, recursive=True, include_hidden=True)) for g in globs]
    return lambda path: any(p.match(path) for p in patterns)


def denied(cmd, deny):
    """Why sh() refuses this command, or None. It stops an obedient worker's mistake; it is not a sandbox."""
    flat = " ".join(cmd.split())
    for found in re.finditer(r"""(?:^|[\s;&|(/"'])git\s+(?:-[cC]\s*\S+\s+|-\S+\s+)*([\w-]+)""", flat):
        if found.group(1) not in GIT_READ_ONLY:
            return f"git {found.group(1)} is refused: git is read-only here ({', '.join(GIT_READ_ONLY)})"
    if re.search(r"(?:^|[\s;&|(/])sudo\s", flat + " "):
        return "sudo is refused"
    return next((f"`{d}` is refused" for d in deny if d in flat), None)


def kill_group(pgid):
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass  # already gone; macOS answers EPERM for a group of zombies


def shell(cmd, timeout, env=None, cwd=None, started=lambda pid: None, wrap=()):
    """Run a command in its own process group and kill the group when it returns, so nothing outlives it. `wrap` is
    a prefix such as the sandbox's, which the command then runs under."""
    with tempfile.TemporaryFile() as out:
        proc = subprocess.Popen([*wrap, "/bin/sh", "-c", cmd] if wrap else cmd, shell=not wrap, cwd=cwd, env=env,
                                stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True)
        started(proc.pid)
        try:
            code = proc.wait(timeout)
        except subprocess.TimeoutExpired:
            code = 124
        finally:
            kill_group(proc.pid)
            proc.wait()
        out.seek(0)
        text = out.read().decode("utf-8", "replace")
    return code, text + (f"\n[killed after {timeout}s]" if code == 124 else "")


def child(fd):
    """`dsk _exec`: run one script against the function API, reporting every call to the parent."""
    chan = socket.socket(fileno=fd).makefile("rw", encoding="utf-8")
    job = json.loads(chan.readline())
    cwd, allowed = os.path.realpath(os.getcwd()), matcher(job["allow"])
    # The worker's own folder for probes and other throwaway files. It comes from job["dir"], which every parent
    # sends, so a child started by an older dsk process finds it too.
    scratch = os.path.realpath(os.path.join(job["dir"], "scratch"))

    def scratch_name(path):
        """Whether a path names the scratch folder the short way, as "@scratch" or "@scratch/<rel>"."""
        return path == "@scratch" or path.startswith("@scratch/")

    def tell(**record):
        chan.write(json.dumps(record) + "\n")
        chan.flush()

    def locate(path, change=False):
        """The only place that decides what a script may read or change."""
        if path == "@answer" or (path == "@stdin" and not change):
            return os.path.join(job["dir"], path[1:])
        if not change and re.fullmatch(r"@\d+", path):
            return os.path.join(job["dir"], "out", path[1:])
        real = os.path.realpath(os.path.join(scratch, path[len("@scratch/"):]) if scratch_name(path) else path)
        if real == scratch or real.startswith(scratch + os.sep):
            return real  # the scratch folder is the worker's to read and to change, whatever --allow says
        if scratch_name(path):
            raise PermissionError(f"{path} leaves the scratch folder")
        rel = os.path.relpath(real, cwd)
        if rel == ".." or rel.startswith("../"):
            if not change:  # reading guards nothing: sh() reads any file the user can, so read() may as well
                return real
            raise PermissionError(OUTSIDE.format(path))
        if change and not allowed(rel):
            scope = ", ".join(job["allow"]) or "none, this run is read-only"
            raise PermissionError(f"{path} does not match the allow patterns ({scope})")
        return real

    def load(path, errors):
        try:
            with open(locate(path), encoding="utf-8", errors=errors, newline="") as f:
                return f.read()
        except FileNotFoundError:
            raise FileNotFoundError(f"no such file: {path}") from None

    def read(path, start=1, end=None):
        text = load(path, "replace")
        return text if (start, end) == (1, None) else "\n".join(text.split("\n")[start - 1:end])

    def write(path, text):
        real = locate(path, change=True)
        os.makedirs(os.path.dirname(real), exist_ok=True)
        with open(real, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def edit(path, old, new, count=1):
        text = load(path, "strict")
        if text.count(old) != count:
            raise ValueError(f"old occurs {text.count(old)} times in {path}, expected {count}")
        write(path, text.replace(old, new))

    def find(pattern):
        patterns = [pattern] if isinstance(pattern, str) else list(pattern)
        if any(scratch_name(p) for p in patterns):  # "@scratch/**": the files of the scratch folder, by their short names
            inside = [os.path.relpath(os.path.join(d, f), scratch) for d, _, fs in os.walk(scratch) for f in fs]
            match = matcher([p[len("@scratch/"):] or "**" for p in patterns if scratch_name(p)])
            return sorted("@scratch/" + n for n in inside if match(n))
        for p in patterns:  # an empty list here would read as "no such files", and the worker would keep looking
            if os.path.isabs(p) or p == ".." or p.startswith("../"):
                raise PermissionError(OUTSIDE.format(p))
        listing = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], capture_output=True,
                                 encoding="utf-8", errors="replace")
        if listing.returncode == 0:
            names = listing.stdout.split("\0")
        else:  # not a git repository
            names = [os.path.relpath(os.path.join(d, f)) for d, _, fs in os.walk(".") for f in fs]
        match = matcher(patterns)
        found = sorted(n for n in names if match(n) and os.path.isfile(n) and not n.startswith(".git/"))
        if not found and listing.returncode == 0:
            # Git lists no file it ignores, so build output and screenshots came back as []: in one batch 16 workers
            # then spent a turn on `ls`. A pattern that names such a folder is looked up on disk, in that folder only.
            tops = {p.split("/", 1)[0] for p in patterns if "/" in p}
            walked = [os.path.relpath(os.path.join(d, f)) for top in sorted(tops) if top != ".git" and os.path.isdir(top)
                      and not set(top) & set("*?[") for d, _, fs in os.walk(top) for f in fs]
            found = sorted(n for n in {*walked, *patterns} if match(n) and os.path.isfile(n) and not n.startswith(".git/"))
        return found

    def grep(pattern, glob="**/*"):
        regex, hits = re.compile(pattern), []
        for path in find(glob):
            try:
                with open(locate(path), encoding="utf-8") as f:  # locate(): a "@scratch/..." name is not a path
                    hits += [(path, n, line.rstrip("\n")) for n, line in enumerate(f, 1) if regex.search(line)]
            except (UnicodeDecodeError, OSError):
                pass  # binary or unreadable
        return hits

    def sh(cmd, timeout=120):
        refusal = denied(cmd, job["sh_deny"])
        if refusal:
            raise PermissionError(refusal)
        code, out = shell(cmd, timeout, started=lambda pid: tell(pgid=pid, cmd=cmd))
        return types.SimpleNamespace(code=code, out=out)

    def web(kind, *args):  # runs in the parent, which holds the key
        if not job["web"]:
            raise PermissionError(f"{kind}() needs --web; this run has web: off")
        tell(rpc=kind, args=args)
        reply = json.loads(chan.readline())
        if "err" in reply:
            raise RuntimeError(reply["err"])
        return reply["ok"]

    def leave(fn, text, open_issues=""):  # a hard exit, so no `except` in the script can swallow it
        tell(fn=fn, arg=str(text), open=str(open_issues))
        sys.stdout.flush()
        os._exit(0)

    def logged(name, fn):
        def call(*args, **kwargs):
            arg = str(next(iter([*args, *kwargs.values()]), ""))[:200]
            try:
                result = fn(*args, **kwargs)
            except Exception as e:
                tell(fn=name, arg=arg, err=f"{type(e).__name__}: {e}"[:200])
                raise
            tell(fn=name, arg=arg, code=getattr(result, "code", 0))
            return result
        return call

    api = {name: logged(name, fn) for name, fn in
           (("read", read), ("write", write), ("edit", edit), ("glob", find), ("grep", grep), ("sh", sh))}
    api.update(search=lambda query, n=5: web("search", str(query), int(n)), fetch=lambda url: web("fetch", str(url)),
               note=lambda text: tell(fn="note", arg=str(text)), ask=lambda question: leave("ask", question),
               done=lambda summary, open_issues="": leave("done", summary, open_issues))
    class Glob(types.SimpleNamespace):
        """The name `glob` in a script: glob() is our function and so is glob.glob(), so `import glob` is harmless."""

        def __call__(self, pattern):
            return self.glob(pattern)

    def importer(name, *args):
        """`import glob` in a script must hand back our glob(), not the standard module's unsorted one."""
        return globs if name.split(".")[0] == "glob" else builtins.__import__(name, *args)

    globs = Glob(glob=api["glob"])
    every = {"__name__": "__main__", "__builtins__": {**vars(builtins), "__import__": importer},
             **{name: __import__(name) for name in IMPORTS}, **api,  # the modules are ready: re.search() needs no import
             "glob": globs}  # after the api, so that glob.glob() works without an import as well
    try:
        exec(compile(job["script"], "<script>", "exec"), every)
    except SystemExit:
        pass
    except BaseException as e:
        source = job["script"].split("\n")
        frames = [f"  line {f.lineno}: {source[f.lineno - 1].strip()}"
                  for f in traceback.extract_tb(e.__traceback__) if f.filename == "<script>"]
        tell(error="\n".join(frames[-3:] + [f"{type(e).__name__}: {e}"[:600]]))
    sys.stdout.flush()


def locks(requests, replies):
    """Serve `N lock|wait|unlock PATH` lines appended to `requests`, answering `N held|busy|ok` in `replies`. Polled,
    not piped, so that dsk can wait for an answer without an event loop. The locks live as long as dsk does."""
    import time
    parent, held, seen, pending = os.getppid(), {}, 0, b""
    while os.getppid() == parent:
        with open(requests, "rb") as f:
            f.seek(seen)
            data = f.read()
        seen += len(data)
        *lines, pending = (pending + data).split(b"\n")
        for line in lines:
            n, verb, path = line.decode("utf-8").split(" ", 2)
            if verb == "unlock":
                held.pop(path).close()
                answer = "ok"
            else:
                handle = open(path, "w")
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | (0 if verb == "wait" else fcntl.LOCK_NB))
                    held[path], answer = handle, "held"
                except OSError:
                    handle.close()
                    answer = "busy"
            with open(replies, "a", encoding="utf-8") as out:
                out.write(f"{n} {answer}\n")
        time.sleep(0.005)


def outlive_signals():
    """A helper ends when dsk does, not before: a Ctrl-C to the terminal reaches its whole process group, and a lock
    helper that died of it would free dsk's session lock while dsk is still settling the worker's changes."""
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)


def main():
    verb = sys.argv[1:2]
    if verb in (["gates"], ["locks"]):
        outlive_signals()
    if verb == ["exec"]:
        child(int(sys.argv[2]))
    elif verb == ["gate"]:
        print(gate(sys.stdin.read()) or "")
    elif verb == ["gates"]:  # one script per line, as a JSON string; one JSON answer per line, until stdin closes
        for line in sys.stdin:
            print(json.dumps(gate(json.loads(line))), flush=True)
    elif verb == ["locks"]:
        locks(sys.argv[2], sys.argv[3])
    else:
        sys.exit("usage: runner.py exec FD | gate | gates | locks REQUESTS REPLIES")


if __name__ == "__main__":
    main()
