// dsk: a code-mode DeepSeek worker for Claude Code. Claude plans and reviews, DeepSeek writes. Each turn the worker
// replies with one Python script; dsk runs it (runner.py) and sends back only what it printed. See README.md.
//
// This file is the command line: the port of dsk.py's argparse setup and main(). Node's util.parseArgs knows no
// subcommands, abbreviations or choices, so the parser is a table of the same commands and flags, and it answers a
// mistake in argparse's words.
import { Fail, G, Interrupted, OutputClosed, dumps, eprint, interruptOnSignals, print, write, isOsError, pyRepr } from './lib/base.js';
import { cmdAccept, cmdReject } from './lib/accept.js';
import { cmdAnswer, cmdBench, cmdContinue, cmdRun, cmdShow, cmdWait } from './lib/commands.js';
import { config } from './lib/config.js';
import { cmdDoctor, cmdProvider, cmdWeb } from './lib/providers.js';
import { cmdConfigure, cmdPrune, cmdStats, cmdStatus } from './lib/stats.js';
import { MAX_TOKENS } from './lib/texts.js';
/** A parse error, printed as `dsk · error: ...` with exit code 1: argparse's 2 is dsk's `question`. */
class ParseError extends Error {
}
/** -h or --help: the help is printed and dsk exits 0. */
class HelpShown extends Error {
}
const json = (help = 'print the report as one JSON object') => ({ flags: ['--json'], dest: 'json', action: 'store_true', help });
/** Every command and flag of dsk.py's argparse setup, in its order. */
function commands() {
    const list = [];
    const command = (name, help, run, ...ids) => {
        const c = { name, help, run, positionals: ids.map((dest) => ({ dest })), options: [
                { flags: ['-h', '--help'], dest: 'help', action: 'help', help: 'show this help message and exit' },
                { flags: ['--verbose'], dest: 'verbose', action: 'store_true', help: 'per-turn progress on stderr' }
            ] };
        list.push(c);
        return c;
    };
    const efforts = Object.keys(MAX_TOKENS);
    const run = command('run', 'delegate a task', cmdRun);
    run.positionals.push({ dest: 'text', nargs: '?', help: 'the brief' });
    run.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the brief from a file' }, { flags: ['--allow'], dest: 'allow', action: 'append', metavar: 'GLOB', help: 'paths the worker may change' }, { flags: ['--check'], dest: 'check', action: 'append', metavar: 'CMD', help: 'acceptance test, run by dsk' }, { flags: ['--file'], dest: 'file', action: 'append', metavar: 'PATH',
        help: 'attach a file, or lines A to B of it as PATH:A-B (- is stdin)' }, { flags: ['--web'], dest: 'web', action: 'store_true', help: 'enable search() and fetch()' }, { flags: ['--worktree'], dest: 'worktree', action: 'store_true', help: 'work in a fresh git worktree' }, { flags: ['--no-sandbox'], dest: 'no_sandbox', action: 'store_true',
        help: "run this task's scripts and checks without the macOS sandbox, for tools that start their own" }, { flags: ['--effort'], dest: 'effort', action: 'store', choices: efforts,
        help: 'thinking effort (default: `effort` in the config, else off)' }, { flags: ['--recheck', '--no-recheck'], dest: 'recheck', action: 'bool',
        help: "send the first done() that passes its checks back once, for a second look in the worker's reasoning " +
            '(default: `recheck` in the config, else off)' }, { flags: ['--reviewer', '--no-reviewer'], dest: 'reviewer', action: 'bool',
        help: 'have a hand-in that passes its checks read by an independent reviewer, a fresh request with no tools, ' +
            'and send its findings back (default: `reviewer` in the config, else off)' }, { flags: ['--profile'], dest: 'profile', action: 'store', help: 'use this provider profile only' }, { flags: ['--max-turns'], dest: 'max_turns', action: 'store', type: 'int',
        help: 'turns the run may take (default: 30 with --allow, 12 without)' }, { flags: ['--owner'], dest: 'owner', action: 'store', default: process.env['CLAUDE_CODE_SESSION_ID'] ?? '',
        help: 'the Claude Code session that started the run (default: $CLAUDE_CODE_SESSION_ID)' }, json());
    const answer = command('answer', "answer the worker's question", cmdAnswer, 'id');
    answer.positionals.push({ dest: 'text', nargs: '?', help: 'the answer' });
    answer.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the answer from a file (- is stdin)' }, { flags: ['--profile'], dest: 'profile', action: 'store', metavar: 'NAME', help: 'continue on this provider profile' }, json());
    const show = command('show', "print a session's report", cmdShow, 'id');
    for (const [flag, help] of [['review', 'the review packet'], ['diff', "the worker's whole diff"],
        ['log', 'tokens and actions per turn'], ['answer', 'the whole answer'],
        ['json', 'the report as one JSON object']]) {
        show.options.push({ flags: ['--' + flag], dest: flag, action: 'store_true', help, group: 'view' });
    }
    const cont = command('continue', 'give a finished session its next task', cmdContinue, 'id');
    cont.positionals.push({ dest: 'text', nargs: '?', help: 'the next task' });
    cont.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the task from a file (- is stdin)' }, { flags: ['--allow'], dest: 'allow', action: 'append', metavar: 'GLOB', help: 'paths the worker may change' }, { flags: ['--check'], dest: 'check', action: 'append', metavar: 'CMD', help: 'acceptance test, run by dsk' }, { flags: ['--max-turns'], dest: 'max_turns', action: 'store', type: 'int',
        help: 'turns this round may take (default: the earlier limit, at least 30 when --allow is new)' }, { flags: ['--recheck', '--no-recheck'], dest: 'recheck', action: 'bool', help: 'the second look for this round (left out, it stays as it was)' }, { flags: ['--reviewer', '--no-reviewer'], dest: 'reviewer', action: 'bool',
        help: 'the independent reviewer for this round (left out, it stays as it was)' }, { flags: ['--profile'], dest: 'profile', action: 'store', metavar: 'NAME', help: 'run this round on this provider profile' }, json());
    command('accept', 'mark as reviewed; after --worktree, apply the changes', cmdAccept, 'id');
    const reject = command('reject', 'send defects back, or --drop the work', cmdReject, 'id');
    reject.positionals.push({ dest: 'text', nargs: '?', help: 'the defects, as a numbered list' });
    reject.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the defects from a file (- is stdin)' }, { flags: ['--drop'], dest: 'drop', action: 'store_true', help: 'discard the work' }, { flags: ['--max-turns'], dest: 'max_turns', action: 'store', type: 'int', help: 'turns the round this reject starts may take' }, { flags: ['--profile'], dest: 'profile', action: 'store', metavar: 'NAME', help: 'run the next round on this provider profile' }, json());
    const wait = command('wait', 'block until sessions have stopped, printing each report', cmdWait);
    wait.positionals.push({ dest: 'id', nargs: '*', help: "sessions to wait for (default: this project's running ones)" });
    wait.options.push({ flags: ['--timeout'], dest: 'timeout', action: 'store', type: 'float', metavar: 'SECONDS',
        help: 'give up after this long, with exit code 124' }, json());
    const status = command('status', "this project's sessions", cmdStatus);
    status.options.push({ flags: ['--hook'], dest: 'hook', action: 'store_true', help: 'act as a Stop hook' }, json("the last day's sessions on any project, as JSON"));
    const stats = command('stats', 'what the sessions measured: turns, tokens, time', cmdStats);
    stats.positionals.push({ dest: 'id', nargs: '*', help: 'sessions to measure (default: the last N days)' });
    stats.options.push({ flags: ['--days'], dest: 'days', action: 'store', type: 'int', default: 7, metavar: 'N', help: 'how far back to look (default 7)' }, { flags: ['--project'], dest: 'project', action: 'store_true', help: "only this project's sessions" }, json('as JSON'), { flags: ['--sessions'], dest: 'sessions', action: 'store_true', help: 'add a line per session' });
    command('prune', 'delete settled sessions that are old enough, and name the ones that wait for you', cmdPrune).options.push({ flags: ['--days'], dest: 'days', action: 'store', type: 'int', metavar: 'N',
        help: 'delete what was settled more than N days ago (default: `keep_days` in the config, else 30)' }, { flags: ['--dry-run'], dest: 'dry_run', action: 'store_true', help: 'say what would go, and delete nothing' });
    command('search', 'raw web search, no model', cmdWeb, 'target').options.push({ flags: ['--count'], dest: 'count', action: 'store', type: 'int', default: 5, metavar: 'N', help: 'how many results (default 5)' });
    command('fetch', 'raw page fetch, no model', cmdWeb, 'target');
    command('doctor', 'check each provider profile', cmdDoctor).options.push({ flags: ['--profile'], dest: 'profile', action: 'store', metavar: 'NAME', help: 'check this profile only' });
    const bench = command('bench', 'time each provider profile, fastest first', cmdBench);
    bench.options.push({ flags: ['--profile'], dest: 'profile', action: 'append', metavar: 'NAME', help: 'measure this profile (repeatable)' }, json('the measurements as JSON'));
    const configure = command('configure', 'show how dsk is set up', cmdConfigure);
    configure.options.push({ flags: ['--hook'], dest: 'hook', action: 'store_true', help: "act as a Claude Code hook: store the plugin's options first" }, { flags: ['--announce'], dest: 'announce', action: 'store_true', help: 'with --hook: say what is still missing' }, { flags: ['--data'], dest: 'data', action: 'store', metavar: 'DIR', help: "with --hook: the plugin's data folder" });
    const provider = command('provider', 'list, add, change, rename, reorder, enable, disable or remove the provider profiles', cmdProvider);
    provider.positionals.push({ dest: 'action', choices: ['list', 'add', 'set', 'rename', 'up', 'move', 'order', 'enable', 'disable', 'remove'] }, { dest: 'name', nargs: '?', help: 'the provider; order: listed (your priority) or fastest' }, { dest: 'new', nargs: '?', help: 'rename: the new name; move: the new place on the route, from 1' });
    provider.options.push({ flags: ['--url'], dest: 'url', action: 'store', help: 'add, set: the base URL of the OpenAI-compatible API' }, { flags: ['--model'], dest: 'model', action: 'store', help: 'add, set: the model id as the endpoint lists it' }, { flags: ['--key-stdin'], dest: 'key_stdin', action: 'store_true', help: 'add, set: read the API key from standard input' }, { flags: ['--json'], dest: 'json', action: 'store_true', help: 'list: as JSON' });
    return list;
}
/** The characters two strings have in common, as difflib's SequenceMatcher counts them (no junk: the strings are short). */
function matching(a, b) {
    let best = 0, at = 0, bt = 0;
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            let k = 0;
            while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k])
                k++;
            if (k > best)
                [best, at, bt] = [k, i, j]; // the earliest in a, then in b, of the longest blocks
        }
    }
    return best ? best + matching(a.slice(0, at), b.slice(0, bt)) + matching(a.slice(at + best), b.slice(bt + best)) : 0;
}
/** difflib.get_close_matches(value, choices, 1): the choice most like `value`, if it is at least 0.6 alike. */
function closest(value, choices) {
    let found = null;
    for (const choice of choices) {
        const score = (2 * matching(choice, value)) / (choice.length + value.length || 1);
        if (score >= 0.6 && (!found || score > found[0] || (score === found[0] && choice > found[1])))
            found = [score, choice];
    }
    return found ? found[1] : null;
}
/** argparse's own words for a value that is not one of the choices, with Python 3.15's guess at what was meant. */
function badChoice(name, value, choices) {
    const guess = closest(value, choices);
    return new ParseError(`argument ${name}: invalid choice: ${pyRepr(value)}${guess ? `, maybe you meant ${pyRepr(guess)}?` : ''} ` +
        `(choose from ${choices.map(pyRepr).join(', ')})`);
}
/**
 * The value of a flag, as its type converts it and its choices allow it, or its error. A number is plain decimal and
 * not negative: each one dsk takes (turns, seconds, days, results) is a count or a limit, and NaN would be none.
 */
