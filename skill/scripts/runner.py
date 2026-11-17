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


def foreign(node):
    """The modules an import statement names that a script may not import."""
    modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or "."]
    return [m for m in modules if m.split(".")[0] not in IMPORTS + ("glob",)]  # glob is our function: `import glob` is harmless


def unused(tree):
    """The imports of modules a script may not import whose names it never uses, as in `import os` above a script
    that calls only read() and glob(): 10 of the 12 refused imports in 111 logged sessions were such a line, and each
    cost its worker a turn. They are dropped before the script runs (strip()), so they give it nothing. A name counts
    as used wherever it appears as a name, an attribute, an argument or a definition, which is more than it needs."""
    imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) and foreign(n)]
    skip = {id(a) for n in imports for a in n.names}
    used = set()
    for node in ast.walk(tree):
        if id(node) in skip:
            continue
        for field, value in ast.iter_fields(node):
            if field in ("id", "arg", "name", "attr", "asname", "rest") and isinstance(value, str):
                used.add(value.split(".")[0])
            elif field == "names" and isinstance(node, (ast.Global, ast.Nonlocal)):
                used.update(value)
    bound = lambda n, a: a.asname or (a.name.split(".")[0] if isinstance(n, ast.Import) else a.name)
    return [n for n in imports if all(a.name != "*" and bound(n, a) not in used for a in n.names)]


def strip(tree, nodes):
    """The tree with each of these import statements replaced by `pass`, which keeps every line where it was."""
    gone = {id(n) for n in nodes}

    class Drop(ast.NodeTransformer):
        def visit_Import(self, node):
            return ast.copy_location(ast.Pass(), node) if id(node) in gone else node
        visit_ImportFrom = visit_Import

    return ast.fix_missing_locations(Drop().visit(tree))


def gate(script):
    """Refuse a script that would act outside the function API. Returns a one-line reason, or None."""
    try:
        tree = ast.parse(script)
    except SyntaxError as e:
        return f"SyntaxError on line {e.lineno}: {e.msg}"
    except (ValueError, RecursionError, MemoryError) as e:  # a lone surrogate, or nesting too deep to parse
        return f"the script cannot be parsed: {type(e).__name__}: {e}"[:300]
    dropped = {id(n) for n in unused(tree)}
    for node in ast.walk(tree):
        names = [node.id] if isinstance(node, ast.Name) else [node.attr] if isinstance(node, ast.Attribute) else []
        if id(node) in dropped:
            continue
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


QUOTED = re.compile(r'"(?:[^"\\]|\\.)*"' + r"|'[^']*'")


def spoken(flat):
    """A command with the text it only carries blanked out, for the git check. A quoted string is an argument, such
    as a grep pattern or a commit message, unless it is the script of `sh -c` or of `eval`, which the shell runs: of
    29 git refusals in the logs of 720 sessions, 8 were the word git inside such a string, and each cost its worker
    a turn. sudo and the deny list are matched on the whole command, as they were: `ssh host "kubectl delete ..."` runs what
    its string says, and nothing measured says a quoted match there is a false one."""
    def text(found):
        runs = re.search(r"(?:\s-\w*c|\beval)\s*$", flat[:found.start()])
        return found.group() if runs else found.group()[0] + " " * (len(found.group()) - 2) + found.group()[-1]
    return QUOTED.sub(text, flat)


def denied(cmd, deny):
    """Why sh() refuses this command, or None. It stops an obedient worker's mistake; it is not a sandbox."""
    flat = " ".join(cmd.split())
    for found in re.finditer(r"""(?:^|[\s;&|(/"'])git\s+(?:-[cC]\s*\S+\s+|-\S+\s+)*([\w-]+)""", spoken(flat)):
        if found.group(1) not in GIT_READ_ONLY:
            return f"git {found.group(1)} is refused: git is read-only here ({', '.join(GIT_READ_ONLY)})"
    if re.search(r"(?:^|[\s;&|(/])sudo\s", flat + " "):
        return "sudo is refused"
    return next((f"`{d.strip()}` is refused" for d in deny if d in flat + " "), None)


