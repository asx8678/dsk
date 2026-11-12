# dsk

A small headless CLI that Claude Code calls through Bash to hand work to DeepSeek V4.1 Flash. Claude plans and reviews; DeepSeek writes code, tests, docs and web research. One Python file, standard library only, Python 3.14 or newer.

Each turn the worker sends one Python script. The script reads, edits, runs and searches through a small function API, and only what it prints comes back. A task takes about 3 turns, not 30.

## Install

```
./install.sh            # links the skill, the reviewer agent and a `dsk` command (use --copy to copy instead)
```

Then, by hand:

1. **Keys.** `dsk` reads keys only from the environment. Export them in your shell profile, or source a private file that does: `[ -f ~/.config/dsk/env ] && . ~/.config/dsk/env`.
2. **Config.** `~/.config/dsk/config.json` names the environment variables; it never holds a key.

   ```json
   {
     "route": ["thirdparty", "official"],
     "profiles": {
       "thirdparty": {"base_url": "https://example.com/v1", "key_env": "DSK_THIRDPARTY_API_KEY", "model": "deepseek-v4.1-flash", "compact_at": 24000, "extra": {}},
       "official":   {"base_url": "https://api.deepseek.com", "key_env": "DEEPSEEK_API_KEY", "model": "deepseek-flash", "compact_at": 48000, "extra": {}}
     },
     "search": {"base_url": "https://api.deepseek.com", "key_env": "DEEPSEEK_API_KEY"},
     "sh_deny": ["make deploy", "docker push"],
     "env_pass": []
   }
   ```

   The `official` profile, the `search` block and a default `sh_deny` list are built in, so the file may hold only what differs, down to one field of a profile or of the `search` block. A `sh_deny` list in the file adds to the built-in one; a built-in entry cannot be removed. A broken file, or a profile without `base_url`, `key_env` or `model`, ends every command with one `dsk · error:` line that names the file. `extra` is merged into the request body; a `null` value removes a key the provider rejects. Optional keys: `backoff` (retry waits in seconds, default `[2, 6, 18]`) and `limits` (`turn_seconds` 600, `run_seconds` 3600, `run_tokens` 2000000).
3. **Check it.** `dsk doctor` tests each profile: the key, the model ID, that thinking-off is honoured, five replies over a three-turn exchange, and whether and where cached tokens are reported.
4. **Permissions.** The skill pre-approves `dsk` only for the turn that invokes it. For later turns and background runs, add `"Bash(dsk *)"` to `permissions.allow` in `~/.claude/settings.json`.

## Commands

```
dsk run [--allow GLOB]... [--check CMD]... [--file PATH]... [--web] [--worktree]
        [--effort off|low|high|max] [--profile NAME] [--max-turns 12] [--owner ID]
        "brief"            (or --brief FILE)
dsk answer ID "text"       reply to the worker's question; the run continues
dsk show   ID [--review | --diff | --log | --answer]
dsk accept ID              mark as reviewed; after --worktree, apply the changes to the main tree
dsk reject ID "defects"    send defects back into the same session; the run continues
dsk reject ID --drop       discard the work
dsk status [--hook]        this project's open sessions; --hook is the Claude Code Stop hook
dsk doctor [--profile NAME]
```

Every command prints a short plain-text report on stdout. `--verbose` adds one line per turn on stderr. The last line of a report names the commands that are valid next.

```
dsk 7f3a · review · thirdparty · 3 turns · in 5.5k (90% cached) · out 1.5k
summary: Added 22 tests for parse_duration and format_duration; all pass.
checks:  python3 -m unittest discover -s tests → 0
changed: tests/test_durations.py (+128)
next:    dsk show 7f3a --review | dsk accept 7f3a | dsk reject 7f3a "defects"
```

| Status | Meaning | Exit code |
|---|---|---|
| `review` | files changed, checks passed, waiting for accept or reject | 0 |
| `done` | read-only task finished; the answer is in the report | 0 |
| `question` | the worker called `ask()` | 2 |
| `stuck` | same reply twice, or three failing turns in a row | 3 |
| `limit` | turn, time or token limit reached | 3 |
| `error` | API, config or internal error, or an interrupted run | 1 |

`summary`, `answer`, `notes` and `question` are the worker's claims. Every other line is measured by `dsk`.

## How it works

