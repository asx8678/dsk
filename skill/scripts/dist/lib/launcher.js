// Mending the dsk command an older install.sh wrote to ~/.local/bin. Up to 0.10 it ran scripts/dsk.py, which 0.11.0
// removed, so after an update it finds no dsk to run and says the plugin is not installed. The hooks mend it, since
// they run the new version first, before anyone types `dsk`.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
import { LAUNCHER } from './texts.js';
/** Where install.sh writes the dsk command. */
export function launcherPath() {
    return path.join(process.env.HOME || os.homedir(), '.local', 'bin', 'dsk');
}
/**
 * Whether `target` is a dsk command an older install.sh wrote that runs scripts/dsk.py: a file with install.sh's
 * mark, or the link the first versions made. A file without the mark is the user's own and is never touched.
 */
export function oldLauncher(target) {
    let st;
    try {
        st = fs.lstatSync(target);
    }
    catch {
        return false;
    }
    if (st.isSymbolicLink())
        return fs.readlinkSync(target).endsWith('scripts/dsk.py');
    if (!st.isFile() || st.size > 64 * 1024)
        return false;
    const text = fs.readFileSync(target, 'utf8');
    return text.includes("Written by dsk's install.sh") && text.includes('scripts/dsk.py');
}
/**
 * Rewrites an old dsk command with the one install.sh writes now, in one step as install.sh does, so that a dsk
 * starting meanwhile never finds half a file. The sentence that tells the user, or '' when there was nothing to mend
 * or it could not be mended: a hook never fails for it.
 */
export function mendLauncher() {
    const target = launcherPath();
    const fresh = `${target}.new.${process.pid}`;
    try {
        if (!oldLauncher(target))
            return '';
        fs.writeFileSync(fresh, LAUNCHER, 'utf8');
        fs.chmodSync(fresh, 0o755);
        fs.renameSync(fresh, target);
    }
    catch {
        try {
            fs.rmSync(fresh, { force: true });
        }
        catch { /* nothing was left */ }
        return '';
    }
    return '~/.local/bin/dsk ran the Python dsk, which this version removed: it now runs this one.';
}