CHANGES = ("os.remove", "os.rename", "os.truncate", "os.link", "os.symlink", "os.mkdir", "os.rmdir", "os.chmod", "os.chown")
STARTS = ("os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "subprocess.Popen", "pty.spawn")
WRITING = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND


def outside(event, args):
    """Why a script may not do what this audit event says it is about to do, or None. A script acts through the
    function API alone: it changes files with write() and edit() and starts commands with sh(). The gate reads the
    script for that; this is asked about what the script then does, so io.FileIO() or a module's own `os` gets no
    further than open() would. Reading is free, and so is Python's own bytecode cache, which an import may write."""
    target = args[0] if args else None
    path = os.fsdecode(target) if isinstance(target, (str, bytes, os.PathLike)) else ""
    name = os.path.basename(path)
    if event in STARTS:
        return f"{event}() is not allowed; start commands with sh(cmd)"
    if name == "__pycache__" or (".pyc" in name and "__pycache__" in path):
        return None
    if event == "open":
        mode, flags = args[1], args[2]
        writes = any(c in mode for c in "wax+") if isinstance(mode, str) else bool((flags or 0) & WRITING)
        if writes and not isinstance(target, int):  # a number is a descriptor that is open already
            return f"opening {path} for writing is not allowed; use write(path, text) or edit()"
    elif event in CHANGES:
        return f"{event}() is not allowed; change files with write() and edit(), or with sh()"
    return None


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
        late = False
        try:
            code = proc.wait(timeout)
        except subprocess.TimeoutExpired:
            code, late = 124, True  # a command may exit 124 by itself, as `timeout` does: only this one was killed
        finally:
            kill_group(proc.pid)
            proc.wait()
        out.seek(0)
        text = out.read().decode("utf-8", "replace")
    return code, text + (f"\n[killed after {timeout}s]" if late else "")


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

    def in_scratch(cmd):
        """The command with "@scratch" as a word's start made the scratch folder's path. Workers wrote a probe with
        write("@scratch/t.mjs") and ran `node @scratch/t.mjs`, which failed: one spent three turns finding the path.
        Only a path with no shell syntax in it is put in, so that no quoting can change what the command means."""
        if not re.fullmatch(r"[\w./+-]+", scratch):
            return cmd
        return re.sub(r"(?<![\w@./~$-])@scratch(?=/|$|[\s'\";|&)<>])", lambda _: scratch, cmd)

    def tell(**record):
        chan.write(json.dumps(record) + "\n")
        chan.flush()

    working = [0]  # above zero while a function of the API runs: those open files and start commands themselves

    def audit(event, args):
        """What the script does by itself, outside the API, is refused before it happens: outside() says which. So
        a script that started no shell command has changed exactly the files it wrote with write() and edit(), which
        is what the scope gate takes for granted (lib/revert.ts)."""
        refusal = None if working[0] else outside(event, args)
        if refusal:
            raise PermissionError(refusal)

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
        code, out = shell(in_scratch(cmd), timeout, started=lambda pid: tell(pgid=pid, cmd=cmd))
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
            first = next(iter([*args, *kwargs.values()]), "")
            if name in ("write", "edit"):
                first = kwargs.get("path", first)
            arg = str(first)[:200]
            # The scope gate tells what a script wrote from these records, so a written path longer than the 200
            # characters kept of an argument is logged whole as well: cut, it named no file, and the change was
            # taken for someone else's.
            whole = {"path": str(first)} if name in ("write", "edit") and len(str(first)) > 200 else {}
            working[0] += 1
            try:
                result = fn(*args, **kwargs)
            except Exception as e:
                tell(fn=name, arg=arg, err=f"{type(e).__name__}: {e}"[:200], **whole)
                raise
            finally:
                working[0] -= 1
            tell(fn=name, arg=arg, code=getattr(result, "code", 0), **whole)
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
    sys.addaudithook(audit)  # from here on, and never taken off again: only the script runs after this line
    try:
        tree = ast.parse(job["script"])
        dropped = unused(tree)
        if dropped:  # said first, so that the worker stops writing them
            lines = sorted({ast.get_source_segment(job["script"], n) or "import" for n in dropped})
            print("dropped, not run: " + "; ".join(lines) + " (not allowed, and nothing in the script used it)")
            tree = strip(tree, dropped)
        exec(compile(tree, "<script>", "exec"), every)
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
            try:
                answer = gate(json.loads(line))
            except Exception as e:  # this process serves a whole run: one script it cannot read must not end it
                answer = f"the script could not be checked: {type(e).__name__}: {e}"[:300]
            print(json.dumps(answer), flush=True)
    elif verb == ["locks"]:
        locks(sys.argv[2], sys.argv[3])
    else:
        sys.exit("usage: runner.py exec FD | gate | gates | locks REQUESTS REPLIES")


if __name__ == "__main__":
    main()
