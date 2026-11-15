# How dsk works

The protocol in full; the README has the short version.

## Reply format

Every request carries one static tool, `run_code(code)`, and with thinking off the call is forced. A reply that is not exactly one valid call is not run and gets a fixed message back.

## Function API

Inside the script: `read`, `write`, `edit`, `glob`, `grep`, `sh`, `search`, `fetch`, `note`, `ask`, `done`. `write("@answer", text)` stores a long research answer in the session; `read("@3")` returns the full output of turn 3, and `read("@stdin")` an attachment that was piped in. A page fetched twice in one session is served from the session's copy. `"@scratch/name"` is a file in the session's scratch folder, which `sh()` and the checks know as `$DSK_SCRATCH`: the one place outside the working directory a script may write, for probes and other throwaway files. `read` also takes a path outside the working directory, since `sh()` can read it anyway; `write`, `edit`, `glob` and `grep` do not. It is never part of the change and is removed when the session is accepted or dropped. A script kept there resolves its imports from that folder, not from the project. `glob()` lists what git does not ignore; a pattern that names a folder, such as `shots/*.png`, also finds ignored files in it when nothing else matches.

## Execution

Each script runs in a fresh `python3 -I` child with a hard timeout that kills its process group. The allowed modules are already imported, and `import glob` gives the script dsk's own `glob()`. What a turn printed goes back cut to `limits.output_chars`, or to `limits.read_chars` when the turn only read files: in the logs of 118 sessions, nine in ten of the turns that were cut only read. A reply identical to the one before is not run and gets one warning; a second one stops the run as `stuck`, or moves it to the next profile when there is one. A script that is the previous one with only its numbers changed, changes no file and prints nothing the last four turns had not shown counts the same way, and three such replies in a row move or stop the run: one worker spent its last 15 turns printing ever shorter slices of the same lines. The request after such a reply is sent with temperature 0.7, and with 1.0 after two in a row, when thinking is off. Three logged loops of identical replies were sent to their provider again, four times each at each setting: the same script came back 11 times of 12 at temperature 0, twice at 0.7 and never at 1.0. A logged loop of near-copies came back 8 times of 8 at 0, once at 0.7 and twice at 1.0. A shell command that fails the same way three times in a row, with the same output, gets a note that the last changes did not touch what it tests. A reply cut off at the output limit is not kept in the conversation. A report for `stuck` or `limit` has a `spent:` line, the turns of the round by kind, and, when nothing was changed, `last:`, what the worker last printed.

- An AST gate refuses imports outside a fixed list of pure standard-library modules, `open`, `exec`, `eval`, `compile`, `__import__`, `input`, and any name starting with `__`.
- The child reports every API call to the parent over a socket. Reports and compaction are built from that ledger, not from what the model says.
- `search` and `fetch` execute in the parent, which alone holds the key.
- Scripts, `sh()` and checks get a scrubbed environment: no key variables, nothing that looks like a credential, cloud CLIs pointed at empty configuration.
- On macOS the script's process, and with it every `sh()` command, and each check run under `sandbox-exec` with a profile built per session. Writes are denied, then allowed in `/tmp`, the temp folder and the build caches (`~/Library/Caches`, `~/.cache`, `~/.npm`, `~/go/pkg/mod`, Xcode's DerivedData, SwiftPM's folder, and `sandbox_write`), denied again under `/private/tmp/claude-*`, where other Claude sessions keep their scratchpads, and allowed in the working directory, the scratch folder and the session's answer file. Git's own directory is denied, all but its index, because hooks and config run code outside any sandbox. Reading dsk's key file, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.docker`, `~/.kube`, the Keychains and `sandbox_hide` is denied. Whether the profile applies is tried once when the run starts and kept in the session's head; a command's output is never read to guess it, since `sandbox-exec` exits 65 on a bad profile and so may any command. A session started without a sandbox keeps running without one.
- `sh()` refuses `sudo`, any git command that writes, and the `sh_deny` list. Each command runs in its own process group, which is killed when the command returns.

## Cache discipline

The system prompt and the tool are constants in the source. The first user message is ordered stable-first: `DSK.md` (labelled as an attached file, so the worker knows it has it), run header, attached files, brief. A session is an append-only JSONL log, and every request is rebuilt from it. Before each send, `dsk` checks that the serialized messages extend the previous request of the series byte for byte, using a length and SHA-256 stored in the log, so the check also holds across `answer` and `reject`. Only session start, compaction and provider failover start a new series. Hit tokens are recorded per turn; `dsk show ID --log` prints them.

## Streaming

Every request asks for a stream with usage at the end (`stream_options.include_usage`). The reply is rebuilt from the events into the shape a JSON reply has: text, `reasoning_content` and `reasoning` each joined on its own, tool calls joined by index, the last `finish_reason`, the usage chunk. The socket timeout is `limits.idle_seconds`, so a stream that goes quiet fails like a dropped connection; `limits.reply_seconds` caps the whole reply. A response that is not `text/event-stream` is read as JSON. Each `usage` record has `first`, the seconds until the first data arrived.

## Attachments

`--file PATH` attaches a whole file and `--file PATH:A-B` lines A to B of it, under that name; the run header tells the worker how many characters a turn shows.

## Compaction

When the last request exceeds the profile's `compact_at`, the series restarts as: system prompt, first message with a digest in place of the dropped turns, then the last two turns verbatim. The first message keeps the task. In a round that a reject started, it also keeps that reject's defects, under `## The lead's review`. Attached files of up to 4,000 characters always stay. Larger ones stay in the order attached while the compacted messages fit in half of `compact_at`, counted at 3 characters a token. If any were dropped, one last message names them, a line range as `read("PATH", A, B)`, and tells the worker to read a file again before relying on it. The digest holds all notes, every question with its answer, one ledger line per action in the dropped turns, and the files changed so far. There is no model call, so the same log always compacts to the same bytes. The check runs again before every request, against the `compact_at` of the profile the request goes to, so a failover to a profile that compacts sooner compacts first. In a `--worktree` run, a dropped file that git ignores is named by its path in the main tree, since the worktree has no copy of it.

