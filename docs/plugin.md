# The plugin

The parts of the plugin are listed in the README; this page has the two things that need more room.

## How the form's answers reach dsk

Claude Code hands a plugin's options to its hooks, as `CLAUDE_PLUGIN_OPTION_*` variables, and not to the commands Claude runs through Bash. So `dsk configure --hook` writes them to `options.json` in the plugin's data folder (`~/.claude/plugins/data/dsk-<marketplace>/`, mode 600) and leaves a pointer to it in `~/.config/dsk/plugin.json`. `dsk` builds its configuration from the built-in defaults, then those options, then `~/.config/dsk/config.json`; a key comes from the environment, else `~/.config/dsk/env`, else the options. The sandbox denies reading that file and the `.new` copy written beside it, as it denies `~/.config/dsk`, which holds the pointer. The data folder is Claude Code's: uninstalling the plugin deletes it, and the keys with it. At session start the same hook says what is still missing; before a prompt it says nothing, and it never fails a session.

## The display

Loaded, it reads `dsk status --json` every two seconds while a job runs or a dsk call is in flight, and every sixteen otherwise, and draws:

- **Above the prompt,** as Claude Code draws its own subagents: one line for the whole (how many workers, how long, tokens, cached share), then a branch per running job of this session, with what it is doing, its turns as a bar, the command in flight, `quiet 1m10s` once its log has not moved for 45 seconds, and `↯ coralbricks 429 → thirdparty` after a failover.
- **Under the prompt,** a status line: `✻ dsk 2 running · ↑ 12.3k · ↓ 2.1k · 83% cached`, or `⏺ dsk 1 waiting for you`.
- **On a `dsk run`, `answer` or `reject` row,** the brief in place of the whole command line, and under it the job's progress while the call runs or its run goes on in the background. ctrl+o shows the command as it was run.
- **Under a dsk call,** its report as a card: how the job stopped and its figures, the worker's words, each check with ✔ or ✘, each changed file with its lines added and removed. A review packet's diff, and the output of `dsk show ID --diff`, are drawn as Claude Code draws its own edits, the first 60 lines.
- **In the pane (`/dsk`),** this session's jobs from the last day as trees (running, waiting for you, finished) with their cost, and what runs in other sessions. `[ diff ]` and `[ turns ]` on a job open its whole diff, or each turn's cache level and tokens, in the pane.

A row is tied to its job by the brief the command holds; of 23 dsk calls in one day's session, 22 were tied to the right job, and the one that was not started four jobs from a shell loop. `claude plugin test skill` runs the plugin's 14 tests on all four surfaces; they check the tree that is drawn, not how a terminal paints it.
