---
name: delegate
description: Hand the hands-on work to a DeepSeek worker through the dsk CLI, and keep planning, orchestration, review and decisions for yourself. Use it by default to scout a codebase (find where things live, trace a flow, read many files or logs), to write code from your plan (features, fixes, tests, boilerplate, mechanical edits), and for sourced web research. Do the work yourself only when a change is shorter than its brief, is security-sensitive, or needs the user's credentials.
allowed-tools:
  - Bash(dsk *)
  - Bash(${CLAUDE_SKILL_DIR}/bin/dsk *)
---

# dsk: you plan and verify, DeepSeek does the work

`dsk` hands one bounded task to a DeepSeek worker and prints a short report. Nothing the worker produces counts as finished until you have reviewed it and run `dsk accept`. A Stop hook sends you back to any session you started that is still waiting for review. It reminds you of `review` only: a run without `--worktree` that stopped as `question`, `stuck`, `limit` or `error` leaves its partial edits in the tree with no reminder, so settle it before you move on.

`dsk` is on PATH while the plugin is enabled. If the shell does not find it, use `${CLAUDE_SKILL_DIR}/bin/dsk` in its place.

If a command fails with `... is not set`, dsk has no provider yet. Do not ask for a key in the chat. Tell the user to run the `/plugin configure ...` command the error names, which asks for a DeepSeek API key, or for a custom endpoint, model and key, and then to restart Claude Code. `dsk configure` shows how dsk is set up.

## Who does what

- **The worker scouts and writes.** Scouting: where something lives, how a flow runs, what many files or logs say, sourced web research. Writing: features and fixes from your plan, tests, boilerplate, mechanical edits across many files.
- **You plan, orchestrate, verify and decide.** Split the work into bounded steps, settle the design and put the decision in the brief, run steps side by side, review every diff, check every claim, and choose what to accept.
- **Do it yourself** when the change is shorter than its brief, when it is security-sensitive (authentication, cryptography, secrets, permissions), or when it needs the user's credentials.

## The loop

1. **Scout** with read-only runs, one question each, until you can plan without guessing.
2. **Plan.** Give each step its files (`--allow`), a check (`--check`) and what done looks like.
3. **Write**, one run per step. Steps that touch different files run side by side with `--worktree`.
4. **Verify.** Read each diff against its brief, then `dsk accept` or `dsk reject`.

## How much to check: fast by default

Most of a change's time goes to waiting for the provider, turn after turn, and to review rounds. So the default is fast:

- **Fast (the default).** The brief asks for the code, not for tests. Give one quick `--check`: the fastest command that shows the code runs (a compile, an import, a lint, or an existing test command that takes under a minute). Read the diff yourself. No reviewer subagent. A compile check does not start the program: for UI wiring or lifecycle code, put a launch or smoke command in the check, or try the result yourself before `dsk accept`.
- **Careful.** Only when a mistake could lose, revert or delete the user's data or files (migrations, installers, anything that removes or overwrites), or when the user asks: the brief also asks for tests that fail without the change, the check runs them, and the `dsk:reviewer` subagent reads any diff above about 150 changed lines.

## How

```
dsk run [--allow GLOB]... [--check CMD]... [--file PATH]... [--web] [--worktree] [--no-sandbox]
        [--effort off|low|high|max] [--max-turns N] [--profile NAME] [--recheck] [--reviewer] ("brief" | --brief FILE)
```

### Rules that cost work when broken

- **Hands off the tree until an in-place run stops.** This holds for every run without `--worktree` in a git repository, read-only runs included. Each worker script that starts a shell command is charged with every change made from its start to its end, and so are the checks: a change outside `--allow` is undone (a copy is kept in the session directory) and a change inside it counts as the worker's, whoever made it. Without `--allow` that is every change. You cannot tell when those windows are open, so make no edits until the run reports.
- **One in-place run per tree.** A second run without `--worktree` is refused while the first is working, and so are `dsk accept` of a worktree session and `accept`, `reject`, `answer` or `continue` of any session that works in that tree. Wait, or use `--worktree`.
- **Run dsk bare.** Put no `| head`, `| tail` or other pipe after a dsk command: the pipe's exit code replaces dsk's, so a stuck or failed run looks like exit code 0, also in a background notice. The reports are short already.

### The brief and what you attach

