// The session log: one append-only JSONL file per session. Every request, report and digest is rebuilt from it, so
// a session started by an older dsk, the Python one included, goes on under this one.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
import { Fail, STATE, flock, now, pyJson, pyRound, tokenHex } from './base.js';
import { ALIASES } from './config.js';
/** One append-only JSONL log. Every request, report and digest is rebuilt from it. */
export class Session {
    id;
    dir;
    path;
    recs = [];
    /** The process group of the shell command a script is running, while it runs (run_script). */
    shelled = null;
    /** What the worker was shown of the last turn's output, and whether that turn may have changed a file. `changed`
     * leaves out the scratch folder and @answer: it is whether the project itself may have changed. */
    printed = '';
    moved = false;
    changed = false;
    /** dsk.py's `_lock`: this process's lock on the session, while it drives it. */
    lockHandle = null;
    /** dsk.py's `_tree`: this process's lock on the working tree, for a run in place. */
    treeLock = null;
    constructor(sid = null) {
        const fresh = sid === null;
        // Four hex characters while a free one is easy to find. After eight taken in a row most of the 65,536 are, so
        // the id grows to six characters, and then to eight: a state folder nobody prunes cannot run out of names.
        for (let taken = 0; sid === null; taken++) {
            sid = tokenHex(taken < 8 ? 2 : taken < 16 ? 3 : 4);
            fs.mkdirSync(path.join(STATE, sid), { recursive: true });
            try {
                fs.mkdirSync(path.join(STATE, sid, 'out'));
            }
            catch (e) {
                if (e?.code !== 'EEXIST')
                    throw e;
                sid = null;
            }
        }
        this.id = sid;
        this.dir = path.join(STATE, sid);
        this.path = path.join(this.dir, 'log.jsonl');
        if (!fresh) {
            let text;
            try {
                text = fs.readFileSync(this.path, 'utf8');
            }
            catch {
                throw new Fail(`no session ${sid}`);
            }
            // A line torn by a crash has no newline: skip it.
            const lines = text.split('\n');
            lines.pop();
            this.recs = lines.map((line) => JSON.parse(line));
        }
    }
    /** Append a record of kind `t`. `at` goes last, so it replaces the `at` a close() copies in. */
    add(t, fields = {}) {
        const rec = { t, ...fields, at: pyRound(now(), 3) };
        fs.appendFileSync(this.path, pyJson(rec) + '\n', 'utf8');
        this.recs.push(rec);
        return rec;
    }
    of(...types) {
        return this.recs.filter((r) => types.includes(r.t));
    }
    /** The last record of any of `types`, or null. Typed loosely, as dsk.py indexed it at once: s.last("state")["status"]. */
    last(...types) {
        for (let i = this.recs.length - 1; i >= 0; i--) {
            if (types.includes(this.recs[i].t))
                return this.recs[i];
        }
        return null;
    }
    /** Records of `types` after the last `marker` record. */
    since(marker, ...types) {
        const start = this.recs.findLastIndex((r) => r.t === marker);
        if (start < 0)
            throw new Error(`no ${marker} record`); // max() of an empty sequence, as in dsk.py
        return this.recs.slice(start).filter((r) => types.includes(r.t));
    }
    /** One lock per session, held by whichever dsk process is driving it. */
    lock() {
        this.lockHandle = flock(path.join(this.dir, 'lock'), `session ${this.id} is busy: another dsk process is running it`);
        return this;
    }
    /** The last state. A `running` session that no process holds was interrupted, so it counts as `error`. */
    status() {
        const status = this.last('state').status;
        if (status === 'running' && this.lockHandle === null) {
            try {
                this.lock().lockHandle.close();
                this.lockHandle = null;
            }
            catch (e) {
                if (e instanceof Fail)
                    return 'running';
                throw e;
            }
        }
        return status === 'running' ? 'error' : status;
    }
    get head() {
        return this.recs[0];
    }
    get turn() {
        return Math.max(0, ...this.of('msg').map((r) => r['turn']));
    }
    /** A job started under a provider's old name runs on under its new one (`dsk provider rename`). */
    get profile() {
        const name = this.last('series').profile;
        return Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
    }
}
