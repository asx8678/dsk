const crypto = process.getBuiltinModule('node:crypto');
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
/**
 * Python's `key in d` for a dict: own keys only. `in` and d[key] on a plain object also see Object.prototype, so a
 * provider named `constructor` or `toString` would seem to exist.
 */
export function has(d, key) {
    return d !== null && d !== undefined && Object.hasOwn(d, key);
}
/** Python's d.get(key, fallback) for a dict: own keys only, and a stored null is returned as null. */
export function get(d, key, fallback = null) {
    return has(d, key) ? d[key] : fallback;
}
/** Whether a value that came out of JSON is a dict, as Python's isinstance(value, dict) asked. */
export function isDict(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Python's truth of a JSON value: false for null, false, 0 and "", and for an empty list or dict. */
export function truthy(value) {
    if (value === null || value === undefined || value === false || value === 0 || value === '')
        return false;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === 'object')
        return Object.keys(value).length > 0;
    return true;
}
/**
 * Python's except OSError: an error with a code (ENOENT, EACCES, and Node's ERR_FS_EISDIR from rm or cp), unless it
 * is a TypeError or RangeError, which Node throws for a call it was given wrongly: a bug, which keeps its stack.
 */
export function isOsError(e) {
    return typeof e?.code === 'string' && !(e instanceof TypeError || e instanceof RangeError);
}
/** A failure dsk reports as `dsk · error: <message>`, as a Python `Fail` was. */
export class Fail extends Error {
    name = 'Fail';
}
/** A signal arrived (SIGINT, SIGTERM or SIGHUP): Python's KeyboardInterrupt. */
export class Interrupted extends Error {
    name = 'Interrupted';
    constructor() {
        super('interrupted');
    }
}
/** Flags that main() sets for the whole process, as dsk.py's module globals VERBOSE and JSON were. */
export const G = { verbose: false, json: false };
// ---------------------------------------------------------------- the interrupt
/**
 * Aborted when a signal arrives. Python raised KeyboardInterrupt wherever the program stood, and the `finally`
 * blocks on the way out (settling a script's changes, killing a process group) ran. Node runs a signal handler only
 * between tasks, so every wait that can last (a reply, a script, a check, a sleep) listens to this signal instead and
 * rejects with Interrupted; the `finally` blocks run as they did. Synchronous code is never cut in the middle.
 */
export const stopping = new AbortController();
/** Turn SIGINT, SIGTERM and SIGHUP into an interrupt. main() calls it once. */
export function interruptOnSignals() {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => stopping.abort());
    }
}
/** Throw Interrupted when a signal has arrived. */
export function checkInterrupt() {
    if (stopping.signal.aborted)
        throw new Interrupted();
}
/** Call `fn` once when a signal arrives (at once if one has). Returns a function that unregisters it. */
export function onInterrupt(fn) {
    if (stopping.signal.aborted) {
        fn();
        return () => { };
    }
    stopping.signal.addEventListener('abort', fn, { once: true });
    return () => stopping.signal.removeEventListener('abort', fn);
}
/** time.sleep(seconds), as a promise that rejects with Interrupted when a signal arrives. */
export function sleep(seconds) {
    return new Promise((resolve, reject) => {
        if (stopping.signal.aborted)
            return reject(new Interrupted());
        const off = onInterrupt(() => {
            clearTimeout(timer);
            reject(new Interrupted());
        });
        const timer = setTimeout(() => {
            off();
            resolve();
        }, Math.max(0, seconds * 1000));
    });
}
/** Block the whole process for `seconds`. Only for the lock helper, which must answer without an event loop. */
export function sleepSync(seconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds * 1000));
}
// ---------------------------------------------------------------- JSON as Python writes it
/** A number Python held as a float, so JSON writes `1.0`, not `1`: the temperature 1.0 of HEAT, sent as dsk.py sent it. */
export class PyFloat {
    value;
    constructor(value) {
        this.value = value;
    }
}
/** Python's repr() of a float, which json.dumps writes: shortest digits, as JavaScript finds them, in Python's
 * notation: `0.0`, `1.5`, `5.9211e-05`, `1e+16`. */