**Reply format.** Every request carries one static tool, `run_code(code)`, and with thinking off the call is forced. A reply that is not exactly one valid call is not run and gets a fixed message back.

**Function API.** Inside the script: `read`, `write`, `edit`, `glob`, `grep`, `sh`, `search`, `fetch`, `note`, `ask`, `done`. `write("@answer", text)` stores a long research answer in the session; `read("@3")` returns the full output of turn 3, and `read("@stdin")` an attachment that was piped in. A page fetched twice in one session is served from the session's copy.

**Execution.** Each script runs in a fresh `python3 -I` child with a hard timeout that kills its process group.
- An AST gate refuses imports outside a fixed list of pure standard-library modules, `open` (also as `io.open`, `io.FileIO` and `io.open_code`), `exec`, `eval`, `compile`, `__import__`, `input`, and any name starting with `__`.
- The child reports every API call to the parent over a socket. Reports and compaction are built from that ledger, not from what the model says.
- `search` and `fetch` execute in the parent, which alone holds the key.
- Scripts, `sh()` and checks get a scrubbed environment: no key variables, nothing that looks like a credential, cloud CLIs pointed at empty configuration.
- `sh()` refuses `sudo`, any git command that writes, and the `sh_deny` list. Quoted text counts as an argument and is not looked into, so `grep "git commit" docs/` passes, and so does `bash -c "git push"`. Each command runs in its own process group, which is killed when the command returns.

**Cache discipline.** The system prompt and the tool are constants in the source. The first user message is ordered stable-first: `DSK.md` (labelled as an attached file, so the worker knows it has it), run header, attached files, brief. A session is an append-only JSONL log, and every request is rebuilt from it. Before each send, `dsk` checks that the serialized messages extend the previous request of the series byte for byte, using a length and SHA-256 stored in the log, so the check also holds across `answer` and `reject`. Only session start, compaction and provider failover start a new series. Hit tokens are recorded per turn; `dsk show ID --log` prints them.

**Compaction.** When the last request exceeds the profile's `compact_at`, the series restarts as: system prompt, first message with a digest in place of the large attached files, then the last two turns verbatim. Attached files of up to 4,000 characters stay. If larger ones were dropped, one last message names them and tells the worker to read a file again before relying on it. The digest holds all notes, every question with its answer, every defect list sent with `reject`, one ledger line per action in the dropped turns, and the files changed so far. There is no model call, so the same log always compacts to the same bytes.

**Gates.** Write mode (`--allow`) needs a git repository. An `--allow` value that ends in `/` or names a directory means everything under it (`--allow tests` is `tests/**`, `--allow .` is `**`); a leading `./` is ignored. `write()` and `edit()` refuse the repository's own `.git` (in any letter case), whatever `--allow` says; `.github/` and `.gitignore` are ordinary paths. An `answer:` or `summary:` line longer than 1,500 characters is cut and ends with how many were left out and `dsk show ID --answer`.
- *Snapshots:* the working tree is recorded as a tree object at start, around every script and check, and at every stop, in an index kept in the session directory, so your own index is untouched and only changed files are hashed again. Only what changes while a script or a check is running is attributed to the worker. Its change set is those files, from the start snapshot to the last stop, so it excludes your uncommitted changes and anything you edit between its turns.
- *Scope:* after every script and after the checks, what changed outside `--allow` during that script is undone by `dsk`, listed as `scope: reverted ...`, and reported to the worker. A copy of whatever is undone stays in the session directory. A script that started no shell command is charged only for the files it wrote, since `write` and `edit` are checked when called. A script that is interrupted or killed is still settled, by the same run or by the next command on the session that is not refused. A running `dsk` touches its log once a second. When a killed run is settled later, only files last touched up to two seconds after the final touch count as its work, so what you do in the tree afterwards is left alone. A deletion carries no time and is put back. If you later edit a file the run itself had changed, `--drop` refuses, as it does whenever the tree has moved.
- *One in-place run per tree:* a second run without `--worktree` is refused while the first is working, so one run never undoes another's work.
- *Checks:* `dsk` runs each `--check` itself. A failure goes back to the worker and the run continues.
- *Research:* every URL in an answer must have been returned by `search()` or opened by `fetch()` in the session; others are listed as unverified. An anchor counts as the page it is on.
- *Review:* the Stop hook (`dsk status --hook`) exits 2 while a session started by the current Claude Code session is in `review`.

