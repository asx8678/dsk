// dsk status, dsk stats and dsk configure: what the sessions on disk say, measured from their logs.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const { isDeepStrictEqual: sameJSON } = process.getBuiltinModule('node:util');
import { PyFloat, pySum, Fail, Interrupted, SCRIPTS, STATE, cpHead, dumps, eprint, fixed, get, has, now, print, pyRound, pythonPath, xdg, pyJsonAscii, words } from './base.js';
import { projectRoot } from './commands.js';
import { config, plugin, secret, setup } from './config.js';
import { roundLimit, scope } from './gates.js';
import { cachedShare, kilo } from './reports.js';
import { Session } from './session.js';
import { fastOrder, speeds } from './speed.js';
import { OPTIONS, SETUP } from './texts.js';
import { mendLauncher } from './launcher.js';
import { paused } from './wire.js';
import { removeWorktree } from './accept.js';
import { prunable } from './prune.js';
/** The first line of a file, without reading the rest of it. */
function firstLine(file) {
    const fd = fs.openSync(file, 'r');
    const chunks = [];
    try {
        for (;;) {
            const chunk = Buffer.alloc(65536);
            const n = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (!n)
                break;
            const nl = chunk.subarray(0, n).indexOf(10);
            chunks.push(nl < 0 ? chunk.subarray(0, n) : chunk.subarray(0, nl));
            if (nl >= 0)
                break;
        }
    }
    finally {
        fs.closeSync(fd);
    }
    return Buffer.concat(chunks).toString('utf8');
}
/** `time.strftime('%a %H:%M', time.localtime(x))`, in the local time zone. */
function shortTime(x) {
    const d = new Date(x * 1000), days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** os.path.getmtime(): CPython makes the float as sec + nsec * 1e-9, which rounds otherwise than nanoseconds / 1e9. */
function mtime(file) {
    const ns = fs.statSync(file, { bigint: true }).mtimeNs;
    return Number(ns / 1000000000n) + Number(ns % 1000000000n) * 1e-9;
}
/** os.listdir(): the names in the order the file system keeps them. fs.readdirSync() sorts them. */
function listdir(dir) {
    const d = fs.opendirSync(dir);
    const names = [];
    try {
        for (let e = d.readSync(); e !== null; e = d.readSync())
            names.push(e.name);
    }
    finally {
        d.closeSync();
    }
    return names;
}
/** The sessions whose head satisfies `wanted`. Only the first line of the other logs is read. */
export function sessions(wanted) {
    const found = [];
    const dirs = fs.existsSync(STATE) && fs.statSync(STATE).isDirectory() ? fs.readdirSync(STATE).sort() : [];
    for (const sid of dirs) {
        let head;
        try {
            head = JSON.parse(firstLine(path.join(STATE, sid, 'log.jsonl')) || '{}');
        }
        catch {
            continue; // a lock file, or a session that is only just being created
        }
        if (get(head, 't') === 'head' && wanted(head)) {
            const s = new Session(sid);
            if (s.last('state'))
                found.push(s);
        }
    }
    return found;
}
/** What a session's usage cost at its profiles' prices, or null when one of them has no price. */
function sessionCost(cfg, usage) {
    const prices = usage.map((u) => get(get(cfg.profiles, u.profile, {}), 'price'));
    return !prices.every((p) => p) ? null : pySum(usage.map((u, i) => {
        const p = prices[i];
        return ((u.prompt - (u.hit || 0)) * p.in + (u.hit || 0) * p.cached + u.out * p.out) / 1e6;
    }));
}
/** Each failover of a session in order: the profile it left, and why. */
function failovers(series) {
    return series.slice(1).flatMap((b, i) => b.why === 'failover' && b.status !== 'chosen' ? [`${series[i].profile} ${b.status || 'network'}`] : []);
}
/** One session as plain data, for `status --json`: what a progress display needs. All of it is measured. */
export function job(s, cfg) {
    const head = s.head, usage = s.of('usage'), status = s.status(), st = s.last('state') || {}, series = s.of('series');
    const at = Math.max(...s.recs.map((r, i) => (r.t === 'req' || r.t === 'state' ? i : -1)));
    const tail = s.recs.slice(at); // the turn in flight
    const acts = tail.filter((r) => r.t === 'ledger'), done = s.since('round', 'ledger');
    let checking = acts.some((r) => r.fn === 'done') && !tail.some((r) => r.t === 'checks');
    const last = [...tail].reverse().find((r) => ['doing', 'ledger', 'checks', 'result'].includes(r.t)) || { t: '' };
    checking = checking || !!last.review; // the independent review runs after the checks
    const phase = !tail.some((r) => r.t === 'usage') ? 'model' : checking ? 'checks' : 'script';
    return { id: s.id, status, phase: status === 'running' ? phase : '', profile: s.profile,
        doing: last.t === 'doing' && status === 'running' ? cpHead(words(last.arg), 80) : '',
        failover: failovers(series).at(-1) ?? '', cost: sessionCost(cfg, usage),
        turn: s.since('round', 'result').length, max_turns: roundLimit(s.recs), turns: s.turn,
        in: usage.reduce((n, u) => n + u.prompt, 0), out: usage.reduce((n, u) => n + u.out, 0), cached: cachedShare(usage),
        act: done.length && status === 'running' ? cpHead(words(`${done[done.length - 1].fn} ${done[done.length - 1].arg}`), 80) : '',
        step: done.length && status === 'running' ? done[done.length - 1].fn : '',
        note: cpHead(words(get(st, 'question') || get(st, 'why') || get(st, 'error') || ''), 160),
        changed: (get(st, 'changed') || []).length,
        brief: cpHead(words(get(scope(s), 'task') || head.brief), 300),
        owner: head.owner, root: head.root, worktree: head.worktree, created: head.created,
        active: mtime(s.path) };
}
/** The middle value, the lower of the two in the middle of an even count, and 0 when there is nothing to measure. */
export function median(values) {
    const xs = [...values].sort((a, b) => a - b);
    return xs.length ? xs[Math.floor((xs.length - 1) / 2)] : 0;
}
/** The 95th percentile by nearest rank, the lowest sample at or above 95% of them, and 0 with nothing to measure. */
export function p95(values) {
    const xs = [...values].sort((a, b) => a - b);
    return xs.length ? xs[Math.max(0, Math.floor((xs.length * 95 + 99) / 100) - 1)] : 0;
}
/** A whole-number percentage of `whole`, and 0 when there is nothing to be a share of. */
export function share(part, whole) {
    return whole ? pyRound(part * 100 / whole) : 0;
}
/** The same percentage, for a line that ends in it. */
export function percent(part, whole) {
    return `${share(part, whole)}%`;
}
/** A number of seconds to one decimal, without a pointless .0. */
export function duration(x) {
    return fixed(pyRound(x, 1), 1).replace(/\.0$/, '');
}
/** What one turn did, from its result and that turn's ledger records: a failure, files, commands, a stop, reading. */
export function turnKind(result, acts) {
    if (result.fail)
        return 'failed:' + result.fail;
    const fns = new Set(acts.map((a) => a.fn));
    if (fns.has('write') || fns.has('edit'))
        return 'write';
    if (fns.has('sh'))
        return 'run';
    return [...fns].some((fn) => fn !== 'ask' && fn !== 'done') ? 'read' : 'stop';
}
/**
 * One session as plain numbers for `dsk stats`, all of it measured from its log. Logs written before
 * timestamps existed have no `at`, and every duration they cannot give is null.
 */
export function metrics(s, cfg) {
    const head = s.head, usage = s.of('usage'), results = s.of('result'), series = s.of('series'), acts = s.of('ledger');
    const kindsList = results.map((r) => turnKind(r, acts.filter((a) => a.turn === r.turn)));
    const kinds = Object.create(null);
    for (const kind of kindsList)
        kinds[kind] = (has(kinds, kind) ? kinds[kind] : 0) + 1;
    const stamped = s.recs.filter((r) => has(r, 'at')).map((r) => r.at);
    const reqs = s.recs.map((r, i) => (r.t === 'req' && has(r, 'at') ? i : -1)).filter((i) => i >= 0);
    let model = 0.0;
    const speed = Object.create(null);
    reqs.forEach((i, n) => {
        const stop = n + 1 < reqs.length ? reqs[n + 1] : s.recs.length;
        const answered = s.recs.slice(i + 1, stop).find((r) => r.t === 'usage' && has(r, 'at'));
        if (answered) { // a req the API never answered has no time of its own to measure
            const req = s.recs[i];
            const took = answered.at - req.at;
            model += took;
            const p = has(speed, answered.profile) ? speed[answered.profile] : (speed[answered.profile] = [0.0, 0]);
            p[0] += took;
            p[1] += 1;
        }
    });
    const states = s.of('state');
    let waited = 0.0; // from each stop the lead had to answer to the run that answered it
    states.forEach((r, n) => {
        if (['review', 'question', 'stuck', 'limit', 'done'].includes(r.status) && has(r, 'at')) {
            const again = states.slice(n + 1).find((x) => x.status === 'running' && has(x, 'at'));
            waited += again ? again.at - r.at : 0;
        }
    });
    return { id: s.id, root: head.root, owner: head.owner, worktree: head.worktree,
        effort: head.effort, web: head.web, created: head.created, status: s.status(),
        profiles: [...new Set(usage.map((u) => u.profile))], rounds: s.of('round').length,
        rejects: s.of('reject').length, continues: s.of('base').length,
        compactions: series.filter((r) => r.why === 'compact').length,
        failovers: failovers(series),
        turns: results.length, kinds,
        lead_in: kindsList.findIndex((kind) => kind !== 'read') < 0 ? kindsList.length : kindsList.findIndex((kind) => kind !== 'read'),
        cut: results.filter((r) => String(r.text).includes('characters cut here')).length,
        in: usage.reduce((n, u) => n + u.prompt, 0), out: usage.reduce((n, u) => n + u.out, 0),
        hit: usage.reduce((n, u) => n + (u.hit || 0), 0), cached: cachedShare(usage),
        max_out: usage.length ? Math.max(...usage.map((u) => u.out)) : 0, speed, cost: sessionCost(cfg, usage),
        // a session that began before timestamps is stamped only at its end: its time is unknown, not zero
        seconds: has(head, 'at') ? pyRound(stamped[stamped.length - 1] - head.at, 1) : null,
        model_seconds: reqs.length ? pyRound(model, 1) : null,
        lead_seconds: has(head, 'at') ? pyRound(waited, 1) : null };
}
/** One line of the plain stats report: a label in a column ten characters wide. */
export function label(text, value) {
    return `${(text + ':').padEnd(10)} ${value}`;
}
/** The plain `dsk stats` report, one line per label, over the sessions as (log, metrics) pairs. */
export function statsSummary(pairs) {
    const ms = pairs.map((pair) => pair[1]);
    const turns = ms.reduce((n, m) => n + m.turns, 0);
    const statuses = Object.create(null);
    for (const m of ms)
        statuses[m.status] = (has(statuses, m.status) ? statuses[m.status] : 0) + 1;
    const byCount = Object.entries(statuses).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const most = ms.reduce((a, b) => (b.turns > a.turns ? b : a));
    const lines = [label('sessions', `${ms.length} · ` + byCount.map(([status, n]) => `${status} ${n}`).join(' · ')),
        label('turns', `${turns} · median ${median(ms.map((m) => m.turns))} per session · ` +
            `most ${most.turns} (${most.id})`)];
    const kinds = Object.create(null);
    for (const m of ms)
        for (const [kind, n] of Object.entries(m.kinds))
            kinds[kind] = (has(kinds, kind) ? kinds[kind] : 0) + Number(n);
    lines.push(label('kinds', Object.entries(kinds)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([kind, n]) => `${kind} ${percent(Number(n), turns)}`).join(' · ')));
    const lead = ms.filter((m) => get(m.kinds, 'write')).map((m) => m.lead_in);
    lines.push(label('lead-in', `median ${median(lead)} read turns before the first change · ` +
        `${lead.filter((n) => n >= 5).length} sessions with 5 or more`));
    const cut = ms.reduce((n, m) => n + m.cut, 0);
    lines.push(label('cut', `${cut} of ${turns} turns had their output cut (${percent(cut, turns)})`));
    const biggest = ms.reduce((a, b) => (b.max_out > a.max_out ? b : a));
    const truncated = ms.reduce((n, m) => n + (get(m.kinds, 'failed:truncated', 0) || 0), 0);
    const outs = [];
    for (const [s, _] of pairs)
        for (const u of s.of('usage'))
            outs.push(u.out);
    lines.push(label('replies', `median ${median(outs)} tokens · largest ${biggest.max_out} (${biggest.id}) · ${truncated} cut off at the limit`));
    let spentLine = `in ${kilo(ms.reduce((n, m) => n + m.in, 0))} ` +
        `(${share(ms.reduce((n, m) => n + m.hit, 0), ms.reduce((n, m) => n + m.in, 0))}% cached) · ` +
        `out ${kilo(ms.reduce((n, m) => n + m.out, 0))}`;
    if (ms.every((m) => m.cost !== null))
        spentLine += ` · $${fixed(pySum(ms.map((m) => m.cost)), 2)}`;
    lines.push(label('tokens', spentLine));
    const rejected = ms.reduce((n, m) => n + m.rejects, 0);
    lines.push(label('rounds', `${rejected} rejected rounds in ${ms.filter((m) => m.rejects).length} sessions · ` +
        `${ms.reduce((n, m) => n + m.continues, 0)} continued`));
    if (ms.some((m) => m.seconds !== null)) {
        lines.push(label('time', `model ${duration(pySum(ms.map((m) => m.model_seconds || 0)))}s · lead waited ` +
            `${duration(pySum(ms.map((m) => m.lead_seconds || 0)))}s · total ` +
            `${duration(pySum(ms.map((m) => m.seconds || 0)))}s`));
    }
    const blank = { turns: 0, in: 0, hit: 0, out: 0, away: 0, seconds: 0.0, timed: 0 };
    const totals = new Map();
    for (const [s, m] of pairs) {
        for (const u of s.of('usage')) {
            if (!totals.has(u.profile))
                totals.set(u.profile, { ...blank });
            const p = totals.get(u.profile);
            p.turns += 1;
            p.in += u.prompt;
            p.hit += u.hit || 0;
            p.out += u.out;
            if (get(u, 'first') != null) { // a streamed reply: how long it took to start
                if (!p.firsts)
                    p.firsts = [];
                p.firsts.push(get(u, 'first'));
            }
        }
        for (const [name, values] of Object.entries(m.speed)) {
            if (!totals.has(name))
                totals.set(name, { ...blank });
            const p = totals.get(name), pair = values;
            p.seconds += pair[0];
            p.timed += pair[1];
        }
        const ss = s.of('series');
        for (let i = 1; i < ss.length; i++) {
            const a = ss[i - 1], b = ss[i];
            if (b.why === 'failover' && b.status !== 'chosen') { // also from a profile no session shown so far has a turn on
                if (!totals.has(a.profile))
                    totals.set(a.profile, { ...blank });
                totals.get(a.profile).away += 1;
            }
        }
    }
    for (const [name, p] of [...totals.entries()].sort((a, b) => b[1].turns - a[1].turns || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        let row = `profile ${name}: ${p.turns} turns · in ${kilo(p.in)} (${share(p.hit, p.in)}% cached) · ` +
            `out ${kilo(p.out)} · ${p.away} failovers away`;
        if (p.timed)
            row += ` · ${fixed(p.seconds / p.timed, 1)} s per turn`;
        if (p.firsts)
            row += ` · first data p95 ${fixed(p95(p.firsts), 1)}s`;
        lines.push(row);
    }
    return lines;
}
/** One line per session for `dsk stats --sessions`: what it measured and where it ran. */
export function sessionLine(m) {
    const kinds = m.kinds;
    const failed = Object.entries(kinds).filter(([kind]) => kind.startsWith('failed:')).reduce((n, [, v]) => n + Number(v), 0);
    return `${m.id} · ${m.status} · ${m.turns} turns (${get(kinds, 'read', 0)} r, ${get(kinds, 'write', 0)} w, ` +
        `${get(kinds, 'run', 0)} x, ${failed} f) · in ${kilo(m.in)} (${share(m.hit, m.in)}% cached) · ` +
        `out ${kilo(m.out)} · ${path.basename(String(m.root).replace(/\/+$/, ''))}`;
}
/**
 * `dsk status`: this project's open sessions. With --json, the last day's jobs on any project, for a display that
 * polls; with --hook, the Claude Code Stop hook, which sends the lead back to work that waits for its review.
 */
export function cmdStatus(args, cfg) {
    if (args.json) { // every session of the last day, on any project, newest first: for a display that polls
        // What a kept job was made with besides its log: this code's fields (bump the number) and the prices.
        const cache = path.join(STATE, 'status.json');
        // A Map, not an object: the order is os.listdir's, which the cache keeps and the sort below keeps for ties, and an
        // object would put ids made of digits first.
        const made = [3, Object.fromEntries(Object.entries(cfg.profiles).map(([k, v]) => [k, get(v, 'price')]))];
        const fresh = new Map([['for', made]]);
        let old = {};
        try {
            old = JSON.parse(fs.readFileSync(cache, 'utf8'));
        }
        catch {
            old = {};
        }
        old = sameJSON(get(old, 'for'), made) ? old : {};
        const dirs = fs.existsSync(STATE) && fs.statSync(STATE).isDirectory() ? listdir(STATE) : [];
        for (const sid of dirs) {
            let stat;
            try {
                stat = fs.statSync(path.join(STATE, sid, 'log.jsonl'), { bigint: true });
            }
            catch {
                continue;
            }
            const key = [String(stat.mtimeNs), String(stat.size)], had = get(old, sid); // strings: a nanosecond mtime does not fit a JSON number
            const sameKey = had && Array.isArray(had.key) && had.key[0] === key[0] && had.key[1] === key[1];
            if (sameKey && get(get(had, 'job', {}), 'status') !== 'running') {
                fresh.set(sid, had); // a log that has not moved since its session stopped is not read again
                continue;
            }
            const s = new Session(sid);
            if (s.recs.length && get(s.head, 't') === 'head' && s.last('state'))
                fresh.set(sid, { key, job: job(s, cfg) });
        }
        if (!sameJSON(Object.fromEntries(fresh), old)) {
            fs.writeFileSync(cache + `.${process.pid}`, pyJsonAscii(fresh), 'utf8');
            fs.renameSync(cache + `.${process.pid}`, cache);
        }
        const recent = [...fresh].filter(([sid]) => sid !== 'for').map(([, e]) => e.job)
            .filter((j) => j.created > now() - 86400);
        recent.sort((a, b) => b.created - a.created);
        print(dumps({ jobs: recent }));
        return 0;
    }
    if (args.hook) { // a Claude Code Stop hook: exit 2 sends Claude back to review what it delegated
        let event = {};
        try {
            event = JSON.parse(fs.readFileSync(0, 'utf8'));
        }
        catch {
            // no event, or not JSON: nothing is known to wait, and a hook that fails shows an error at every turn end
        }
        const mine = (head) => get(head, 'owner') && get(head, 'owner') === get(event, 'session_id');
        const waiting = get(event, 'stop_hook_active') ? [] : sessions(mine).filter((s) => s.status() === 'review');
        for (const s of waiting) {
            eprint(`dsk ${s.id} is waiting for your review: run dsk show ${s.id} --review, then dsk accept ${s.id} or ` +
                `dsk reject ${s.id} "defects"`);
        }
        return waiting.length ? 2 : 0;
    }
    const root = projectRoot() || process.cwd();
    const mine = sessions((head) => head.root === root);
    const open = mine.filter((s) => !['accepted', 'dropped', 'done'].includes(s.status()));
    for (const s of open) {
        const age = Math.floor(Math.trunc(now() - s.head.created) / 60); // minutes: int(seconds) // 60, as in dsk.py
        print(`dsk ${s.id} · ${s.status()} · ${Math.floor(age / 60)}h${String(age % 60).padStart(2, '0')}m ago · ${cpHead(s.head.brief, 60)}`);
    }
    print(`${open.length} open, ${mine.length - open.length} finished` + (open.length ? `\nnext:    dsk show ${open[0].id}` : ''));
    return 0;
}
/** What the sessions measured, read from their logs: turns, kinds, tokens, time, rounds and profiles. */
export function cmdStats(args, cfg) {
    let found;
    if (args.id && args.id.length) { // nargs='*' gives [], which Python reads as false
        found = args.id.map((sid) => new Session(sid));
    }
    else {
        const wanted = now() - args.days * 86400;
        found = sessions((head) => head.created > wanted);
    }
    if (args.project) { // only the sessions this project's runs wrote
        const root = projectRoot() || process.cwd();
        found = found.filter((s) => s.head.root === root);
    }
    if (!found.length) {
        print(`no sessions in the last ${args.days} days`);
        return 0;
    }
    const pairs = found.map((s) => [s, metrics(s, cfg)]).sort((a, b) => b[1].created - a[1].created);
    if (args.json) {
        // the seconds of `speed` were a float sum in dsk.py, the turns a count
        print(dumps({ sessions: pairs.map(([, m]) => ({ ...m, speed: Object.fromEntries(Object.entries(m.speed).map(([name, [seconds, turns]]) => [name, [new PyFloat(seconds), turns]])) })) }));
        return 0;
    }
    for (const row of statsSummary(pairs))
        print(row);
    if (args.sessions) {
        print();
        for (const [, m] of pairs)
            print(sessionLine(m));
    }
    return 0;
}
/** The bytes a folder holds, links not followed: what deleting it frees. */
function folderBytes(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        total += entry.isDirectory() ? folderBytes(full) : fs.lstatSync(full).size;
    }
    return total;
}
/**
 * Delete the folders of the sessions prunable() lets go (lib/prune.ts, whose laws gdp-wired proves): the settled
 * ones nothing was written to for `keep` days. Each is locked first, so one that a dsk process drives stays. With
 * `report`, every log is read and the sessions that still wait for a decision are named too; without it a log is
 * read only once its age qualifies, so the daily call from `dsk run` costs one stat per session. `dry` deletes nothing.
 */
