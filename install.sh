#!/bin/sh
# Install dsk for Claude Code through its own `claude plugin` command, and a `dsk` command for your own shell.
#   ./install.sh              install dsk@asx8678 from GitHub (asx8678/dsk), or update it when it is installed.
#                             Needs no checkout, so this works too:
#                             curl -fsSL https://raw.githubusercontent.com/asx8678/dsk/main/install.sh | sh
#   ./install.sh --local      install the dsk in this checkout as dsk@asx8678. Claude Code loads it from the
#                             checkout, so edits take effect in the sessions started afterwards, and rerunning
#                             this refreshes the copy that the dsk command of your own shell runs.
#   ./install.sh --dev        link this checkout as dsk@skills-dir (~/.claude/skills/dsk -> <checkout>/skill),
#                             so that edits take effect at once.
#   ./install.sh --uninstall  uninstall dsk from Claude Code. ~/.config/dsk and ~/.local/state/dsk stay.
set -eu

usage() {
    cat >&2 <<'EOF'
install.sh: usage: install.sh [--local | --dev | --uninstall]

  (nothing)     install dsk@asx8678 from GitHub, or update it when it is installed
  --local       install the dsk in this checkout as dsk@asx8678; Claude Code loads it from the checkout, so
                edits take effect in the sessions started afterwards, and running this again refreshes it
  --dev         link this checkout as dsk@skills-dir, so that edits take effect at once
  --uninstall   uninstall dsk from Claude Code
EOF
    exit 2
}

mode=github   # no argument: dsk@asx8678 from GitHub
case "${1:-}" in
    "")          ;;
    --local)     mode=local ;;
    --dev)       mode=dev ;;
    --uninstall) mode=uninstall ;;
    *)           usage ;;
esac
[ $# -le 1 ] || usage

here=$(cd "$(dirname "$0")" && pwd)
claude="$HOME/.claude"   # a plugin in skills/ loads by itself in every session started after this
skill="$claude/skills/dsk"
bin="$HOME/.local/bin"
id=dsk@asx8678
dev_id=dsk@skills-dir
marketplace=asx8678
repo=asx8678/dsk

case "$mode" in
local|dev)
    if [ ! -d "$here/skill" ]; then
        echo "install.sh: there is no skill/ folder next to this script. Clone the repository first:" >&2
        echo "            git clone https://github.com/asx8678/dsk && cd dsk && ./install.sh --$mode" >&2
        exit 1
    fi
    ;;
esac

case "$mode" in
dev) ;;   # a link needs nothing from Claude Code, which picks it up at the next session
*)
    if ! command -v claude >/dev/null 2>&1; then
        echo "install.sh: the claude command is not on your PATH. Install Claude Code first: https://claude.com/claude-code" >&2
        exit 1
    fi
    ;;
esac

# ---- the Python that reads what Claude Code says

py3=
python_ok() {   # is there a Python 3.13 or newer under a name dsk accepts, and which one is it?
    for py in python3 python3.13 python3.14 python3.15; do
        if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 13) else 1)' >/dev/null 2>&1; then
            py3=$py
            return 0
        fi
    done
    return 1
}

case "$mode" in
uninstall) ;;   # uninstall reads no lists, so it needs no Python
*)
    if ! python_ok; then
        echo "install.sh: dsk needs Python 3.13 or newer, as python3, python3.13, python3.14 or python3.15, and there is none on your PATH. Install Python first: https://www.python.org/downloads/" >&2
        exit 1
    fi
    ;;
esac

# ---- what the claude plugin command says

plugins_json() {   # what Claude Code lists as installed
    claude plugin list --json 2>/dev/null || echo '[]'
}

marketplaces_json() {   # what marketplaces Claude Code has added
    claude plugin marketplace list --json 2>/dev/null || echo '[]'
}

is_installed() {   # is the plugin $1 installed for the user? A copy in a project is not the user's.
    plugins_json | "$py3" -c 'import json, sys
want = sys.argv[1]
sys.exit(0 if any(p.get("id") == want and p.get("scope") == "user" for p in json.load(sys.stdin)) else 1)' "$1"
}

version_of() {   # the version of the plugin $1 that the user has installed, or nothing
    plugins_json | "$py3" -c 'import json, sys
want = sys.argv[1]
for plugin in json.load(sys.stdin):
    if plugin.get("id") == want and plugin.get("scope") == "user":
        print(plugin.get("version", ""))
        break' "$1"
}

marketplace_listed() {   # is a marketplace named $1 added at all?
    marketplaces_json | "$py3" -c 'import json, sys
want = sys.argv[1]
sys.exit(0 if any(m.get("name") == want for m in json.load(sys.stdin)) else 1)' "$1"
}