export function pyFloatRepr(x) {
    if (Number.isNaN(x))
        return 'NaN';
    if (!Number.isFinite(x))
        return x > 0 ? 'Infinity' : '-Infinity';
    if (x === 0)
        return Object.is(x, -0) ? '-0.0' : '0.0';
    const [mantissa, power] = x.toExponential().split('e');
    const exp = Number(power);
    const sign = mantissa.startsWith('-') ? '-' : '';
    const digits = mantissa.replace('-', '').replace('.', '');
    if (exp < -4 || exp >= 16) {
        const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
    }
    if (exp < 0)
        return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
    const whole = exp + 1;
    return sign + (digits.length <= whole ? `${digits}${'0'.repeat(whole - digits.length)}.0`
        : `${digits.slice(0, whole)}.${digits.slice(whole)}`);
}
/** The keys whose numbers dsk.py always held as floats (time.time(), a division, a round() of a float): written
 * `1.0`, not `1`, as JSON from Python has them. JavaScript cannot tell 1.0 from 1, so the key says it. */
const FLOAT_KEYS = new Set(['at', 'created', 'active', 'cached', 'first', 'until', 'seconds', 'model_seconds', 'lead_seconds']);
/**
 * json.dumps as dsk.py called it. `sep` is [item separator, key separator]: the default is Python's own (', ', ': '),
 * which the log uses; dumps() passes the compact pair the requests use. Keys keep their insertion order. A number
 * that is not whole is written as Python writes a float; a whole one as Python wrote it, an int, unless its key says
 * dsk.py held a float there (FLOAT_KEYS; `cost` once any usage was counted; the seconds of a profile's `speed`).
 * `ascii` is json.dumps' default ensure_ascii, for the files dsk.py wrote that way. A BigInt is a nanosecond mtime.
 */
