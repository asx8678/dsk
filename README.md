# dsk

A small headless CLI that Claude Code calls through Bash to hand work to DeepSeek V4.1 Flash. Claude plans and reviews; DeepSeek writes code, tests, docs and web research. One Python file, standard library only, Python 3.13 or newer. It ships as a Claude Code plugin: the skill, a reviewer agent, the review gate and a display of the jobs.

Each turn the worker sends one Python script. The script reads, edits, runs and searches through a small function API, and only what it prints comes back. A task takes about 3 turns, not 30.

## Install

In Claude Code:

```
/plugin install dsk --marketplace asx8678/dsk
```

Claude Code then asks which provider runs the worker, and for what that provider needs:

| Provider | What you enter |
|---|---|
| `official` | your DeepSeek API key |
| `custom` | the endpoint URL of any OpenAI-compatible API that serves a DeepSeek model, the model name, and that endpoint's API key. A DeepSeek API key is optional here: with one, the official API is the fallback and web search (`--web`) is available |

Keys are masked as you type and kept in Claude Code's secure store. `/plugin configure dsk@asx8678` opens the same form again; restart Claude Code after changing it. From a shell, `claude plugin install dsk --marketplace asx8678/dsk` installs without asking, and each `--config KEY=VALUE` sets one option (`provider`, `deepseek_api_key`, `custom_base_url`, `custom_model`, `custom_api_key`). Until a provider is set, each session starts by saying what is missing, and `dsk configure` shows how dsk is set up. `dsk doctor` checks the key and the model against the provider.

The plugin needs Python 3.13 or newer on `PATH`, as `python3` or as `python3.13`, `python3.14` or `python3.15`.

### From a checkout

```
./install.sh            # links the plugin into ~/.claude/skills/dsk (as dsk@skills-dir) and a `dsk` command into ~/.local/bin
                        # use --copy to copy instead
```

`/plugin configure dsk@skills-dir` asks for the provider in the same way. Everything below is optional: it is how to set dsk up by hand, with more than one provider. What a config file and the key file say wins over the plugin's form.

1. **Keys.** `dsk` takes each key from the environment, or else from `~/.config/dsk/env`, a private file (mode 600) of lines like `export DEEPSEEK_API_KEY='...'`. Nothing has to be sourced, so Claude Code needs no setup. A key read from the file never enters `dsk`'s environment, so scripts, `sh()` and checks cannot see it.
2. **Config.** `~/.config/dsk/config.json` names the environment variables; it never holds a key.

   ```json
   {
     "route": ["thirdparty", "official"],
     "profiles": {
       "thirdparty": {"base_url": "https://example.com/v1", "key_env": "DSK_THIRDPARTY_API_KEY", "model": "deepseek-v4.1-flash", "compact_at": 24000, "extra": {}},
       "official":   {"base_url": "https://api.deepseek.com", "key_env": "DEEPSEEK_API_KEY", "model": "deepseek-flash", "compact_at": 48000, "extra": {}}
     },
     "search": {"base_url": "https://api.deepseek.com", "key_env": "DEEPSEEK_API_KEY"},
     "sh_deny": ["terraform apply", "kubectl delete", "pip install", "npm install"],
     "env_pass": []
   }
   ```

   The `official` profile, the `search` block and a default `sh_deny` list are built in, so the file may hold only what differs. `extra` is merged into the request body; a `null` value removes a key the provider rejects. Optional keys: `backoff` (retry waits in seconds, default `[2, 6, 18]`) and `limits` (`turn_seconds` 600, `run_seconds` 3600, `run_tokens` 2000000). A profile may set `max_sessions`, the number of runs the provider serves at once (see **Providers**), and `price`, dollars per million tokens as `{"in": 0.005, "cached": 0.003, "out": 0.57}`, from which `status --json` reports each job's cost. `headers` adds request headers; in a value, `{session}` becomes an ID that stays the same for the whole run, across `answer`, `reject` and failover. OpenCode Go needs `"headers": {"x-opencode-session": "{session}"}`. `pause_hours` (default 1) is how long a profile is skipped after it reports its credit used up, when the error names no reset time (see **Providers**).
3. **Check it.** `dsk doctor` tests each profile: the key, the model ID, that thinking-off is honoured, five replies over a three-turn exchange, and whether and where cached tokens are reported.
4. **Permissions.** The skill pre-approves `dsk` only for the turn that invokes it. For later turns and background runs, add `"Bash(dsk *)"` to `permissions.allow` in `~/.claude/settings.json`. That rule also covers every `--check` command and every shell command the worker runs: none of them reaches a permission prompt, and only the guards in **Guardrails, stated honestly** stand in the way.
5. **Display.** In a session that was already open, run `/reload-plugins` once. `/dsk-jobs on` loads the live display and `/dsk-jobs off` unloads it; see **The plugin**.

