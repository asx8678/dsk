#!/bin/sh
# Install dsk for Claude Code: the skill, the reviewer agent, and a `dsk` command.
#   ./install.sh          symlink, so edits in this checkout take effect at once
#   ./install.sh --copy   copy, so the install survives moving or deleting this checkout
set -eu

here=$(cd "$(dirname "$0")" && pwd)
claude="$HOME/.claude"   # the skill's Stop hook is written for this location
skill="$claude/skills/dsk"
agent="$claude/agents/dsk-reviewer.md"

mkdir -p "$claude/skills" "$claude/agents"
chmod +x "$here/skill/scripts/dsk.py"
if [ -L "$skill" ]; then
    rm "$skill"
elif [ -e "$skill" ]; then
    if [ "${1:-}" != "--copy" ]; then
        echo "install.sh: $skill exists and is not a link. Remove it, or rerun with --copy to replace it." >&2
        exit 1
    fi
    rm -rf "$skill"
fi
rm -f "$agent"
if [ "${1:-}" = "--copy" ]; then
    cp -R "$here/skill" "$skill"
    cp "$here/agents/dsk-reviewer.md" "$agent"
else
    ln -s "$here/skill" "$skill"
    ln -s "$here/agents/dsk-reviewer.md" "$agent"
fi
echo "skill:  $skill"
echo "agent:  $agent"

bin="$HOME/.local/bin"
if [ -d "$bin" ]; then
    ln -sf "$skill/scripts/dsk.py" "$bin/dsk"
    echo "dsk:    $bin/dsk"
    case ":$PATH:" in *":$bin:"*) ;; *) echo "        $bin is not on your PATH yet" ;; esac
else
    echo "dsk:    not linked, because $bin does not exist. Create it and rerun to get a 'dsk' command."
fi

cat <<'EOF'

Still to do by hand:
1. Keys. dsk takes each key from the environment, or else from ~/.config/dsk/env (chmod 600), with
   lines like:
       export DEEPSEEK_API_KEY='...'
2. Config. Put your provider profiles in ~/.config/dsk/config.json (see README.md), then run: dsk doctor
3. Permissions. The skill pre-approves dsk only for the turn that invokes it. For later turns and
   background runs, add this to "permissions": {"allow": [...]} in ~/.claude/settings.json:
       "Bash(dsk *)"
EOF