export function pyJson(value, sep = [', ', ': '], ascii = false) {
    const text = serialize(value, sep, false);
    return ascii ? asciiEscaped(text) : text;
}
function serialize(value, sep, float) {
    if (value === null || value === undefined)
        return 'null';
    if (value instanceof PyFloat)
        return pyFloatRepr(value.value);
    if (typeof value === 'bigint')
        return value.toString();
    if (typeof value === 'number') {
        if (float || !Number.isInteger(value) || !Number.isFinite(value))
            return pyFloatRepr(value);
        return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
    }
    if (typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map((v) => serialize(v, sep, false)).join(sep[0]) + ']';
    if (typeof value === 'object') {
        // A Map is a dict whose order JavaScript would otherwise change: ids made of digits go first in an object.
        const d = (value instanceof Map ? Object.fromEntries(value) : value);
        const items = (value instanceof Map ? [...value] : Object.entries(d)).filter(([, v]) => v !== undefined);
        return '{' + items.map(([k, v]) => {
            let inner;
            if (k === 'speed' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
                // metrics' {profile: [seconds, turns]}: the seconds were a float sum, the turns a count
                inner = '{' + Object.entries(v).map(([name, pair]) => JSON.stringify(name) + sep[1] +
                    (Array.isArray(pair) ? '[' + pair.map((x, i) => serialize(x, sep, i === 0)).join(sep[0]) + ']'
                        : serialize(pair, sep, false))).join(sep[0]) + '}';
            }
            else {
                // `cost` is sum() over the usage: a float, unless there was no usage and sum() gave its start, the int 0
                const float = FLOAT_KEYS.has(k) || (k === 'cost' && (v !== 0 || Number(d['in']) > 0));
                inner = serialize(v, sep, float);
            }
            return JSON.stringify(k) + sep[1] + inner;
        }).join(sep[0]) + '}';
    }
    throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}
/** json.dumps as Python calls it with no arguments: spaces after the separators, every non-ASCII character escaped. */
export function pyJsonAscii(value) {
    return pyJson(value, [', ', ': '], true);
}
/** A text with every character outside ASCII as a \\uXXXX escape, as json.dumps writes it by default. */
export function asciiEscaped(text) {
    return text.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
/** dsk.py's dumps(): compact JSON, non-ASCII kept as it is. The only serializer of a request. */
export function dumps(value) {
    return pyJson(value, [',', ':']);
}
// ---------------------------------------------------------------- strings by code point
/** Python's len() of a str: code points, not UTF-16 units. A fingerprint's `n` counts this way in every log. */
export function cpLen(text) {
    let n = text.length;
    for (let i = 0; i < text.length - 1; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                n--;
                i++;
            }
        }
    }
    return n;
}
/** Python's text[:n] for n >= 0: the first n code points. */
export function cpHead(text, n) {
    let i = 0;
    for (let k = 0; k < n && i < text.length; k++) {
        const c = text.charCodeAt(i);
        i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    }
    return text.slice(0, i);
}
/** Python's " ".join(text.split()): the words of a text, with every run of whitespace made one space. */
export function words(text) {
    const trimmed = String(text).trim();
    return trimmed ? trimmed.split(/\s+/).join(' ') : '';
}
/** Python's str.splitlines(): every line separator Python knows, and no empty last line after a final one. */
export function splitLines(text) {
    if (!text)
        return [];
    const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
/**
 * Python's repr() of a value that came out of JSON, as dsk.py's messages quoted one: a string in the quote that saves
 * escaping, with control characters escaped; None, True and False by name; lists and dicts as Python prints them.
 */
export function pyRepr(value) {
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
        return Number.isInteger(value) ? String(value) : pyFloat(value);
    }
    if (typeof value === 'boolean')
        return value ? 'True' : 'False';
    if (Array.isArray(value))
        return '[' + value.map(pyRepr).join(', ') + ']';
    if (typeof value === 'object') {
        return '{' + Object.entries(value).map(([k, v]) => pyRepr(k) + ': ' + pyRepr(v)).join(', ') + '}';
    }
    return String(value);
}
/** The SHA-256 of a text or of bytes, in hex. */
export function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}
/** dsk.py's fingerprint(): the length in code points and the SHA-256 of the UTF-8 bytes. */
export function fingerprint(wire) {
    return { n: cpLen(wire), sha: sha256(wire) };
}
/** secrets.token_hex(n). */
export function tokenHex(n) {
    return crypto.randomBytes(n).toString('hex');
}
// ---------------------------------------------------------------- numbers as Python prints them
/**
 * When x lies exactly halfway between two numbers of `digits` decimals, where Python rounds to even and toFixed()
 * away from zero: x * 10**digits rounded to even. Otherwise null, and toFixed(), which rounds the exact binary value
 * as Python does, is right. Decided on x's exact decimal digits, which toFixed(100) gives: 2.675 is
 * 2.67499999999999982..., no tie, though 2.675 * 100 computes to 267.5.
 */
function tie(x, digits) {
    const exact = Math.abs(x).toFixed(100).replace(/0+$/, '');
    const fraction = exact.split('.')[1] ?? '';
    if (fraction.length !== digits + 1 || !fraction.endsWith('5'))
        return null;
    const low = Number(exact.slice(0, exact.length - 1).replace('.', ''));
    return Math.sign(x) * (low % 2 === 0 ? low : low + 1);
}
/** Python's round(x, digits): half to even on exact ties. round(x) with no digits gives an integer as Python's did. */
export function pyRound(x, digits = 0) {
    const even = tie(x, digits);
    if (even !== null)
        return even / 10 ** digits;
    return Number(x.toFixed(digits));
}
/**
 * Python's sum() of floats. Since 3.12 CPython adds floats with Neumaier's compensated summation, so a cost summed
 * over many turns ends in other digits than a plain loop of additions gives: 0.01787005, not 0.017870050000000002.
 * The first item is added to the start, 0, as it is; every later one is compensated, and the compensation is added
 * at the end when it is finite. An int 0 in the list, as `x or 0` gives, changes nothing either way.
 */