function converted(opt, value) {
    const name = opt.flags.join('/');
    if (opt.type) {
        const n = Number(value);
        const decimal = opt.type === 'int' ? /^\s*\+?\d+\s*$/ : /^\s*\+?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;
        if (!decimal.test(value) || !Number.isFinite(n))
            throw new ParseError(`argument ${name}: invalid ${opt.type} value: ${pyRepr(value)}`);
        return n;
    }
    if (opt.choices && !opt.choices.includes(value))
        throw badChoice(name, value, opt.choices);
    return value;
}
/** What help calls a flag's value: its metavar, else its choices, else its dest in capitals; '' for a flag without. */
function metavar(o) {
    if (o.action !== 'store' && o.action !== 'append')
        return '';
    return ` ${o.metavar ?? (o.choices ? `{${o.choices.join(',')}}` : o.dest.toUpperCase())}`;
}
/** What help calls a positional: its choices, else its name. */
const posName = (p) => p.choices ? `{${p.choices.join(',')}}` : p.dest;
/** The help of the whole program, or of one command: what -h prints, laid out as argparse lays it out. */
function help(all, c) {
    if (!c) {
        const names = all.map((x) => x.name);
        return `usage: dsk [-h] {${names.join(',')}} ...\n\nA code-mode DeepSeek worker for Claude Code.\n\npositional arguments:\n` +
            `  {${names.join(',')}}\n` + all.map((x) => `    ${x.name.padEnd(12)}${x.help}`).join('\n') +
            '\n\noptions:\n  -h, --help    show this help message and exit\n';
    }
    const usage = [];
    c.options.forEach((o, n) => {
        const item = o.action === 'bool' ? o.flags.join(' | ') : o.flags[0] + metavar(o);
        if (o.group && o.group === c.options[n - 1]?.group)
            usage[usage.length - 1] += ` | ${item}`;
        else
            usage.push(item);
    });
    const positionals = c.positionals.map((p) => [posName(p), p.help]);
    const options = c.options.map((o) => [o.flags.map((f) => f + metavar(o)).join(', '), o.help]);
    // The help starts at column 24, or 2 past the longest name when every name is shorter; a longer name gets a line.
    const at = Math.min(Math.max(...[...positionals, ...options].map(([name]) => name.length)) + 4, 24);
    const row = ([name, text = '']) => (name.length <= at - 4 ? `  ${name.padEnd(at - 2)}${text}` : `  ${name}\n${' '.repeat(at)}${text}`).trimEnd();
    const lines = [[`usage: dsk ${c.name}`, ...usage.map((u) => `[${u}]`), ...c.positionals.map((p) => p.nargs === '?' ? `[${posName(p)}]` : p.nargs === '*' ? `[${posName(p)} ...]` : posName(p))].join(' '), '', c.help];
    if (positionals.length)
        lines.push('', 'positional arguments:', ...positionals.map(row));
    lines.push('', 'options:', ...options.map(row));
    return lines.join('\n') + '\n';
}
/**
 * argparse's test for a word that names no flag: it is an unknown flag, unless it is - alone, a negative number or
 * has a space, which make it a value (`dsk reject ID "- the test fails"`).
 */
