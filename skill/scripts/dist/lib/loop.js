// The worker loop: the run header and the first message, then one turn at a time until the worker asks, gets stuck,
// hits a limit, or hands in.
import { G, comma, cpHead, cpLen, eprint, format, get, has, now, pyJsonAscii, words } from './base.js';
import { compact } from './compaction.js';
import { cleanEnv, runScript } from './exec.js';
import { changes, gates, halt, roundLimit, scope, settle, span, tree } from './gates.js';
import { gate, parse } from './reply.js';
import { turnLine } from './reports.js';
import { independentReview, secondLook } from './review.js';
import { turnKind } from './stats.js';
import { ALTERNATING, CONFIRMED, CUT_OFF, HEAT, NUDGE, ONE_CALL, REPEAT, SAME_FAILURE, SANDBOX_LINE, SCRATCH, SPOKEN, SPOKEN_CHARS, STALE, NUMBERED, LAST_TURN_READ, LAST_TURN_WRITE, CHECK_PASSED, STILL_PASSED, RECHECK_OVER, RECHECK_TURNS, TIMED_OUT, TIMED_OUT_REPLY, TRUNCATED } from './texts.js';
import { chat, laterProfiles, release } from './wire.js';
import { tally } from './stops.js';
/** The lines that say what a run may change, what it must pass and how long it may take. */
export function runHeader(terms, web, date) {
    const shown = has(terms, 'output_chars') && has(terms, 'read_chars')
        ? `output: a turn shows at most ${comma(terms.output_chars)} characters of what you print, ${comma(terms.read_chars)} when it only reads files`
        : ''; // a session started before these keys has no line
    return ['## Run', 'allow: ' + (terms.allow.join(', ') || '(none: this run is read-only)'),
        ...terms.checks.map((cmd) => `check: ${cmd}`), `web: ${web ? 'on' : 'off'}`, shown,
        `turn limit: ${terms.max_turns}`, `date: ${date}`,
        get(terms, 'scratch') ? SCRATCH : '', // a session started before the folder has no line
        get(terms, 'sandbox') ? SANDBOX_LINE : ''].filter(Boolean).join('\n');
}
/**
 * An attached file's text with each line led by its number and a tab, counted from A for `PATH:A-B`. Workers asked
 * for file:line read every attached file again to number it: 9 of 10 review runs spent their first turn on that.
 */
export function numbered(file, text) {
    const first = Number(/:(\d+)-\d+$/.exec(file)?.[1] ?? 1);
    const lines = text.split('\n');
    const end = lines.length > 1 && lines[lines.length - 1] === '' ? lines.pop() : undefined; // a final newline is no line
    return lines.map((line, i) => `${first + i}\t${line}`).join('\n') + (end === undefined ? '' : '\n');
}
/** DSK.md, run header, attached files, brief, review: most stable first, so sessions share the longest prefix. */
export function firstMessage(head, digest = "", files = null, review = "") {
    const run = runHeader(head, head.web, head.date);
    const attached = (files === null ? head.files : files).map(([file, text]) => `<attached path="${file}">\n${numbered(file, text)}\n</attached>`);
    const facts = head.dsk_md ? `<attached path="DSK.md">\n${head.dsk_md}\n</attached>` : '';
    return [facts, run, attached.length ? NUMBERED : '', ...attached, '## Task\n' + head.brief, review, digest].filter(Boolean).join('\n\n');
}
/**
 * The answer a read-only run gave as plain text, or null. A worker that has its findings often writes them as its
 * reply and calls nothing. In the logs of 73 sessions all 34 replies that were no run_code call were such answers,
 * 1,719 to 13,693 characters each, in runs with no --allow: sending them back cost 8,080 s, six runs ended at
 * their turn limit with the answer thrown away, and one handed in "Review answer handed in." in its place. A run
 * that may change files still hands in with done(), after its checks, and a short text is a remark, not an answer.
 */