export function pySum(values) {
    let total = 0;
    let compensation = 0;
    let first = true;
    for (const x of values) {
        if (first) {
            total = 0 + x;
            first = false;
            continue;
        }
        const t = total + x;
        compensation += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
        total = t;
    }
    if (compensation && Number.isFinite(compensation))
        total += compensation;
    return total;
}
/** f"{x:.{digits}f}": a fixed number of decimals, half to even on exact ties as Python formats them. */
export function fixed(x, digits) {
    const even = tie(x, digits);
    return even !== null ? (even / 10 ** digits).toFixed(digits) : x.toFixed(digits);
}
/** f"{x:,}" for an integer, and f"{x:,.{digits}f}" with digits: thousands separated by commas. */
export function comma(x, digits) {
    const text = digits === undefined ? String(Math.trunc(x)) : fixed(x, digits);
    const [whole, fraction] = text.split('.');
    const sign = whole.startsWith('-') ? '-' : '';
    const grouped = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + grouped + (fraction !== undefined ? '.' + fraction : '');
}
/** f"{x:.{digits}%}": a share as a percentage. */
export function fmtPercent(x, digits = 0) {
    return fixed(x * 100, digits) + '%';
}
/** str(x) of a Python float: an integral value keeps its `.0` (`3.0`), as f"{x}" printed it. */
export function pyFloat(x) {
    return Number.isInteger(x) && Math.abs(x) < 1e16 ? `${x}.0` : String(x);
}
/** Python's str.format for the templates dsk.py kept as constants: `{}`, `{0}` and `{name}`, and `{{`, `}}`. */
export function format(template, ...args) {
    const named = args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
        && !Array.isArray(args[args.length - 1]) ? args[args.length - 1] : {};
    let auto = 0;
    return template.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (whole, field) => {
        if (whole === '{{')
            return '{';
        if (whole === '}}')
            return '}';
        const name = (field ?? '').split(':')[0] ?? '';
        const value = name === '' ? args[auto++] : /^\d+$/.test(name) ? args[Number(name)] : named[name];
        return String(value);
    });
}
/** Epoch seconds, as time.time() gave them. */
export function now() {
    return Date.now() / 1000;
}
// ---------------------------------------------------------------- where dsk keeps things
/** dsk.py's xdg(): $VAR/dsk, or the default under the home folder. */
export function xdg(variable, fallback) {
    const base = process.env[variable] || fallback.replace(/^~(?=$|\/)/, os.homedir());
    return path.join(base, 'dsk');
}
/** Sessions, slots and caches: ~/.local/state/dsk. Read once, at startup, as dsk.py read it. */
export const STATE = xdg('XDG_STATE_HOME', '~/.local/state');
/**
 * os.path.realpath(): symlinks resolved, and a path that does not exist yet kept as its resolved parent plus its own
 * name, where Node's realpathSync throws. The scope gate compares written paths this way, and the sandbox profile names
 * build caches that may not exist yet.
 */
export function realPath(p) {
    const abs = path.resolve(p);
    try {
        return fs.realpathSync(abs);
    }
    catch {
        const parent = path.dirname(abs);
        return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
    }
}
/** os.path.relpath(target, base): "." for the base itself, where Node says "". */
export function relPath(target, base) {
    return path.relative(path.resolve(base), path.resolve(target)) || '.';
}
/** os.path.expanduser. */
export function expandUser(p) {
    return p.replace(/^~(?=$|\/)/, os.homedir());
}
/**
 * The worker's side, a Python file in the scripts folder: one level up from lib/, or two from dist/lib/ in a build.
 * Resolved once, at startup: every later turn starts a child from it, and the path dsk was started through can be a
 * link that an install replaces during a run.
 */
export const RUNNER = fs.realpathSync([path.join(import.meta.dirname, '..', 'runner.py'),
    path.join(import.meta.dirname, '..', '..', 'runner.py')].find((p) => fs.existsSync(p))
    ?? path.join(import.meta.dirname, '..', 'runner.py'));
