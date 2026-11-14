#!/bin/sh
# Tests install.sh against a throwaway HOME. It installs this checkout, so it covers --local, --dev and
# --uninstall, and it uses no network.
#   sh tests/install_test.sh     prints install_test: ok, or FAIL: what on stderr
set -eu

checkout=$(cd "$(dirname "$0")/.." && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' 0
mkdir -p "$home/.local/bin"
log="$home/install.log"

fail() {   # stop at the first thing that is wrong, showing what install.sh said
    echo "FAIL: $*" >&2
    if [ -s "$log" ]; then
        echo "--- install.sh said:" >&2
        sed 's/^/    /' "$log" >&2
    fi
    exit 1
}

status=0
install_status() {   # run install.sh in the throwaway HOME, keeping its output and its exit status
    status=0
    HOME="$home" "$checkout/install.sh" "$@" >"$log" 2>&1 || status=$?
    return 0
}

install_dsk() {   # run install.sh in the throwaway HOME, which must work, and keep its output for a failure
    install_status "$@"
    [ "$status" = 0 ] || fail "install.sh $* exited $status"
}

ids() {   # the plugin ids Claude Code lists
    HOME="$home" claude plugin list --json | grep '"id":' || true
}

count_ids() {   # how many dsk plugins Claude Code lists
    ids | grep -c 'dsk@' || true
}

no_dev_link() {   # ~/.claude/skills/dsk must not exist at all
    if [ -e "$home/.claude/skills/dsk" ] || [ -L "$home/.claude/skills/dsk" ]; then
        fail "$1 left ~/.claude/skills/dsk in place"
    fi
}

command_works() {   # the dsk command must run
    HOME="$home" "$home/.local/bin/dsk" --help >/dev/null 2>&1 || fail "$1: ~/.local/bin/dsk --help failed"
}

# 1. --local installs the plugin, not the link, and writes the dsk command.
install_dsk --local
ids | grep -q '"id": "dsk@asx8678"' || fail "--local did not install dsk@asx8678"
no_dev_link "--local"
command_works "--local"

# 2. A second --local does not install the plugin twice.
install_dsk --local
[ "$(count_ids)" = 1 ] || fail "the second --local left $(count_ids) dsk plugins, not one"

# 3. --dev links the checkout, and only that form of the plugin loads.
install_dsk --dev
ids | grep -q '"id": "dsk@skills-dir"' || fail "--dev did not install dsk@skills-dir"
if ids | grep -q 'dsk@asx8678'; then fail "--dev left dsk@asx8678 installed as well"; fi
[ "$(readlink "$home/.claude/skills/dsk")" = "$checkout/skill" ] || fail "the link does not point at $checkout/skill"
command_works "--dev"

# 4. --local after --dev removes the link and installs the plugin only.
install_dsk --local
no_dev_link "--local after --dev"
ids | grep -q '"id": "dsk@asx8678"' || fail "--local after --dev did not install dsk@asx8678"
if ids | grep -q 'dsk@skills-dir'; then fail "--local after --dev left dsk@skills-dir installed"; fi
[ "$(count_ids)" = 1 ] || fail "--local after --dev left $(count_ids) dsk plugins, not one"

# 5. --uninstall removes the plugin, the marketplace and the command.
install_dsk --uninstall
if ids | grep -q 'dsk@'; then fail "--uninstall left a dsk plugin: $(ids)"; fi
if HOME="$home" claude plugin marketplace list --json | grep -q 'asx8678'; then
    fail "--uninstall left the asx8678 marketplace"
fi
if [ -e "$home/.local/bin/dsk" ]; then fail "--uninstall left ~/.local/bin/dsk"; fi

# 6. --local leaves a ~/.local/bin/dsk alone when install.sh did not write it.
printf '#!/bin/sh\necho not dsk\n' >"$home/.local/bin/dsk"
chmod 755 "$home/.local/bin/dsk"
cp "$home/.local/bin/dsk" "$home/foreign"
install_dsk --local
cmp -s "$home/foreign" "$home/.local/bin/dsk" || fail "--local replaced ~/.local/bin/dsk, which install.sh did not write"

# 7. An argument that is not a mode prints the usage and exits 2.
status=0
HOME="$home" "$checkout/install.sh" --nonsense >/dev/null 2>&1 || status=$?
[ "$status" = 2 ] || fail "install.sh --nonsense exited $status, not 2"

# 8. The dsk command skips a cache folder marked .orphaned_at, and tells the user when every folder is marked.
rm -f "$home/.local/bin/dsk"
install_dsk --local
cache="$home/.claude/plugins/cache/asx8678/dsk"
mkdir -p "$cache/0.0.1/scripts"
printf '#!/bin/sh\necho orphan\n' >"$cache/0.0.1/scripts/dsk.py"
chmod 755 "$cache/0.0.1/scripts/dsk.py"
: >"$cache/0.0.1/.orphaned_at"   # written last, so that this folder is the newest one in the cache
HOME="$home" "$home/.local/bin/dsk" --help >"$home/out" 2>&1 || fail "the dsk command failed with an orphaned folder in the cache"
if grep -q orphan "$home/out"; then fail "the dsk command ran the folder marked .orphaned_at"; fi
grep -q 'usage: dsk' "$home/out" || fail "the dsk command did not print dsk's usage"
for folder in "$cache"/*/; do : >"$folder/.orphaned_at"; done
install_status_skip=0
HOME="$home" "$home/.local/bin/dsk" --help >"$home/out" 2>&1 || install_status_skip=$?
[ "$install_status_skip" = 1 ] || fail "the dsk command exited $install_status_skip, not 1, when every cache folder is orphaned"
grep -q 'the plugin is not installed' "$home/out" || fail "the dsk command did not say the plugin is not installed"
rm -rf "$cache/0.0.1"
rm -f "$cache"/*/.orphaned_at

# 9. --dev stops at a folder in ~/.claude/skills that is not dsk, and leaves it and the plugin alone.
mkdir -p "$home/.claude/skills/dsk"
printf 'not dsk\n' >"$home/.claude/skills/dsk/notes.txt"
install_status --dev
[ "$status" != 0 ] || fail "--dev exited 0 with a folder that is not dsk at ~/.claude/skills/dsk"
ids | grep -q '"id": "dsk@asx8678"' || fail "--dev uninstalled dsk@asx8678 before noticing the folder"
[ -f "$home/.claude/skills/dsk/notes.txt" ] || fail "--dev touched the folder that is not dsk"
rm -rf "$home/.claude/skills/dsk"

# 10. A failing `claude plugin install` says what state dsk is in, and keeps the --dev link.
install_dsk --dev
real=$(command -v claude)
mkdir -p "$home/fakebin"
printf '#!/bin/sh\nfor arg in "$@"; do\n    if [ "$arg" = install ]; then echo "fake claude: no" >&2; exit 1; fi\ndone\nexec "%s" "$@"\n' "$real" >"$home/fakebin/claude"
chmod 755 "$home/fakebin/claude"
saved_path=$PATH
PATH="$home/fakebin:$PATH"
install_status --local
PATH=$saved_path
[ "$status" != 0 ] || fail "--local exited 0 when claude plugin install failed"
grep -q 'is not installed; .* is still in place' "$log" || fail "--local did not say what state dsk is in after the failed install"
[ -L "$home/.claude/skills/dsk" ] || fail "--local removed the --dev link when its own install failed"

# 11. A copy in a project is not the user's install, so it neither blocks --local nor stops --dev.
project="$home/project"
mkdir -p "$project"
( cd "$project" && HOME="$home" claude plugin install dsk@asx8678 --scope project ) >"$log" 2>&1 || fail "could not install dsk@asx8678 at project scope for this test"
install_dsk --local
install_dsk --dev

echo "install_test: ok"
