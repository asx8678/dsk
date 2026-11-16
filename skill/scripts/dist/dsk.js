// dsk: a code-mode DeepSeek worker for Claude Code. Claude plans and reviews, DeepSeek writes. Each turn the worker
// replies with one Python script; dsk runs it (runner.py) and sends back only what it printed. See README.md.
//
// This file is the command line: the port of dsk.py's argparse setup and main(). argparse has no counterpart in
// Node, so the parser is a table of the same commands and flags, and it answers a mistake in argparse's words.
import { Fail, G, Interrupted, OutputClosed, dumps, eprint, interruptOnSignals, print, write } from './lib/base.js';
import { cmdAccept, cmdReject } from './lib/accept.js';
import { cmdAnswer, cmdBench, cmdContinue, cmdRun, cmdShow, cmdWait } from './lib/commands.js';
import { config } from './lib/config.js';
import { cmdDoctor, cmdProvider, cmdWeb } from './lib/providers.js';
import { cmdConfigure, cmdStats, cmdStatus } from './lib/stats.js';
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
    const command = (name, help, ...ids) => {
        const c = { name, help, positionals: ids.map((dest) => ({ dest })),
            options: [{ flags: ['--verbose'], dest: 'verbose', action: 'store_true', help: 'per-turn progress on stderr' }] };
        list.push(c);
        return c;
    };
    const efforts = Object.keys(MAX_TOKENS);
    const run = command('run', 'delegate a task');
    run.positionals.push({ dest: 'text', nargs: '?', help: 'the brief' });
    run.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the brief from a file' }, { flags: ['--allow'], dest: 'allow', action: 'append', default: [], metavar: 'GLOB', help: 'paths the worker may change' }, { flags: ['--check'], dest: 'check', action: 'append', default: [], metavar: 'CMD', help: 'acceptance test, run by dsk' }, { flags: ['--file'], dest: 'file', action: 'append', default: [], metavar: 'PATH',
        help: 'attach a file, or lines A to B of it as PATH:A-B (- is stdin)' }, { flags: ['--web'], dest: 'web', action: 'store_true', help: 'enable search() and fetch()' }, { flags: ['--worktree'], dest: 'worktree', action: 'store_true', help: 'work in a fresh git worktree' }, { flags: ['--no-sandbox'], dest: 'no_sandbox', action: 'store_true',
        help: "run this task's scripts and checks without the macOS sandbox, for tools that start their own" }, { flags: ['--effort'], dest: 'effort', action: 'store', choices: efforts,
        help: 'thinking effort (default: `effort` in the config, else off)' }, { flags: ['--recheck'], dest: 'recheck', action: 'bool',
        help: "send the first done() that passes its checks back once, for a second look in the worker's reasoning " +
            '(default: `recheck` in the config, else off)' }, { flags: ['--reviewer'], dest: 'reviewer', action: 'bool',
        help: 'have a hand-in that passes its checks read by an independent reviewer, a fresh request with no tools, ' +
            'and send its findings back (default: `reviewer` in the config, else off)' }, { flags: ['--profile'], dest: 'profile', action: 'store', help: 'use this provider profile only' }, { flags: ['--max-turns'], dest: 'max_turns', action: 'store', type: 'int',
        help: 'turns the run may take (default: 30 with --allow, 12 without)' }, { flags: ['--owner'], dest: 'owner', action: 'store', default: process.env['CLAUDE_CODE_SESSION_ID'] ?? '',
        help: 'the Claude Code session that started the run (default: $CLAUDE_CODE_SESSION_ID)' }, json());
    const answer = command('answer', "answer the worker's question", 'id');
    answer.positionals.push({ dest: 'text', nargs: '?', help: 'the answer' });
    answer.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the answer from a file (- is stdin)' }, { flags: ['--profile'], dest: 'profile', action: 'store', metavar: 'NAME', help: 'continue on this provider profile' }, json());
    const show = command('show', "print a session's report", 'id');
    for (const [flag, help] of [['review', 'the review packet'], ['diff', "the worker's whole diff"],
        ['log', 'tokens and actions per turn'], ['answer', 'the whole answer'],
        ['json', 'the report as one JSON object']]) {
        show.options.push({ flags: ['--' + flag], dest: flag, action: 'store_true', help, group: 'view' });
    }
    const cont = command('continue', 'give a finished session its next task', 'id');
    cont.positionals.push({ dest: 'text', nargs: '?', help: 'the next task' });
    cont.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the task from a file (- is stdin)' }, { flags: ['--allow'], dest: 'allow', action: 'append', default: [], metavar: 'GLOB', help: 'paths the worker may change' }, { flags: ['--check'], dest: 'check', action: 'append', default: [], metavar: 'CMD', help: 'acceptance test, run by dsk' }, { flags: ['--max-turns'], dest: 'max_turns', action: 'store', type: 'int',
        help: 'turns this round may take (default: the earlier limit, at least 30 when --allow is new)' }, { flags: ['--recheck'], dest: 'recheck', action: 'bool', help: 'the second look for this round (left out, it stays as it was)' }, { flags: ['--reviewer'], dest: 'reviewer', action: 'bool',
        help: 'the independent reviewer for this round (left out, it stays as it was)' }, { flags: ['--profile'], dest: 'profile', action: 'store', metavar: 'NAME', help: 'run this round on this provider profile' }, json());
    command('accept', 'mark as reviewed; after --worktree, apply the changes', 'id');
    const reject = command('reject', 'send defects back, or --drop the work', 'id');
    reject.positionals.push({ dest: 'text', nargs: '?', help: 'the defects, as a numbered list' });
    reject.options.push({ flags: ['--brief'], dest: 'brief', action: 'store', metavar: 'FILE', help: 'read the defects from a file (- is stdin)' }, { flags: ['--drop'], dest: 'drop', action: 'store_true', help: 'discard the work' }, { flags: ['--max-turns'], dest: 'max_turns', action: 'store', type: 'int', help: 'turns the round this reject starts may take' }, { flags: ['--profile'], dest: 'profile', action: 'store', metavar: 'NAME', help: 'run the next round on this provider profile' }, json());
    const wait = command('wait', 'block until sessions have stopped, printing each report');
    wait.positionals.push({ dest: 'id', nargs: '*', help: "sessions to wait for (default: this project's running ones)" });
    wait.options.push({ flags: ['--timeout'], dest: 'timeout', action: 'store', type: 'float', metavar: 'SECONDS',
        help: 'give up after this long, with exit code 124' }, json());
    const status = command('status', "this project's sessions");
    status.options.push({ flags: ['--hook'], dest: 'hook', action: 'store_true', help: 'act as a Stop hook' }, json("the last day's sessions on any project, as JSON"));
    const stats = command('stats', 'what the sessions measured: turns, tokens, time');
    stats.positionals.push({ dest: 'id', nargs: '*', help: 'sessions to measure (default: the last N days)' });
    stats.options.push({ flags: ['--days'], dest: 'days', action: 'store', type: 'int', default: 7, metavar: 'N', help: 'how far back to look (default 7)' }, { flags: ['--project'], dest: 'project', action: 'store_true', help: "only this project's sessions" }, json('as JSON'), { flags: ['--sessions'], dest: 'sessions', action: 'store_true', help: 'add a line per session' });
    command('search', 'raw web search, no model', 'target').options.push({ flags: ['--count'], dest: 'count', action: 'store', type: 'int', default: 5 });
    command('fetch', 'raw page fetch, no model', 'target');
    command('doctor', 'check each provider profile').options.push({ flags: ['--profile'], dest: 'profile', action: 'store' });
    const bench = command('bench', 'time each provider profile, fastest first');
    bench.options.push({ flags: ['--profile'], dest: 'profile', action: 'append', default: [], metavar: 'NAME', help: 'measure this profile (repeatable)' }, json('the measurements as JSON'));
    const configure = command('configure', 'show how dsk is set up');
    configure.options.push({ flags: ['--hook'], dest: 'hook', action: 'store_true', help: "act as a Claude Code hook: store the plugin's options first" }, { flags: ['--announce'], dest: 'announce', action: 'store_true', help: 'with --hook: say what is still missing' }, { flags: ['--data'], dest: 'data', action: 'store', metavar: 'DIR', help: "with --hook: the plugin's data folder" });
    const provider = command('provider', 'list, add, change, rename, reorder, enable, disable or remove the provider profiles');
    provider.positionals.push({ dest: 'action', choices: ['list', 'add', 'set', 'rename', 'up', 'move', 'order', 'enable', 'disable', 'remove'] }, { dest: 'name', nargs: '?', help: 'the provider; order: listed (your priority) or fastest' }, { dest: 'new', nargs: '?', help: 'rename: the new name; move: the new place on the route, from 1' });
    provider.options.push({ flags: ['--url'], dest: 'url', action: 'store', help: 'add, set: the base URL of the OpenAI-compatible API' }, { flags: ['--model'], dest: 'model', action: 'store', help: 'add, set: the model id as the endpoint lists it' }, { flags: ['--key-stdin'], dest: 'key_stdin', action: 'store_true', help: 'add, set: read the API key from standard input' }, { flags: ['--json'], dest: 'json', action: 'store_true', help: 'list: as JSON' });
    return list;
}
/** Python's repr() of a string, as argparse quotes a value in its messages. */
function repr(text) {
    const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
    return quote + text.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote) + quote;
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
    return new ParseError(`argument ${name}: invalid choice: ${repr(value)}${guess ? `, maybe you meant ${repr(guess)}?` : ''} ` +
        `(choose from ${choices.map(repr).join(', ')})`);
}
/** The value of a flag of type int or float, as argparse converts it, or its error. */
function converted(opt, value) {
    const name = opt.flags.join('/');
    if (opt.type === 'int') {
        if (!/^\s*[+-]?\d+\s*$/.test(value))
            throw new ParseError(`argument ${name}: invalid int value: ${repr(value)}`);
        return parseInt(value, 10);
    }
    if (opt.type === 'float') {
        const n = Number(value);
        if (!value.trim() || Number.isNaN(n) && !/^\s*[+-]?nan\s*$/i.test(value)) {
            throw new ParseError(`argument ${name}: invalid float value: ${repr(value)}`);
        }
        return n;
    }
    if (opt.choices && !opt.choices.includes(value))
        throw badChoice(name, value, opt.choices);
    return value;
}
/** The help of the whole program, or of one command: what -h prints. */
function help(all, c) {
    if (!c) {
        const names = all.map((x) => x.name);
        return `usage: dsk [-h] {${names.join(',')}} ...\n\nA code-mode DeepSeek worker for Claude Code.\n\npositional arguments:\n` +
            `  {${names.join(',')}}\n` + all.map((x) => `    ${x.name.padEnd(12)}${x.help}`).join('\n') +
            '\n\noptions:\n  -h, --help    show this help message and exit\n';
    }
    const shown = (o) => o.action === 'bool' ? `--${o.dest}, --no-${o.dest}`
        : o.action === 'store_true' ? o.flags[0] : `${o.flags[0]} ${o.metavar ?? o.dest.toUpperCase()}`;
    const usage = [`usage: dsk ${c.name} [-h]`, ...c.options.map((o) => `[${shown(o)}]`),
        ...c.positionals.map((p) => p.nargs === '?' ? `[${p.dest}]` : p.nargs === '*' ? `[${p.dest} ...]` : p.dest)];
    const lines = [usage.join(' '), '', c.help];
    if (c.positionals.length) {
        lines.push('', 'positional arguments:', ...c.positionals.map((p) => `  ${(p.choices ? `{${p.choices.join(',')}}` : p.dest).padEnd(22)}${p.help ?? ''}`));
    }
    lines.push('', 'options:', `  ${'-h, --help'.padEnd(22)}show this help message and exit`, ...c.options.map((o) => `  ${shown(o).padEnd(22)}${o.help ?? ''}`));
    return lines.join('\n') + '\n';
}
/** argparse's parse_args() for dsk's commands: the arguments by dest name, with every default filled in. */
export function parse(argv) {
    const all = commands();
    if (!argv.length)
        throw new ParseError('the following arguments are required: command');
    const [first, ...rest] = argv;
    if (first === '-h' || first === '--help') {
        write(help(all));
        throw new HelpShown();
    }
    if (first.startsWith('-') && first !== '-')
        throw new ParseError('the following arguments are required: command');
    const c = all.find((x) => x.name === first);
    if (!c)
        throw badChoice('command', first, all.map((x) => x.name));
    const args = { command: c.name };
    for (const o of c.options) {
        args[o.dest] = o.action === 'store_true' ? false : o.action === 'append' ? [...(o.default ?? [])]
            : o.default ?? null;
    }
    const loose = [];
    const unknown = [];
    const groupSeen = new Map();
    // Every long flag, with its --no- form for a --x/--no-x pair: what an abbreviation is matched against.
    const spellings = new Map();
    for (const o of c.options) {
        for (const f of o.flags)
            spellings.set(f, { opt: o, negative: false });
        if (o.action === 'bool')
            spellings.set(`--no-${o.flags[0].slice(2)}`, { opt: o, negative: true });
    }
    spellings.set('--help', { opt: { flags: ['--help'], dest: 'help', action: 'store_true' }, negative: false });
    let i = 0;
    let rawOnly = false;
    while (i < rest.length) {
        const word = rest[i];
        i++;
        if (rawOnly || word === '-' || !word.startsWith('-')) {
            loose.push(word);
            continue;
        }
        if (word === '--') {
            rawOnly = true;
            continue;
        }
        if (word === '-h') {
            write(help(all, c));
            throw new HelpShown();
        }
        const eq = word.startsWith('--') ? word.indexOf('=') : -1;
        const flag = eq > 0 ? word.slice(0, eq) : word;
        let found = spellings.get(flag);
        if (!found && flag.startsWith('--')) { // argparse takes any unambiguous prefix of a long flag
            const matches = [...spellings.keys()].filter((s) => s.startsWith(flag));
            if (matches.length > 1)
                throw new ParseError(`ambiguous option: ${flag} could match ${matches.join(', ')}`);
            if (matches.length === 1)
                found = spellings.get(matches[0]);
        }
        if (!found) {
            unknown.push(word);
            continue;
        }
        const { opt, negative } = found;
        if (opt.dest === 'help') {
            write(help(all, c));
            throw new HelpShown();
        }
        const name = opt.flags.join('/');
        if (opt.group) {
            const other = groupSeen.get(opt.group);
            if (other && other !== opt.flags[0])
                throw new ParseError(`argument ${opt.flags[0]}: not allowed with argument ${other}`);
            groupSeen.set(opt.group, opt.flags[0]);
        }
        if (opt.action === 'store_true' || opt.action === 'bool') {
            if (eq > 0)
                throw new ParseError(`argument ${opt.action === 'bool' ? `--${opt.dest.replace(/_/g, '-')}/--no-${opt.dest.replace(/_/g, '-')}` : name}: ignored explicit argument ${repr(word.slice(eq + 1))}`);
            args[opt.dest] = opt.action === 'store_true' ? true : !negative;
            continue;
        }
        let value;
        if (eq > 0) {
            value = word.slice(eq + 1);
        }
        else {
            const next = rest[i];
            if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-\d/.test(next))) {
                throw new ParseError(`argument ${name}: expected one argument`);
            }
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
    return args;
}
/** str() of an OSError as Python printed it: `[Errno 2] No such file or directory: 'brief.md'`. */
function osErrorText(e) {
    const described = /^[A-Z0-9_]+: ([^,]*)/.exec(e.message)?.[1] ?? e.message;
    const text = described.charAt(0).toUpperCase() + described.slice(1);
    const errno = typeof e.errno === 'number' ? Math.abs(e.errno) : null;
    return (errno !== null ? `[Errno ${errno}] ` : '') + text + (e.path ? `: ${repr(e.path)}` : '');
}
const RUN = {
    run: cmdRun, answer: cmdAnswer, show: cmdShow, continue: cmdContinue, accept: cmdAccept, reject: cmdReject,
    status: cmdStatus, wait: cmdWait, stats: cmdStats, search: cmdWeb, fetch: cmdWeb, doctor: cmdDoctor,
    configure: cmdConfigure, bench: cmdBench, provider: cmdProvider,
};
/** dsk.py's main(): parse, run the command, and turn a Fail or an OS error into `dsk · error: ...` and exit code 1. */
export async function main(argv = process.argv.slice(2)) {
    let args;
    try {
        args = parse(argv);
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
    G.json = ['run', 'answer', 'continue', 'reject', 'show', 'wait'].includes(args['command']) && Boolean(args['json']);
    interruptOnSignals();
    try {
        return Number(await RUN[args['command']](args, config())) || 0;
    }
    catch (e) {
        if (e instanceof OutputClosed)
            return 1; // `dsk status | head -1`: the reader has all it wanted
        const os = e && typeof e === 'object' && typeof e.code === 'string' && !(e instanceof Fail);
        if (e instanceof Fail || os) {
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