function spokenAnswer(s, reply) {
    const text = typeof reply?.content === 'string' ? reply.content.trim() : '';
    const calls = get(reply, 'tool_calls', []);
    return !scope(s).allow.length && !calls.length && cpLen(text) >= SPOKEN_CHARS ? text : null;
}
/** Run one reply. Returns (text for the worker, why the turn failed or '', the ask/done record or None). */
export async function takeTurn(s, cfg, env, turn, reply, finish) {
    s.changed = false; // a turn that runs no script changes nothing
    if (finish === 'time')
        return [format(TIMED_OUT, { seconds: cfg.limits.reply_seconds }), 'truncated', null];
    if (finish === 'length')
        return [TRUNCATED, 'truncated', null];
    const script = parse(reply);
    if (script === null) {
        const answer = spokenAnswer(s, reply);
        if (answer === null)
            return [NUDGE, 'malformed', null];
        const stop = { fn: 'done', arg: answer, open: '' }; // the record done(answer) would have left
        s.add('ledger', { turn, ...stop });
        s.printed = '';
        s.moved = false;
        s.changed = false;
        return [SPOKEN, '', stop];
    }
    const refusal = await gate(script);
    if (refusal)
        return [`refused, nothing was run: ${refusal}`, 'refused', null];
    const before = span(s);
    let output;
    let error;
    let stop;
    let reverted;
    try {
        [output, error, stop] = await runScript(s, cfg, env, turn, script);
    }
    finally { // also when the run is interrupted: what the script did so far is still the worker's
        reverted = settle(s, before, turn);
    }
    const wrote = [...new Set(s.of('ledger')
            .filter((r) => r.turn === turn && (r.fn === 'write' || r.fn === 'edit') && !has(r, 'err'))
            .map((r) => r.path ?? r.arg))];
    // A turn that only reads may show more: in the logs of 118 sessions, 505 of the 550 turns whose output was
    // cut only read files, and workers paged through one file up to 38 times.
    const fns = new Set(s.of('ledger').filter((r) => r.turn === turn).map((r) => r.fn));
    const limits = cfg.limits;
    const onlyReads = fns.size > 0 && [...fns].every((fn) => ['read', 'glob', 'grep', 'note'].includes(fn));
    const cap = onlyReads ? limits.read_chars : limits.output_chars;
    if (cpLen(output) > cap) {
        const marker = `[... ${cpLen(output) - cap} characters cut here: a turn that only reads shows at most ${comma(limits.read_chars)} characters, any other turn ${comma(limits.output_chars)}; read("@${turn}") returns all of it ...]`;
        const chars = Array.from(output);
        output = `${chars.slice(0, Math.floor(cap / 2)).join('')}\n${marker}\n${chars.slice(Math.floor(-cap / 2)).join('')}`;
    }
    // For the loop: what the worker is shown of its output, and whether the turn may have changed a file. Outside
    // a git repository nobody can tell what a shell command changed, so such a turn counts as one that did.
    const touched = before ? s.last('gate').touched : [];
    s.printed = output;
    s.moved = Boolean(wrote.length || reverted.length || touched.length || (!before && fns.has('sh')));
    s.changed = Boolean(wrote.some((p) => !String(p).startsWith('@')) || touched.length || (!before && fns.has('sh')));
    const parts = [
        wrote.length ? 'wrote: ' + wrote.join(', ') : '',
        output.trim() ? 'output:\n' + output.replace(/\n+$/, '') : 'output: (none)',
        error ? 'error:\n' + error : '',
        reverted.length ? 'reverted, outside the allow patterns: ' + reverted.join(', ') : '',
    ];
    return [parts.filter(Boolean).join('\n'), error ? 'error' : '', stop];
}
/**
 * What a hand-in answers. A read-only worker that printed its findings in the turn that called done() and passed
 * done() a one-line summary of them lost the findings: in a measured batch, a review answered with that line alone.
 * So the lines of that turn's output that the summary does not already hold go with it, when they are not short.
 * Line by line, because a worker that prints its answer and then a line more ("lines: 14"), or that reflows its
 * first line in done(), has neither text inside the other: whole-text matching doubled 2 of 4 answers in a batch.
 */
