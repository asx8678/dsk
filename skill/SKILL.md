---
name: delegate
description: Hand the hands-on work to a DeepSeek worker through the dsk CLI, and keep planning, orchestration, review and decisions for yourself. Use it by default to scout a codebase (find where things live, trace a flow, read many files or logs), to write code from your plan (features, fixes, tests, boilerplate, mechanical edits), and for sourced web research. Do the work yourself only when a change is shorter than its brief, is security-sensitive, or needs the user's credentials.
allowed-tools:
  - Bash(dsk *)
  - Bash(${CLAUDE_SKILL_DIR}/bin/dsk *)
---

# dsk: you plan and verify, DeepSeek does the work

`dsk` hands one bounded task to a DeepSeek worker and prints a short report. The worker scouts and writes; you plan, brief, review and decide. Do the work yourself when the change is shorter than its brief, is security-sensitive, or needs the user's credentials.

```
dsk run [--allow GLOB]... [--check CMD]... [--file PATH]... [--web] [--worktree] [--no-sandbox]
        [--effort off|low|high|max] [--max-turns N] [--profile NAME] [--recheck] [--reviewer] ("brief" | --brief FILE)
```

- **Scout** (no `--allow`, so read-only): one question, where to look, and the form of the answer.
- **Write:** `--allow` the narrowest paths and give one quick `--check` (a compile, a lint, or a test command under a minute). The brief is two to five lines: what to produce and what done looks like, with files and functions named by path. Attach what the worker must read with `--file PATH` or `--file PATH:A-B`.
- **Short task:** run it in the foreground with a Bash timeout of 600000 ms. **Long, parallel or background:** add `--worktree` and start it as a background Bash command.

## Rules that cost work when broken

- **Nothing is finished before `dsk accept`.** Read `dsk show ID --review` against the brief first, and never tell the user that delegated work is done before the accept. A run that ended `done` changed nothing and takes no accept.
- **Hands off the tree** while a run without `--worktree` is working, read-only runs included: a change made meanwhile is undone or counted as the worker's.
- **Run dsk bare.** No `| head`, `| tail` or other pipe after a dsk command: the pipe's exit code replaces dsk's.
- **Settle every stop.** The Stop hook reminds you of `review` only. A run that stopped as `question`, `stuck`, `limit` or `error` keeps its partial edits, or its worktree and branch, until `dsk accept ID` or `dsk reject ID --drop`.
- **A report is claims and measurements.** `summary`, `answer`, `notes` and `question` are the worker's claims: open the source for any fact you will build on. Its last line, `next:`, names the commands that are valid now.

## After the report

| Status | What you do |
|---|---|
| `review` | `dsk accept ID`, or `dsk reject ID "1. ... 2. ..."` with a numbered defect list. After two rejected rounds, take the task over. |
| `done` | The answer is in `dsk show ID --answer`. `dsk continue ID "next task"` sends the same worker on. |
| `question` | `dsk answer ID "..."` from your own context; ask the user only if you cannot. |
| `stuck`, `limit`, `error` | Take over from the partial diff, let the worker go on with `dsk reject ID "guidance"`, or `dsk reject ID --drop`. |

If the shell does not find `dsk`, use `${CLAUDE_SKILL_DIR}/bin/dsk`. If a command fails with `... is not set`, tell the user to run the `/plugin configure ...` command it names and to restart Claude Code; do not ask for a key in the chat. If the repository root has no `DSK.md`, write one (at most 40 lines: layout, checks, conventions) and tell the user. Close with what was delegated, your verdict, and the turns, cached share and tokens from the report's first line.

## Read `${CLAUDE_SKILL_DIR}/REFERENCE.md` first when

- a mistake could lose, revert or delete the user's data or files, or a diff will pass about 150 lines (careful changes, acceptance items, `--recheck`, the `dsk:reviewer` subagent);
- the brief asks for a review or an analysis (which `--effort` answers);
- you start several runs of one kind, use `--worktree` for work that git ignores, or keep a session with `dsk continue`;
- a flag, a status, a report line (`caution:`, `ignored:`, `sandbox:`) or a refusal is not covered above.
