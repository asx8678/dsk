# Commands

Every `dsk` command and flag, what a report looks like as text, and the same report as JSON.

```
dsk run [--allow GLOB]... [--check CMD]... [--file PATH[:A-B]]... [--web] [--worktree] [--no-sandbox]
        [--effort off|low|high|max] [--profile NAME]
        [--max-turns N]    (default: 30 with --allow, 12 without)
        [--owner ID]       (default: $CLAUDE_CODE_SESSION_ID, which Claude Code sets for every command)
        "brief"            (or --brief FILE)
        [--json]           (also for answer, reject, continue, show and wait: the report as one JSON object)
dsk answer ID "text"       reply to the worker's question; the run continues (or --brief FILE, as for run)
        [--profile NAME]   (also for reject and continue: move the session to that provider and hold it there)
dsk show   ID [--review | --diff | --log | --answer | --json]
dsk accept ID              mark as reviewed; after --worktree, apply the changes to the main tree
dsk reject ID "defects"    send defects back into the same session; the run continues (or --brief FILE)
        [--max-turns N]    (the turns of the round this starts, and of that round only)
dsk reject ID --drop       discard the work
dsk continue ID "task"     send the next task into a session that is done or accepted; the worker keeps its context
        [--allow GLOB]... [--check CMD]... [--max-turns N]     (each replaces the run's; left out, it stays)
dsk status [--hook]        this project's open sessions; --hook is the Claude Code Stop hook
dsk wait [ID ...]          block until those sessions (default: yours in this project, running or just started) have stopped,
        [--timeout SECONDS]    printing each report as it comes; exit 124 when the time is up
dsk status --json          the last day's sessions on any project, as JSON, for a display to poll
dsk stats [ID ...]         what sessions measured: outcomes, where the turns went, tokens, time, per profile
        [--days 7] [--project] [--sessions] [--json]
dsk search "query"         raw web search, no model
dsk fetch URL              raw page fetch, no model
dsk doctor [--profile NAME]
dsk bench [--profile NAME]... [--json]     time each provider now with two small requests, fastest first
dsk configure              how dsk is set up: the route, and whether each provider has its key
```

## A report

```
dsk 7f3a · review · thirdparty · 3 turns · in 5.5k (90% cached) · out 1.5k
summary: Added 22 tests for parse_duration and format_duration; all pass.
checks:  python3 -m unittest discover -s tests → 0
changed: tests/test_durations.py (+128)
context: 7.1k of 48.0k
next:    dsk show 7f3a --review | dsk accept 7f3a | dsk reject 7f3a "defects"
```

## JSON

With `--json`, `run`, `answer`, `reject`, `continue`, `show` and `wait` print one JSON object per report on stdout and nothing else there; an error is `{"error": "..."}`. The object holds what `status --json` gives for a job (see [Progress](internals.md#progress)) and the rest of the report: `left` (the profiles the session moved away from), `summary`, `answer`, `question`, `error`, `why`, `open`, `notes`, `checks` (a list of `{"cmd", "code"}`), `checked`, `passed_before`, `files` (a list of `{"path", "added", "deleted"}`), `reverted`, `workdir`, `context` (`used`, `limit`, `compactions`) and `next`. A program should read this and not the text, whose wording may change. The line `dsk ID · running · profile` that a run prints first goes to stderr in both forms.