export function answerOf(printed, arg, writing) {
    if (writing)
        return arg;
    const summary = String(arg);
    const rest = String(printed ?? '').split('\n').filter((line) => line.trim() && !summary.includes(line.trim())).join('\n');
    return cpLen(rest.trim()) < SPOKEN_CHARS ? arg : `${arg}\n\n${rest.trim()}`;
}
/** Python's == for the JSON values a reply is made of: arrays and dicts compare by contents. */
const { isDeepStrictEqual: equal } = process.getBuiltinModule('node:util');
/** A JSON value whose dicts have their keys sorted, as json.dumps(sort_keys=True) writes them at every depth. */
function sortKeys(value) {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort())
            sorted[key] = sortKeys(value[key]);
        return sorted;
    }
    return value;
}
/** What a reply says, without the call ids that differ every time. */
export function said(message) {
    return [message.content, get(message, 'tool_calls', []).map((call) => call.function)];
}
/** A reply with every number blanked: two scripts that differ only in a line number or a slice bound share it. */
export function shape(message) {
    return pyJsonAscii(sortKeys(said(message))).replace(/\d+/g, '0');
}
/** The second look asked in the round in flight, if one was: a session logged before rounds were marked has none. */
function secondLookOf(s) {
    return s.of('round').length ? s.since('round', 'recheck').find((r) => !has(r, 'skipped')) : undefined;
}
/**
 * The check a shell command ran last, if it ended with one: then the command's exit code is the check's. Workers run
 * the check behind other commands (`bash -n x.sh && bash tests/run.sh`), and an exact match missed those.
 */
function checkRun(a, checks) {
    if (a.fn !== 'sh' || !has(a, 'code'))
        return undefined;
    const cmd = words(a.arg);
    return checks.find((c) => cmd === c || cmd.endsWith(`&& ${c}`) || cmd.endsWith(`; ${c}`));
}
/**
 * Send the pending turn result as the next message, with the lead's text after it. It is sent only now, so that an
 * answer, a defect list or a failed check rides in the same message. Returns whether there was one to send.
 */
function sendPending(s, cfg, extra) {
    const pending = s.last('result', 'msg');
    if (pending.t !== 'result')
        return false;
    const calls = get(s.last('msg').m, 'tool_calls', []);
    for (const call of calls.slice(0, -1)) {
        s.add('msg', { turn: pending.turn, m: { role: 'tool', tool_call_id: call.id, content: ONE_CALL } });
    }
    const target = calls.length ? { role: 'tool', tool_call_id: calls[calls.length - 1].id } : { role: 'user' };
    s.add('msg', { turn: pending.turn, m: { ...target, content: pending.text + extra } });
    compact(s, cfg);
    return true;
}
/** The tokens the round in flight has used, in and out: what `run_tokens` limits. */
function roundTokens(s) {
    return s.since('round', 'usage').reduce((sum, u) => sum + u.prompt + u.out, 0);
}
/** Halt at a bad stop, with the checks run first when the worker changed files and they are configured. */
async function badStop(s, cfg, env, status, info = {}) {
    // A second look that ends here without changing anything leaves the hand-in that passed its checks a turn
    // or more ago: that is handed in as it was, and `why` says that the second look did not finish.
    // Not after the reviewer sent findings back: then the hand-in has defects that nobody has answered.
    const look = (s.of('round').length && !s.since('round', 'reviewer').length)
        ? (s.since('round', 'recheck')[0] ?? null) : null;
    if (look && get(look, 'tree') && look.tree === tree(s)) {
        const handed = [...s.of('ledger')].reverse().find((r) => r.turn === look.turn && r.fn === 'done');
        return halt(s, undefined, { summary: handed.arg, open: handed.open,
            why: `${info.why} during the second look, which changed nothing` });
    }
    const run = changes(s)[1].length > 0 && scope(s).checks.length > 0;
    if (run)
        await gates(s, cfg, env); // its result is no use to a worker that is being stopped: only the record matters
    return halt(s, status, { checked: run, ...info });
}
/**
 * The notes a turn that ran has earned, and whether it was stale. The repeat check misses a script sent again with
 * one number changed: one worker spent its last 15 turns printing ever shorter slices of the same lines. So a turn
 * that is the previous script but for its numbers, changes nothing and prints nothing new counts as a reply that
 * got nowhere, like a repeat. And a check that fails the same way after every change gets a note every third time:
 * one worker ran 13 such turns to its limit.
 */