## Gates

Write mode (`--allow`) needs a git repository.

- *Snapshots:* the working tree is recorded as a tree object at start, around every script and check, and at every stop, in an index kept in the session directory, so your own index is untouched and only changed files are hashed again. Only what changes while a script or a check is running is attributed to the worker. Its change set is those files, from the start snapshot to the last stop, so it excludes your uncommitted changes and anything you edit between its turns.
- *Scope:* after every script and after the checks, what changed outside `--allow` during that script is undone by `dsk`, listed as `scope: reverted ...`, and reported to the worker. A copy of whatever is undone stays in the session directory. A script that started no shell command is charged only for the files it wrote, since `write` and `edit` are checked when called. A script that is interrupted or killed is still settled, by the same run or by the next command on the session.
- *One in-place run per tree:* a second run without `--worktree` is refused while the first is working, so one run never undoes another's work.
- *Checks:* `dsk` runs each `--check` itself. A failure goes back to the worker and the run continues. At a `stuck` or `limit` stop where the worker changed files, `dsk` runs the checks once more, so the report says whether the partial work passes them.
- *Research:* every URL in an answer must have been returned by `search()` or opened by `fetch()` in the session; others are listed as unverified.
- *Review:* the Stop hook (`dsk status --hook`) exits 2 while a session started by the current Claude Code session is in `review`.

## Worktrees

`--worktree` runs the task in a fresh git worktree seeded with your uncommitted state; the repository needs at least one commit. `accept` applies the worktree as it stands to the main tree with `git apply`: changes land uncommitted, a conflict is refused as a whole, and it waits for any in-place run in that tree. An edit you made in the worktree, between rounds or after the worker stopped, is included when its path matches `--allow`; one outside `--allow` is not applied, and is kept as `late.patch` in the session directory. In place, `reject --drop` reverse-applies the worker's diff and refuses if those files have moved. A worktree run that ends `done` changed nothing, so its worktree and branch are removed at once.

## Continuing

`dsk continue ID "task"` sends a next task into a session that is `done` or `accepted`: the same conversation, so the worker keeps what it has read and the request still extends the cached prefix. It logs a `base` record with the round's own terms (`--allow`, `--check`, `--max-turns`, each kept from before when left out) and a new start snapshot, so the review packet, `accept` and `reject --drop` deal with that round's changes only. A worktree that `accept` or `done` removed is built again from the main tree as it is now, and the earlier round's `@answer` is kept aside as `answer.N` in the session directory. After a compaction the worker's first message carries the current task and the terms of its round, and the digest lists the earlier tasks as finished. Every report has a measured `context:` line, the size of the next request against the profile's `compact_at`, with the number of compactions so far: it is what tells the lead to start a fresh run instead.

## State

State lives in `~/.local/state/dsk/<id>/`: the log, full turn outputs, the answer, the worktree and a lock.

## Stats

Every log record carries `at`, the time it was written. `dsk stats` reads the logs back: sessions by outcome; turns by kind (`read`, `write`, `run`, `stop`, `failed:<why>`); how many read turns came before the first change; how many turns had their output cut; reply sizes; tokens and cost; rejected rounds; and per profile the turns, tokens, failovers away and seconds per turn. `--sessions` adds a line per session and `--json` gives each session's numbers. A log from before timestamps existed gives no durations.

## Progress

`dsk status --json` prints `{"jobs": [...]}`, newest first, one object per session created in the last day on any project. Each is read off the session's log, so a run in flight shows where it is: `status`, and while running `phase` (`model` while it waits for a reply, `script`, `checks`), `doing` (the shell command or check in flight) and `act` (the last action the turn finished); `turn` of `max_turns` in the current round and `turns` overall; `in`, `out` and `cached` (the cached share of the input tokens, or null); `cost` in dollars, or null when a profile it used has no `price`; `failover` (the profile it left and why, such as `coralbricks 429`); `note` (the question, or why it stopped), `changed`, `brief`, `profile`, `owner`, `root`, `worktree`, and `created` and `active` in epoch seconds. What it read of a log is kept in `~/.local/state/dsk/status.json` and used again until that log moves, so a reading costs the same however many sessions the day holds: about 0.05 s, most of it Python starting.
