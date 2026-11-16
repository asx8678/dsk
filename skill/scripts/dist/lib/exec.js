// Running a worker's script: the environment it gets, the web tool, and the process that runs it through runner.py.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
import { Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg } from './base.js';
import { searchKey } from './config.js';
import { scope } from './gates.js';
import { sandboxed } from './sandbox.js';
import { job } from './stats.js';
import { SECRET } from './texts.js';
import { post } from './wire.js';
/** Python's except OSError: a Node system error carries a string code (ENOENT, EPIPE...). */
function isOsError(e) {
    return typeof e === 'object' && e !== null && typeof e.code === 'string';
}
/** The environment for scripts, sh() and checks: mine, minus everything that looks like a credential. */
export function cleanEnv(cfg, sdir) {
    const keys = new Set();
    for (const block of Object.values(cfg['profiles']))
        keys.add(block['key_env']);
    keys.add(cfg['search']['key_env']);
    const pass = cfg['env_pass'];
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined)
            continue;
        SECRET.lastIndex = 0;
        if (!keys.has(k) && (pass.includes(k) || !SECRET.test(k)))
            env[k] = v;
    }
    const empty = path.join(sdir, 'empty'), scratch = path.join(sdir, 'scratch');
    fs.mkdirSync(empty, { recursive: true });
    fs.mkdirSync(scratch, { recursive: true });
    Object.assign(env, {
        KUBECONFIG: os.devNull, AWS_SHARED_CREDENTIALS_FILE: os.devNull, AWS_CONFIG_FILE: os.devNull,
        AWS_EC2_METADATA_DISABLED: 'true', CLOUDSDK_CONFIG: empty, AZURE_CONFIG_DIR: empty, DOCKER_CONFIG: empty,
        GIT_TERMINAL_PROMPT: '0', PYTHONHASHSEED: '0', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', TZ: 'UTC',
        DSK_SCRATCH: scratch,
    });
    return env;
}
/** One raw search or fetch on the official tools API. No model is involved. */
export async function webTool(cfg, kind, target, count = 5) {
    const payload = kind === 'search' ? { query: target, count } : { url: target };
    const base = cfg['search']['base_url'];
    const url = `${base.replace(/\/+$/, '')}/v1/tools/${kind}`;
    return await post(url, searchKey(cfg), dumps(payload), cfg['backoff']);
}
/** search() and fetch() for a script. The ledger records what was asked and which URLs came back. A page is
 * fetched once per session: workers read long pages a slice per turn, and every real fetch is billed. */
export async function webCall(s, cfg, turn, kind, args) {
    const argv = args;
    const page = path.join(s.dir, 'pages', sha256(argv[0]).slice(0, 16));
    if (kind === 'fetch' && fs.existsSync(page)) {
        s.add('ledger', { turn, fn: kind, arg: argv[0], code: 0, cached: true });
        return { ok: readText(page) };
    }
    const [status, data] = await webTool(cfg, kind, argv[0], argv[1]);
    if (status !== 200) {
        s.add('ledger', { turn, fn: kind, arg: cpHead(argv[0], 200), err: `HTTP ${status}` });
        return { err: `${kind} failed: HTTP ${status} ${data}` };
    }
    if (kind === 'fetch') {
        s.add('ledger', { turn, fn: kind, arg: argv[0], code: 0 });
        const title = get(data, 'title');
        const text = [title ? `# ${title}` : '', get(data, 'content', '')].filter(Boolean).join('\n\n');
        fs.mkdirSync(path.dirname(page), { recursive: true });
        fs.writeFileSync(page, text, 'utf8');
        return { ok: text };
    }
    const results = get(data, 'results', []).map((r) => {
        const result = {};
        for (const k of ['title', 'url', 'date', 'summary'])
            result[k] = get(r, k);
        return result;
    });
    s.add('ledger', { turn, fn: kind, arg: cpHead(argv[0], 200), code: 0, urls: results.map((r) => r['url']) });
    return { ok: results };
}
/** Read a UTF-8 text file as Python's text mode did, with universal newlines. */
function readText(file) {
    return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}
