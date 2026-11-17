# dsk: reference

`SKILL.md` holds what every run needs. This file holds the rest: read the section you are about to use, or the one a report, an error or `SKILL.md` points you to.

## Who does what

- **The worker scouts and writes.** Scouting: where something lives, how a flow runs, what many files or logs say, sourced web research. Writing: features and fixes from your plan, boilerplate, mechanical edits across many files, and tests when the change is careful.
- **You plan, orchestrate, verify and decide.** Split the work into bounded steps, settle the design and put the decision in the brief, run steps side by side, review every diff, check every claim, and choose what to accept.
- **Do it yourself** when the change is shorter than its brief, is security-sensitive (authentication, cryptography, secrets, permissions), or needs the user's credentials.

## The loop

1. **Scout** with read-only runs, one question each, until you can plan without guessing.
2. **Plan.** Give each step its files (`--allow`), a check (`--check`) and what done looks like.
3. **Write**, one run per step. Steps that touch different files run side by side with `--worktree`.
4. **Verify.** Read each diff against its brief, then `dsk accept` or `dsk reject`.

## How much to check: fast by default

Most of a change's time goes to waiting for the provider, turn after turn, and to review rounds.

- **Fast (the default).** The brief asks for the code, not for tests. Give one quick `--check`: the fastest command that shows the code runs (a compile, an import, a lint, or an existing test command that takes under a minute). Read the diff yourself, with no reviewer subagent. A compile check does not start the program: for UI wiring or lifecycle code, put a launch or smoke command in the check, or try the result yourself before `dsk accept`.
- **Careful.** Only when a mistake could lose, revert or delete the user's data or files (migrations, installers, anything that removes or overwrites), or when the user asks: the brief also asks for tests that fail without the change, the check runs them, and the `dsk:reviewer` subagent reads any diff above about 150 changed lines.

## Rules that cost work when broken

- **Hands off the tree until an in-place run stops.** This holds for every run without `--worktree` in a git repository, read-only runs included. A worker script that starts a shell command, and each check, is charged with every change made while it runs: one outside `--allow` is undone (a copy is kept in the session directory), one inside it counts as the worker's, whoever made it. Without `--allow` that is every change. You cannot tell when those windows are open, so make no edits until the run reports.
- **One in-place run per tree.** A second run without `--worktree` is refused while the first is working, and so are `dsk accept` of a worktree session and `accept`, `reject`, `answer` or `continue` of any session that works in that tree. Wait, or use `--worktree`.
- **Run dsk bare.** Put no `| head`, `| tail` or other pipe after a dsk command: the pipe's exit code replaces dsk's, so a stuck or failed run looks like exit code 0, also in a background notice.

## The brief and what you attach

- **Brief:** two to five lines saying what to produce and what done looks like. Structure goes in the flags; project facts go in `DSK.md`. Name files and functions by path: the worker asks when a task cannot be done as written, but when a name fits two things it picks the likelier one without saying so.
- **Acceptance items:** for a careful change, or one whose diff will run past about 150 lines, end the brief with numbered items, `A1.`, `A2.` and so on, and add `--recheck`; "Careful changes" below says how to write them.
- **Scouting brief:** one question, the directories or files to look in, and the form of the answer (`file:line` and one line per finding, at most 40 lines). A narrow question is one the worker can answer by searching: one that makes it print everything is cut off at the output limit.
- **Review or analysis brief** (a read-only run whose product is one long answer): give the form of a finding and a cap (at most 10, one line each), and ask for a snippet copied from the source in each, so that you can grep what it claims. Pass `--effort low`, whatever the config says: the worker works such an answer out in one reply, and of the other efforts `off` read its attached files again until the turn limit and `max` was cut off at the reply limit (the numbers are below).
- **`--file`:** over half of all worker turns only read, and each costs seconds of waiting, so attach what the worker must read: a whole file with `--file PATH` (`-` is stdin), or just the lines that matter with `--file PATH:A-B` (find them with grep first). A turn that only reads shows the worker up to 24,000 characters, any other turn 6,000. When a long run is compacted, a file of up to 4,000 characters stays attached and larger ones stay in the order given while there is room, so attach first what the worker needs most, and keep instructions in the brief. `reject`, `continue` and `answer` take no `--file`: put new material in their text or `--brief FILE`.

## What the run may do

