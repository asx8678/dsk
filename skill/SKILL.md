---
name: dsk
description: Hand the hands-on work to a DeepSeek worker through the dsk CLI, and keep planning, orchestration, review and decisions for yourself. Use it by default to scout a codebase (find where things live, trace a flow, read many files or logs), to write code from your plan (features, fixes, tests, boilerplate, mechanical edits), and for sourced web research. Do the work yourself only when a change is shorter than its brief, is security-sensitive, or needs the user's credentials.
allowed-tools:
  - Bash(dsk *)
  - Bash(${CLAUDE_SKILL_DIR}/bin/dsk *)
  - Bash(${CLAUDE_SKILL_DIR}/scripts/dsk.py *)
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

- **Fast (the default).** The brief asks for the code, not for tests. Give one quick `--check`: the fastest command that shows the code runs (a compile, an import, a lint, or an existing test command that takes under a minute). Read the diff yourself. No reviewer subagent.
- **Careful.** Only when a mistake could lose, revert or delete the user's data or files (migrations, installers, anything that removes or overwrites), or when the user asks: the brief also asks for tests that fail without the change, the check runs them, and the `dsk:reviewer` subagent reads any diff above about 150 changed lines.

Say in your closing message which of the two you used.

## How

```
dsk run [--allow GLOB]... [--check CMD]... [--file PATH]... [--web] [--worktree]
        [--effort low|high|max] [--max-turns N] [--profile NAME] ("brief" | --brief FILE)
```

- **Brief:** two to five lines saying what to produce and what done looks like. Structure goes in the flags; project facts go in `DSK.md`. Name files and functions by path: the worker asks when a task cannot be done as written, but when a name fits two things it picks the likelier one without saying so.
- **Scouting brief:** one question, the directories or files to look in, and the form of the answer (`file:line` and one line per finding, at most 40 lines). A narrow question is one the worker can answer by searching: one that makes it print everything is cut off at the output limit.
- **Long files:** over half of all worker turns only read. A turn that only reads shows the worker up to 24,000 characters, any other turn 6,000, and each turn costs seconds of waiting. So attach what the worker must know instead of letting it look: a whole file with `--file PATH`, or just the lines that matter with `--file PATH:A-B` (find them with grep first).
- **`--allow`:** the paths the worker may change. Make it as narrow as the task permits. `*` stays inside one directory, `**` crosses them. Without `--allow` the run is read-only. This stops a mistaken worker, not a hostile one: `write()` and `edit()` refuse other paths, and `dsk` undoes changes to any other file git does not ignore, but the worker's shell commands can still change git-ignored files (`.env`, `node_modules`) and paths outside the repository. Outside a git repository nothing is undone.
- **`--check`:** give one for any change. `dsk` runs it itself and reaches `review` only when it passes.
- **`--file`:** attach what the worker must read (`-` is stdin), so it spends no turn fetching it. A file of up to 4,000 characters stays attached for the whole run; a larger one is dropped if a long run is compacted, so keep instructions in the brief or in a small file.
- **`--web`:** search and fetch, for research. Leave it off for tasks that also run commands in a repository with secrets.
- **Owner:** `dsk` takes your session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for every command, so the Stop hook knows whose run it is. Pass `--owner` only to say otherwise.
- **`--effort`:** only for briefs that need judgment. The default is no thinking.
- **`--max-turns`:** 12 by default. A run that uses them up stops as `limit`, and so does one past the time or token limit in the config.
- Globs and checks are relative to the repository root, wherever you call `dsk` from. `--file` and `--brief` paths are relative to the current directory.
- **Short tasks:** run in the foreground with a Bash timeout of 600000 ms. If the timeout passes, the run is moved to the background and keeps going: wait for its completion notice.
- **Hands off the tree until an in-place run stops.** This holds for every run without `--worktree` in a git repository, read-only runs included. Each worker script that starts a shell command is charged with every change made from its start to its end, and so are the checks: a change outside `--allow` is undone (a copy is kept in the session directory) and a change inside it counts as the worker's, whoever made it. Without `--allow` that is every change. You cannot tell when those windows are open, so make no edits until the run reports.
- **Long, parallel or background tasks, read-only ones included:** add `--worktree` and start it as a background Bash command. Keep working in the main tree and review when it reports. A worktree has no git-ignored files, so a check that needs `node_modules` or a virtualenv must create them, and a scout of logs or build output runs in place. A worktree run that ends `done` removes its worktree itself; one that ends `stuck`, `limit` or `error` keeps it until `dsk reject ID --drop`.
- **One in-place run per tree.** A second run without `--worktree` is refused while the first is working, and so is `dsk accept` of a worktree session. Wait, or use `--worktree`.
- **`dsk answer` and `dsk reject ID "..."`** start the worker again and can take as long as a run. Call them as you called the run: the same Bash timeout, in the background for a worktree session, and hands off the tree for an in-place one.