- **Brief:** two to five lines saying what to produce and what done looks like. Structure goes in the flags; project facts go in `DSK.md`. Name files and functions by path: the worker asks when a task cannot be done as written, but when a name fits two things it picks the likelier one without saying so.
- **Acceptance items:** for a careful change, or one whose diff will run past about 150 lines, end the brief with numbered items, `A1.`, `A2.` and so on. You review against them, and the second look (`--recheck`) goes through them one by one. Give each one behaviour with concrete values: not "handles errors" but "on a timeout, retries 3 times, 2 seconds apart, then exits 1". Add one edge case and one thing that must not change. Whatever can be run belongs in a `--check`, not in an item. For a task that changes or deletes state, also ask in the brief what happens if it runs twice, if it stops halfway, or if an outside call fails; what it changes outside its target; and whether it prints or stores a secret.
- **Scouting brief:** one question, the directories or files to look in, and the form of the answer (`file:line` and one line per finding, at most 40 lines). A narrow question is one the worker can answer by searching: one that makes it print everything is cut off at the output limit.
- **Long files:** over half of all worker turns only read. A turn that only reads shows the worker up to 24,000 characters, any other turn 6,000, and each turn costs seconds of waiting. So attach what the worker must know instead of letting it look: a whole file with `--file PATH`, or just the lines that matter with `--file PATH:A-B` (find them with grep first).
- **`--file`:** attach what the worker must read (`-` is stdin), so it spends no turn fetching it. When a long run is compacted, a file of up to 4,000 characters always stays attached; larger ones stay in the order given while there is room, and the rest are dropped with a note to read them again. So attach first what the worker needs most, slice big files with `PATH:A-B`, and keep instructions in the brief. `reject`, `continue` and `answer` take no `--file`: put new material in their text or `--brief FILE`.

### What the run may do

