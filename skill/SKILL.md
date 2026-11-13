---
name: dsk
description: Delegate bounded, checkable work to a DeepSeek worker through the dsk CLI, then review what it hands in. Use for tests for existing code, boilerplate, mechanical edits across many files, reading many files or logs to answer a question, and sourced web research. Not for design decisions, security-sensitive changes, or anything that needs the user's credentials.
allowed-tools:
  - Bash(dsk *)
  - Bash(${CLAUDE_SKILL_DIR}/bin/dsk *)
  - Bash(${CLAUDE_SKILL_DIR}/scripts/dsk.py *)
---

# dsk: you plan and review, DeepSeek writes

`dsk` hands one bounded task to a DeepSeek worker and prints a short report. Nothing the worker produces counts as finished until you have reviewed it and run `dsk accept`. A Stop hook sends you back to any session you started that is still waiting for review.

`dsk` is on PATH while the plugin is enabled. If the shell does not find it, use `${CLAUDE_SKILL_DIR}/bin/dsk` in its place.

If a command fails with `... is not set`, dsk has no provider yet. Do not ask for a key in the chat. Tell the user to run the `/plugin configure ...` command the error names, which asks for a DeepSeek API key, or for a custom endpoint, model and key, and then to restart Claude Code. `dsk configure` shows how dsk is set up.

## When to delegate

- **Yes:** bounded work with a result you can check. Tests for existing code, boilerplate, mechanical edits across many files, reading many files or logs to answer a question, sourced web research.
- **No:** design decisions, security-sensitive changes, anything that needs the user's credentials.

## How

```
dsk run [--allow GLOB]... [--check CMD]... [--file PATH]... [--web] [--worktree]
        [--effort low|high|max] "brief"
```

- **Brief:** two to five lines saying what to produce and what done looks like. Structure goes in the flags; project facts go in `DSK.md`. Name files and functions by path: the worker asks when a task cannot be done as written, but when a name fits two things it picks the likelier one without saying so.
- **`--allow`:** the only paths the worker may change. Make it as narrow as the task permits. `*` stays inside one directory, `**` crosses them. Without `--allow` the run is read-only.
- **`--check`:** give at least one for any change. `dsk` runs it itself and reaches `review` only when it passes.
- **`--file`:** attach what the worker must read (`-` is stdin), so it spends no turn fetching it. A file of up to 4,000 characters stays attached for the whole run; a larger one is dropped if a long run is compacted, so keep instructions in the brief or in a small file.
- **`--web`:** search and fetch, for research. Leave it off for tasks that also run commands in a repository with secrets.
- **Owner:** `dsk` takes your session from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for every command, so the Stop hook knows whose run it is. Pass `--owner` only to say otherwise.
- **`--effort`:** only for briefs that need judgment. The default is no thinking.
- Paths, globs and checks are relative to the repository root, wherever you call `dsk` from.
- **Short tasks:** run in the foreground with a Bash timeout of 600000 ms, and do not touch the tree until it returns. If the timeout passes, the run is moved to the background and keeps going: wait for its completion notice. While one of the worker's shell commands is running, any change outside `--allow` is undone (a copy is kept in the session directory), whoever made it.
- **Long or parallel tasks:** add `--worktree` and start it as a background Bash command. Keep working in the main tree and review when it reports. A worktree has no git-ignored files, so a check that needs `node_modules` or a virtualenv must create them.
- **One in-place run per tree.** A second run without `--worktree` is refused while the first is working, and so is `dsk accept` of a worktree session. Wait, or use `--worktree`.

## What to do with each status

The last line of every report names the commands that are valid next.

| Status | Exit | What you do |
|---|---|---|
| `question` | 2 | Answer from your own context with `dsk answer ID "..."`. Ask the user only if you cannot. |
| `review` | 0 | Read `dsk show ID --review`. Then `dsk accept ID`, or `dsk reject ID "1. ... 2. ..."` with a numbered defect list. |
| `stuck`, `limit` | 3 | Take over from the notes and partial diff in the report, or re-brief. `dsk accept ID` keeps the partial work, `dsk reject ID "guidance"` lets the worker continue, `dsk reject ID --drop` discards it. |
| `done` | 0 | A read-only answer. Treat it as claims: check the `sources:` line and open the source for any fact you will build on. |
| `error` | 1 | Read the `error:` line. `dsk reject ID --drop` cleans up. |

**Reviewing.** In a report, `summary`, `answer`, `notes` and `question` are the worker's claims; every other line is measured by `dsk`. Judge the diff against the brief yourself when it is under about 150 changed lines. Above that, hand the packet to the `dsk:reviewer` subagent, unless your instructions forbid subagents, in which case review it yourself. After a rejected round, `dsk show ID --review` shows only what changed since your last review. After two rejected rounds, take the task over.

**Never tell the user that delegated work is finished before `dsk accept`.**

## DSK.md

If the repository root has no `DSK.md`, write one once: at most 40 lines covering the layout, how to run tests and linters, and conventions. Then leave it alone. It opens every run's first message, so a stable `DSK.md` is a cached prefix.

## Closing message to the user

Say what was delegated, the verdict, the turns, the cached share and the tokens. All of them are on the first line of the report.

## Other commands

- `dsk status`: this project's open sessions.
- `dsk show ID [--diff | --log | --answer]`: the whole diff, tokens and actions per turn, or the whole answer.
- `dsk search "query"` and `dsk fetch URL`: raw web search and page fetch, with no model.
- `dsk doctor`: check each provider profile.
