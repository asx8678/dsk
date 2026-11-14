# DSK.md: facts for dsk workers in this repository

## Layout
- `skill/scripts/dsk.py`: the whole CLI in one file. Python 3.13+, standard library only. Sections are marked `# ---- name`.
- `tests/test_dsk.py`: its tests, against a scripted API server (`FakeAPI`) and temporary git repositories.
- `skill/hooks/register.tsx`: the Claude Code display (TypeScript), tested by `skill/tests/jobs.test.tsx`.
- `skill/SKILL.md`, `skill/agents/reviewer.md`, `README.md`: instructions and documentation. Change them only when the task says so.

## Checks
- `python3 -m unittest discover -s tests` runs every Python test, in about 40 seconds.
- One test: `python3 -m unittest -k part_of_its_name tests.test_dsk`.
- The display tests need the `claude` CLI and are not yours to run.

## Conventions
- No new files, no new dependencies, nothing outside the standard library.
- `dsk.py` is long: grep for the `def` you need and read that function, not the file from the top.
- Short functions, each with a docstring that says what it is for. Comments say why, in a full sentence.
- Lines may be long. Do not reflow or reformat lines you do not otherwise change.
- A test's name is a sentence about behaviour, such as `test_full_profile_is_skipped_and_the_last_one_waits_for_a_slot`.
- Tests drive the CLI with `self.dsk(...)` or `self.run_ok(...)`, script the worker's replies with `self.api.replies = [script("...")]`, and assert on output and files.
- Reports are plain text with fixed labels (`summary:`, `checks:`, `next:`) in a column eight characters wide.
- Never change `SYSTEM` or `TOOLS`: they are a cache prefix every session shares.
