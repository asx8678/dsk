// The second look and the independent reviewer, and the helpers that read a reviewer's reply and find a quote in a
// file.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
import { Fail, cpHead, cpLen, fixed, format, get, has, now, pyJson, pyRound } from './base.js';
import { apiKey, claimSlot } from './config.js';
import { changes, git, scope } from './gates.js';
import { FINDING, MAX_FINDINGS, NO_FIX, RECHECK, RECHECK_DIFF, RECHECK_LONG, REVIEWER, REVIEWER_FINDINGS, SEVERITY } from './texts.js';
import { headers, post, requestBody } from './wire.js';
/** Python's str.splitlines(): a trailing newline does not add an empty last line. */
function splitLines(text) {
    if (!text)
        return [];
    const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
/** Python's idea of whitespace, for str.split() and str.strip(): U+200B is not one; U+001C-U+001F and U+0085 are. */
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
/** Python's " ".join(text.split()): every run of whitespace becomes one space, with no ends. */
function folded(text) {
    return text.split(PY_SPACE).filter((piece) => piece !== '').join(' ');
}
/** Python's str.strip() with no argument: trim exactly the whitespace above, and nothing else. */
function pyStrip(text) {
    let start = 0, end = text.length;
    while (start < end && PY_SPACE.test(text[start]))
        start++;
    while (end > start && PY_SPACE.test(text[end - 1]))
        end--;
    return text.slice(start, end);
}
/** text.rstrip("\n"): drop the newlines at the end, and only there. */
function withoutEndNewlines(text) {
    return text.replace(/\n+$/, '');
}
/** Python's isinstance(value, dict), for a value that came out of JSON. */
function isDict(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** json.JSONDecoder().raw_decode(text, at) for an object at `at`: the value and the index just past it. */
function rawDecode(text, at) {
    let depth = 0, inString = false, escaped = false;
    for (let i = at; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"')
            inString = true;
        else if (ch === '{' || ch === '[')
            depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0)
                return [JSON.parse(text.slice(at, i + 1)), i + 1];
        }
    }
    throw new Error('unterminated JSON value');
}
/** After a done() whose checks pass: the text that sends the hand-in back for a second look, or '' when none is due.
 * One per round, and only for a change: an answer has no diff to check. `over` is the limit the round has reached, if
 * any: a hand-in that passes must not end as `limit` because dsk asked for one more turn. */
export function secondLook(s, cfg, turn, over) {
    const terms = scope(s);
    if (!get(terms, 'recheck') || s.since('round', 'recheck').length)
        return '';
    const [end, changed] = changes(s);
    if (!changed.length)
        return '';
    if (s.head['effort'] === 'off') { // the second look happens in the worker's reasoning, and a run without thinking has none
        s.add('recheck', { turn, skipped: 'thinking is off' });
        return '';
    }
    if (over) {
        s.add('recheck', { turn, skipped: `no ${over} left` });
        return '';
    }
    s.add('recheck', { turn, tree: end });
    const paths = changed.map((entry) => entry[2]);
    const diff = git(s.head['root'], ['diff', '--no-renames', terms['start'], end, '--',
        ...paths.map((p) => ':(literal)' + p)]);
    // Half the window at most, as for the attached files: the conversation still has to fit beside it.
    const profile = get(cfg['profiles'], s.profile);
    const fits = cpLen(diff) <= Math.floor(get(profile, 'compact_at', 32000) * 3 / 2);
    const shown = fits ? format(RECHECK_DIFF, { diff: withoutEndNewlines(diff) })
        : format(RECHECK_LONG, { lines: splitLines(diff).length, files: paths.join(', ') });
    return RECHECK + '\n\n' + shown;
}
/** The second look of the round in flight, measured from the log: null when none was due, else the turn it was asked
 * after or why it was skipped, the characters of reasoning in the reply that followed (null before there is one), and
 * the worker's files that changed after it. */
