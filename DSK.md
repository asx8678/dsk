# DSK.md: facts for dsk workers in this repository

## Layout
- `skill/scripts/dsk.ts` and `skill/scripts/lib/*.ts`: the CLI in TypeScript, one module per part (wire, loop, gates, review, reports, commands...). Node 22.18 or newer runs it; no runtime dependencies. `skill/bin/dsk`, the hooks and the display start it through `skill/scripts/start.mjs`, which runs the build in `skill/scripts/dist/` while its stamp matches the sources, else the sources.
- `skill/scripts/runner.py`: the worker side in Python (the scripts' function API, the AST gate, the lock helper).
- `skill/scripts/lib/stops.ts`, `revert.ts`, `lifecycle.ts`, `retry.ts`: the stateful rules (when a run stops, what the scope gate undoes, which command acts on which session, when a request is sent again), each with its laws as `// gdp: law` comments.
- `tests/test_dsk.py`: tests against a scripted API server (`FakeAPI`) and temporary git repositories, run against dsk.ts. `tests/test_glob.py`: the TypeScript path matcher against Python's. `tests/test_build.py`: the build is fresh.
- `skill/hooks/register.tsx`: the Claude Code display (TypeScript), tested by `skill/tests/jobs.test.tsx`.
- `skill/SKILL.md`, `skill/agents/reviewer.md`, `README.md`: instructions and documentation. Change them only when the task says so.

## Checks
- `npm run check` type-checks with TypeScript 7 and checks that every async call is awaited. In a fresh worktree, `npm ci` comes first.
- `npm run build` compiles the sources into `skill/scripts/dist/`; after changing a `.ts` file, build again, or `tests/test_build.py` fails.
- `bun run prove` proves with gdp-wired (through bunx, never npm or npx; nothing installed) the laws of the four rules above, and that each rule's broken variants in `tools/prove.mjs` are refused.
- `python3 -m unittest discover -s tests` runs every test against dsk.ts, in about 75 seconds. One test: `python3 -m unittest -k part_of_its_name tests.test_dsk`.
- The display tests need the `claude` CLI and are not yours to run.

## Conventions
- No new runtime dependencies: Node's standard modules only, and Python's standard library in `runner.py`.
- TypeScript: erasable syntax only (no `enum`, no `namespace`, no parameter properties), `import type` for types, `.ts` in import paths.
- Short functions, each with a doc comment that says what it is for. Comments say why, in a full sentence.
- Lines may be long. Do not reflow or reformat lines you do not otherwise change.
- A test's name is a sentence about behaviour, such as `test_full_profile_is_skipped_and_the_last_one_waits_for_a_slot`.
- Reports are plain text with fixed labels (`summary:`, `checks:`, `next:`) in a column eight characters wide.
- Never change `SYSTEM` or `TOOLS` in `lib/texts.ts`: they are a cache prefix every session shares.