/** The scripts folder: where dsk.ts, runner.py and dist/ live. */
export const SCRIPTS = path.dirname(RUNNER);
let python = null;
/** A Python 3.13 or newer on PATH, for the worker's scripts: python3, else python3.15, 3.14 or 3.13. */
export function pythonPath() {
    if (python)
        return python;
    for (const name of ['python3', 'python3.15', 'python3.14', 'python3.13']) {
        const probe = process.getBuiltinModule('node:child_process').spawnSync(name, ['-I', '-c', 'import sys; sys.exit(sys.version_info < (3, 13))'], { stdio: 'ignore' });
        if (probe.status === 0)
            return (python = name);
    }
    throw new Fail("dsk needs Python 3.13 or newer on PATH, as python3 or python3.13 to 3.15, to run the worker's scripts");
}
const O_EXLOCK = 0x20; // macOS: open() takes the same lock flock() does, which Node has no call for
const O_NONBLOCK = 0x4;
/** Whether this system's open() can take an flock: macOS, unless DSK_LOCKS=helper asks for the other way. */
function nativeLocks() {
    return process.platform === 'darwin' && process.env['DSK_LOCKS'] !== 'helper';
}
let helper = null;
/** Ask runner.py's lock server for `verb` on `file`, and wait for the answer. */
function askHelper(verb, file) {
    if (!helper) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsk-locks-'));
        helper = { dir, requests: path.join(dir, 'requests'), replies: path.join(dir, 'replies'), n: 0 };
        fs.writeFileSync(helper.requests, '');
        fs.writeFileSync(helper.replies, '');
        process.getBuiltinModule('node:child_process').spawn(pythonPath(), ['-I', RUNNER, 'locks', helper.requests, helper.replies], { stdio: 'ignore' }).unref();
        const made = helper;
        process.on('exit', () => fs.rmSync(made.dir, { recursive: true, force: true }));
    }
    const n = ++helper.n;
    fs.appendFileSync(helper.requests, `${n} ${verb} ${file}\n`);
    const answer = new RegExp(`^${n} (\\w+)$`, 'm');
    const deadline = verb === 'wait' ? Infinity : Date.now() + 15000;
    for (;;) {
        const found = answer.exec(fs.readFileSync(helper.replies, 'utf8'));
        if (found)
            return found[1];
        if (Date.now() > deadline)
            throw new Fail(`the lock helper did not answer for ${file}`);
        sleepSync(0.002);
    }
}
/** An exclusive flock on `file`, or Fail(busy) at once when another process holds it. dsk.py's flock(). */
export function flock(file, busy) {
    if (nativeLocks()) {
        let fd;
        try {
            fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_EXLOCK | O_NONBLOCK, 0o644);
        }
        catch (e) {
            if (e?.code === 'EAGAIN' || e?.code === 'EWOULDBLOCK')
                throw new Fail(busy);
            throw e;
        }
        let open = true;
        return { close: () => { if (open) {
                open = false;
                fs.closeSync(fd);
            } } };
    }
    if (askHelper('lock', path.resolve(file)) !== 'held')
        throw new Fail(busy);
    return held(path.resolve(file));
}
/** An exclusive flock on `file`, waiting for it as long as another process holds it. */
export function flockWait(file) {
    if (nativeLocks()) {
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_EXLOCK, 0o644);
        let open = true;
        return { close: () => { if (open) {
                open = false;
                fs.closeSync(fd);
            } } };
    }
    askHelper('wait', path.resolve(file));
    return held(path.resolve(file));
}
function held(file) {
    let open = true;
    return { close: () => { if (open) {
            open = false;
            askHelper('unlock', file);
        } } };
}
// ---------------------------------------------------------------- processes
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/**
 * Python's bytes.decode("utf-8", "surrogateescape"): valid UTF-8 as text, and each byte that is not as a lone
 * surrogate U+DC80..U+DCFF, so that encodeEscaped() gives the very same bytes back. git() reads diffs this way: a
 * diff of a Latin-1 file goes back to `git apply` byte for byte, where U+FFFD would have changed the file.
 */