export function prune(keep, options = {}) {
    const gone = [], waiting = [];
    const dirs = fs.existsSync(STATE) && fs.statSync(STATE).isDirectory() ? fs.readdirSync(STATE).sort() : [];
    for (const sid of dirs) {
        const dir = path.join(STATE, sid);
        let age;
        let s;
        try {
            age = (now() - mtime(path.join(dir, 'log.jsonl'))) / 86400;
            if (age < keep && !options.report)
                continue;
            s = new Session(sid);
        }
        catch {
            continue; // no session: the slots, a pause, a lock file; or a log that cannot be read, which is left as it is
        }
        if (!s.recs.length || get(s.head, 't') !== 'head' || !s.last('state'))
            continue;
        let held = false;
        try {
            s.lock();
        }
        catch (e) {
            if (!(e instanceof Fail))
                throw e;
            held = true;
        }
        try {
            const status = s.status();
            if (prunable(status, held, age, keep)) {
                const bytes = folderBytes(dir);
                if (!options.dry) {
                    // A settled session has no worktree left; one that does still has it registered in its repository.
                    if (s.head.worktree && fs.existsSync(s.head.workdir))
                        removeWorktree(s.head);
                    fs.rmSync(dir, { recursive: true, force: true });
                }
                gone.push({ id: sid, bytes });
            }
            else if (options.report && ['review', 'question', 'stuck', 'limit', 'error'].includes(status)) {
                waiting.push({ id: sid, status, bytes: folderBytes(dir), root: s.head.root,
                    worktree: Boolean(s.head.worktree) && fs.existsSync(s.head.workdir) });
            }
        }
        finally {
            s.lockHandle?.close();
        }
    }
    return { gone, waiting };
}
/**
 * Once a day, when the config sets `keep_days`: prune without a word, so that a state folder nobody tends stays
 * bounded. `dsk run` calls it before it starts; a failure here never stops that run.
 */