export function rechecked(s) {
    const marks = s.of('round').length ? s.since('round', 'recheck') : [];
    const asked = marks.length ? marks[0] : null;
    if (!asked)
        return null;
    const st = s.last('state');
    const found = s.of('msg').find((r) => r['turn'] === asked['turn'] + 1 && r['m']['role'] === 'assistant') ?? null;
    const reply = found === null ? null : found['m'];
    // What the second look changed ends where the reviewer, if any, took over.
    const until = s.since('round', 'reviewer').find((r) => get(r, 'tree'))?.['tree'] || get(st, 'end');
    const moved = new Set();
    if (get(asked, 'tree') && until) {
        for (const p of git(s.head['root'], ['diff', '--name-only', '--no-renames', '-z', asked['tree'], until]).split('\0'))
            moved.add(p);
    }
    return {
        turn: asked['turn'],
        skipped: get(asked, 'skipped', ''),
        reasoning: reply === null ? null : cpLen(get(reply, 'reasoning_content') || ''),
        changed: (get(st, 'changed') || []).map((entry) => entry[2]).filter((p) => moved.has(p)),
    };
}
/** A file's text in a tree object, or null when the tree has no such file. */
export function blob(root, treeId, path) {
    try {
        return git(root, ['show', `${treeId}:${path}`]);
    }
    catch (e) {
        if (e instanceof Fail)
            return null;
        throw e;
    }
}
/** The line where `quote` starts in `text`, with every run of whitespace compared as one space, or null. The reviewer
 * names no line numbers: models miscount them, so dsk finds the line itself. */
export function locate(text, quote) {
    const want = folded(quote);
    let flat = '', flatCp = 0;
    const starts = [];
    for (const [n, line] of splitLines(text).entries()) {
        const piece = folded(line);
        if (piece) {
            starts.push([flatCp, n + 1]);
            flat += piece + ' ';
            flatCp += cpLen(piece) + 1;
        }
    }
    const at = want ? flat.indexOf(want) : -1;
    if (at < 0)
        return null;
    const atCp = cpLen(flat.slice(0, at));
    let line = null;
    for (const [pos, n] of starts)
        if (pos <= atCp)
            line = n;
    return line;
}
/** The one JSON object a reply holds, with or without a code fence around it, or null. */
export function jsonObject(text) {
    const body = pyStrip(text || '');
    const first = body.indexOf('{'), last = body.lastIndexOf('}');
    if (!(0 <= first && first < last))
        return null;
    try {
        const found = JSON.parse(body.slice(first, last + 1));
        return isDict(found) ? found : null;
    }
    catch {
        return null;
    }
}
/** The list of findings in a reviewer's reply, or, when the reply broke off inside that list, every finding that
 * arrived whole. null when the reply has no such list. */
