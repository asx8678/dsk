// The sandbox: the SBPL profile macOS's sandbox-exec applies to a worker's scripts and checks. The profile is cached
// per text, and so is the answer whether sandbox-exec applies it on this machine.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
import { Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg } from './base.js';
import { plugin } from './config.js';
import { SANDBOX_EXEC, SANDBOX_HIDE, SANDBOX_WRITE } from './texts.js';
/** Profile text -> whether sandbox-exec applies it here, tried once per process; "user_cache" holds the cache folder. */
export const sandboxes = new Map();
/**
 * os.path.realpath(): symlinks resolved, a path that does not exist yet kept as its resolved parent plus its name.
 * Node's realpathSync throws ENOENT for the missing build caches and hidden folders in a profile, as Python's does not.
 */
function real(p) {
    const abs = path.resolve(p);
    try {
        return fs.realpathSync(abs);
    }
    catch {
        const parent = path.dirname(abs);
        return parent === abs ? abs : path.join(real(parent), path.basename(abs));
    }
}
/** Python's repr() of the config value a message embeds: a string in the quote that saves escaping, else a literal. */
function pyRepr(value) {
    if (typeof value === 'string') {
        const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
        let out = quote;
        for (const ch of value) {
            const code = ch.codePointAt(0) ?? 0;
            if (ch === '\\' || ch === quote)
                out += '\\' + ch;
            else if (ch === '\n')
                out += '\\n';
            else if (ch === '\r')
                out += '\\r';
            else if (ch === '\t')
                out += '\\t';
            else if (code < 0x20 || (code >= 0x7f && code < 0xa0))
                out += '\\x' + code.toString(16).padStart(2, '0');
            else
                out += ch;
        }
        return out + quote;
    }
    if (value === null || value === undefined)
        return 'None';
    if (typeof value === 'number') {
        // Python keeps 7 and 7.0 distinct; an integer JSON value reads as an int here, and repr has no .0 then.
        if (Object.is(value, -0))
            return '-0.0';
        if (Number.isInteger(value))
            return String(value);
        return pyFloat(value);
    }
    if (typeof value === 'boolean')
        return value ? 'True' : 'False';
    if (Array.isArray(value))
        return '[' + value.map(pyRepr).join(', ') + ']';
    if (typeof value === 'object') {
        return '{' + Object.keys(value).map((k) => pyRepr(k) + ': ' + pyRepr(value[k])).join(', ') + '}';
    }
    return String(value);
}
/** A path as an SBPL string literal. */
export function sbpl(path) {
    return '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
/** The git directory of a working tree and the common one (they differ in a worktree), or [] outside git. */
export function gitDirs(workdir) {
    const done = runSync('git', ['-C', workdir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
    if (done.code !== 0)
        return [];
    const found = done.out.trim();
    return [...new Set((found ? found.split(/\s+/) : []).map((p) => real(p)))];
}
/** macOS's per-user cache folder, the sibling of the temp folder where clang keeps its module cache, or None. */
export function userCache() {
    if (!sandboxes.has('user_cache')) {
        const found = runSync('getconf', ['DARWIN_USER_CACHE_DIR']);
        const text = found.out.trim();
        sandboxes.set('user_cache', found.code === 0 && text ? real(text) : null);
    }
    return sandboxes.get('user_cache');
}
/** The SBPL profile for the worker's scripts and the checks. Rules that come later win, so the order matters: */
export function sandboxProfile(cfg, workdir, sdir) {
    const home = (p) => real(expandUser(p));
    const temp = [...new Set([real('/tmp'), real(os.tmpdir())])];
    const cache = userCache();
    const writes = [...SANDBOX_WRITE, ...get(cfg, 'sandbox_write', [])].map(home);
    const caches = [...(cache ? [cache] : []), ...writes];
    const mine = [real(workdir), real(path.join(sdir, 'scratch')), ...temp.slice(1)]; // the temp folder may be a scratchpad too
    const gits = gitDirs(workdir);
    const under = (paths) => paths.map((p) => `(subpath ${sbpl(p)})`).join(' ');
    const forms = ['(version 1)', '(allow default)', '(deny file-write*)',
        '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") ' +
            '(literal "/dev/stderr") (regex #"^/dev/fd/"))',
        `(allow file-write* ${under([...temp, ...caches])})`,
        '(deny file-write* (regex #"^/private/tmp/claude-[0-9]+/"))',
        `(allow file-write* ${under(mine)} (literal ${sbpl(path.join(real(sdir), 'answer'))}))`];
    if (gits.length) {
        forms.push(`(deny file-write* ${under(gits)})`, `(allow file-write* (literal ${sbpl(gits[0] + '/index')}) (literal ${sbpl(gits[0] + '/index.lock')}))`);
    }
    const hidden = [...SANDBOX_HIDE, ...get(cfg, 'sandbox_hide', [])].map(home);
    const stored = plugin('path'); // the keys entered in the plugin's form, and the copy `configure --hook` writes beside it
    if (stored)
        hidden.push(real(stored), real(stored) + '.new');
    forms.push(`(deny file-read* ${under(hidden)})`);
    return forms.join(' ');
}
/** Whether sandbox-exec applies `profile` here, tried once. A failure is never read off a command's own output: */
export function sandboxWorks(profile) {
    if (!sandboxes.has(profile)) {
        try {
            sandboxes.set(profile, runSync(SANDBOX_EXEC, ['-p', profile, '/usr/bin/true'], { timeout: 30_000 }).code === 0);
        }
        catch {
            sandboxes.set(profile, false);
        }
    }
    return sandboxes.get(profile);
}
/** At a run's start: (True, "") when its scripts and checks will run sandboxed, else (False, why). `refused` is */
export function sandboxMode(cfg, workdir, sdir, refused = false) {
    const mode = get(cfg, 'sandbox', 'auto');
    if (mode !== 'auto' && mode !== 'off' && mode !== 'required') {
        throw new Fail(`config: sandbox is ${pyRepr(mode)}, not one of auto, off, required`);
    }
    if (refused && mode === 'required') {
        throw new Fail('config: sandbox is required, so --no-sandbox is refused');
    }
    if (refused)
        return [false, '--no-sandbox'];
    if (mode === 'off')
        return [false, ''];
    const why = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC) ? ''
        : 'no sandbox-exec on this system';
    const later = why || (sandboxWorks(sandboxProfile(cfg, workdir, sdir)) ? ''
        : 'sandbox-exec could not apply the profile');
    if (later && mode === 'required') {
        throw new Fail(`config: sandbox is required, but ${later}`);
    }
    return [!later, later];
}
/** The command prefix that runs a script or a check in the session's sandbox, or [] for a session without one. */
/** Python's truthiness, which JavaScript's empty [] and {} do not share. */
function truthy(value) {
    if (value === null || value === undefined || value === false || value === 0 || value === '')
        return false;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === 'object')
        return Object.keys(value).length > 0;
    return true;
}
/** The command prefix that runs a script or a check in the session's sandbox, or [] for a session without one. */
export function sandboxed(s, cfg) {
    if (!truthy(get(s.head, 'sandbox')))
        return [];
    const profile = sandboxProfile(cfg, s.head['workdir'], s.dir);
    if (!sandboxWorks(profile)) {
        throw new Fail('the sandbox this run started with cannot be applied any more; dsk reject ID --drop, or set ' +
            '"sandbox": "off" in the config and run it again');
    }
    return [SANDBOX_EXEC, '-p', profile];
}