- **`--allow`:** the paths the worker may change, as narrow as the task permits. `*` stays inside one directory, `**` crosses them. Without `--allow` the run is read-only, and `--allow` needs a git repository. This stops a mistaken worker, not a hostile one: `write()` and `edit()` refuse other paths, `dsk` undoes changes to any other file git does not ignore, and on macOS a sandbox keeps the writes of scripts and checks inside the working directory, `$DSK_SCRATCH`, the temp folders and the build caches. Git-ignored files in the tree (`.env`, `node_modules`) stay writable, and without the sandbox (Linux, or a report line `sandbox: off`) shell commands can change paths outside the repository too.
- **`--check`:** give one for any change. `dsk` runs it itself and reaches `review` only when it passes. Each check may run for 600 seconds, and the first one that fails stops the rest. It runs in the sandbox: point its output into the tree or `$DSK_SCRATCH`, not at your scratchpad; for `sandbox_apply: Operation not permitted`, see "The sandbox" below. A `caution:` line in the report means the worker saw that check pass before it changed anything, so it cannot show that the task was done: verify the change another way.
- **`--web`:** search and fetch, for research. It needs the search key, a DeepSeek API key: when `dsk` answers `web search needs the key ...`, research with your own tools, or tell the user to add that key. Leave it off for tasks that also run commands in a repository with secrets.
- **`--max-turns`:** 30 by default for a run with `--allow`, 12 for a read-only one. A run that uses them up stops as `limit`, and so does one past the config's time or token limit. A reject or a continue starts a fresh budget; an answer does not. `dsk reject --max-turns N` holds for that round only. Leave the default unless you want a short probe: of 25 runs capped at 18 turns, 6 used every one.
- **`--effort`:** how hard the worker thinks: `off`, `low`, `high` or `max`. A run that names none takes `effort` from the user's config (`dsk configure` shows it), and no thinking when the config has none. An effort in the config is the user's choice: leave the flag out, and do not lower it to save time, except for a review or analysis brief (above). When the config sets none, add `--effort` only for briefs that need judgment. A session keeps its effort through `continue`, `reject` and `answer`; after a reply that was still going at the reply limit, `dsk` sends the rest of that round at `low`.
- **`--recheck`, `--reviewer`:** both off by default. `--recheck`, a second look by the worker, is for a careful change or a diff past about 150 lines (see "Careful changes" below). Leave `--reviewer` off: it is a review by a request with no tools, not the `dsk:reviewer` subagent, and in a replay it raised a blocker or major on 17 of 22 hand-ins the lead had accepted.
- **`--profile NAME`:** hold a run on one provider, with no failover; `reject`, `answer` and `continue` take it too, to move a session. Without it `dsk` picks the provider and can move mid-run: the report then begins `zro after coralbricks`.
- Globs and checks are relative to the repository root, wherever you call `dsk` from. `--file` and `--brief` paths are relative to the current directory.

## What the worker can and cannot do

- **It can read** any path with `read()`, outside the working directory too: a dependency's source, or a file in your scratchpad that the brief names. `glob()` and `grep()` see only the working directory and the worker's own scratch folder, and `glob()` lists a file git ignores only when the pattern names its folder, as in `shots/*.png`.
- **It cannot see images.** For visual work (layout, charts, anything judged by eye) give it a script that prints measurements, such as element boxes and overlaps, and name that script in the brief.
- **Its shell refuses** git beyond reading (`status`, `diff`, `log`, `show`, `grep`, `ls-files`, `blame`, `rev-parse`), `sudo`, and the config's `sh_deny`: by default `pip install`, `npm install`, and the terraform, kubectl and helm commands that change something. Commits, installs and deploys are yours. A `--check` may contain them, because `dsk` runs it, but the worker cannot run that check itself and loses a turn finding out.

## Foreground, background and worktrees

- **Short tasks** (one scouting question, or a change to a file or two): run in the foreground with a Bash timeout of 600000 ms. If the timeout passes, the run is moved to the background and keeps going: wait for its completion notice.
- **Long, parallel or background tasks, read-only ones included:** add `--worktree` and start each run as its own background Bash command, so that each gives its completion notice, and keep working in the main tree. For runs started together from one command, end that command with `dsk wait`: it blocks until they have stopped and prints each report.
- **What a worktree holds:** your tree as it is now, uncommitted and untracked files included (the repository needs one commit), but no git-ignored files: a check that needs `node_modules` or a virtualenv must create them, and a scout of logs or build output runs in place.
- **What a worktree hands in:** `dsk accept` applies what git tracks and the rest goes with the worktree, so a task whose product git ignores (build output, screenshots, `.env`) runs in place. A worktree run that ends `done` removes its worktree itself. After any other stop the worktree and its branch `dsk/ID` stay until `dsk accept` or `dsk reject ID --drop`, and only a `review` gets a reminder: settle each one.
- **Your edits and a worktree:** keep your own edits to files the run may not change. `dsk accept` applies the worktree as it stands: an edit you made there inside `--allow` is included, one outside it is kept as a patch and not applied. If it answers `conflict, nothing was applied`, your tree changed a file the run changed too: set your edit aside and accept again, or apply `dsk show ID --diff` by hand and drop the run.
- **`dsk answer` and `dsk reject ID "..."`** start the worker again and can take as long as a run. Call them as you called the run: the same Bash timeout, in the background for a worktree session, and hands off the tree for an in-place one.