export function autoPrune(cfg) {
    const keep = Number(get(cfg, 'keep_days'));
    if (!(keep > 0))
        return;
    const stamp = path.join(STATE, 'pruned');
    try {
        if (now() - mtime(stamp) < 86400)
            return;
    }
    catch {
        // never pruned yet
    }
    try {
        fs.mkdirSync(STATE, { recursive: true });
        fs.writeFileSync(stamp, '');
        prune(keep);
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
    }
}
/** `dsk prune`: delete the settled sessions older than --days, and name the ones that still wait for a decision. */
export function cmdPrune(args, cfg) {
    const kept = Number(get(cfg, 'keep_days'));
    const keep = args.days ?? (kept > 0 ? kept : 30);
    const { gone, waiting } = prune(keep, { dry: args.dry_run, report: true });
    const mega = (bytes) => `${fixed(bytes / 1e6, 1)} MB`;
    const freed = mega(gone.reduce((n, g) => n + g.bytes, 0));
    const age = keep > 0 ? ` settled more than ${keep} day${keep === 1 ? '' : 's'} ago` : ', every settled one';
    print(`dsk prune · ${args.dry_run ? 'would delete' : 'deleted'} ${gone.length} session${gone.length === 1 ? '' : 's'}${age} · ${freed}`);
    for (const w of waiting) {
        print(`kept:    ${w.id} · ${w.status} · ${mega(w.bytes)}${w.worktree ? ', its worktree included' : ''} · ${path.basename(w.root)}`);
    }
    if (waiting.length) {
        print(`next:    ${waiting.length === 1 ? 'it waits' : 'they wait'} for your decision: dsk show ID, then dsk accept ID or dsk reject ID --drop`);
    }
    return 0;
}
/** This dsk's version, from the plugin's manifest beside this script; '' when there is none (a bare checkout copy). */
export function version() {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
        return String(get(data, 'version', ''));
    }
    catch {
        return '';
    }
}
/**
 * How dsk is set up. As a Claude Code hook (--hook) it first stores the plugin's options, which Claude Code hands
 * to hooks alone, where `config` and `secret` read them; at session start (--announce) it says what is still missing.
 */