function notesFor(s, seen, turn, reply, before, acts, stop) {
    const printed = words(s.printed);
    const stale = !stop && !s.moved && before !== null && shape(reply) === shape(before)
        && acts.some((a) => a.fn !== 'note') && seen.shown.slice(-4).some((old) => old.includes(printed));
    seen.shown.push(printed);
    let note = stale ? '\n\n' + STALE : '';
    // A worker that saw its check pass ran it again, or prove, or git status, for one or two more turns in every
    // write run of a measured batch: dsk runs the checks at done() anyway. One careful run went on checking itself
    // for 9 turns after that note, so it is said again every third turn in which nothing changes.
    const checks = (scope(s).checks ?? []).map((c) => words(c));
    const passed = stop ? undefined : acts.filter((a) => a.code === 0).map((a) => checkRun(a, checks)).find(Boolean);
    const looking = Boolean(secondLookOf(s)); // the second look has its own note
    if (passed && seen.changedAt) {
        note += '\n\n' + format(CHECK_PASSED, { cmd: cpHead(passed, 80) });
        Object.assign(seen, { passedAt: turn, passedCmd: passed });
    }
    else if (!stop && !looking && seen.passedAt && seen.passedAt >= seen.changedAt) {
        const n = turn - seen.passedAt;
        if (n >= 3 && n % 3 === 0)
            note += '\n\n' + format(STILL_PASSED, { cmd: cpHead(seen.passedCmd, 80), n });
    }
    const broken = acts.filter((a) => a.fn === 'sh' && get(a, 'code'));
    if (acts.some((a) => a.fn === 'sh')) {
        const mark = broken.length ? [broken.map((a) => [a.arg, a.code]), printed.replace(/\d+/g, '0')] : [];
        seen.failing = [mark, mark.length && equal(mark, seen.failing[0]) ? seen.failing[1] + 1 : mark.length ? 1 : 0];
        if (mark.length && seen.failing[1] % 3 === 0) {
            const cmd = cpHead(words(broken[broken.length - 1].arg), 80);
            note += '\n\n' + format(SAME_FAILURE, { cmd, n: seen.failing[1] });
        }
    }
    return [stale, note];
}
/**
 * After done(): the checks, then the second look, then the reviewer. The text of the first that sends the hand-in
 * back to the worker, or '' when it stands. A confirmed hand-in ran and passed its checks a turn ago, and nothing
 * moved since: only the reviewer, if any, is still to come.
 */