export function decodeEscaped(data) {
    try {
        return strictUtf8.decode(data);
    }
    catch {
        // not all of it is UTF-8: decode it sequence by sequence
    }
    let out = '';
    let i = 0;
    while (i < data.length) {
        const b = data[i];
        const need = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
        if (need === 0) {
            out += String.fromCharCode(b);
            i += 1;
            continue;
        }
        if (need > 0 && i + need < data.length) {
            try {
                out += strictUtf8.decode(data.subarray(i, i + need + 1));
                i += need + 1;
                continue;
            }
            catch {
                // an invalid sequence: escape its first byte and go on from the next
            }
        }
        out += String.fromCharCode(0xdc00 + b);
        i += 1;
    }
    return out;
}
/** Python's str.encode("utf-8", "surrogateescape"): the inverse of decodeEscaped(). */
export function encodeEscaped(text) {
    if (!/[\udc80-\udcff]/.test(text))
        return Buffer.from(text, 'utf8');
    const parts = [];
    let run = '';
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        const pairedLow = i > 0 && (text.charCodeAt(i - 1) & 0xfc00) === 0xd800 && (c & 0xfc00) === 0xdc00;
        if (c >= 0xdc80 && c <= 0xdcff && !pairedLow) {
            parts.push(Buffer.from(run, 'utf8'), Buffer.from([c - 0xdc00]));
            run = '';
        }
        else {
            run += text[i];
        }
    }
    parts.push(Buffer.from(run, 'utf8'));
    return Buffer.concat(parts);
}
/**
 * subprocess.run with captured text output. No limit on the output: a diff can be large. `escape` reads the output
 * and writes a string input as Python's errors="surrogateescape" did, byte for byte (see decodeEscaped).
 */
export function runSync(cmd, args, options = {}) {
    const { escape, ...rest } = options;
    if (escape && typeof rest.input === 'string')
        rest.input = encodeEscaped(rest.input);
    const done = process.getBuiltinModule('node:child_process').spawnSync(cmd, args, { maxBuffer: 2 ** 31 - 1, ...rest });
    if (done.error) {
        // Python's subprocess names what is missing: the working folder when it is gone, else the program.
        const e = done.error;
        if (e.code === 'ENOENT') {
            const gone = rest.cwd !== undefined && !fs.existsSync(String(rest.cwd)) ? String(rest.cwd) : cmd;
            throw Object.assign(new Error(`ENOENT: no such file or directory, '${gone}'`), { code: 'ENOENT', errno: -2, path: gone });
        }
        throw e;
    }
    const text = (b) => (b === null || b === undefined ? '' : Buffer.isBuffer(b)
        ? (escape ? decodeEscaped(b) : b.toString('utf8')) : String(b));
    return { code: done.status ?? -(os.constants.signals[done.signal] ?? 1),
        out: text(done.stdout), err: text(done.stderr) };
}
/** Kill a process group. Already gone is fine; macOS answers EPERM for a group of zombies. */
export function killGroup(pgid) {
    try {
        process.kill(-pgid, 'SIGKILL');
    }
    catch {
        // gone already
    }
}
/** The exit status as Python's Popen.wait() gave it: the code, or minus the signal that killed the process. */
export function exitStatus(code, signal) {
    if (code !== null)
        return code;
    return -(os.constants.signals[signal] ?? 1);
}
/** Read a file through a descriptor, whatever its position: all of it, or its last `tail` bytes. */
export function readFd(fd, tail = Infinity) {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - tail);
    const buffer = Buffer.alloc(size - from);
    let got = 0;
    while (got < buffer.length) {
        const n = fs.readSync(fd, buffer, got, buffer.length - got, from + got);
        if (n === 0)
            break;
        got += n;
    }
    return buffer.subarray(0, got);
}
/** A file in the temp folder, open for reading and writing and already unlinked, as tempfile.TemporaryFile was. */
export function tempFile() {
    const name = path.join(os.tmpdir(), `dsk-${process.pid}-${tokenHex(6)}`);
    const fd = fs.openSync(name, 'w+', 0o600);
    fs.unlinkSync(name);
    return fd;
}
/**
 * dsk.py's shell(): run a command in its own process group, output and errors together, and kill the group when it
 * returns, so nothing outlives it. `wrap` is a prefix such as the sandbox's, which the command then runs under.
 * Returns [exit code, output]; 124 and a note when it ran out of time. A signal kills the group and rejects with
 * Interrupted, as KeyboardInterrupt did. `tail` keeps the last bytes of the output alone, for a caller that shows
 * only its end: 50 MB of output, read whole and cut afterwards, took a second and 660 MB of memory.
 */
