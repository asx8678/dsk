// The commands that start and drive a session (run, answer, continue, show, wait, bench), and resume(), which
// refuses a command the session's state does not admit.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
import { Fail, G, Interrupted, STATE, dumps, eprint, flock, get, has, now, print, runSync, sleep, isOsError, pyRepr, relPath } from './base.js';
import { makeWorktree, refuseIgnored, removeWorktree, treeLock } from './accept.js';
import { apiKey, searchKey } from './config.js';
import { answerText, changes, halt, scope, settle, snapshot, tree } from './gates.js';
import { firstMessage, loop, runHeader } from './loop.js';
import { report, reportJson, turnLine, workerDiff } from './reports.js';
import { sandboxMode } from './sandbox.js';
import { Session } from './session.js';
import { bench, fastOrder, orderedRoute, speedText } from './speed.js';
import { autoPrune, sessions } from './stats.js';
import { EXIT, MAX_TOKENS, SYSTEM } from './texts.js';
import { STATUSES, admits } from './lifecycle.js';
/** Remove a tree as shutil.rmtree(path, ignore_errors=True) did: failures to delete are not failures of the caller. */
function rmTree(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    catch (e) {
        if (!isOsError(e))
            throw e;
    }
}
/** A path's stat, or null for a missing or unreadable path: to os.path.isfile and isdir it is simply neither. */
function statOf(p) {
    try {
        return fs.statSync(p);
    }
    catch (e) {
        if (isOsError(e))
            return null;
        throw e;
    }
}
/** The lines of a text as Python readlines() gave them: each keeps its newline, and the last may have none. */
function linesOf(text) {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
/** datetime.date.today(), as "YYYY-MM-DD": the local day, not UTC's. */
function today() {
    const d = new Date();
    return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Run the loop to its next stop, print the report, return the exit code. Any failure becomes `error`. */
export async function drive(s, cfg, extra = "") {
    eprint(`dsk ${s.id} · running · ${s.profile}`);
    s.add("state", { status: "running" });
    try {
        await loop(s, cfg, extra);
    }
    catch (e) {
        // str(e) and type(e).__name__, as near as JavaScript has them: an Error's message, and its constructor's name.
        const text = e instanceof Error ? e.message : String(e), named = `${(typeof e === 'object' && e?.constructor?.name) || typeof e}: ${text}`;
        const message = e instanceof Fail ? text : e instanceof Interrupted ? "interrupted" : `internal: ${named}`;
        if (G.verbose)
            eprint(e instanceof Error ? (e.stack ?? named) : String(e));
        try {
            halt(s, "error", { error: message });
        }
        catch (halted) {
            if (!(halted instanceof Fail))
                throw halted;
            s.add("state", { status: "error", error: message });
        }
    }
    if (s.status() === "done" && s.head["worktree"]) // nothing was changed: there is nothing left to accept
        removeWorktree(s.head);
    print(G.json ? dumps(reportJson(s, cfg)) : report(s, false, cfg));
    return get(EXIT, s.status(), 0) ?? 0;
}
/** Load and lock a session that `command` may act on: admits() in lifecycle.ts says which. */
export function resume(sid, command) {
    const s = new Session(sid).lock();
    if (s.head["start"] && !s.head["worktree"])
        s.treeLock = treeLock(s.head["root"]);
    if (s.last("state")["status"] === "running") { // we hold its lock, so the process that ran it died: record where it stopped
        const window = s.last("span", "gate");
        if (window && window["t"] === "span")
            settle(s, window["before"]);
        const [end, changed] = changes(s);
        s.add("state", { status: "error", end, changed, error: "interrupted: its dsk process was killed" });
    }
    // Which command may act on which status is admits()'s to say, whose laws gdp-wired proves (lib/lifecycle.ts).
    if (!admits(command, s.status())) {
        const needs = STATUSES.filter((status) => admits(command, status));
        throw new Fail(`session ${sid} is ${s.status()}; this command needs ${needs.join(' or ')}`);
    }
    return s;
}
/** End a session as accepted or dropped, keeping what its last stop measured. */
export function close(s, status) {
    rmTree(path.join(s.dir, "scratch")); // throwaway files, of no use after this
    const last = Object.fromEntries(Object.entries(s.last("state")).filter(([k]) => k !== "t"));
    s.add("state", { ...last, status });
}
/** The root of the git repository the command was called in, or null outside one. */
export function projectRoot() {
    const top = runSync("git", ["rev-parse", "--show-toplevel"]);
    return top.code === 0 ? top.out.trim() : null;
}
/** The text of a file, or of stdin for `-`: for a brief, an answer, a defect list or a next task. */
export function slurp(file) {
    if (file === "-")
        return fs.readFileSync(0, "utf8").replace(/\r\n?/g, "\n"); // universal newlines, as Python's text mode gave them
    return fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}
/** [name, text] for one --file: the whole file, or lines A to B of it when the value is PATH:A-B and PATH exists. */
export function attachment(value, workdir) {
    const match = /^(.+):(\d+)-(\d+)\n?$/s.exec(value);
    if (!match || !statOf(match[1])?.isFile())
        return [value === "-" ? "@stdin" : relPath(value, workdir), slurp(value)];
    const path_ = match[1];
    const first = Number(match[2]), last = Number(match[3]);
    const lines = linesOf(slurp(path_));
    if (first < 1 || first > last)
        throw new Fail(`${value}: lines ${first} to ${last} is not a range; lines are numbered from 1 and A comes before B`);
    if (last > lines.length)
        throw new Fail(`${value}: ${path_} has ${lines.length} lines, so there is no line ${last}`);
    return [`${relPath(path_, workdir)}:${first}-${last}`, lines.slice(first - 1, last).join('')];
}
/** `dsk run`: start a session on a brief, in place or in a worktree of its own, and drive it to its first stop. */
export async function cmdRun(args, cfg) {
    if (Boolean(args.text) === Boolean(args.brief))
        throw new Fail('give the brief as "text" or with --brief FILE, not both');
    const root = projectRoot();
    if ((args.allow.length || args.worktree) && !root)
        throw new Fail("--allow and --worktree need a git repository");
    if (args.worktree)
        refuseIgnored(root, args.allow); // a worktree was refused above when there is no repository
    let route = args.profile ? [args.profile] : cfg["route"];
    for (const name of route) {
        if (!has(cfg["profiles"], name))
            throw new Fail(`unknown profile ${name}`);
    }
    if (!args.profile)
        route = await orderedRoute(cfg, route); // fastest first when the setting says so, and measured if that is stale
    apiKey(cfg["profiles"][route[0]]); // every name on the route was looked up above
    if (args.web)
        searchKey(cfg);
    const effort = args.effort || get(cfg, "effort", "off");
    if (!has(MAX_TOKENS, effort))
        throw new Fail(`config: effort is ${pyRepr(effort)}, not one of ${Object.keys(MAX_TOKENS).join(', ')}`);
    let workdir = root || process.cwd();
    const brief = args.text || slurp(args.brief);
    const files = (args.file ?? []).map((value) => attachment(value, workdir));
    const dskPath = path.join(workdir, "DSK.md");
    const dskMd = fs.existsSync(dskPath) ? slurp(dskPath) : "";
    const guard = root && !args.worktree ? treeLock(root) : null; // held until this run returns
    autoPrune(cfg);
    const s = new Session().lock();
    let start;
    let sandbox;
    let unsandboxed;
    try {
        start = null;
        if (args.worktree) {
            workdir = path.join(s.dir, "wt");
            makeWorktree(s, root, workdir);
        }
        if (root)
            start = snapshot(workdir, path.join(s.dir, "index"));
        [sandbox, unsandboxed] = sandboxMode(cfg, workdir, s.dir, args.no_sandbox);
    }
    catch (e) {
        if (args.worktree)
            removeWorktree({ root: root, workdir, id: s.id });
        rmTree(s.dir);
        throw e;
    }
    const head = s.add("head", {
        id: s.id, root: root || workdir, workdir, worktree: args.worktree, start,
        allow: args.allow, checks: args.check, web: args.web, effort,
        recheck: args.recheck == null ? Boolean(get(cfg, "recheck")) : args.recheck,
        reviewer: args.reviewer == null ? Boolean(get(cfg, "reviewer")) : args.reviewer,
        max_turns: args.max_turns || (args.allow.length ? 30 : 12), // leads gave writing runs 25 to 40
        scratch: true, sandbox, unsandboxed,
        output_chars: cfg["limits"]["output_chars"], read_chars: cfg["limits"]["read_chars"],
        owner: args.owner, route, brief: brief.trim(), files, dsk_md: dskMd.trim(),
        date: today(), created: now(),
    });
    for (const [file, text] of files) {
        if (file === "@stdin") // kept in the session, so it can still be read after compaction drops the attached copy
            fs.writeFileSync(path.join(s.dir, "stdin"), text, "utf8");
    }
    s.add("series", { why: "start", profile: route[0] });
    s.add("msg", { turn: 0, m: { role: "system", content: SYSTEM } });
    s.add("msg", { turn: 0, m: { role: "user", content: firstMessage(head) } });
    s.add("round");
    const code = await drive(s, cfg);
    void guard;
    return code;
}
/** Run a session's next round on the profile the lead named with --profile, and hold it there (see later_profiles). It is logged as a failover, because that is the one kind of series record that keeps the messages. */
export function chooseProfile(s, cfg, name) {
    if (!name) {
        if (!has(cfg["profiles"], s.profile)) // `dsk provider remove` took it away after the last round
            throw new Fail(`session ${s.id} ran on ${s.profile}, which was removed; choose another with --profile, one of: `
                + `${cfg["route"].filter((n) => has(cfg["profiles"], n)).join(', ')}`);
        return;
    }
    if (!has(cfg["profiles"], name))
        throw new Fail(`unknown profile ${name}`);
    apiKey(cfg["profiles"][name]);
    s.add("series", { why: "failover", profile: name, status: "chosen" }); // also when it is there already: this holds it there
}
/** `dsk answer`: give the worker the lead's answer to its question, and drive the run on. */
export async function cmdAnswer(args, cfg) {
    if (Boolean(args.text) === Boolean(args.brief))
        throw new Fail('give the answer as "text" or with --brief FILE, not both');
    const text = args.text || slurp(args.brief);
    const s = resume(args.id, 'answer');
    chooseProfile(s, cfg, args.profile);
    s.add("answer", { text });
    return await drive(s, cfg, "\n\nlead's answer: " + text);
}
/** `dsk show`: a session's report, or its review packet, its whole diff, its turns, or its whole answer. */
export function cmdShow(args, cfg) {
    const s = new Session(args.id);
    let text;
    if (args.diff) {
        text = workerDiff(s);
    }
    else if (args.answer) {
        text = answerText(s);
    }
    else if (args.log) { // every turn in order, with the events that started a new series
        text = s.of("series", "result").map((r) => r["t"] === "series" ? `-- new series: ${r['why']} on ${r['profile']}` : turnLine(s, r["turn"])).join("\n");
    }
    else {
        text = G.json ? dumps(reportJson(s, cfg)) : report(s, args.review, cfg);
    }
    print(text.replace(/\n+$/, ""));
    return 0;
}
/** Give a finished session the lead's next task: same conversation, new terms, fresh round. */
export async function cmdContinue(args, cfg) {
    if (Boolean(args.text) === Boolean(args.brief))
        throw new Fail('give the task as "text" or with --brief FILE, not both');
    const text = args.text || slurp(args.brief);
    const s = resume(args.id, 'continue');
    if (s.head["worktree"]) // before anything is added to the log: a refused continue leaves the session as it was
        refuseIgnored(s.head["root"], args.allow);
    chooseProfile(s, cfg, args.profile);
    const head = s.head;
    if (args.allow.length && head["start"] === null)
        throw new Fail("--allow needs a git repository");
    const allow = args.allow.length ? args.allow : scope(s)["allow"];
    const checks = args.check.length ? args.check : scope(s)["checks"];
    let turns = args.max_turns || scope(s)["max_turns"];
    if (args.allow.length && !(scope(s)["allow"] || []).length && args.max_turns == null) { // `not []` is True in Python
        // a read-only session that turns to writing in this round gets the turn limit a writing run would have
        turns = Math.max(turns, 30);
    }
    const recheck = args.recheck == null ? get(scope(s), "recheck", false) : args.recheck;
    const reviewer = args.reviewer == null ? get(scope(s), "reviewer", false) : args.reviewer;
    if (head["worktree"] && !statOf(head["workdir"])?.isDirectory()) {
        // accept applied the last round and removed the worktree, so build a fresh one from the tree as it is now
        removeWorktree(head);
        for (const name of ["index", "index.main"])
            fs.rmSync(path.join(s.dir, name), { force: true });
        makeWorktree(s, head["root"], head["workdir"]);
    }
    const answer = path.join(s.dir, "answer");
    if (fs.existsSync(answer)) // the last round's @answer would answer for this one, in the report and in the gate
        fs.renameSync(answer, `${answer}.${s.of('base').length + 1}`);
    const start = head["start"] ? tree(s) : null;
    s.add("base", { start, allow, checks, max_turns: turns, task: text, recheck, reviewer });
    s.add("round");
    const terms = { allow, checks, max_turns: turns };
    for (const key of ["output_chars", "read_chars", "scratch"])
        if (has(head, key))
            terms[key] = head[key];
    const extra = ("\n\nthe lead has the next task for this session. What you did before stands.\n\n"
        + runHeader(terms, head["web"], today())
        + "\n\n## Task\n" + text);
    return await drive(s, cfg, extra);
}
/** Block until the named sessions, or this project's running ones, have stopped, printing each report as it
 * comes. Runs started together from one shell command give no notice of their own; this is the notice. */
export async function cmdWait(args, cfg) {
    const ids = args.id ?? [];
    let started = now(), seen = now();
    const waiting = [...new Set(ids)];
    let reported = 0;
    for (const sid of waiting)
        new Session(sid); // fails now for an ID that does not exist, not after the others have been waited for
    const root = projectRoot() || process.cwd(), owner = process.env.CLAUDE_CODE_SESSION_ID || "", known = new Set(waiting);
    const deadline = args.timeout != null ? started + args.timeout : null;
    function driven(sid) {
        /** Whether a dsk process is running the session: it holds the lock. Asked without reading the log, which is long. */
        try {
            flock(path.join(STATE, sid, "lock"), "").close();
            return false;
        }
        catch (e) {
            if (e instanceof Fail)
                return true;
            throw e;
        }
    }
    function mine(head) {
        /** Without IDs: this lead's sessions in this project that run, or that were started with this very command.
         * `dsk run ... & dsk run ... & dsk wait`: a run started a moment ago may be over already. */
        return (head["root"] === root && (!owner || head["owner"] === owner) && !known.has(head["id"])
            && (get(head, "created", 0) >= started - 5 || driven(head["id"])));
    }
    while (true) {
        for (const s of (ids.length ? [] : sessions(mine))) {
            known.add(s.id);
            waiting.push(s.id);
        }
        for (const sid of waiting.filter((sid) => !driven(sid))) {
            const s = new Session(sid);
            if (s.last("state") && s.status() !== "running") {
                print(G.json ? dumps(reportJson(s, cfg)) : report(s, false, cfg).replace(/\n+$/, "") + "\n");
                const i = waiting.indexOf(sid);
                if (i >= 0)
                    waiting.splice(i, 1);
                reported += 1;
            }
        }
        if (waiting.length) {
            seen = now();
        }
        else if (ids.length || now() - seen >= (reported ? 4 : 10)) { // a run of the same command may still be starting
            if (!reported && !G.json) // JSON lines only: a display reads the exit code, not a sentence
                print("dsk · nothing is running");
            return 0;
        }
        if (deadline !== null && now() >= deadline) {
            if (G.json)
                eprint(`dsk · still running: ${waiting.join(' ')}`);
            else
                print(`dsk · still running: ${waiting.join(' ')}`);
            return 124;
        }
        await sleep(2);
    }
}
/** Measure the provider profiles (all of the route's by default) and print them fastest first. */
export async function cmdBench(args, cfg) {
    const names = [...new Set((args.profile && args.profile.length ? args.profile : cfg["route"]))];
    for (const name of names) {
        if (!has(cfg["profiles"], name))
            throw new Fail(`unknown profile ${name}`);
    }
    const found = await bench(cfg, names), at = now();
    if (args.json) {
        print(dumps(found));
    }
    else {
        print(`dsk bench · ${names.length} profile${names.length !== 1 ? "s" : ""}`);
        for (const name of fastOrder(found, names))
            print(`${String(name).padEnd(12)} ${speedText(get(found, name) || {}, at)}`);
    }
    return names.some((name) => { const seconds = get(get(found, name) || {}, "seconds"); return seconds !== null && seconds !== undefined; }) ? 0 : 1;
}
