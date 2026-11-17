// The reports: the short text report and the JSON one, both measured from a session's log. The types stay loose:
// every value here is a log record read by key.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
import { comma, cpHead, fixed, fmtPercent, format, get, has, isOsError, splitLines } from './base.js';
import { answerText, git, scope } from './gates.js';
import { rechecked, reviewed } from './review.js';
import { job, turnKind } from './stats.js';
import { NEXT, SEVERITY } from './texts.js';
/** Tokens in thousands, one decimal, as `kilo` printed them: 12345 becomes "12.3k". */
export function kilo(n) {
    return fixed(n / 1000, 1) + 'k';
}
/** Cached share of the input tokens, over the turns where the provider reported it. None if it never did. */
export function cachedShare(usage) {
    const known = (usage).filter((u) => u['hit'] !== null);
    if (!known.length)
        return null;
    const hit = known.reduce((n, u) => n + u['hit'], 0);
    const prompt = known.reduce((n, u) => n + u['prompt'], 0);
    return hit / Math.max(1, prompt);
}
/** One line per turn: input tokens, cache hits and misses, output tokens, and what the script did. */
export function turnLine(s, turn) {
    const S = s;
    const u = (S.of('usage')).slice().reverse().find((r) => r['turn'] === turn);
    const hit = u['hit'] === null ? '?' : u['hit'];
    const miss = u['hit'] === null ? '?' : u['prompt'] - u['hit'];
    let acts = (S.of('ledger')).filter((r) => r['turn'] === turn).map((r) => {
        let act = cpHead(`${r['fn']} ${r['arg']}`, 50).replace(/\n/g, ' ');
        act += has(r, 'err') ? ' ✗' : r['fn'] === 'sh' ? ` → ${r['code']}` : '';
        return act;
    });
    acts = acts.length > 8 ? [...acts.slice(0, 8), `and ${acts.length - 8} more`] : acts.slice(0, 8);
    const failedRec = (S.of('result')).find((r) => r['turn'] === turn && r['fail']);
    const failed = failedRec ? failedRec['fail'] : '';
    return (`t${String(turn).padEnd(3)} in ${String(u['prompt']).padStart(7)} hit ${String(hit).padStart(7)} miss ${String(miss).padStart(7)} out ${String(u['out']).padStart(6)} | `
        + (failed ? `[${failed}] ` : '') + acts.join('; '));
}
/** The worker's change set: its files, from the start snapshot (or the tree `since`) to its last stop. */
export function workerDiff(s, flags = [], options = {}) {
    const S = s;
    const st = S.last('state');
    const paths = ((get(st, 'changed', [])) || []).map(([, , p]) => ':(literal)' + p);
    return paths.length ? git(S.head['root'], ['diff', ...flags, options.since || scope(S)['start'], st['end'], '--', ...paths]) : '';
}
/**
 * The checks the worker ran itself, and saw pass, in a turn before the first one that changed a file: a check
 * that passes on the untouched tree cannot show that the task was done. A round the lead started with a reject
 * also counts the checks dsk ran when the rejected round stopped. Only what the log holds: a worker that never
 * ran the check first leaves this empty, which says nothing about the check.
 */
export function passedBefore(s) {
    const S = s;
    const checks = new Map();
    for (const cmd of scope(S)['checks'])
        checks.set(cpHead(cmd, 200), cmd); // the ledger keeps 200 characters
    const recs = S.recs;
    let start = 0;
    recs.forEach((r, i) => { if (r['t'] === 'base' || r['t'] === 'reject')
        start = i; });
    let passed = [];
    let turn = [];
    if (recs[start] && recs[start]['t'] === 'reject') { // dsk ran these when the rejected round stopped
        let stopped = { results: [] };
        for (let i = start - 1; i >= 0; i--)
            if (recs[i]['t'] === 'checks') {
                stopped = recs[i];
                break;
            }
        passed = (stopped['results']).filter(([, code]) => code === 0).map(([cmd]) => cmd);
    }
    for (const r of recs.slice(start)) {
        const touched = r['touched'];
        if ((r['t'] === 'ledger' && (r['fn'] === 'write' || r['fn'] === 'edit') && !has(r, 'err'))
            || (r['t'] === 'gate' && (Array.isArray(touched) ? touched.length > 0 : touched)))
            break;
        if (r['t'] === 'ledger' && r['fn'] === 'sh' && r['code'] === 0 && checks.has(r['arg']))
            turn.push(checks.get(r['arg']));
        else if (r['t'] === 'result') { // only now is it known that the turn changed nothing
            passed = passed.concat(turn);
            turn = [];
        }
    }
    return [...new Set(passed)];
}
/**
 * The profiles a session left after sending them a request, in order. A profile whose slots were all taken was
 * passed over before any request: naming it ("thirdparty after opendesign") read as a failover in 4 of 16 reports
 * of a batch whose runs had not failed anywhere.
 */