marketplace_is_wanted() {   # is asx8678 added from what $1 wants: the GitHub repo $2, or the folder $2?
    marketplaces_json | "$py3" -c 'import json, sys
want, kind, source, repo = sys.argv[1:5]
for market in json.load(sys.stdin):
    if market.get("name") == want:
        match = market.get("repo") == repo if kind == "github" else market.get("path") == source
        sys.exit(0 if match else 1)
sys.exit(1)' "$marketplace" "$1" "$2" "$repo"
}

# ---- the two forms of the plugin

dsk_folder() {   # is $1 a real folder holding a copy of the dsk plugin?
    [ -f "$1/.claude-plugin/plugin.json" ] && grep -q '"name": "dsk"' "$1/.claude-plugin/plugin.json"
}

check_skills_folder() {   # stop, before anything is changed, unless ~/.claude/skills/dsk is ours or absent
    if [ -L "$skill" ]; then
        return 0
    fi
    if [ -e "$skill" ] && ! dsk_folder "$skill"; then
        echo "install.sh: $skill exists and is not dsk. Move it away and rerun." >&2
        exit 1
    fi
}

remove_dev() {   # remove the other form of the plugin, so that it loads once; the plugin is installed by now
    if [ -L "$skill" ]; then
        rm "$skill"
        echo "removed: $skill (the --dev link)"
    elif [ -e "$skill" ]; then
        rm -rf "$skill"
        echo "removed: $skill (a copy of the plugin)"
    fi
}

remove_command() {   # remove ~/.local/bin/dsk when it is the one install.sh writes
    if [ -L "$bin/dsk" ] || { [ -f "$bin/dsk" ] && grep -q "Written by dsk's install.sh" "$bin/dsk"; }; then
        rm -f "$bin/dsk"
        echo "dsk:    removed $bin/dsk"
    fi
}

install_failed() {   # say what state dsk is in when the plugin or its marketplace could not be installed
    if [ -L "$skill" ] || [ -e "$skill" ]; then   # the other form is removed only after a good install
        echo "install.sh: dsk@asx8678 is not installed; $skill is still in place, so dsk works as before. Run ./install.sh again." >&2
    else
        echo "install.sh: dsk is not installed now; run ./install.sh again, or ./install.sh --dev to link this checkout." >&2
    fi
    exit 1
}

# ---- the modes

marketplace_to_wanted() {   # add asx8678 from the source this mode wants, or refresh it when it is there
    case "$mode" in
    local) kind=directory; source=$here ;;
    *)     kind=github;    source=$repo ;;
    esac
    if marketplace_is_wanted "$kind" "$source"; then
        claude plugin marketplace update "$marketplace" || {
            echo "install.sh: the asx8678 marketplace could not be refreshed: dsk is as it was; check the network, then run ./install.sh again." >&2
            exit 1
        }
        return 0
    fi
    if marketplace_listed "$marketplace"; then
        echo "warning: asx8678 is added from another source, so it is removed and added again: keys entered in /plugin configure must be entered again; keys in ~/.config/dsk/env are not touched." >&2
        claude plugin marketplace remove "$marketplace" || {
            echo "install.sh: the asx8678 marketplace could not be removed, so dsk is as it was; run ./install.sh again." >&2
            exit 1
        }
    fi
    if [ "$kind" = directory ]; then
        claude plugin marketplace add "$here" || install_failed
    else
        claude plugin marketplace add "$repo" || install_failed
    fi
}

install_plugin() {   # default and --local: the marketplace, then the plugin, then the other form goes away
    check_skills_folder
    marketplace_to_wanted
    if [ "$mode" = local ]; then
        if is_installed "$id"; then
            # the version may be unchanged while the files differ, so install again instead of updating
            claude plugin uninstall "$id" --keep-data || {
                echo "install.sh: dsk@asx8678 could not be uninstalled for the reinstall, so dsk is as it was; run ./install.sh --local again." >&2
                exit 1
            }
        fi
        claude plugin install "$id" || install_failed
    elif is_installed "$id"; then
        claude plugin update "$id" || {
            echo "install.sh: dsk is still installed at its old version: run ./install.sh again, or ./install.sh --dev to link this checkout." >&2
            exit 1
        }
    else
        claude plugin install "$id" || install_failed
    fi
    is_installed "$id" || install_failed
    remove_dev
}