/** Write one protocol line and wait until the socket has taken it, as sendall did. */
function writeLine(sock, line) {
    return new Promise((resolve, reject) => {
        sock.write(line, (err) => err ? reject(err) : resolve());
    });
}
/** The exit status of a child, waiting for its `exit` event when it has not fired yet. */
function waitExit(proc) {
    if (proc.exitCode !== null || proc.signalCode !== null)
        return Promise.resolve(exitStatus(proc.exitCode, proc.signalCode));
    return new Promise((resolve) => {
        proc.once('exit', (code, signal) => resolve(exitStatus(code, signal)));
    });
}
/** Wait at most `ms` for the child to exit, but let a signal cut the wait short. */
function waitForExitOr(proc, ms) {
    if (proc.exitCode !== null || proc.signalCode !== null)
        return Promise.resolve();
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        let off = () => { };
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            proc.removeListener('exit', finish);
            off();
            resolve();
        };
        timer = setTimeout(finish, ms);
        proc.once('exit', finish);
        const un = onInterrupt(finish);
        if (settled)
            un();
        else
            off = un;
    });
}
/** One line from the child, or whether its deadline or an interrupt came first. */
async function nextLine(lines, deadline, interrupted) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, (deadline - now()) * 1000));
    });
    try {
        return await Promise.race([lines.next(), timeout, interrupted]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** Run one script in a fresh child process. Returns (output, error, the ask/done record or None). */
export async function runScript(s, cfg, env, turn, script) {
    const limit = cfg['limits']['turn_seconds'];
    const outPath = path.join(s.dir, 'out', String(turn));
    const out = fs.openSync(outPath, 'w');
    let proc;
    try {
        const argv = [...sandboxed(s, cfg), pythonPath(), '-I', RUNNER, 'exec', '3'];
        proc = process.getBuiltinModule('node:child_process').spawn(argv[0], argv.slice(1), {
            cwd: s.head['workdir'], env, detached: true, stdio: ['ignore', out, out, 'pipe'],
        });
    }
    finally {
        fs.closeSync(out);
    }
    const sock = proc.stdio[3];
    sock.on('error', () => { }); // a closed socket says the child is gone; its exit status says why
    const rl = process.getBuiltinModule('node:readline').createInterface({ input: sock });
    rl.on('error', () => { }); // the input errors are OSErrors: the exit status tells the story
    const lines = rl[Symbol.asyncIterator]();
    let interrupted = false, resolveInterrupt = () => { };
    const interrupt = new Promise((resolve) => { resolveInterrupt = resolve; });
    const offInterrupt = onInterrupt(() => { interrupted = true; resolveInterrupt(); });
    const interruptedLine = interrupt.then(() => 'interrupt');
    const job = { dir: s.dir, script, allow: scope(s)['allow'], web: s.head['web'], sh_deny: cfg['sh_deny'] };
    s.shelled = null;
    const deadline = now() + limit;
    let running = null, error = '', stop = null, ended = false, code = 0;
    try {
        await writeLine(sock, dumps(job) + '\n');
        while (true) {
            if (interrupted)
                break;
            const step = await nextLine(lines, deadline, interruptedLine);
            if (step === 'interrupt' || interrupted)
                break;
            if (step === 'timeout') {
                error = `timed out after ${limit}s: the script and everything it started were killed`;
                break;
            }
            if (step.done) { // the script closed its end by itself
                ended = true;
                break;
            }
            const record = JSON.parse(step.value);
            if (has(record, 'pgid')) { // a shell command has started: from here on the script can change anything
                running = s.shelled = record['pgid'];
                s.add('doing', { turn, arg: get(record, 'cmd', '') });
            }
            else if (has(record, 'rpc')) {
                const reply = await webCall(s, cfg, turn, record['rpc'], record['args']);
                if (!interrupted)
                    await writeLine(sock, dumps(reply) + '\n');
            }
            else if (has(record, 'error')) {
                error = record['error'];
            }
            else {
                s.add('ledger', { turn, ...record });
                if (record['fn'] === 'sh')
                    running = null;
                if (record['fn'] === 'ask' || record['fn'] === 'done')
                    stop = record;
            }
        }
    }
    catch (e) {
        if (e instanceof Interrupted)
            interrupted = true;
        else if (!isOsError(e))
            throw e;
    }
    finally {
        if (ended)
            await waitForExitOr(proc, 5000); // let the interpreter finish exiting before the sweep
        for (const pgid of [proc.pid, running])
            if (pgid)
                killGroup(pgid);
        code = await waitExit(proc);
        rl.close();
        sock.destroy();
        offInterrupt();
    }
    if (interrupted)
        checkInterrupt();
    if (code && !error && !stop)
        error = `the script process died with status ${code}`;
    return [readText(outPath), error, stop];
}