async function handedIn(s, cfg, env, turn, stop, confirms, over) {
    const problem = confirms ? '' : (await gates(s, cfg, env)) || secondLook(s, cfg, turn, over());
    return problem || (await independentReview(s, cfg, turn, over(), stop));
}
/** Why a run is stuck, in the words the report gives the lead. */
function stuckWhy(t, alternates) {
    return t.repeats < 2 && t.idle < 3 ? 'three failing turns in a row'
        : alternates ? 'the same two replies, alternating'
            : t.repeats >= 2 ? 'same reply three times in a row'
                : 'three replies in a row that showed nothing new';
}
/** Drive the session to its next stop. `extra` is the lead's text, appended to the pending turn result. */
export async function loop(s, cfg, extra = "") {
    const limits = cfg.limits;
    const started = now();
    let t = { repeats: 0, idle: 0, failures: 0, stop: 'running', failedOver: false };
    let reads = 0;
    const env = cleanEnv(cfg, s.dir);
    const writing = Boolean(scope(s).allow.length);
    const saidHere = [];
    const seen = { shown: [], failing: [null, 0], changedAt: 0, passedAt: 0, passedCmd: '' };
    let left = 0;
    /** Whether the run is past its time or its token limit. */
    const spentLimit = () => now() - started > limits.run_seconds || roundTokens(s) > limits.run_tokens;
    /** The limit this round has reached, counting the turn in flight: `turn`, `time`, `token`, or ''. */
    const over = () => !left ? 'turn' : now() - started > limits.run_seconds ? 'time'
        : roundTokens(s) > limits.run_tokens ? 'token' : '';
    while (true) {
        if (sendPending(s, cfg, extra))
            extra = '';
        const before = [...s.of('msg')].reverse().find((r) => r.m.role === 'assistant')?.m ?? null;
        const previous = before === null ? null : said(before);
        const [reply, finish] = await chat(s, cfg, HEAT[Math.min(t.idle, 2)]);
        const turn = s.turn + 1;
        // A cut-off reply is not kept: resent with every later request, three of them cost one session 48,000 tokens.
        // The worker still hears that its reply was cut off, in the message that carries this turn's result.
        s.add('msg', { turn, m: finish === 'length' ? CUT_OFF : finish === 'time' ? TIMED_OUT_REPLY : reply });
        const done = s.since('round', 'result').length, limitTurns = roundLimit(s.recs);
        left = Math.max(0, limitTurns - done - 1);
        const nowSaid = said(reply);
        const asked = s.last('recheck');
        // The second look says that the same script once more is a fine answer: it confirms the hand-in, so it is
        // no repeat. Nothing is run twice: the script ran and its checks passed a turn ago, and nothing moved since.
        const confirms = Boolean(asked) && !has(asked, 'skipped') && asked.turn === turn - 1 && equal(nowSaid, previous);
        // Alternating between two scripts gets a worker no further than repeating one, so both count the same way.
        const alternates = saidHere.length >= 3 && equal(nowSaid, saidHere[saidHere.length - 2])
            && equal(saidHere[saidHere.length - 1], saidHere[saidHere.length - 3])
            && !equal(saidHere[saidHere.length - 1], nowSaid);
        saidHere.push(nowSaid);
        const repeat = (equal(nowSaid, previous) || alternates) && !confirms;
        let stale = false;
        let body;
        let failed;
        let stop;
        if (confirms) {
            body = CONFIRMED;
            failed = '';
            stop = [...s.of('ledger')].reverse().find((r) => r.turn === turn - 1 && r.fn === 'done');
        }
        else if (repeat) { // a worker that has its answer and only forgot to call done() gets one warning, not a stop
            body = alternates ? ALTERNATING : REPEAT;
            failed = 'repeat';
            stop = null;
        }
        else {
            [body, failed, stop] = await takeTurn(s, cfg, env, turn, reply, finish);
        }
        const acts = s.of('ledger').filter((a) => a.turn === turn);
        if (!repeat && !confirms && s.changed)
            seen.changedAt = turn; // a script that failed halfway may have changed files too
        if (!repeat && !failed && !confirms) {
            const [was, note] = notesFor(s, seen, turn, reply, before, acts, stop);
            stale = was;
            body += note;
        }
        let text = `turn ${turn} · ${left} left\n${body}`;
        let finished = false;
        if (stop && stop.fn === 'done') { // each step's text, when it has one, goes back to the worker instead
            const problem = await handedIn(s, cfg, env, turn, stop, confirms, over);
            text = text + (problem ? '\n\n' + problem : '');
            finished = !problem;
        }
        const kind = turnKind({ turn, fail: failed }, acts);
        reads = writing && kind === 'read' ? reads + 1 : 0; // a run that only reads never gets its work done
        if (reads && reads % 12 === 0) {
            text += `\n\nnote: the last ${reads} turns only read files. ${left} turns are left: start writing now, ` +
                'or call ask() if the task cannot be done as written.';
        }
        // A scout that read to its turn limit lost everything it had found: say so while one reply is left.
        if (left === 1 && !finished)
            text += '\n\n' + (writing ? LAST_TURN_WRITE : LAST_TURN_READ);
        // The second look has no budget of its own: at effort max one worker ran 14 more turns of its own tests in it
        // before it handed in, half the tokens of a batch of 16 sessions. From its third turn on, it is told to finish.
        const look = secondLookOf(s);
        if (look && !stop && !finished && left !== 1 && turn - look.turn >= RECHECK_TURNS) {
            text += '\n\n' + format(RECHECK_OVER, { n: turn - look.turn });
        }
        s.add('result', { turn, text, fail: failed, ...(finish === 'time' ? { slow: true } : {}) }); // `slow` lowers the effort: effortNow()
        if (G.verbose)
            eprint(turnLine(s, turn));
        const later = laterProfiles(s, cfg);
        t = tally(t, { repeat, failed: Boolean(failed), stale, finished, asked: Boolean(stop && stop.fn === 'ask'),
            later: later.length > 0, done, limit: limitTurns, spent: spentLimit() });
        if (t.stop === 'done')
            return halt(s, undefined, { summary: answerOf(s.printed, stop.arg, writing), open: stop.open });
        if (t.stop === 'question')
            return halt(s, 'question', { question: stop.arg });
        if (t.failedOver) { // another provider may break the loop, so it is tried before the run gives up
            release(cfg, s.profile);
            s.add('series', { why: 'failover', profile: later[0], status: 'repeat' });
        }
        if (t.stop === 'stuck')
            return await badStop(s, cfg, env, 'stuck', { why: stuckWhy(t, alternates) });
        if (t.stop === 'limit')
            return await badStop(s, cfg, env, 'limit', { why: `${over()} limit reached` });
    }
}
