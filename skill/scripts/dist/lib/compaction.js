// Compaction: when a series outgrows its profile's compact_at, older turns are dropped for a digest of what they did,
// built from the log alone, so the same log always compacts to the same bytes.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
import { Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg } from './base.js';
import { changes, roundLimit } from './gates.js';
import { firstMessage } from './loop.js';
import { findingsText } from './review.js';
import { KEEP } from './texts.js';
import { seriesMsgs } from './wire.js';
/** Python's task.strip(): whether a finished task has anything in it worth a line of the digest. */
function nonBlank(task) {
    return String(task).trim() !== '';
}
/** Python's " ".join(task.split()): the task's words, with every run of whitespace made one space. */
function oneLine(task) {
    const trimmed = String(task).trim();
    return trimmed ? trimmed.split(/\s+/).join(' ') : '';
}
/** isAbsolute called where a `path` parameter would otherwise hide the module, as Python's os.path.isabs. */
function isAbsolutePath(p) {
    return path.isAbsolute(p);
}
/** path.join for name_again, whose own `path` parameter hides the node:path import. */
function joinPath(a, b) {
    return path.join(a, b);
}
/** What the dropped turns did, as fixed-format text. */
export function digest(recs, upto, changed) {
    const ledger = recs.filter((r) => r['t'] === 'ledger');
    const answers = recs.filter((r) => r['t'] === 'answer').map((r) => r['text']);
    let answer = 0;
    const out = [`## Digest of turns 1-${upto}, whose messages were dropped`];
    out.push(...ledger.filter((r) => r['fn'] === 'note').map((r) => `note: ${r['arg']}`));
    const bases = recs.filter((r) => r['t'] === 'base');
    // A base record starts the next round, so its task is the one finished by the base after it.
    const finished = bases.length
        ? [get(recs[0], 'brief') || '', ...bases.slice(0, -1).map((r) => r['task'])]
        : [];
    out.push(...finished.filter(nonBlank).map((task) => `earlier task, finished: ${cpHead(oneLine(task), 300)}`));
    for (const r of ledger) {
        if (r['fn'] === 'ask') {
            out.push(`you asked: ${r['arg']}`);
            out.push(`the lead answered: ${answer < answers.length ? answers[answer++] : '(not yet)'}`);
        }
    }
    const acts = ledger.filter((r) => r['turn'] <= upto && ['write', 'edit', 'sh', 'search', 'fetch'].includes(r['fn']));
    for (const r of acts.slice(-80)) {
        const tail = has(r, 'err') ? ' (failed)' : r['fn'] === 'sh' ? ` → ${r['code']}` : '';
        out.push(`t${r['turn']} ${r['fn']} ${r['arg']}${tail}`);
    }
    out.push('files changed so far: ' + (changed.join(', ') || 'none'));
    return out.join('\n');
}
/** A dropped attachment as the read() call that fetches it again: lines A to B of a file, or the whole file. A
 * file git ignores is not in a worktree, so there it is named by its path in the main tree, which read() takes. */
export function nameAgain(path, head = null) {
    const match = path.match(/^(.+):(\d+)-(\d+)\n?$/s);
    let name = match ? match[1] : path;
    if (head && get(head, 'worktree') && !name.startsWith('@') && !isAbsolutePath(name)
        && !fs.existsSync(joinPath(head['workdir'], name)) && fs.existsSync(joinPath(head['root'], name))) {
        name = joinPath(head['root'], name);
    }
    return match ? `read("${name}", ${match[2]}, ${match[3]})` : name;
}
/** The messages that restart the series: system prompt, first message with a digest in place of the large
 * attached files, then the last two turns verbatim. No model call: the same log always compacts to the same bytes. */