function flagLike(word) {
    return word.startsWith('-') && word !== '-' && !/^-\.?\d/.test(word) && !word.includes(' ');
}
/** argparse's parse_args() for dsk's commands: the command, and its arguments by dest name with every default filled in. */
function parse(argv) {
    const all = commands();
    if (!argv.length)
        throw new ParseError('the following arguments are required: command');
    const [first, ...rest] = argv;
    if (first === '-h' || first === '--help') {
        write(help(all));
        throw new HelpShown();
    }
    if (flagLike(first))
        throw new ParseError('the following arguments are required: command');
    const c = all.find((x) => x.name === first);
    if (!c)
        throw badChoice('command', first, all.map((x) => x.name));
    const args = { command: c.name };
    for (const o of c.options) {
        if (o.action !== 'help')
            args[o.dest] = o.action === 'store_true' ? false : o.action === 'append' ? [] : o.default ?? null;
    }
    const spellings = new Map(c.options.flatMap((o) => o.flags.map((f) => [f, o])));
    /** The flag a word names, by its spelling or an unambiguous prefix of a long one, and the value after its `=`. */
    const named = (word) => {
        if (!word.startsWith('-') || word === '-' || word === '--')
            return undefined;
        const eq = word.startsWith('--') ? word.indexOf('=') : -1;
        const flag = eq > 0 ? word.slice(0, eq) : word;
        let spelled = flag;
        if (!spellings.has(flag)) {
            const matches = flag.startsWith('--') ? [...spellings.keys()].filter((s) => s.startsWith(flag)) : [];
            if (matches.length > 1)
                throw new ParseError(`ambiguous option: ${word} could match ${matches.join(', ')}`);
            if (!matches.length)
                return undefined;
            spelled = matches[0];
        }
        return { opt: spellings.get(spelled), spelled, value: eq > 0 ? word.slice(eq + 1) : undefined };
    };
    const loose = [];
    const unknown = [];
    const groupSeen = new Map();
    let rawOnly = false;
    for (let i = 0; i < rest.length; i++) {
        const word = rest[i];
        if (rawOnly) {
            loose.push(word);
            continue;
        }
        if (word === '--') {
            rawOnly = true;
            continue;
        }
        const found = named(word);
        if (!found) {
            (flagLike(word) ? unknown : loose).push(word);
            continue;
        }
        const { opt, spelled } = found;
        const name = opt.flags.join('/');
        if (opt.group) {
            const other = groupSeen.get(opt.group);
            if (other && other !== name)
                throw new ParseError(`argument ${name}: not allowed with argument ${other}`);
            groupSeen.set(opt.group, name);
        }
        if (opt.action !== 'store' && opt.action !== 'append') {
            if (found.value !== undefined)
                throw new ParseError(`argument ${name}: ignored explicit argument ${pyRepr(found.value)}`);
            if (opt.action === 'help') {
                write(help(all, c));
                throw new HelpShown();
            }
            args[opt.dest] = opt.action === 'store_true' || !spelled.startsWith('--no-');
            continue;
        }
        let value = found.value;
        if (value === undefined) {
            const next = rest[i + 1];
            if (next === undefined || named(next) || flagLike(next))
                throw new ParseError(`argument ${name}: expected one argument`);
            value = next;
            i++;
        }
        const v = converted(opt, value);
        if (opt.action === 'append')
            args[opt.dest].push(v);
        else
            args[opt.dest] = v;
    }
    // Positionals in order: the required ones first take their word, an optional one takes it while words are left.
    let k = 0;
    const missing = [];
    for (const p of c.positionals) {
        if (p.nargs === '*') {
            args[p.dest] = loose.slice(k);
            k = loose.length;
        }
        else if (p.nargs === '?') {
            args[p.dest] = k < loose.length ? loose[k++] : null;
        }
        else if (k < loose.length) {
            args[p.dest] = loose[k++];
        }
        else {
            args[p.dest] = null;
            missing.push(p.dest);
        }
    }
    if (missing.length)
        throw new ParseError(`the following arguments are required: ${missing.join(', ')}`);
    for (const p of c.positionals) {
        if (p.choices && args[p.dest] !== null && !p.choices.includes(args[p.dest])) {
            throw badChoice(p.dest, args[p.dest], p.choices);
        }
    }
    unknown.push(...loose.slice(k));
    if (unknown.length)
        throw new ParseError(`unrecognized arguments: ${unknown.join(' ')}`);
    return [c, args];
}
/** str() of an OSError as Python printed it: `[Errno 2] No such file or directory: 'brief.md'`. */
function osErrorText(e) {
    const described = /^[A-Z0-9_]+: ([^,]*)/.exec(e.message)?.[1] ?? e.message;
    const text = described.charAt(0).toUpperCase() + described.slice(1);
    const errno = typeof e.errno === 'number' ? Math.abs(e.errno) : null;
    return (errno !== null ? `[Errno ${errno}] ` : '') + text + (e.path ? `: ${pyRepr(e.path)}` : '');
}
/** dsk.py's main(): parse, run the command, and turn a Fail or an OS error into `dsk · error: ...` and exit code 1. */
async function main(argv = process.argv.slice(2)) {
    let c;
    let args;
    try {
        [c, args] = parse(argv);
    }
    catch (e) {
        if (e instanceof HelpShown)
            return 0;
        if (e instanceof ParseError) {
            print(`dsk · error: ${e.message}`);
            return 1;
        }
        throw e;
    }
    G.verbose = Boolean(args['verbose']);
    G.json = ['run', 'answer', 'continue', 'reject', 'show', 'wait'].includes(c.name) && Boolean(args['json']);
    interruptOnSignals();
    try {
        return Number(await c.run(args, config())) || 0;
    }
    catch (e) {
        if (e instanceof OutputClosed)
            return 1; // `dsk status | head -1`: the reader has all it wanted
        if (e instanceof Fail || isOsError(e)) {
            const message = e instanceof Fail ? e.message : osErrorText(e);
            print(G.json ? dumps({ error: message }) : `dsk · error: ${message}`);
            return 1;
        }
        if (e instanceof Interrupted)
            return 130; // a signal outside a run: Python's KeyboardInterrupt ended it the same way
        throw e;
    }
}
try {
    process.exit(await main());
}
catch (e) {
    // The output closed while main() said something outside its own catch: the usage, or an error it was reporting.
    if (e instanceof OutputClosed)
        process.exit(1);
    // What Python printed for an exception nobody caught: its traceback, and exit status 1.
    eprint(e?.stack ?? String(e));
    process.exit(1);
}