## What to do with each status

The last line of every report names the commands that are valid next.

| Status | Exit | What you do |
|---|---|---|
| `question` | 2 | Answer from your own context with `dsk answer ID "..."`. Ask the user only if you cannot. |
| `review` | 0 | Read `dsk show ID --review`. Then `dsk accept ID`, or `dsk reject ID "1. ... 2. ..."` with a numbered defect list (`--brief FILE` for a long one). |
| `stuck`, `limit` | 3 | The report's `spent:` line says where the turns went and `last:` what the worker last printed. Take over from those and the partial diff, or re-brief. `dsk accept ID` keeps the partial work, `dsk reject ID "guidance"` lets the worker continue, `dsk reject ID --drop` discards it. |
| `done` | 0 | The worker changed no files: a read-only answer, or a writable run that found nothing to change. The report's `answer:` stops at 1,500 characters; `dsk show ID --answer` prints all of it. Treat it as claims: open the source for any fact you will build on, and after a `--web` run check the `sources:` line. |
| `error` | 1 | Read the `error:` line. `dsk reject ID --drop` cleans up. |

**Reviewing.** In a report, `summary`, `answer`, `notes` and `question` are the worker's claims; every other line is measured by `dsk`. Judge the diff against the brief yourself. For a careful change above about 150 changed lines, hand the packet to the `dsk:reviewer` subagent, unless your instructions forbid subagents. After a rejected round, `dsk show ID --review` shows only what changed since your last review. After two rejected rounds, take the task over.

**Never tell the user that delegated work is finished before `dsk accept`.**

## Keep a session while the work is related

```
dsk continue ID [--allow GLOB]... [--check CMD]... [--max-turns N] "next task"
```

It sends the next task into a session that ended `done` or that you accepted. The worker keeps what it has read and the provider keeps its cached prefix, so a scout can go on to write what it found, and a writer can take the next step on the same code. Flags you leave out stay as they were. Call it as you called the run.

- **Continue** when the next task builds on what this worker has read or written.
- **Start a fresh `dsk run`** when the task is unrelated, or when the report's `context:` line shows the worker near its limit or already compacted (`context: 44.1k of 48.0k · compacted 1×`). A compacted worker has dropped its old turns, so a fresh one with a precise brief does better.

## DSK.md

If the repository root has no `DSK.md`, write one once and tell the user you added it: at most 40 lines covering the layout, how to run tests and linters, and conventions. Then leave it alone. It opens every run's first message, so a stable `DSK.md` is a cached prefix.

## Closing message to the user

Say what was delegated and your verdict (accepted, rejected or dropped), then the turns, the cached share and the tokens from the first line of the report. The cached share is missing there when the provider does not report it.

## Other commands

- `dsk status`: this project's open sessions.
- `dsk bench`: time each provider now, fastest first. With `route_order` set to `fastest` in the config, runs do this by themselves and start on the fastest provider that has a free place.
- `dsk stats [ID ...]`: what sessions measured: where the turns went, tokens, seconds per turn and per provider. Look here when runs feel slow.
- `dsk show ID [--diff | --log | --answer]`: the whole diff, tokens and actions per turn, or the whole answer.
- `dsk search "query"` and `dsk fetch URL`: raw web search and page fetch, with no model.
- `dsk doctor`: check each provider profile.