## Commands

```
dsk run [--allow GLOB]... [--check CMD]... [--file PATH]... [--web] [--worktree]
        [--effort off|low|high|max] [--profile NAME] [--max-turns 12]
        [--owner ID]       (default: $CLAUDE_CODE_SESSION_ID, which Claude Code sets for every command)
        "brief"            (or --brief FILE)
dsk answer ID "text"       reply to the worker's question; the run continues
dsk show   ID [--review | --diff | --log | --answer]
dsk accept ID              mark as reviewed; after --worktree, apply the changes to the main tree
dsk reject ID "defects"    send defects back into the same session; the run continues
dsk reject ID --drop       discard the work
dsk status [--hook]        this project's open sessions; --hook is the Claude Code Stop hook
dsk status --json          the last day's sessions on any project, as JSON, for a display to poll
dsk search "query"         raw web search, no model
dsk fetch URL              raw page fetch, no model
dsk doctor [--profile NAME]
dsk configure              how dsk is set up: the route, and whether each provider has its key
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
| `done` | no file changed: a read-only answer, or a writable run that found nothing to change; the answer is in the report | 0 |
| `question` | the worker called `ask()` | 2 |
| `stuck` | same reply twice, or three failing turns in a row | 3 |
| `limit` | turn, time or token limit reached | 3 |
| `error` | API, config or internal error, or an interrupted run | 1 |

`summary`, `answer`, `notes` and `question` are the worker's claims. Every other line is measured by `dsk`.

## How it works

**Reply format.** Every request carries one static tool, `run_code(code)`, and with thinking off the call is forced. A reply that is not exactly one valid call is not run and gets a fixed message back.

**Function API.** Inside the script: `read`, `write`, `edit`, `glob`, `grep`, `sh`, `search`, `fetch`, `note`, `ask`, `done`. `write("@answer", text)` stores a long research answer in the session; `read("@3")` returns the full output of turn 3, and `read("@stdin")` an attachment that was piped in. A page fetched twice in one session is served from the session's copy.

**Execution.** Each script runs in a fresh `python3 -I` child with a hard timeout that kills its process group.
- An AST gate refuses imports outside a fixed list of pure standard-library modules, `open`, `exec`, `eval`, `compile`, `__import__`, `input`, and any name starting with `__`.
- The child reports every API call to the parent over a socket. Reports and compaction are built from that ledger, not from what the model says.
- `search` and `fetch` execute in the parent, which alone holds the key.
- Scripts, `sh()` and checks get a scrubbed environment: no key variables, nothing that looks like a credential, cloud CLIs pointed at empty configuration.
- `sh()` refuses `sudo`, any git command that writes, and the `sh_deny` list. Each command runs in its own process group, which is killed when the command returns.

**Cache discipline.** The system prompt and the tool are constants in the source. The first user message is ordered stable-first: `DSK.md` (labelled as an attached file, so the worker knows it has it), run header, attached files, brief. A session is an append-only JSONL log, and every request is rebuilt from it. Before each send, `dsk` checks that the serialized messages extend the previous request of the series byte for byte, using a length and SHA-256 stored in the log, so the check also holds across `answer` and `reject`. Only session start, compaction and provider failover start a new series. Hit tokens are recorded per turn; `dsk show ID --log` prints them.

**Compaction.** When the last request exceeds the profile's `compact_at`, the series restarts as: system prompt, first message with a digest in place of the large attached files, then the last two turns verbatim. Attached files of up to 4,000 characters stay. If larger ones were dropped, one last message names them and tells the worker to read a file again before relying on it. The digest holds all notes, every question with its answer, one ledger line per action in the dropped turns, and the files changed so far. There is no model call, so the same log always compacts to the same bytes.

**Gates.** Write mode (`--allow`) needs a git repository.
- *Snapshots:* the working tree is recorded as a tree object at start, around every script and check, and at every stop, in an index kept in the session directory, so your own index is untouched and only changed files are hashed again. Only what changes while a script or a check is running is attributed to the worker. Its change set is those files, from the start snapshot to the last stop, so it excludes your uncommitted changes and anything you edit between its turns.
- *Scope:* after every script and after the checks, what changed outside `--allow` during that script is undone by `dsk`, listed as `scope: reverted ...`, and reported to the worker. A copy of whatever is undone stays in the session directory. A script that started no shell command is charged only for the files it wrote, since `write` and `edit` are checked when called. A script that is interrupted or killed is still settled, by the same run or by the next command on the session.
- *One in-place run per tree:* a second run without `--worktree` is refused while the first is working, so one run never undoes another's work.
- *Checks:* `dsk` runs each `--check` itself. A failure goes back to the worker and the run continues.
- *Research:* every URL in an answer must have been returned by `search()` or opened by `fetch()` in the session; others are listed as unverified.
- *Review:* the Stop hook (`dsk status --hook`) exits 2 while a session started by the current Claude Code session is in `review`.

**Worktrees.** `--worktree` runs the task in a fresh git worktree seeded with your uncommitted state. `accept` applies the worker's diff to the main tree with `git apply`: changes land uncommitted, a conflict is refused as a whole, and it waits for any in-place run in that tree. In place, `reject --drop` reverse-applies the worker's diff and refuses if those files have moved.

**Providers.** A session starts on the first profile in `route`. On 402, or when retries of a network failure, 408, 429 or 5xx are used up, it continues on the next profile in a new series. A 400 whose message mentions a limit is treated as a 429, because one gateway reports its concurrency limit that way. A profile with `max_sessions` N has N slots, file locks in `~/.local/state/dsk/slots/`; a run holds one from its first request on that profile until its `dsk` process exits. Profiles that reach the same `base_url` with the same `key_env` share one set of slots, limited by the smallest `max_sessions` among them. When all are taken, the run moves to the next profile without sending a request, or, on the last profile in the route, waits for a slot; the display shows such a skip as `coralbricks busy → opencode`, and a real failover as `↯ coralbricks 429 → opencode`. `dsk doctor` takes a slot too, and leaves a profile unchecked while running jobs hold all of its slots. An error that says the credit or quota is used up is not retried: a 402, or a 400, 403 or 429 whose message mentions quota, credit, balance, billing, payment, allowance or a usage limit, but not concurrency, "at a time" or a rate limit. The profile is then paused until the reset time the message names (if within a week), or for its `pause_hours`. Every run skips a paused profile without sending a request, except the last profile in the route, which is always tried. Pauses are files in `~/.local/state/dsk/paused/`; `dsk configure` shows them, and deleting one ends it. A reply with no `finish_reason` whose output reached `max_tokens` counts as cut off (`length`), because one gateway leaves the field empty.

**State** lives in `~/.local/state/dsk/<id>/`: the log, full turn outputs, the answer, the worktree and a lock.

**Progress.** `dsk status --json` prints `{"jobs": [...]}`, newest first, one object per session created in the last day on any project. Each is read off the session's log, so a run in flight shows where it is: `status`, and while running `phase` (`model` while it waits for a reply, `script`, `checks`), `doing` (the shell command or check in flight) and `act` (the last action the turn finished); `turn` of `max_turns` in the current round and `turns` overall; `in`, `out` and `cached` (the cached share of the input tokens, or null); `cost` in dollars, or null when a profile it used has no `price`; `failover` (the profile it left and why, such as `coralbricks 429`); `note` (the question, or why it stopped), `changed`, `brief`, `profile`, `owner`, `root`, `worktree`, and `created` and `active` in epoch seconds. What it read of a log is kept in `~/.local/state/dsk/status.json` and used again until that log moves, so a reading costs the same however many sessions the day holds: about 0.05 s, most of it Python starting.

## The plugin

`skill/` is the plugin, in Claude Code's standard layout, and `.claude-plugin/marketplace.json` at the root of this repository is what lets `/plugin install` find it:

| Part | File | What it is |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | the name, the version, and `userConfig`: the five options of the form above |
| Skill | `SKILL.md` | tells Claude when and how to delegate. `/dsk` from a checkout, `/dsk:dsk` installed from the marketplace |
| Agent | `agents/reviewer.md` | `dsk:reviewer`, for review packets too long to read inline |
| Command | `bin/dsk` | on the `PATH` of Claude's Bash tool while the plugin is enabled |
| Hooks | `hooks/hooks.json` | three commands: at session start and before each prompt, `dsk configure --hook`; at each stop, `dsk status --hook` |
| Hooks module | `hooks/register.tsx` | the display; TypeScript, because Claude Code runs it itself |
| CLI | `scripts/dsk.py` | everything else. Claude Code never loads it, it only runs it |

**How the form's answers reach dsk.** Claude Code hands a plugin's options to its hooks, as `CLAUDE_PLUGIN_OPTION_*` variables, and not to the commands Claude runs through Bash. So `dsk configure --hook` writes them to `options.json` in the plugin's data folder (`~/.claude/plugins/data/dsk-<marketplace>/`, mode 600) and leaves a pointer to it in `~/.config/dsk/plugin.json`. `dsk` builds its configuration from the built-in defaults, then those options, then `~/.config/dsk/config.json`; a key comes from the environment, else `~/.config/dsk/env`, else the options. The data folder is Claude Code's: uninstalling the plugin deletes it, and the keys with it. At session start the same hook says what is still missing; before a prompt it says nothing, and it never fails a session.

The Stop hook and the two configure hooks are always on. The display is not: `/dsk-jobs on` loads it and `/dsk-jobs off` unloads it, in the session where you type it and in the sessions you start afterwards. Unloaded, it reads nothing and draws nothing.

Loaded, it reads `dsk status --json` every two seconds while a job runs or a dsk call is in flight, and every sixteen otherwise, and draws:

- **Above the prompt,** as Claude Code draws its own subagents: one line for the whole (how many workers, how long, tokens, cached share), then a branch per running job of this session, with what it is doing, its turns as a bar, the command in flight, `quiet 1m10s` once its log has not moved for 45 seconds, and `↯ coralbricks 429 → thirdparty` after a failover.
- **Under the prompt,** a status line: `✻ dsk 2 running · ↑ 12.3k · ↓ 2.1k · 83% cached`, or `⏺ dsk 1 waiting for you`.
- **On a `dsk run`, `answer` or `reject` row,** the brief in place of the whole command line, and under it the job's progress while the call runs or its run goes on in the background. ctrl+o shows the command as it was run.
- **Under a dsk call,** its report as a card: how the job stopped and its figures, the worker's words, each check with ✔ or ✘, each changed file with its lines added and removed. A review packet's diff, and the output of `dsk show ID --diff`, are drawn as Claude Code draws its own edits, the first 60 lines.
- **In the pane (`/dsk-jobs`),** this session's jobs from the last day as trees (running, waiting for you, finished) with their cost, and what runs in other sessions. `[ diff ]` and `[ turns ]` on a job open its whole diff, or each turn's cache level and tokens, in the pane.

A row is tied to its job by the brief the command holds; of 23 dsk calls in one day's session, 22 were tied to the right job, and the one that was not started four jobs from a shell loop. `claude plugin test skill` runs the plugin's 13 tests on all four surfaces; they check the tree that is drawn, not how a terminal paints it.

## Guardrails, stated honestly

The AST gate, the scrubbed environment, the denylist and the scope gate stop an obedient but mistaken model. They are not a sandbox: a worker with `sh()` is as powerful as a shell and can read any file you can. Keep `--web` off for tasks that also need `sh()` in a repository with secrets, because fetched pages are untrusted input. Nothing here prevents running `dsk` inside a container.

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
- **`python3 -I` discards `PYTHONHASHSEED`,** so the seed is pinned for `sh()` and checks but not for the script process itself.
- **In a git repository the working directory is the repository root.**
- **Size:** `dsk.py` has 1,520 lines, over the 1,000-line target and, since the key file, `max_sessions`, `status --json`, `configure`, profile `headers` and provider pauses were added, over the 1,300-line limit too (48 lines are longer than 120 characters). By your rule the next step is to cut a feature: the candidates are `doctor` (about 55 lines), the raw `search` and `fetch` commands (12), and the time and token limits (6).

## Tests

```
python3 -m unittest discover -s tests     # 83 tests against a scripted API server and temp git repositories
python3 tests/live.py --table             # real toy tasks on the real providers; costs a few cents
```

`../trials` holds a harness that plays the lead on realistic small projects and grades the result with held-out tests and mutants, the session logs it collected, and `FINDINGS.md`.

## Known limits

- The worker asks when a brief cannot be done as written (51 of 51 trial runs), but when a name fits two things it takes the likelier one without asking (38 of 38). Name files and functions by path in the brief.
- An interrupted run can only be dropped, not resumed. What it changed is still attributed to it. Claude Code 2.1.322 does not kill a command whose Bash timeout passes; it moves it to the background, and stopping the task sends SIGTERM and then kills the whole process tree. If `dsk` alone is killed with SIGKILL, a script in the middle of a shell command runs on until that command returns, and may write after a `--drop`.
- A snapshot writes a blob for every untracked file that is not git-ignored into the repository's object store, and the first snapshot of a session hashes them all (6.5 s for 300 MB; 0.04 s for later ones). `git gc` removes those objects later. Ignore large data directories.
- The Stop hook runs at every turn end once it is loaded: in one real session it ran 16 times in a row, each in under 0.1 s. Every one of those runs found nothing to review, so its blocking path (exit 2) is covered by the tests but has not yet been seen live. As part of the plugin it has not run in a real session yet.
- The display has been tested as a drawn tree, not as painted pixels: nobody has yet checked a screenshot of it.
- The plugin's install has been run from the shell in a scratch home (marketplace add, install, `--config`, `configure`), and its hooks by hand with the variables Claude Code documents, against the real official API and a real custom endpoint. It has not yet been installed from GitHub into a live session, so the form itself and the hooks as Claude Code fires them are unseen.

## Later, not now

`dsk map` (one read-only brief over many items in parallel), `dsk stats`, a container mode.
