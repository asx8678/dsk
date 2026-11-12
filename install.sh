#!/bin/sh
# Install dsk for Claude Code: the skill, the reviewer agent, and a `dsk` command.
#   ./install.sh          symlink, so edits in this checkout take effect at once
#   ./install.sh --copy   copy, so the install survives moving or deleting this checkout
set -eu
if [ $# -gt 1 ] || { [ $# -eq 1 ] && [ "$1" != "--copy" ]; }; then
    echo "usage: ./install.sh [--copy]" >&2
    exit 1
fi

here=$(cd "$(dirname "$0")" && pwd)
claude="$HOME/.claude"   # the skill's Stop hook is written for this location
skill="$claude/skills/dsk"
agent="$claude/agents/dsk-reviewer.md"

if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 14))' 2>/dev/null; then
    echo "install.sh: dsk needs python3 to be Python 3.14 or newer. The Stop hook runs python3 too." >&2
    exit 1
fi
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
1. Keys. dsk reads them only from the environment. Export DEEPSEEK_API_KEY and DSK_THIRDPARTY_API_KEY
   in your shell profile, or source a private file that does, for example:
       [ -f ~/.config/dsk/env ] && . ~/.config/dsk/env
2. Config. Put your provider profiles in ~/.config/dsk/config.json (see README.md), then run: dsk doctor
3. Permissions. The skill pre-approves dsk only for the turn that invokes it. For later turns and
   background runs, add this to "permissions": {"allow": [...]} in ~/.claude/settings.json:
       "Bash(dsk *)"
EOF