export function findingsIn(text) {
    const whole = jsonObject(text);
    if (whole !== null) {
        const findings = get(whole, 'findings');
        return Array.isArray(findings) ? findings : null;
    }
    const body = text || '';
    const start = /"findings"\s*:\s*\[/.exec(body);
    if (!start)
        return null;
    const found = [];
    let at = start.index + start[0].length;
    while (true) {
        while (at < body.length && ' \t\r\n,'.includes(body[at]))
            at++;
        if (at >= body.length || body[at] !== '{')
            return found;
        try {
            const [item, end] = rawDecode(body, at);
            at = end;
            found.push(item);
        }
        catch { // the finding the reply broke off in
            return found;
        }
    }
}
/** Findings as the worker gets them: what to do with them, then each one with its proof. */
export function findingsText(findings) {
    const out = [REVIEWER_FINDINGS];
    for (const f of findings) {
        out.push(`${f['id']} ${f['severity']} ${f['path']}:${f['line']}: ${f['quote']}`, `  input: ${f['input']}`, `  expected: ${f['expected']}`, `  actual: ${f['actual']}`, `  fix: ${f['fix']}`);
    }
    return out.join('\n');
}
/** The reviewer's user message: the task (with the lead's defects, in a round a reject started), DSK.md and the
 * attached files, the diff, the whole text of each changed file that is not new, and from the second review on the
 * findings sent back before, with the author's answer. Whole files only, while the message fits the profile's window
 * at 3 characters a token. Returns [text, [the files left out]], or [null, why] when the diff alone is too big. */
export function reviewInput(s, cfg, end, changed, prior, answer) {
    const head = s.head, root = head['root'], terms = scope(s);
    const start = terms['start'];
    const profile = get(cfg['profiles'], s.profile);
    const cap = get(profile, 'compact_at', 32000) * 3;
    const rejected = s.last('base', 'reject');
    const parts = ['## Task\n' + (get(terms, 'task') || head['brief'])];
    if (rejected && rejected['t'] === 'reject') {
        parts.push('## The lead\'s review of an earlier version, which this version answers\n' + rejected['text']);
    }
    const paths = changed.map((entry) => entry[2]);
    const diff = git(root, ['diff', '--no-renames', start, end, '--', ...paths.map((p) => ':(literal)' + p)]);
    const result = ['## Result\n=== DIFF ===\n' + withoutEndNewlines(diff)];
    if (prior.length) {
        const said = [get(answer, 'arg', ''), get(answer, 'open', '')].filter(Boolean).join(' | ');
        result.push('## PRIOR FINDINGS\n' + splitLines(findingsText(prior)).slice(1).join('\n')
            + `\nthe author's answer: ${said || '(none)'}`);
    }
    let used = 0;
    for (const piece of parts.concat(result))
        used += cpLen(piece);
    if (used > cap)
        return [null, 'the diff is too large for one review'];
    const context = [], whole = [], left = [];
    const attached = (head['dsk_md'] ? [['DSK.md', head['dsk_md']]] : [])
        .concat(head['files']);
    for (const [p, text] of attached) {
        const block = `<attached path="${p}">\n${text}\n</attached>`;
        if (used + cpLen(block) <= cap) {
            context.push(block);
            used += cpLen(block);
        }
        else {
            left.push(p);
        }
    }
    for (const [added, , p] of changed) {
        if (added === '-' || blob(root, start, p) === null)
            continue; // a binary file, or a new one: the diff shows it whole
        const text = blob(root, end, p);
        const block = text !== null ? `=== FILE: ${p}, as it now stands ===\n${withoutEndNewlines(text)}` : null;
        if (block && used + cpLen(block) <= cap) {
            whole.push(block);
            used += cpLen(block);
        }
        else if (block) {
            left.push(p);
        }
    }
    return [parts.concat(context, result, whole).join('\n\n'), left];
}
/** The findings dsk can check, each with an id and the line its quote starts on, and how many it dropped: a finding
 * needs a known severity, a file of the change, every field filled in, and a quote that is in that file. A finding at
 * a place already reported, one whose fix is no fix (NO_FIX), and any past the first MAX_FINDINGS, is dropped too. */
export function checkedFindings(s, end, changed, raw, number) {
    const texts = new Map();
    for (const [added, , p] of changed) {
        const text = added === '-' ? null : blob(s.head['root'], end, p);
        if (text !== null)
            texts.set(p, text);
    }
    const kept = [], places = new Set();
    let dropped = 0;
    for (const f of raw) {
        const path = get(f, 'path');
        const ok = isDict(f) && SEVERITY.includes(get(f, 'severity')) && texts.has(path)
            && FINDING.every((k) => typeof get(f, k) === 'string' && pyStrip(get(f, k)))
            && !NO_FIX.has(folded(get(f, 'fix').toLowerCase()).replace(/^[ .]+/, '').replace(/[ .]+$/, ''));
        const line = ok ? locate(texts.get(path), get(f, 'quote')) : null;
        const place = line && JSON.stringify([path, folded(get(f, 'quote'))]);
        if (!line || (place && places.has(place)) || kept.length === MAX_FINDINGS) {
            dropped++;
            continue;
        }
        places.add(place);
        const found = { id: `R${number}-F${kept.length + 1}` };
        for (const k of FINDING)
            found[k] = cpHead(folded(get(f, k)), 500);
        found['line'] = line;
        kept.push(found);
    }
    return [kept, dropped];
}
/** After a hand-in passes its checks and its second look: one review in a fresh context, with no tools and none of
 * the worker's conversation. Returns the text that sends the blocker and major findings back to the worker, or '' to
 * hand in. A review that fails (an HTTP error, a reply cut off at reviewer_seconds, a reply that is not one JSON object)
 * is recorded and the hand-in goes ahead: the reviewer adds a check, it cannot fail a run by itself. The call is logged
 * as a `reviewer` record, never as msg, req or usage: those are the worker's series. */
export async function independentReview(s, cfg, turn, over, done) {
    if (!get(scope(s), 'reviewer'))
        return '';
    const calls = s.since('round', 'reviewer');
    if (calls.length >= get(cfg, 'reviewer_calls', 2) || calls.some((r) => has(r, 'skipped')))
        return '';
    const [end, changed] = changes(s);
    if (!changed.length)
        return '';
    if (over) {
        s.add('reviewer', { turn, skipped: `no ${over} left` });
        return '';
    }
    const prior = [];
    for (const r of calls)
        for (const f of get(r, 'findings', []))
            if (f['severity'] !== 'minor')
                prior.push(f);
    const [text, left] = reviewInput(s, cfg, end, changed, prior, done);
    const name = s.profile, profile = get(cfg['profiles'], name), effort = get(cfg, 'reviewer_effort', 'low');
    if (text === null || !claimSlot(cfg, name)) { // the process holds a slot there already, unless a failover moved it
        s.add('reviewer', { turn, skipped: text === null ? left : `no free slot on ${name}` });
        return '';
    }
    const number = calls.length + 1, began = now();
    s.add('doing', { turn, arg: `independent review on ${name}`, review: true });
    const msgs = [{ role: 'system', content: REVIEWER }, { role: 'user', content: text }];
    const [status, data] = await post(profile['base_url'].replace(/\/+$/, '') + '/chat/completions', apiKey(profile), requestBody(profile, effort, msgs, 0, false, get(cfg, 'reviewer_tokens', 4000)), cfg['backoff'], headers(profile, `dsk-${s.id}-reviewer`), false, cfg['limits']['idle_seconds'], cfg['limits']['reviewer_seconds']);
    const rec = {
        turn, tree: end, profile: name, effort, seconds: pyRound(now() - began, 1), chars: cpLen(text), left_out: left,
    };
    if (status !== 200) {
        s.add('reviewer', { ...rec, error: `HTTP ${status}` });
        return '';
    }
    let choice, usage, message;
    try {
        if (!isDict(data) || !Array.isArray(data['choices']) || !data['choices'].length)
            throw new TypeError('unexpected');
        choice = data['choices'][0];
        if (!isDict(choice))
            throw new TypeError('unexpected');
        usage = get(data, 'usage') || {};
        if (!isDict(usage))
            throw new TypeError('unexpected');
        message = get(choice, 'message') || {};
        if (!isDict(message))
            throw new TypeError('unexpected');
    }
    catch {
        s.add('reviewer', { ...rec, error: 'an unexpected response' });
        return '';
    }
    const keptAs = path.join(s.dir, `reviewer.${s.of('reviewer').length + 1}.json`); // numbered across rounds, not reused
    const finish = get(choice, 'finish_reason', null);
    const content = get(message, 'content', null);
    const reasoning = get(message, 'reasoning_content') || get(message, 'reasoning');
    fs.writeFileSync(keptAs, pyJson({ finish, content, reasoning }), 'utf8'); // what it said, in full
    const details = get(usage, 'prompt_tokens_details') || {};
    const hit = get(usage, 'prompt_cache_hit_tokens', get(details, 'cached_tokens'));
    Object.assign(rec, { prompt: get(usage, 'prompt_tokens') || 0, hit, out: get(usage, 'completion_tokens') || 0 });
    const raw = findingsIn(get(message, 'content')), cut = get(choice, 'finish_reason') === 'length';
    if (raw === null) {
        s.add('reviewer', { ...rec, error: cut ? `cut off after ${fixed(rec['seconds'], 0)} s` : 'the reply was not one JSON object of findings' });
        return '';
    }
    const [kept, dropped] = checkedFindings(s, end, changed, raw, number);
    s.add('reviewer', { ...rec, findings: kept, dropped, cut });
    const sent = kept.filter((f) => f['severity'] !== 'minor');
    return sent.length ? findingsText(sent) : '';
}
/** The independent reviews of the round in flight, measured from the log: null when none was due, else each call as
 * recorded, and of the findings sent back, those whose quote is still in the file at the last stop. */
export function reviewed(s) {
    const calls = s.of('round').length ? s.since('round', 'reviewer') : [];
    if (!calls.length)
        return null;
    const st = s.last('state'), root = s.head['root'];
    const sent = [];
    for (const r of calls)
        for (const f of get(r, 'findings', []))
            if (f['severity'] !== 'minor')
                sent.push(f);
    const texts = new Map();
    if (get(st, 'end'))
        for (const f of sent)
            texts.set(f['path'], blob(root, st['end'], f['path']));
    return {
        calls: calls.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 't' && k !== 'at'))),
        sent: sent.map((f) => f['id']),
        still_there: sent.filter((f) => texts.get(f['path']) && locate(texts.get(f['path']), f['quote'])).map((f) => f['id']),
    };
}