## What to do with each status

The last line of every report names the commands that are valid next.

| Status | Exit | What you do |
|---|---|---|
| `question` | 2 | Answer from your own context with `dsk answer ID "..."`. Ask the user only if you cannot. |
| `review` | 0 | Read `dsk show ID --review`. Then `dsk accept ID`, or `dsk reject ID "1. ... 2. ..."` with a numbered defect list (`--brief FILE` for a long one). An `ignored:` line names files the worker wrote that git ignores: no diff shows them, so open them yourself, and copy them out of a worktree before `dsk accept` deletes it. |
| `stuck`, `limit` | 3 | The `checks:` line shows whether the partial work passes the checks, `spent:` where the turns went and `last:` what the worker last printed. Take over from those and the partial diff, or re-brief. `dsk accept ID` keeps the partial work, `dsk reject ID "guidance"` lets the worker continue, `dsk reject ID --drop` discards it. |
| `done` | 0 | The worker changed no files (what its shell commands wrote to git-ignored paths is not counted). The report's `answer:` stops at 1,500 characters; `dsk show ID --answer` prints all of it. Treat it as claims: open the source for any fact you will build on, and after a `--web` run check the `sources:` line. |
| `error` | 1 | Read the `error:` line. `dsk reject ID --drop` cleans up. |

**Reviewing.** In a report, `summary`, `answer`, `notes`, `question` and `open` are the worker's claims, and a `finding` line is the reviewer's; every other line is measured by `dsk`. Judge the diff against the brief yourself; for a careful change above about 150 changed lines, hand the packet to the `dsk:reviewer` subagent, unless your instructions forbid subagents. After a rejected round, `dsk show ID --review` shows only what changed since your last review, and its checks passed before that round too, so `review` says nothing about your defects: rerun the repro of each one before `dsk accept`. After two rejected rounds, take the task over. When two runs of a parallel batch come back with the same defect, add the rule to the briefs of the runs still to start.

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

It sends the next task into a session that ended `done` or that you accepted. The worker keeps what it has read and the provider its cached prefix, so a scout can go on to write what it found, and a writer can take the next step on the same code. Flags you leave out stay as they were, except that a session's first `--allow` raises its turn limit to 30. Call it as you called the run. Start a fresh `dsk run` instead when the task is unrelated, or when the report's `context:` line shows the worker near its limit or already compacted (`context: 44.1k of 48.0k · compacted 1×`): a compacted worker has dropped its old turns.

## DSK.md

If the repository root has no `DSK.md`, write one once and tell the user you added it: at most 40 lines covering the layout, how to run tests and linters, and conventions. Then leave it alone, except to add a fact that a pilot run shows every later run needs. It opens every run's first message, so a stable `DSK.md` is a cached prefix.

## Closing message to the user

Say what was delegated, your verdict (accepted, rejected or dropped) and which way you checked it (fast or careful), then the turns, the cached share and the tokens from the first line of the report. The cached share is missing there when the provider does not report it.

## Other commands

- `dsk status`: this project's open sessions.
- `dsk wait [ID ...] [--timeout SECONDS] [--json]`: block until those sessions, or without IDs your running ones in this project, have stopped, printing each report. It exits 0 whatever the statuses and 124 at the timeout, so read each report.
- `dsk show ID [--review | --diff | --log | --answer | --json]`: the review packet, the whole diff, tokens and actions per turn, the whole answer, or the report as JSON.
- `dsk stats [ID ...]`: where the turns went, tokens, seconds per turn and per provider. Look here when runs feel slow; `dsk bench` times each provider now.
- `dsk search "query"`, `dsk fetch URL`: raw web search and page fetch, with no model. `dsk doctor`: check each provider profile.

## Careful changes

A change is careful when a mistake could lose, revert or delete the user's data or files, or when the user asks.

