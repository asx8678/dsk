// The one path matcher, for --allow and glob(): Python 3.13's glob.translate(pattern, recursive=True,
// include_hidden=True) with '/' as the only separator, ported line by line. runner.py matches the worker's writes with
// the Python original; dsk matches what to revert with this one, so the two must agree on every path. tests/test_glob.py
// holds them to it.
const SEP = '\\/';
const ANY_SEP = SEP;
const NOT_SEP = `[^${SEP}]`;
// include_hidden=True
const ONE_LAST_SEGMENT = `${NOT_SEP}+`;
const ONE_SEGMENT = `${ONE_LAST_SEGMENT}${ANY_SEP}`;
const ANY_SEGMENTS = `(?:.+${ANY_SEP})?`;
const ANY_LAST_SEGMENTS = '.*';
const STAR = `${NOT_SEP}*`;
/** re.escape for one character: any character that is not a letter, a digit or `_` matches itself once escaped. */
function escape(c) {
    return /[\w]/.test(c) ? c : /[\\^$.|?*+()[\]{}\/-]/.test(c) ? '\\' + c : c;
}
/** fnmatch._translate(pat, STAR, NOT_SEP): one path segment's parts. */
function translateSegment(pat) {
    const res = [];
    let i = 0;
    const n = pat.length;
    while (i < n) {
        const c = pat[i];
        i += 1;
        if (c === '*') {
            if (!res.length || res[res.length - 1] !== STAR)
                res.push(STAR);
        }
        else if (c === '?') {
            res.push(NOT_SEP);
        }
        else if (c === '[') {
            let j = i;
            if (j < n && pat[j] === '!')
                j += 1;
            if (j < n && pat[j] === ']')
                j += 1;
            while (j < n && pat[j] !== ']')
                j += 1;
            if (j >= n) {
                res.push('\\[');
            }
            else {
                let stuff = pat.slice(i, j);
                if (!stuff.includes('-')) {
                    stuff = stuff.replaceAll('\\', '\\\\');
                }
                else {
                    const chunks = [];
                    let k = pat[i] === '!' ? i + 2 : i + 1;
                    for (;;) {
                        k = pat.indexOf('-', k);
                        if (k < 0 || k >= j)
                            break;
                        chunks.push(pat.slice(i, k));
                        i = k + 1;
                        k = k + 3;
                    }
                    const chunk = pat.slice(i, j);
                    if (chunk)
                        chunks.push(chunk);
                    else
                        chunks[chunks.length - 1] += '-';
                    // Remove empty ranges: invalid in a regular expression.
                    for (let m = chunks.length - 1; m > 0; m--) {
                        const before = chunks[m - 1];
                        const after = chunks[m];
                        if (before[before.length - 1] > after[0]) {
                            chunks[m - 1] = before.slice(0, -1) + after.slice(1);
                            chunks.splice(m, 1);
                        }
                    }
                    // Escape backslashes and hyphens for set difference (--). Hyphens that create ranges stay.
                    stuff = chunks.map((s) => s.replaceAll('\\', '\\\\').replaceAll('-', '\\-')).join('-');
                }
                // Escape set operations (&&, ~~ and ||).
                stuff = stuff.replace(/([&~|])/g, '\\$1');
                i = j + 1;
                if (!stuff) {
                    res.push('(?!)'); // an empty range never matches
                }
                else if (stuff === '!') {
                    res.push('.'); // a negated empty range matches any character
                }
                else {
                    if (stuff[0] === '!')
                        stuff = '^' + stuff.slice(1);
                    else if (stuff[0] === '^' || stuff[0] === '[')
                        stuff = '\\' + stuff;
                    // Python reads a `]` first in a class as itself; JavaScript reads `[]` as an empty class and `[^]` as any
                    // character. The scan above stops at the first `]` after that place, so this is the only one.
                    stuff = stuff.replace(/^(\^?)\]/, '$1\\]');
                    res.push(`[${stuff}]`);
                }
            }
        }
        else {
            res.push(escape(c));
        }
    }
    return res;
}
/** glob.translate(pat, recursive=True, include_hidden=True), as a regular expression that matches a whole path. */
export function translate(pat) {
    const results = [];
    const parts = pat.split('/');
    const last = parts.length - 1;
    parts.forEach((part, idx) => {
        if (part === '*') {
            results.push(idx < last ? ONE_SEGMENT : ONE_LAST_SEGMENT);
        }
        else if (part === '**') {
            if (idx < last) {
                if (parts[idx + 1] !== '**')
                    results.push(ANY_SEGMENTS);
            }
            else {
                results.push(ANY_LAST_SEGMENTS);
            }
        }
        else {
            if (part)
                results.push(...translateSegment(part));
            if (idx < last)
                results.push(ANY_SEP);
        }
    });
    // Python: (?s:...)\Z with re.match. Here: anchored at both ends, `.` matching newlines too.
    return new RegExp(`^(?:${results.join('')})$`, 's');
}
/** dsk.py's matcher(): whether a path, relative and with '/' separators, matches any of the patterns. */
export function matcher(globs) {
    const patterns = globs.map(translate);
    return (path) => patterns.some((p) => p.test(path));
}