link_checkout() {   # --dev: link this checkout, and only then drop the form that Claude Code installed
    check_skills_folder
    mkdir -p "$claude/skills"
    if [ -L "$skill" ]; then
        rm "$skill"
    elif [ -e "$skill" ]; then
        rm -rf "$skill"
    fi
    ln -s "$here/skill" "$skill" || {
        echo "install.sh: $skill could not be linked, so dsk is not installed now; run ./install.sh --dev again." >&2
        exit 1
    }
    rm -f "$claude/agents/dsk-reviewer.md"   # an earlier install put the reviewer here; it is part of the plugin now, as dsk:reviewer
    if command -v claude >/dev/null 2>&1 && is_installed "$id"; then
        claude plugin uninstall "$id" --keep-data || {
            echo "install.sh: dsk@asx8678 could not be uninstalled, so dsk is installed twice now; run ./install.sh --dev again, or uninstall it in Claude Code." >&2
            exit 1
        }
    fi
}

uninstall() {   # remove every form of dsk, asking claude to do its part and ignoring what it says
    claude plugin uninstall "$id" --keep-data >/dev/null 2>&1 || true
    claude plugin marketplace remove "$marketplace" >/dev/null 2>&1 || true
    if [ -L "$skill" ]; then
        rm "$skill"
        echo "removed: $skill"
    elif [ -e "$skill" ] && dsk_folder "$skill"; then
        rm -rf "$skill"
        echo "removed: $skill"
    fi
    remove_command
    echo "dsk:    $HOME/.config/dsk and $HOME/.local/state/dsk are kept"
}

# ---- the dsk command for the user's own shell

write_command() {   # write ~/.local/bin/dsk, a small script that runs the plugin Claude Code has installed
    dsk_command=no
    if [ ! -d "$bin" ]; then
        echo "dsk:    not linked, because $bin does not exist. Create it and rerun to get a 'dsk' command."
        return 0
    fi
    target="$bin/dsk"
    if [ -L "$target" ] || { [ -f "$target" ] && grep -q "Written by dsk's install.sh" "$target"; }; then
        rm -f "$target"
    elif [ -e "$target" ]; then
        echo "dsk:    left $target alone, because install.sh did not write it."
        return 0
    fi
    cat > "$target" <<'EOF'
#!/bin/sh
# Written by dsk's install.sh: runs the dsk plugin that Claude Code has installed.
set -eu

linked="$HOME/.claude/skills/dsk/scripts/dsk.py"
if [ -f "$linked" ]; then
    exec python3 "$linked" "$@"
fi

newest=
for folder in "$HOME"/.claude/plugins/cache/asx8678/dsk/*/; do
    [ -f "$folder/scripts/dsk.py" ] || continue
    [ ! -f "$folder/.orphaned_at" ] || continue   # an update marks the folder it left behind as orphaned
    if [ -z "$newest" ] || [ "$folder" -nt "$newest" ]; then
        newest="$folder"
    fi
done
if [ -n "$newest" ]; then
    exec python3 "$newest/scripts/dsk.py" "$@"
fi

echo "dsk: the plugin is not installed. Run install.sh again." >&2
exit 1
EOF
    chmod 755 "$target"
    dsk_command=yes
    echo "dsk:    $target"
}

# ---- closing output

json_version() {   # the top-level "version" of a plugin.json
    sed -n 's/^ *"version": *"\([^"]*\)".*$/\1/p' "$1" | head -1
}

finish() {   # what is installed now, the dsk command, and what the user still has to do
    case "$mode" in
    dev) name=$dev_id; version=$(json_version "$here/skill/.claude-plugin/plugin.json") ;;
    *)   name=$id;     version=$(version_of "$id") ;;
    esac
    echo "plugin: $name $version"
    write_command

    cat <<'EOF'

Still to do:
EOF
    n=1
    if [ "$dsk_command" = yes ] && "$bin/dsk" configure >/dev/null 2>&1; then
        :
    else
        echo "$n. Provider. In Claude Code, run /plugin configure $name and enter your DeepSeek API key, or pick"
        echo "   provider custom and enter its endpoint URL, model name and API key. Then restart Claude Code and check it"
        echo "   with: dsk doctor"
        echo "   (Keys in ~/.config/dsk/env and profiles in ~/.config/dsk/config.json work too, and win; see README.md.)"
        n=$((n + 1))
    fi
    echo "$n. Permissions. The skill pre-approves dsk only for the turn that invokes it. For later turns and"
    echo "   background runs, add this to \"permissions\": {\"allow\": [...]} in ~/.claude/settings.json:"
    echo "       \"Bash(dsk *)\""
    n=$((n + 1))
    echo "$n. Display. Restart Claude Code, or run /reload-plugins in sessions that are already open. Then /dsk-jobs on"
    echo "   loads the live display of the jobs and /dsk-jobs off unloads it; the choice holds for later sessions."
}

case "$mode" in
uninstall) uninstall ;;
dev)       link_checkout; finish ;;
*)         install_plugin; finish ;;
esac
