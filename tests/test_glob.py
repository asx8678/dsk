"""dsk.ts matches --allow with its own port of glob.translate; runner.py matches the worker's writes with Python's.
If they disagree, dsk reverts a write the worker was allowed to make, or keeps one it was not. This holds them to the
same answer on every pattern and path below.

Run from the project root:  python3 -m unittest tests.test_glob
"""
import importlib.util, itertools, json, os, shutil, subprocess, unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
spec = importlib.util.spec_from_file_location("runner", os.path.join(ROOT, "skill", "scripts", "runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

PATTERNS = ["*", "**", "*.py", "test_*.py", "**/*.py", "src/**", "src/**/*.ts", "a/*/b", "a/**/b", "a/**/b/*.js",
            "**/test/**", "**/.env", ".github/**", "docs/[a-c]*.md", "[!a]*", "x?y", "foo[", "a-b/*", "*.{js,ts}",
            "[a-]x", "[]]x", "[!]]x", "[^x]y", "[z-a]q", "a+b(c)", "$x^", "dir/", "/abs", "a//b", "**/**/x", "*/**",
            "a\\b", "[\\]x", "[a-c-e]", "[!a-c]z", "nested/**/deep/*.md", "*.tar.gz", "README*", ".*", "**/*",
            "[&&]x", "[~]x", "[|]x", "[!]x", "[]x", "skill/scripts/*.ts", "skill/**/lib/*.ts"]
PATHS = ["a.py", "test_a.py", "src/x.ts", "src/a/b/c.ts", "src", "a/x/b", "a/b", "a/x/y/b", "a/x/b/c.js", "x/test/y.py",
         ".env", "deep/.env", ".github/workflows/ci.yml", "docs/a1.md", "docs/d1.md", "b", "abc", "xzy", "x/y", "foo[",
         "a-b/c", "x.{js,ts}", "x.js", "-x", "ax", "]x", "ax2", "^y", "xy", "zq", "aq", "a+b(c)", "$x^", "dir/", "dir",
         "a//b", "a/b/x", "x", "q/r", "a\\b", "\\x", "b", "d", "-", "dz", "az", "nested/a/b/deep/n.md", "nested/deep/n.md",
         "f.tar.gz", "README.md", ".hidden", "a/.hidden/b.py", "line\nbreak.py", "é.py", "skill/scripts/dsk.ts",
         "skill/scripts/lib/base.ts", "skill/x/lib/y.ts", "&x", "~x", "|x", "!x", ""]


@unittest.skipUnless(shutil.which("node"), "node is not on PATH")
class Glob(unittest.TestCase):
    def test_the_typescript_matcher_agrees_with_python_on_every_pattern_and_path(self):
        expected = [[runner.matcher([p])(path) for path in PATHS] for p in PATTERNS]
        program = ("import { matcher } from %s\n"
                   "const { patterns, paths } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))\n"
                   "console.log(JSON.stringify(patterns.map((p) => paths.map((x) => matcher([p])(x)))))\n")
        source = json.dumps(os.path.join(ROOT, "skill", "scripts", "lib", "glob.ts"))
        program = program.replace("require('node:fs')", "(await import('node:fs')).default") % source
        got = subprocess.run(["node", "--input-type=module", "-e", program], input=json.dumps(
            {"patterns": PATTERNS, "paths": PATHS}), capture_output=True, text=True, check=True).stdout
        for pattern, want, have in zip(PATTERNS, expected, json.loads(got)):
            differ = [path for path, w, h in zip(PATHS, want, have) if w != h]
            self.assertEqual(differ, [], f"pattern {pattern!r}: python and dsk.ts disagree on these paths")


if __name__ == "__main__":
    unittest.main()
