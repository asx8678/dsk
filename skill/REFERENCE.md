# dsk: reference

What `SKILL.md` leaves out because you need it only now and then: what the sandbox allows, and what the second look and the reviewer measured. Read the part a report or a failing check points you to.

## The sandbox

On macOS the worker's scripts, every `sh()` command and every `--check` run under `sandbox-exec`.

- **Writing is allowed** in the working directory, in `$DSK_SCRATCH`, in the temp folders and in the build caches (`~/Library/Caches`, `~/.cache`, `~/.npm`, `~/go/pkg/mod`, Xcode's DerivedData, SwiftPM's folder, and the config's `sandbox_write`).
- **Writing is refused** everywhere else, in `.git` (its hooks and config would run code outside the sandbox), and in the scratchpads of other Claude sessions under the temp folder. So a check's output goes into the tree or `$DSK_SCRATCH`, not to your scratchpad.
- **Reading is refused** for dsk's keys (`~/.config/dsk` and the file where the plugin's form stores them), `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.docker`, `~/.kube`, the Keychains, and the config's `sandbox_hide`.
- **Not covered:** the network, and git-ignored files inside the tree (`.env`, `node_modules`), which stay writable.
- **No sandbox:** on Linux, after a report line `sandbox: off: why`, with `--no-sandbox`, or with `"sandbox": "off"` in the config, which prints no line. Shell commands can then change paths outside the repository too, and `dsk` undoes only what git sees inside it.
- **A tool that starts a sandbox of its own** fails inside this one with `sandbox_apply: Operation not permitted`, because macOS will not nest them. Give SwiftPM `--disable-sandbox` (`swift build --disable-sandbox`); for anything else, run the task with `--no-sandbox`.

## What the second look measured (`--recheck`)

Replayed on 23 hand-ins the lead had rejected after their checks passed, it fixed 6 of the lead's 102 defects outright and 2 in part. It also edited 8 of 22 hand-ins the lead had accepted, and nobody has checked whether that helped. It costs one more turn, a median of 84 s at effort max. So it earns its turn on a careful change or a long diff, and never replaces a `--check` that runs the behaviour.

## What the reviewer measured (`--reviewer`)

In a replay it raised a blocker or major on 17 of 22 hand-ins the lead had accepted, 46 findings in all, and its findings fell within three lines of 5 of the 40 lead defects that name a file and line. It would send most hand-ins back, so leave it off unless the user's config turns it on.