- **Acceptance items:** for a careful change, or one whose diff will run past about 150 lines, end the brief with numbered items, `A1.`, `A2.` and so on: you review against them, and the second look goes through them one by one. Give each one behaviour with concrete values: not "handles errors" but "on a timeout, retries 3 times, 2 seconds apart, then exits 1". Add one edge case and one thing that must not change. Whatever can be run belongs in a `--check`, not in an item. For a task that changes or deletes state, also ask what happens if it runs twice, stops halfway, or an outside call fails; what it changes outside its target; and whether it prints or stores a secret.
- **`--recheck`:** the first hand-in of a round that passes its checks goes back once with its diff, the worker checks each requirement in its reasoning, and sending the same script again confirms it. Use it for a careful change, or one whose diff will run past about 150 lines: below that, reading the diff yourself costs less than the extra turn, a median of 84 s at effort max. It needs thinking on, and never replaces a `--check` that runs the behaviour. The report's `recheck:` line says what it changed; `--no-recheck` turns off one that the config or the session turned on.
- **What the second look measured:** replayed on 23 hand-ins the lead had rejected after their checks passed, it fixed 6 of the lead's 102 defects outright and 2 in part. It also edited 8 of 22 hand-ins the lead had accepted, and nobody has checked whether that helped.
- **`--reviewer`:** where a config turns it on, its blocker and major findings go back to the worker as a failed check does, the `review:` line counts them, and `dsk show ID --review` lists them as its claims. In a replay it raised a blocker or major on 17 of 22 hand-ins the lead had accepted, 46 findings in all, and its findings fell within three lines of 5 of the 40 lead defects that name a file and line. It would send most hand-ins back, so leave it off unless the user's config turns it on.

## Review and analysis briefs: why `--effort low`

A brief that attaches its files and asks for one long answer makes the worker work the whole answer out in one reply. Measured on one day on 30 review runs over this plugin's own sources, each with its files attached and a reply limit of 900 s. The briefs differed between the efforts, so read it as a pattern, not as a comparison:

- `off`, 8 runs: turns of 2 to 4 s, but 7 read the attached files again until the 12-turn limit; 6 of those handed in after a reject.
- `low`, 20 runs: 19 answered, the first reply after 165 to 765 s; one was cut off at its 32,000-token cap.
- `high`, one run: the first reply came after 748 s.
- `max`, one run, on a brief with two questions: cut off at the reply limit twice in a row, with nothing kept.

In the 42 sessions logged before that day, all 22 cut-off replies were cut by the reply limit (`limits.reply_seconds`), every one in a read-only review at effort max: 19,204 s, 38% of the model time, and the turn after such a reply was cut again more often than not. So after one, `dsk` sends the rest of the round at `low`; whether that rescues a round has not yet been seen on a real provider. A read-only run that answers in plain text, with no `done()`, is taken at its word: the text is its answer.

## The `caution:` line

It means the worker saw that check pass before it changed anything, so the check cannot show that the task was done. The line appears only when the worker happened to run the check before its first change, so a report without it says nothing about the check. In a round started by a reject, it means the check already passed before that round.

## Providers and owner

- **Provider:** without `--profile`, a run starts on the first provider of the route that has a free place, or on the fastest one when the config sets `route_order` to `fastest` (`dsk configure` then shows an `order:` line), and it can move to another one mid-run. The first line of the report then reads `zro after coralbricks`. `dsk reject`, `dsk answer` and `dsk continue` take `--profile NAME` to move the session to a particular one; like `dsk run --profile`, that holds it there, with no failover.
- **Owner:** `dsk` takes your session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for every command, so the Stop hook knows whose run it is. Pass `--owner` only to say otherwise.
- **`dsk wait` without IDs** waits for your sessions in this project that are running or were started in the last 5 seconds.

## The sandbox

On macOS the worker's scripts, every `sh()` command and every `--check` run under `sandbox-exec`.

- **Writing is allowed** in the working directory, in `$DSK_SCRATCH`, in the temp folders and in the build caches (`~/Library/Caches`, `~/.cache`, `~/.npm`, `~/go/pkg/mod`, Xcode's DerivedData, SwiftPM's folder, and the config's `sandbox_write`).
- **Writing is refused** everywhere else, in `.git` (its hooks and config would run code outside the sandbox), and in the scratchpads of other Claude sessions under the temp folder. So a check's output goes into the tree or `$DSK_SCRATCH`, not to your scratchpad.
- **Reading is refused** for dsk's keys (`~/.config/dsk` and the file where the plugin's form stores them), `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.docker`, `~/.kube`, the Keychains, and the config's `sandbox_hide`.
- **Not covered:** the network, and git-ignored files inside the tree (`.env`, `node_modules`), which stay writable.
- **No sandbox:** on Linux, after a report line `sandbox: off: why`, with `--no-sandbox`, or with `"sandbox": "off"` in the config, which prints no line. Shell commands can then change paths outside the repository too, and `dsk` undoes only what git sees inside it. Outside a git repository nothing is undone.
- **A tool that starts a sandbox of its own** fails inside this one with `sandbox_apply: Operation not permitted`, because macOS will not nest them. Give SwiftPM `--disable-sandbox` (`swift build --disable-sandbox`); for anything else, run the task with `--no-sandbox`.