export function compaction(recs, changed, compactAt = 32000) {
    const msgs = seriesMsgs(recs);
    const turn = msgs[msgs.length - 1]['turn'];
    const digestText = digest(recs, turn - 2, changed);
    const base = [...recs].reverse().find((r) => r['t'] === 'base') || null;
    let start = 0;
    recs.forEach((r, i) => { if (r['t'] === 'base' || r['t'] === 'reject')
        start = i; });
    const rejected = recs[start]['t'] === 'reject' ? recs[start] : null; // the last base or reject starts the round in flight
    const head = base ? { ...recs[0], ...base, brief: base['task'] } : { ...recs[0] };
    head['max_turns'] = roundLimit(recs); // a round the lead started with a reject may have a limit of its own
    let review = rejected ? `## The lead's review\nThe lead reviewed your work on this task and rejected it. Fix these defects:\n${rejected['text']}` : '';
    let verdict = null;
    for (let i = recs.length - 1; i >= start; i--)
        if (recs[i]['t'] === 'reviewer') {
            verdict = recs[i];
            break;
        } // the reviewer's last word
    const sent = (verdict ? get(verdict, 'findings', []) : []).filter((f) => f['severity'] !== 'minor');
    if (sent.length) {
        review = [review, "## The reviewer's findings\n" + findingsText(sent)].filter((part) => part).join('\n\n');
    }
    const files = recs[0]['files'].map((f, i) => [i, f[0], f[1]]);
    const keep = new Set(files.filter(([, , text]) => cpLen(text) <= KEEP).map(([i]) => i)); // a file up to KEEP always stays
    const turns = msgs.filter((r) => r['turn'] >= turn - 1).map((r) => r['m']);
    const first = (chosen) => {
        const pairs = files.filter(([i]) => chosen.has(i)).map(([, p, text]) => [p, text]);
        return { role: 'user', content: firstMessage(head, digestText, pairs, review) };
    };
    // Larger files stay too, in the order attached, while the compacted messages fit in half the profile's limit.
    for (const [i, , text] of files) {
        if (cpLen(text) > KEEP) {
            const chosen = new Set(keep);
            chosen.add(i);
            if (cpLen(dumps([msgs[0]['m'], first(chosen), ...turns])) <= Math.floor(compactAt * 3 / 2))
                keep.add(i);
        }
    }
    const kept = [{ turn: 0, m: msgs[0]['m'] }, { turn: 0, m: first(keep) },
        ...msgs.filter((r) => r['turn'] >= turn - 1).map((r) => ({ turn: r['turn'], m: r['m'] }))];
    const gone = files.filter(([i]) => !keep.has(i)).map(([, p]) => nameAgain(p, recs[0]));
    if (gone.length && kept[kept.length - 1]['m']['role'] === 'tool') {
        // Said last, where it cannot be missed. Without it a worker carries on from memory and invents what the
        // file said; in trials it then re-read the file on its next turn every time.
        kept.push({ turn, m: { role: 'user', content: 'Older turns were dropped to save space, and so were the '
                    + 'attached copies of: ' + gone.join(', ') + '. Read a file again before you rely on what it said.' } });
    }
    return kept;
}
/** Start a compacted series once the last request has grown past the `compact_at` of the profile the next one
 * goes to. A failover keeps the messages, so a request measured on the profile before it counts too: one run
 * failed over from a profile that compacts at 48k to one that compacts at 24k, and sent that one 37k. */
export function compact(s, cfg) {
    let start = -1;
    s.recs.forEach((r, i) => { if (r['t'] === 'series' && r['why'] !== 'failover')
        start = i; });
    if (start < 0)
        throw new Error('max() arg is an empty sequence');
    let last = null;
    for (let i = s.recs.length - 1; i >= start; i--)
        if (s.recs[i]['t'] === 'usage') {
            last = s.recs[i];
            break;
        }
    const msgs = seriesMsgs(s.recs);
    const limit = get(cfg['profiles'][s.profile], 'compact_at', 32000);
    if (!last || last['prompt'] <= limit)
        return;
    const turnsSeen = msgs.filter((r) => r['turn']).map((r) => r['turn']);
    if (!turnsSeen.length)
        throw new Error('min() arg is an empty sequence');
    if (Math.min(...turnsSeen) > s.turn - 2)
        return;
    const changed = changes(s)[1].map((entry) => entry[2]);
    const fresh = compaction(s.recs, changed, limit);
    s.add('series', { why: 'compact', profile: s.profile, turn: s.turn, changed });
    for (const rec of fresh)
        s.add('msg', { ...rec });
}