- **`--allow`:** the paths the worker may change. Make it as narrow as the task permits. `*` stays inside one directory, `**` crosses them. Without `--allow` the run is read-only, and `--allow` needs a git repository. This stops a mistaken worker, not a hostile one: `write()` and `edit()` refuse other paths, and `dsk` undoes changes to any other file git does not ignore. On macOS the worker's scripts and the checks also run in a sandbox: they cannot write outside the working directory, `$DSK_SCRATCH`, the temp folders and the build caches, nor in `.git`, and cannot read dsk's keys (`~/.config/dsk` and the file where the plugin's form stores them), `~/.ssh` or the other credential stores. Git-ignored files inside the tree (`.env`, `node_modules`) stay writable, and without the sandbox (Linux, a report line `sandbox: off`, or `"sandbox": "off"` in the config, which prints no line) shell commands can change paths outside the repository too. Outside a git repository nothing is undone.
- **`--check`:** give one for any change. `dsk` runs it itself and reaches `review` only when it passes. Each check may run for 600 seconds, and the first one that fails stops the rest. A `caution:` line in the report means the worker saw that check pass before it changed anything, so it cannot show that the task was done: verify the change another way. The line appears only when the worker happened to run the check before its first change, so a report without it says nothing about the check. In a round started by a reject, it means the check already passed before that round. A check runs in the same sandbox: point its output into the tree or `$DSK_SCRATCH`, not at your scratchpad. A tool that starts a sandbox of its own fails inside it, because macOS will not nest them: give SwiftPM `--disable-sandbox` (`swift build --disable-sandbox`), and for anything else that fails with `sandbox_apply: Operation not permitted`, run the task with `--no-sandbox`.
- **`--web`:** search and fetch, for research. It needs the search key, a DeepSeek API key: when `dsk` answers `web search needs the key ...`, research with your own tools, or tell the user to add that key. Leave it off for tasks that also run commands in a repository with secrets.
- **`--max-turns`:** 30 by default for a run with `--allow`, 12 for a read-only one. A run that uses them up stops as `limit`, and so does one past the time or token limit in the config. A reject or a continue starts a fresh turn and token budget; an answer does not. A reject round keeps the run's limit unless `dsk reject` gets `--max-turns N`, which holds for that round only. Leave the default unless you want a short probe: of 25 runs capped at 18 turns, 6 used every one.
- **`--effort`:** how hard the worker thinks: `off`, `low`, `high` or `max`. A run that names none takes `effort` from the user's config (`dsk configure` shows it when it is not `off`), and no thinking when the config has none. When the config sets an effort, that is the user's choice for every run: leave the flag out, and do not lower it to save time. When the config sets none, add `--effort` only for briefs that need judgment. A session keeps the effort it started with through `continue`, `reject` and `answer`.
- **`--recheck`:** a second look, off by default; `--no-recheck` turns off one that the config or the session turned on. Use it for a careful change, or one whose diff will run past about 150 lines: below that, reading the diff yourself costs less than the extra turn, a median of 84 s at effort max. The first hand-in of a round that passes its checks goes back once with its diff, the worker checks each requirement in its reasoning, and sending the same script again confirms it. It needs thinking on. Replayed on 23 hand-ins the lead had rejected after their checks passed, it fixed 6 of the lead's 102 defects outright and 2 in part; it also edited 8 of 22 hand-ins the lead had accepted, and nobody has checked whether that helped. It never replaces a `--check` that runs the behaviour. The `recheck:` line says what it changed.
- **`--reviewer`:** an independent review by a fresh request with no tools, off by default; leave it off: in a replay it raised a blocker or major on 17 of 22 hand-ins the lead had accepted. Where a config turns it on, its blocker and major findings go back to the worker as a failed check does, the `review:` line counts them, and `dsk show ID --review` lists them as its claims.
- **Provider:** without `--profile`, a run starts on the first provider of the route that has a free place, or on the fastest one when the config sets `route_order` to `fastest` (`dsk configure` then shows an `order:` line), and it can move to another one mid-run. The first line of the report then reads `zro after coralbricks`. `dsk reject`, `dsk answer` and `dsk continue` take `--profile NAME` to move the session to a particular one; like `dsk run --profile`, that holds it there, with no failover.
- **Owner:** `dsk` takes your session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for every command, so the Stop hook knows whose run it is. Pass `--owner` only to say otherwise.
- Globs and checks are relative to the repository root, wherever you call `dsk` from. `--file` and `--brief` paths are relative to the current directory.

### What the worker can and cannot do

- **What the worker can read:** `read()` takes any path, outside the working directory too: a dependency's source, or a file in your scratchpad that the brief names. `glob()` and `grep()` see only the working directory, plus a scratch folder of the worker's own for throwaway files. `glob()` lists a file git ignores only when the pattern names its folder, as in `shots/*.png`.
- **What the worker cannot see:** images. It reads text only, so a screenshot tells it nothing. For visual work (layout, charts, anything judged by eye) give it a script that prints measurements, such as element boxes and overlaps, and name that script in the brief.
- **What the worker's shell refuses:** git beyond reading (`status`, `diff`, `log`, `show`, `grep`, `ls-files`, `blame`, `rev-parse`), `sudo`, and the config's `sh_deny`: by default `pip install`, `npm install`, and the terraform, kubectl and helm commands that change something. Commits, installs and deploys are yours. A `--check` may contain them, because `dsk` runs it, but the worker cannot run that check itself and loses a turn finding out.

### Foreground, background and worktrees

- **Short tasks** (one scouting question, or a change to a file or two): run in the foreground with a Bash timeout of 600000 ms. If the timeout passes, the run is moved to the background and keeps going: wait for its completion notice.
- **Long, parallel or background tasks, read-only ones included** (anything larger, anything that runs beside another run, and whenever you have work of your own meanwhile): add `--worktree` and start it as a background Bash command. Keep working in the main tree and review when it reports. Start each run as its own background command, so that each gives its completion notice; for runs started together from one command, end that command with `dsk wait`: it blocks until they have stopped and prints each report.
- **What a worktree holds and hands in:** `--worktree` needs a repository with at least one commit. The worktree starts from your tree as it is now, uncommitted and untracked files included. It has no git-ignored files, so a check that needs `node_modules` or a virtualenv must create them, and a scout of logs or build output runs in place. It hands in none either: `dsk accept` applies what git tracks and the rest goes with the worktree, so a task whose product git ignores (build output, screenshots, `.env`) runs in place, and `--worktree` refuses an `--allow` that names ignored paths. A worktree run that ends `done` removes its worktree itself. After any other stop the worktree and its branch `dsk/ID` stay until `dsk accept` or `dsk reject ID --drop`, and only a `review` gets a reminder: settle each one. `dsk accept` applies the worktree as it stands: an edit you made there inside `--allow` is included, and one outside `--allow` is kept as a patch and not applied. If it answers `conflict, nothing was applied`, your tree changed a file the run changed too, and the session stays open: set your edit aside and accept again, or apply `dsk show ID --diff` by hand and drop the run. So keep your own edits to files the run may not change.
- **`dsk answer` and `dsk reject ID "..."`** start the worker again and can take as long as a run. Call them as you called the run: the same Bash timeout, in the background for a worktree session, and hands off the tree for an in-place one.

## What to do with each status

The last line of every report names the commands that are valid next.

| Status | Exit | What you do |
|---|---|---|
| `question` | 2 | Answer from your own context with `dsk answer ID "..."`. Ask the user only if you cannot. |
| `review` | 0 | Read `dsk show ID --review`. Then `dsk accept ID`, or `dsk reject ID "1. ... 2. ..."` with a numbered defect list (`--brief FILE` for a long one, `--max-turns N` to cap that round). An `ignored:` line names files the worker wrote that git ignores: no diff shows them, so open them yourself, and copy them out of a worktree before `dsk accept` deletes it. |
| `stuck`, `limit` | 3 | When the worker changed files, `dsk` ran the checks at the stop, and the `checks:` line shows whether the partial work passes them. The report's `spent:` line says where the turns went and `last:` what the worker last printed. Take over from those and the partial diff, or re-brief. `dsk accept ID` keeps the partial work, `dsk reject ID "guidance"` lets the worker continue, `dsk reject ID --drop` discards it. |
| `done` | 0 | The worker changed no files: a read-only answer, or a writable run that found nothing to change. What its shell commands wrote to git-ignored paths is not counted. The report's `answer:` stops at 1,500 characters; `dsk show ID --answer` prints all of it. Treat it as claims: open the source for any fact you will build on, and after a `--web` run check the `sources:` line. |
| `error` | 1 | Read the `error:` line. `dsk reject ID --drop` cleans up. |

**Reviewing.** In a report, `summary`, `answer`, `notes`, `question` and `open` are the worker's claims, and a `finding` line is the reviewer's; every other line is measured by `dsk`. Judge the diff against the brief yourself. For a careful change above about 150 changed lines, hand the packet to the `dsk:reviewer` subagent, unless your instructions forbid subagents. After a rejected round, `dsk show ID --review` shows only what changed since your last review. Its checks passed before that round too, so `review` says nothing about your defects, and the `caution:` line says so. Rerun the repro of each numbered defect before `dsk accept`. After two rejected rounds, take the task over. When two runs of a parallel batch come back with the same defect, add the rule to the briefs of the runs still to start.

**Never tell the user that delegated work is finished before `dsk accept`.** A run that ended `done` changed nothing and takes no accept.

## Many runs of one kind

- **Pilot one run first.** Read its `dsk show ID --log`. What it had to find out (how the check works, how to run a probe, where the tools live) will cost every later run the same turns: in one batch of 48 runs, 28 turns read the same check script and 64 wrote the same probe. Put those facts in `DSK.md`, or attach the file, and only then start the rest.
- **Scripts read `--json`, not the text.** With `--json`, `dsk run`, `answer`, `reject`, `continue`, `show` and `wait` print each report as one JSON object on one line: `id`, `status`, `checks` (each `cmd` with its exit `code`), `passed_before`, `files`, `ignored`, `why`, `summary`. The wording of the text report can change; these keys do not.
- **Every diff is still read.** `review` says that the check passed and nothing more. A script may sort a batch by status, but accept only what you have read with `dsk show ID --review`.

## Keep a session while the work is related

```
dsk continue ID [--allow GLOB]... [--check CMD]... [--max-turns N] [--profile NAME] [--recheck] [--reviewer]
             ("next task" | --brief FILE)
```

It sends the next task into a session that ended `done` or that you accepted. The worker keeps what it has read and the provider keeps its cached prefix, so a scout can go on to write what it found, and a writer can take the next step on the same code. Flags you leave out stay as they were, except that a session's first `--allow` raises its turn limit to the 30 of a writing run. Call it as you called the run.

- **Continue** when the next task builds on what this worker has read or written.
- **Start a fresh `dsk run`** when the task is unrelated, or when the report's `context:` line shows the worker near its limit or already compacted (`context: 44.1k of 48.0k · compacted 1×`). A compacted worker has dropped its old turns, so a fresh one with a precise brief does better.

## DSK.md

If the repository root has no `DSK.md`, write one once and tell the user you added it: at most 40 lines covering the layout, how to run tests and linters, and conventions. Then leave it alone, except to add a fact that a pilot run shows every later run needs. It opens every run's first message, so a stable `DSK.md` is a cached prefix.

## Closing message to the user

Say what was delegated, your verdict (accepted, rejected or dropped) and which way you checked it (fast or careful), then the turns, the cached share and the tokens from the first line of the report. The cached share is missing there when the provider does not report it.

## Other commands

- `dsk status`: this project's open sessions.
- `dsk wait [ID ...] [--timeout SECONDS] [--json]`: block until those sessions have stopped, printing each report as it comes. Without IDs: your sessions in this project that are running or were started in the last 5 seconds. It exits 0 whatever the statuses and 124 when the timeout runs out, so read each report.
- `dsk bench`: time each provider now, fastest first; with `route_order` set to `fastest`, runs do this by themselves.
- `dsk stats [ID ...]`: what sessions measured: where the turns went, tokens, seconds per turn and per provider. Look here when runs feel slow.
- `dsk show ID [--review | --diff | --log | --answer | --json]`: the review packet, the whole diff, tokens and actions per turn, the whole answer, or the report as JSON.
- `dsk search "query"` and `dsk fetch URL`: raw web search and page fetch, with no model.
- `dsk doctor`: check each provider profile.