**Worktrees.** `--worktree` runs the task in a fresh git worktree seeded with your uncommitted state. `accept` applies the worker's diff to the main tree with `git apply`: changes land uncommitted, a conflict is refused as a whole, and it waits for any in-place run in that tree. A worktree run that changes nothing ends `done` and removes its worktree and branch at once. In place, `reject --drop` reverse-applies the worker's diff and refuses if those files have moved.

**Providers.** A session starts on the first profile in `route`. On 402, or when retries of a network failure, 408, 429 or any status from 500 to 599 are used up, it continues on the next profile in a new series. A 400 carrying `tier_limit_exceeded` is treated as a 429, because one gateway reports its concurrency limit that way; any other 400 fails at once. A redirect is refused, not followed, and counts as an error: `urllib` would resend the key to the new address.

**State** lives in `~/.local/state/dsk/<id>/`: the log, full turn outputs, the answer, the worktree and a lock.

## Guardrails, stated honestly

The AST gate, the scrubbed environment, the denylist and the scope gate stop an obedient but mistaken model. They are not a sandbox: a worker with `sh()` is as powerful as a shell and can read any file you can. The gate refuses `open` and the `io` openers by name, but not a module reached through another module's attributes, such as `fnmatch.os`; what a script changes that way, without `sh()`, appears in neither `changed:` nor `scope:`. Keep `--web` off for tasks that also need `sh()` in a repository with secrets, because fetched pages are untrusted input. That includes dsk's own keys: with the documented install they sit in `~/.config/dsk/env`, which any script can read through `sh()`. Nothing here prevents running `dsk` inside a container.

What the gates do not see:
- *Outside a git repository* nothing is tracked or undone, so a run without `--allow` is read-only only as far as the worker obeys. In a repository it is enforced: every change git sees is undone.
- *In any run,* changes to git-ignored files and whatever `sh()` writes under `.git/` are not seen by the scope gate. Only `write()` and `edit()` refuse `.git`, and only the repository's own, not one in a subfolder.
- *The environment* loses every variable whose name looks like a credential (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, cloud prefixes), but connection URLs such as `DATABASE_URL` or `SENTRY_DSN` are passed on to scripts and checks. `GH_TOKEN` is set to a dummy value so that `gh` does not fall back to its stored login; to give a check a real one, name `GH_TOKEN` in `env_pass`. `PYTHONDONTWRITEBYTECODE=1` keeps a check that imports the code from adding `__pycache__` files to the change set.

An in-place run cannot tell its own script's side effects from an edit someone else makes during the same seconds. Such an edit outside `--allow` is undone with the script's (a copy is kept). Use `--worktree` when anyone else is working in the tree.

## What differs from the build prompt

Measured on 2026-11-11 with `deepseek-flash` on the official API and `deepseek-v4.1-flash` on a third-party gateway.

- **One `run_code` tool instead of plain-chat replies with `<file>` blocks.** In plain chat the model wrote its own tool-call markup or empty file blocks: 11 of 70 turns failed on the gateway and 5 of 46 on the official API, and one empty block wiped an in-scope file. With the tool, the last acceptance run (18 runs, each with unique content) had 1 failed turn in 60, a script the gate refused, and the 36-scenario trial batch had 1 in 132. A `files` argument was tried and dropped, because the model garbled it whenever it used it; files are written with `write()` and a raw triple-quoted string.
- **The cached share is at or just below the 0.9 target.** From turn 3 on, over three runs of the bench, it was 0.85 to 0.92 for code tasks on the official API (0.83 to 0.90 on the gateway) and 0.80 to 0.83 for web research (0.83 to 0.86 on the gateway). Every request does hit the whole of the previous one. What misses is what the last turn appended, and in a session of 2 to 4 turns that is a large part of a small prompt. Identical runs hit each other's cache entries and look better, which is why `tests/live.py` makes every run unique.
- **Thinking off is sent as both `thinking: disabled` and `reasoning_effort: "none"`,** because the gateway honours only the second. With `--effort` on, the forced call is not available, so `tool_choice` is `auto`, and the model's reasoning is sent back each turn as the API requires.
- **`max_tokens` follows the effort:** 16,000 with thinking off, then 32,000, 64,000 and 128,000.
- **System prompt:** rewritten around the tool, plus one sentence telling the worker to call `done()` in the script that runs the checks. That sentence took the median from 4 turns to 3.
- **One drafted rule was reworded.** "Re-read files instead of trusting old output or the attached copies" made workers read attached files and `DSK.md` again at once. It now says the attached files are current when the task starts and need no second read until something changes them. With `DSK.md` labelled as attached, redundant re-reads fell from 37 to 7 per 44 trial runs; total turns did not change beyond noise.
- **The scope gate runs after every script, not only at `done()`,** and undoes only what that script changed. As first built it undid every out-of-scope change since the start of the run, which deleted or restored files that someone else touched meanwhile. The change set, the review diff and `--drop` are limited to the worker's files for the same reason.
- **Compaction keeps small attached files and ends with a reminder about the large ones it dropped.** As specified, it dropped every attached file, and the worker then carried on from memory and invented what the file had said. Measured on a six-step task whose rules were in an attached file:
  - With a 400-character file and compaction forced at 2,000 tokens, 0 of 4 runs finished, with your original rule wording as much as with mine. Keeping the file: 4 of 4.
  - With a file of over 100,000 characters and one compaction at the configured thresholds, 5 of 6 finished, but only after a failed check sent the worker back to the file four turns later. With the reminder: 4 of 4, and the file is read again on the next turn.
  - Not tested: repeated compaction with a large file since the reminder was added (2 of 12 finished before it), and files between those two sizes. The 4,000-character limit is a choice, not a measured optimum.