export async function shell(cmd, timeout, env, cwd, started = () => { }, wrap = [], tail = Infinity) {
    const out = tempFile();
    try {
        const argv = [...wrap, '/bin/sh', '-c', cmd];
        const child = process.getBuiltinModule('node:child_process').spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', out, out], detached: true });
        const pid = child.pid;
        if (pid === undefined) {
            const error = await new Promise((resolve) => child.once('error', resolve));
            throw error;
        }
        started(pid);
        let timedOut = false;
        let interrupted = false;
        const code = await new Promise((resolve) => {
            const timer = setTimeout(() => { timedOut = true; killGroup(pid); }, timeout * 1000);
            const off = onInterrupt(() => { interrupted = true; killGroup(pid); });
            child.once('exit', (c, s) => { clearTimeout(timer); off(); resolve(exitStatus(c, s)); });
        });
        killGroup(pid);
        if (interrupted)
            throw new Interrupted();
        const text = readFd(out, tail).toString('utf8');
        return timedOut ? [124, text + `\n[killed after ${timeout}s]`] : [code, text];
    }
    finally {
        fs.closeSync(out);
    }
}
// ---------------------------------------------------------------- output
/**
 * Whoever read dsk's output has gone, as `head` does after its lines: nothing more can be told, so main() ends
 * without a word instead of reporting it on the pipe that just closed. Its own class, so that an EPIPE from a child
 * process's pipe still counts as the error it is.
 */
export class OutputClosed extends Error {
}
/** Write all of `text` to a descriptor, synchronously. On macOS Node writes to a pipe asynchronously, so a report
 * written with console.log could be cut off by the process.exit() after it; a full pipe answers EAGAIN, so wait. */
function writeAll(fd, text) {
    const data = Buffer.from(text, 'utf8');
    let done = 0;
    while (done < data.length) {
        try {
            done += fs.writeSync(fd, data, done, data.length - done);
        }
        catch (e) {
            if (e?.code === 'EPIPE')
                throw new OutputClosed(`fd ${fd} closed`);
            if (e?.code !== 'EAGAIN')
                throw e;
            sleepSync(0.001);
        }
    }
}
/** Python's print(): the parts as text, joined by spaces, and a newline. */
export function print(...parts) {
    writeAll(1, parts.map(String).join(' ') + '\n');
}
/** print(..., file=sys.stderr). */
export function eprint(...parts) {
    writeAll(2, parts.map(String).join(' ') + '\n');
}
/** sys.stdout.write(text). */
export function write(text) {
    writeAll(1, text);
}
// ---------------------------------------------------------------- shell words
/** shlex.split(text, comments=comments) in POSIX mode. Throws as Python's ValueError did on an open quote. */
export function shlexSplit(text, comments = false) {
    const words = [];
    let word = '';
    let inWord = false;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (/\s/.test(c)) {
            if (inWord)
                words.push(word);
            word = '';
            inWord = false;
            i++;
        }
        else if (c === '#' && comments) {
            // shlex ends the word at a `#` as well: `a#b` is the word `a` and a comment.
            if (inWord)
                words.push(word);
            word = '';
            inWord = false;
            while (i < text.length && text[i] !== '\n')
                i++;
        }
        else if (c === "'") {
            const end = text.indexOf("'", i + 1);
            if (end < 0)
                throw new Error('No closing quotation');
            word += text.slice(i + 1, end);
            inWord = true;
            i = end + 1;
        }
        else if (c === '"') {
            i++;
            for (;;) {
                if (i >= text.length)
                    throw new Error('No closing quotation');
                const d = text[i];
                if (d === '"')
                    break;
                if (d === '\\' && i + 1 < text.length && '\\"'.includes(text[i + 1])) {
                    word += text[i + 1];
                    i += 2;
                }
                else {
                    word += d;
                    i++;
                }
            }
            inWord = true;
            i++;
        }
        else if (c === '\\') {
            if (i + 1 >= text.length)
                throw new Error('No escaped character');
            word += text[i + 1];
            inWord = true;
            i += 2;
        }
        else {
            word += c;
            inWord = true;
            i++;
        }
    }
    if (inWord)
        words.push(word);
    return words;
}
/** shlex.quote(text). */
export function shlexQuote(text) {
    if (!text)
        return "''";
    if (!/[^\w@%+=:,./-]/.test(text))
        return text;
    return "'" + text.replaceAll("'", `'"'"'`) + "'";
}