export function cmdConfigure(args, cfg) {
    if (args.hook) {
        try {
            const home = xdg('XDG_CONFIG_HOME', '~/.config');
            const data = args.data || process.env.CLAUDE_PLUGIN_DATA || home;
            const name = path.basename(data.replace(/\/+$/, '')); // the data folder is named after the plugin's id: dsk-<marketplace>
            const options = {};
            for (const option of OPTIONS)
                options[option] = process.env[`CLAUDE_PLUGIN_OPTION_${option.toUpperCase()}`] || '';
            const files = [
                [path.join(data, 'options.json'), options],
                [path.join(home, 'plugin.json'), { options: path.join(data, 'options.json'),
                        id: name.startsWith('dsk-') ? 'dsk@' + name.slice(4) : plugin('id') }]
            ];
            for (const [file, value] of files) { // written only when it changed: this runs before every prompt
                let same = false;
                try {
                    same = sameJSON(JSON.parse(fs.readFileSync(file, 'utf8')), value);
                }
                catch {
                    same = false;
                }
                if (!same) {
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    const fd = fs.openSync(file + '.new', 'w', 0o600);
                    try {
                        fs.writeFileSync(fd, pyJsonAscii(value), 'utf8');
                    }
                    finally {
                        fs.closeSync(fd);
                    }
                    fs.renameSync(file + '.new', file);
                }
            }
            const [ready, state] = setup(config());
            let news = '';
            if (args.announce) { // the first session on a new version says so: after an install or an update
                const current = version(), seenAt = path.join(data, 'version');
                let seen = '';
                try {
                    seen = fs.readFileSync(seenAt, 'utf8').trim();
                }
                catch {
                    seen = '';
                }
                if (current && current !== seen) {
                    news = seen ? `dsk ${seen} → ${current} updated.` : `dsk ${current} installed.`;
                    fs.writeFileSync(seenAt, current, 'utf8');
                }
            }
            // dsk.py said this itself when its Python was too old. dsk.ts needs a Python only for the worker's scripts, so
            // it asks at session start, once, and says that before anything else: no run can work without it.
            let python = '';
            if (args.announce) {
                try {
                    pythonPath();
                }
                catch (e) {
                    if (!(e instanceof Fail))
                        throw e;
                    python = e.message;
                }
            }
            // Before every prompt too, not only at session start: /reload-plugins after an update starts no session.
            const mended = mendLauncher();
            let said = null;
            if (python) {
                said = { systemMessage: `${news ? news + ' ' : ''}${python}.` };
            }
            else if (args.announce && ready && news) {
                said = { systemMessage: `${news} /dsk enable shows the jobs, /dsk config configures it.` };
            }
            if (!python && args.announce && !ready) {
                const how = `Run /plugin configure ${plugin('id')} and ${SETUP}. Then restart Claude Code.`;
                said = { systemMessage: `${news ? news + ' ' : ''}dsk is not set up yet: ${state}. ${how}`, hookSpecificOutput: {
                        hookEventName: 'SessionStart', additionalContext: `The dsk plugin has no working provider (${state}), so ` +
                            '`dsk run` will fail. If the user wants to delegate with dsk, tell them: ' + `${how} Never ask for a key in the chat.`
                    } };
            }
            if (mended)
                said = said ? { ...said, systemMessage: `${said.systemMessage} ${mended}` } : { systemMessage: mended };
            if (said)
                print(pyJsonAscii(said));
        }
        catch (e) { // a hook must never stand in the way of a session or a prompt
            if (e instanceof Interrupted)
                throw e;
        }
        return 0;
    }
    const [ready, state] = setup(cfg);
    print(`dsk${version() ? ' ' + version() : ''} · ${ready ? 'ready' : 'not set up'} · ${state}`);
    for (const name of cfg.route) {
        const profile = get(cfg.profiles, name, {});
        const key = secret(get(profile, 'key_env', '') ?? '') ? 'set' : 'missing';
        let until = paused(name);
        const pause = until ? ` · paused until ${shortTime(until)}, credit used up` : '';
        print(`${(name + ':').padEnd(8)} ${get(profile, 'base_url')} · ${get(profile, 'model')} · key ${key}${pause}`);
    }
    if (get(cfg, 'effort', 'off') !== 'off') {
        print(`${'effort:'.padEnd(10)}${cfg.effort} for a run that names none`);
    }
    if (get(cfg, 'route_order') === 'fastest') {
        const found = speeds();
        print(`${'order:'.padEnd(10)}fastest first: ` + fastOrder(found, cfg.route).map((name) => {
            const seconds = get(get(found, name, {}), 'seconds');
            return seconds !== null ? `${name} ${fixed(seconds, 2)}s` : `${name} (not measured)`;
        }).join(', '));
    }
    if (!ready) {
        print(`next:    in Claude Code, /plugin configure ${plugin('id')}: ${SETUP}; then restart Claude Code. ` +
            `Or export the key in ~/.config/dsk/env.`);
    }
    return ready ? 0 : 1;
}