- **After a rejected round, `show --review` prints only what changed since the last review.**
- **A 429 that survives the retries also fails over,** like a repeated 5xx. So does a network failure.
- **The same reply twice is `stuck` only between the worker's own turns.** After `answer` or `reject` an identical script is run, because the lead may have changed what it will find. As specified, `dsk reject ID "I created the file, run the check again"` went straight back to `stuck`.
- **The digest also carries every defect list sent with `reject`.** As specified it held only notes and answers, so one compaction in a rejected round took the list away from the worker that was fixing it.
- **The git list adds `rev-list` and a `git branch` that only lists.** These two were refused in 16 of 1,268 trial turns. Quoted text is no longer checked, which ends refusals such as `pytest -k 'git and not slow'`. The built-in `sh_deny` list adds `pip3 install` and `npm ci`.
- **`python3 -I` discards `PYTHONHASHSEED`,** so the seed is pinned for `sh()` and checks but not for the script process itself.
- **In a git repository the working directory is the repository root.**
- **The raw `dsk search` and `dsk fetch` commands were removed** to stay under the 1,300-line limit. `search()` and `fetch()` inside scripts, with `--web`, and the `search:` line of `dsk doctor` work as before.
- **Size:** `dsk.py` has 1,300 lines, over the 1,000-line target and exactly at the 1,300-line limit, and only because 34 lines are longer than 120 characters; wrapped, it would be about 30 over. The raw `search` and `fetch` commands were cut to pay for the fixes of the 2026-11-12 review. The candidates left to cut are `doctor` (about 55 lines) and the time and token limits (6).

## Tests

```
python3 -m unittest discover -s tests     # 99 tests against a scripted API server and temp git repositories
python3 tests/live.py --table             # real toy tasks on the real providers; costs a few cents
```

`../trials` holds a harness that plays the lead on realistic small projects and grades the result with held-out tests and mutants, the session logs it collected, and `FINDINGS.md`.

## Known limits

- The worker asks when a brief cannot be done as written (51 of 51 trial runs), but when a name fits two things it takes the likelier one without asking (38 of 38). Name files and functions by path in the brief.
- An interrupted run can only be dropped, not resumed. What it changed is still attributed to it. Claude Code 2.1.322 does not kill a command whose Bash timeout passes; it moves it to the background, and stopping the task sends SIGTERM and then kills the whole process tree. If `dsk` alone is killed with SIGKILL, a script in the middle of a shell command runs on until that command returns, and may write after a `--drop`. What it writes more than two seconds after `dsk` died is not attributed to the run.
- A snapshot writes a blob for every untracked file that is not git-ignored into the repository's object store, and the first snapshot of a session hashes them all (6.5 s for 300 MB; 0.04 s for later ones). `git gc` removes those objects later. Ignore large data directories.
- The Stop hook has passed `claude plugin validate` but has not been seen firing in a real Claude Code session.

## Later, not now

`dsk map` (one read-only brief over many items in parallel), `dsk stats`, a container mode.
