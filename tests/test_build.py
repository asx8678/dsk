"""The compiled dsk in skill/scripts/dist must be built from the sources as they are: start.mjs would otherwise run
the sources (correct, but slower), and a commit would ship a build nobody tested. `npm run build` makes it fresh.

Run from the project root:  python3 -m unittest tests.test_build
"""
import os, shutil, subprocess, unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skill", "scripts")


@unittest.skipUnless(shutil.which("node"), "node is not on PATH")
class Build(unittest.TestCase):
    def test_the_build_in_dist_was_made_from_the_sources_as_they_are(self):
        stamp = os.path.join(SCRIPTS, "dist", "BUILD")
        self.assertTrue(os.path.exists(stamp), "no build in skill/scripts/dist: run npm run build")
        now = subprocess.run(["node", "--input-type=module", "-e",
                              f"import {{ sourceHash }} from {os.path.join(SCRIPTS, 'stamp.mjs')!r}; console.log(sourceHash({SCRIPTS!r}))"],
                             capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(open(stamp).read().strip(), now, "skill/scripts/dist is older than the sources: run npm run build")


if __name__ == "__main__":
    unittest.main()
