#!/bin/sh
# Install dsk for Claude Code from this checkout: the plugin (skill, reviewer agent, hooks, job display) as
# dsk@skills-dir, and a `dsk` command for your own shell. To use dsk without a checkout, run this in Claude Code
# instead:  /plugin install dsk --marketplace asx8678/dsk
#   ./install.sh          symlink, so edits in this checkout take effect at once
#   ./install.sh --copy   copy, so the install survives moving or deleting this checkout
set -eu

here=$(cd "$(dirname "$0")" && pwd)
claude="$HOME/.claude"   # a plugin in skills/ loads by itself in every session started after this
skill="$claude/skills/dsk"

mkdir -p "$claude/skills"
chmod +x "$here/skill/scripts/dsk.py" "$here/skill/bin/dsk"
if [ -L "$skill" ]; then
    rm "$skill"
elif [ -e "$skill" ]; then
    if [ "${1:-}" != "--copy" ]; then
        echo "install.sh: $skill exists and is not a link. Remove it, or rerun with --copy to replace it." >&2
        exit 1
    fi
    rm -rf "$skill"
fi
if [ "${1:-}" = "--copy" ]; then
    cp -R "$here/skill" "$skill"
else
    ln -s "$here/skill" "$skill"
fi
rm -f "$claude/agents/dsk-reviewer.md"   # an earlier install put the reviewer here; it is part of the plugin now, as dsk:reviewer
echo "plugin: $skill (dsk@skills-dir)"

bin="$HOME/.local/bin"
if [ -d "$bin" ]; then
    ln -sf "$skill/scripts/dsk.py" "$bin/dsk"
    echo "dsk:    $bin/dsk"
    case ":$PATH:" in *":$bin:"*) ;; *) echo "        $bin is not on your PATH yet" ;; esac
else
    echo "dsk:    not linked, because $bin does not exist. Create it and rerun to get a 'dsk' command."
fi

cat <<'EOF'

Still to do:
1. Provider. In Claude Code, run /plugin configure dsk@skills-dir and enter your DeepSeek API key, or pick
   provider custom and enter its endpoint URL, model name and API key. Then restart Claude Code and check it
   with: dsk doctor
   (Keys in ~/.config/dsk/env and profiles in ~/.config/dsk/config.json work too, and win; see README.md.)
2. Permissions. The skill pre-approves dsk only for the turn that invokes it. For later turns and
   background runs, add this to "permissions": {"allow": [...]} in ~/.claude/settings.json:
       "Bash(dsk *)"
3. Display. In a session that is already open, run /reload-plugins once. Then /dsk-jobs on loads the
   live display of the jobs and /dsk-jobs off unloads it; the choice holds for later sessions.
EOF