export function leftProfiles(S) {
    const asked = [];
    let current = '';
    for (const r of S.recs) {
        if (r['t'] === 'series')
            current = get(r, 'profile');
        else if (r['t'] === 'req' && current && !asked.includes(current))
            asked.push(current);
    }
    return asked.filter((p) => p !== S.profile);
}
/**
 * The share of the input a provider had been sent already, by the turn before on the same profile and with no
 * compaction between, that it did not serve from its cache. What a turn adds is always a miss, so the share of all
 * input that was cached flagged 23 of 119 logged sessions whose providers cached all they could: in those, this
 * share never passed 7%. None when fewer than two turns can be compared, or the provider reports no cache.
 */
export function rereadShare(S) {
    const compacted = new Set(S.of('series').filter((r) => r['why'] === 'compact').map((r) => r['turn']));
    const usage = S.of('usage');
    let sent = 0, missed = 0, pairs = 0;
    for (let i = 1; i < usage.length; i++) {
        const [a, b] = [usage[i - 1], usage[i]];
        if (b['hit'] === null || b['profile'] !== a['profile'] || b['turn'] !== a['turn'] + 1 || compacted.has(a['turn']))
            continue;
        sent += a['prompt'];
        missed += Math.max(0, a['prompt'] - b['hit']);
        pairs += 1;
    }
    return pairs >= 2 && sent ? missed / sent : null;
}
/** The first line of a report: the session, how it stands, its profile and the ones it left, turns and tokens. */
function headline(S, status) {
    const usage = S.of('usage');
    const ledger = S.of('ledger');
    const turns = S.turn;
    const cached = cachedShare(usage);
    const earlier = leftProfiles(S);
    const shown = S.profile + (earlier.length ? ' after ' + earlier.join(', ') : ''); // a failover says which profile came before
    const top = [`dsk ${S.id}`, status, shown, `${turns} turn${turns === 1 ? '' : 's'}`,
        `in ${kilo(usage.reduce((n, u) => n + u['prompt'], 0))}` + (cached === null ? '' : ` (${fmtPercent(cached, 0)} cached)`),
        `out ${kilo(usage.reduce((n, u) => n + u['out'], 0))}`];
    for (const fn of ['search', 'fetch']) {
        const n = ledger.filter((r) => r['fn'] === fn && !r['cached']).length;
        if (n)
            top.push(`${fn} ${n}`);
    }
    return top.join(' · ');
}
/** The `checks:` line: each check dsk ran with its exit code, or that none ran because a bad stop left no change. */
function checksText(S, st, status, checks) {
    const ran = get(st, 'checked'); // a bad stop leaves the checks unrun when the worker changed no files
    const scopedChecks = (scope(S)['checks'] || []);
    return (status === 'stuck' || status === 'limit') && ran === false && scopedChecks.length
        ? 'not run: the worker changed no files'
        : (checks['results']).map(([cmd, code]) => `${cmd} → ${code}`).join('; ');
}
/** The `caution:` line: the checks that pass now and passed before the change too, so they show nothing about it. */
function cautionText(S, st, checks) {
    const passing = new Set((checks['results']).filter(([, code]) => code === 0).map(([cmd]) => cmd)); // a check that fails now needs no such warning
    const changed = get(st, 'changed');
    const before = changed && changed.length ? (passedBefore(S)).filter((cmd) => passing.has(cmd)) : [];
    if (!before.length)
        return '';
    const mark = S.last('base', 'reject') || {};
    return get(mark, 't') === 'reject' // checks dsk ran last round say little about this one
        ? `${before.join('; ')} passed before this round's changes too, so ${before.length === 1 ? 'it does' : 'they do'} not show that the defects were fixed: rerun each defect yourself`
        : `${before.join('; ')} passed before the worker changed anything, so ${before.length === 1 ? 'it does' : 'they do'} not show that the task was done`;
}
/** The `recheck:` line of a round that had a second look due: why it was skipped, or when it was asked and what came of it. */
function recheckText(look) {
    if (look['skipped'])
        return `skipped: ${look['skipped']}`;
    const thought = look['reasoning'] === null ? 'no reply yet' : !look['reasoning'] ? 'no reasoning came back'
        : `${comma(look['reasoning'])} characters of reasoning`;
    return [`asked after turn ${look['turn']}`, thought,
        look['changed'] && look['changed'].length ? 'changed ' + look['changed'].join(', ') : 'no change'].join(' · ');
}
/** The `review:` line: each reviewer call's findings by severity, and how many quotes of those sent back are still in the code. */
function reviewText(verdicts, st) {
    const parts = [];
    (verdicts['calls']).forEach((c, i) => {
        const n = i + 1;
        if (get(c, 'skipped') || get(c, 'error')) {
            parts.push(get(c, 'skipped') ? `skipped: ${c['skipped']}` : `call ${n}: no verdict, ${c['error']}`);
            return;
        }
        const count = {};
        for (const k of SEVERITY)
            count[k] = (c['findings']).filter((f) => f['severity'] === k).length;
        const found = SEVERITY.filter((k) => count[k]).map((k) => `${count[k]} ${k}`).join(', ') || 'nothing';
        parts.push(`call ${n}: ${found}` + (c['dropped'] ? `, ${c['dropped']} dropped` : '')
            + (get(c, 'cut') ? ', cut off' : '') + ` in ${fixed(c['seconds'], 0)} s`);
    });
    if ((verdicts['sent']).length && get(st, 'end')) {
        parts.push(`quotes still in the code: ${(verdicts['still_there']).length} of ${(verdicts['sent']).length}`);
    }
    return parts.join(' · ');
}
/** The `ignored:` line: a write() to files git ignores is in no diff, so nothing else in the report names them. */
function ignoredText(S, ignoredPaths) {
    if (!ignoredPaths.length)
        return '';
    const many = ignoredPaths.length > 1;
    const where = S.head['worktree']
        ? `${many ? 'they are' : 'it is'} only in the worktree ${S.head['workdir']}, which dsk accept and --drop delete`
        : `written, but in no diff, and --drop leaves ${many ? 'them' : 'it'}`;
    return `${ignoredPaths.join(', ')} (git ignores ${many ? 'them' : 'it'}: ${where})`;
}
/** The `spent:` line of a run that got stuck or hit a limit: the turns of the round by kind, the most frequent first. */
function spentText(S) {
    const acts = S.of('ledger');
    const kinds = new Map();
    for (const r of S.since('round', 'result')) {
        const kind = turnKind(r, acts.filter((a) => a['turn'] === r['turn']));
        kinds.set(kind, (kinds.get(kind) || 0) + 1);
    }
    return [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} ${n}`).join(' · ');
}
/** The `last:` line: what the worker last printed, for a run that stopped badly without changing anything. */
function lastText(S) {
    try {
        return cpHead(fs.readFileSync(path.join(S.dir, 'out', String(S.last('result')['turn'])), 'utf8')
            .replace(/\r\n?/g, '\n'), 1500).trim(); // universal newlines, as Python's text mode read it
    }
    catch (e) { // a turn that was never run has no output file
        if (!isOsError(e))
            throw e;
        return '';
    }
}
/** The `context:` line: how full the next request would be, against the point where dsk compacts the series. */
function contextText(S, cfg) {
    const lastUsage = S.last('usage');
    if (!(cfg && Object.keys(cfg).length && lastUsage))
        return '';
    const compacts = (S.of('series')).filter((r) => r['why'] === 'compact').length;
    const profiles = get(cfg, 'profiles', {});
    const profile = get(profiles, S.profile, {});
    return `${kilo(lastUsage['prompt'] + lastUsage['out'])} of ${kilo(get(profile, 'compact_at', 32000) ?? 32000)}`
        + (compacts ? ` · compacted ${compacts}×` : '');
}
/** The diff a review packet or a bad stop ends with: what changed since the lead's last review of the round, cut to `cap` lines. */
function diffLines(S, status, cap) {
    const reviews = S.last('base') ? S.since('base', 'state') : S.of('state');
    const seen = status === 'review' ? (reviews).filter((r) => r['status'] === 'review').map((r) => r['end']).slice(0, -1) : [];
    const diff = splitLines(workerDiff(S, [], { since: seen.length ? seen[seen.length - 1] : null }));
    const lines = seen.length ? [`diff since your last review (the whole diff: dsk show ${S.id} --diff)`] : [];
    lines.push(...diff.slice(0, cap));
    if (diff.length > cap)
        lines.push(`... ${diff.length - cap} more diff lines: dsk show ${S.id} --diff`);
    return lines;
}
/** The short report for the session's last stop, or the review packet. `summary`, `answer`, `question`, `notes`
 * and `open` are the worker's words, and a `finding` line is the reviewer's; every other line is measured. */
export function report(s, review = false, cfg = null) {
    const S = s;
    const st = S.last('state') || {};
    const ledger = S.of('ledger');
    const checks = S.last('checks') || { results: [] };
    const status = S.status();
    const lines = [headline(S, status)];
    const partial = review || status === 'stuck' || status === 'limit';
    const line = (label, text) => {
        if (text)
            lines.push(`${label + ':'}`.padEnd(8) + ' ' + text);
    };
    line('brief', review && (get(scope(S), 'task') || S.head['brief']));
    line('allow', review && (scope(S)['allow']).join(', '));
    line('where', review && S.head['worktree'] && S.head['workdir']);
    line('question', get(st, 'question'));
    line('error', get(st, 'error') || (st['status'] === 'running' && status === 'error' && 'interrupted: its dsk process is gone'));
    line('why', get(st, 'why'));
    line('sandbox', get(S.head, 'unsandboxed') && `off: ${S.head['unsandboxed']}`);
    line('notes', partial && ledger.filter((r) => r['fn'] === 'note').map((r) => r['arg']).join(' | '));
    line(status === 'done' ? 'answer' : 'summary', cpHead(status === 'done' ? answerText(S) : (get(st, 'summary', '') ?? ''), 1500));
    line('open', get(st, 'open'));
    line('checks', checksText(S, st, status, checks));
    line('caution', cautionText(S, st, checks));
    const look = rechecked(S);
    if (look)
        line('recheck', recheckText(look));
    const verdicts = reviewed(S);
    if (verdicts) {
        line('review', reviewText(verdicts, st));
        for (const c of partial ? verdicts['calls'] : []) {
            for (const f of get(c, 'findings', [])) {
                line('finding', `${f['id']} ${f['severity']} ${f['path']}:${f['line']} · input: ${f['input']} · actual: ${f['actual']}`);
            }
        }
    }
    const reverted = [...new Set((S.of('gate')).flatMap((g) => g['reverted']))];
    line('scope', reverted.length ? `reverted ${reverted.join(', ')} (copies in ${path.join(S.dir, 'reverted')})` : '');
    line('changed', ((get(st, 'changed', [])) || []).map(([a, d, p]) => `${p} (${a === '-' ? 'binary' : `+${a}` + (d !== '0' ? ` -${d}` : '')})`).join(', '));
    line('ignored', ignoredText(S, (get(st, 'ignored', [])) || []));
    if (has(st, 'cited')) {
        const bad = st['unverified'];
        line('sources', `${st['cited']} cited, ` + (bad && bad.length ? `${bad.length} unverified: ${bad.slice(0, 5).join(' ')}` : 'all opened in this session'));
    }
    const reread = rereadShare(S);
    if (reread !== null && reread > 0.2)
        line('cache', `low: ${fmtPercent(reread, 0)} of the input the provider had been sent already missed its cache`);
    if (status === 'stuck' || status === 'limit') { // where the turns went, and what the worker last saw when it changed nothing
        line('spent', spentText(S));
        const stChanged = get(st, 'changed');
        if (!(stChanged && stChanged.length))
            line('last', lastText(S));
    }
    line('context', contextText(S, cfg));
    if (partial)
        lines.push(...diffLines(S, status, review ? 300 : 120));
    line('next', format(get(NEXT, status, ''), { id: S.id }));
    return lines.join('\n');
}
/** The report as one JSON object: `job()`'s measured data, plus the words the text report says, measured from
 * the log the same way `report()` measures them, so the two never disagree. */
export function reportJson(s, cfg) {
    const S = s;
    const st = S.last('state') || {};
    const ledger = S.of('ledger');
    const checks = S.last('checks') || { results: [] };
    const status = S.status();
    const passing = new Set((checks['results']).filter(([, code]) => code === 0).map(([cmd]) => cmd)); // a check that fails now needs no such warning
    const head = S.head;
    const last = S.last('usage');
    const changed = get(st, 'changed');
    const profiles = cfg ? get(cfg, 'profiles', {}) : {};
    const profile = get(profiles, S.profile, {});
    const reverted = [...new Set((S.of('gate')).flatMap((g) => g['reverted']))];
    return {
        ...job(S, cfg),
        left: leftProfiles(S),
        summary: get(st, 'summary', ''), answer: status === 'done' ? answerText(S) : '',
        question: get(st, 'question') || '', error: get(st, 'error') || '', why: get(st, 'why') || '',
        open: get(st, 'open') || '', notes: ledger.filter((r) => r['fn'] === 'note').map((r) => r['arg']),
        checks: (checks['results']).map(([cmd, code]) => ({ cmd, code })),
        checked: get(st, 'checked'),
        passed_before: changed && changed.length ? (passedBefore(S)).filter((cmd) => passing.has(cmd)) : [],
        recheck: rechecked(S) ?? null,
        reviewer: reviewed(S) ?? null,
        files: ((changed) || []).map(([a, d, p]) => ({ path: p, added: a === '-' ? null : Math.trunc(Number(a)), deleted: d === '-' ? null : Math.trunc(Number(d)) })),
        reverted,
        ignored: get(st, 'ignored') || [],
        workdir: head['worktree'] ? head['workdir'] : '',
        context: { used: last ? last['prompt'] + last['out'] : 0,
            limit: get(profile, 'compact_at', 32000),
            compactions: (S.of('series')).filter((r) => r['why'] === 'compact').length },
        next: format(get(NEXT, status, ''), { id: S.id }),
    };
}
