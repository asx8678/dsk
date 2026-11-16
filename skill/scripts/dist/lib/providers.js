// dsk provider, dsk web and dsk doctor: the profiles and keys in the user's config, and checking an endpoint.
const fs = process.getBuiltinModule('node:fs');
const nodePath = process.getBuiltinModule('node:path');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
import { Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg } from './base.js';
import { ALIASES, apiKey, claimSlot, plugin, pool, secret } from './config.js';
import { webTool } from './exec.js';
import { said } from './loop.js';
import { parse } from './reply.js';
import { Session } from './session.js';
import { speeds } from './speed.js';
import { DEFAULTS, OPTION_KEYS, PROVIDER_NAME, SYSTEM } from './texts.js';
import { headers, post, release, replayable, requestBody } from './wire.js';
// Python's re.fullmatch of PROVIDER_NAME: texts.ts keeps the pattern without anchors, for .search().
const FULL_PROVIDER_NAME = new RegExp(`^(?:${PROVIDER_NAME.source})$`);
/** Python's text.splitlines(): lines on \n and \r\n, with no empty item after a final line break. */
function splitLines(text) {
    if (text === '')
        return [];
    const lines = text.split(/\r\n|\n/);
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
/** Python's str.rstrip("/"): every trailing slash goes, so two endpoints compare as dsk compared them. */
function stripSlash(text) {
    return text.replace(/\/+$/, '');
}
/** Python's repr of a string in the failure messages: one pair of single quotes. */
function quoted(text) {
    return "'" + text + "'";
}
/** json.dumps(x, indent=2), which config.json is written with: Python escapes every non-ASCII code point. */
function configJson(value) {
    return JSON.stringify(value, null, 2).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
/** The renamed map of a user config, or a fresh one when it does not hold an object, as dsk.py read it. */
function renamedOf(user) {
    return user.renamed && typeof user.renamed === 'object' && !Array.isArray(user.renamed) ? user.renamed : {};
}
/** Replaces a file of the user's in one step: a reader sees the old file or the new one, never half of either. An */
export function writeKept(path, text) {
    fs.mkdirSync(nodePath.dirname(path), { recursive: true });
    let mode;
    try {
        mode = fs.statSync(path).mode & 0o777;
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
        if (e?.code !== 'ENOENT')
            throw e;
        mode = 0o600;
    }
    const tmp = path + '.new';
    const fd = fs.openSync(tmp, 'w', mode);
    try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, path);
}
/** ~/.config/dsk/config.json as the user wrote it, {} when there is none. Every key in it is kept on a rewrite. */
export function userConfig() {
    const file = path.join(xdg('XDG_CONFIG_HOME', '~/.config'), 'config.json');
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
        if (e?.code === 'ENOENT')
            return [file, {}];
        throw e;
    }
    let user;
    try {
        user = JSON.parse(raw);
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
        throw new Fail(`${file}: ${e.message}; fix it by hand, dsk will not rewrite it`);
    }
    const profiles = has(user, 'profiles') ? user.profiles : {};
    const route = has(user, 'route') ? user.route : [];
    if (!user || typeof user !== 'object' || Array.isArray(user)
        || !profiles || typeof profiles !== 'object' || Array.isArray(profiles) || !Array.isArray(route)) {
        throw new Fail(`${file}: not the shape dsk writes (an object, with profiles an object and route a list); fix it by hand`);
    }
    return [file, user];
}
/** Puts `export NAME='key'` in ~/.config/dsk/env in place of any line that set NAME; every other line stays. */
export function setKey(name, key) {
    const file = path.join(xdg('XDG_CONFIG_HOME', '~/.config'), 'env');
    let lines;
    try {
        lines = splitLines(fs.readFileSync(file, 'utf8'));
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
        if (e?.code !== 'ENOENT')
            throw e;
        lines = ['# API keys for dsk. Source this file from your shell profile, or leave it: dsk reads it as well.'];
    }
    const sets = (line) => {
        try {
            return shlexSplit(line, true).some((w) => w.startsWith(name + '='));
        }
        catch (e) {
            if (e instanceof Interrupted)
                throw e;
            return false;
        }
    };
    writeKept(file, [...lines.filter((line) => !sets(line)), `export ${name}=${shlexQuote(key)}`].join('\n') + '\n');
}
/** Takes the lines that set NAME and nothing else out of ~/.config/dsk/env; every other line stays. "gone" when it */
export function dropKey(name) {
    const file = path.join(xdg('XDG_CONFIG_HOME', '~/.config'), 'env');
    let lines;
    try {
        lines = splitLines(fs.readFileSync(file, 'utf8'));
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
        if (e?.code !== 'ENOENT')
            throw e;
        return '';
    }
    const words = (line) => {
        try {
            return shlexSplit(line, true).filter((w) => w !== 'export');
        }
        catch (e) {
            if (e instanceof Interrupted)
                throw e;
            return [];
        }
    };
    const kept = lines.filter((line) => !(words(line).length === 1 && words(line)[0].startsWith(name + '=')));
    if (kept.length < lines.length)
        writeKept(file, kept.join('\n') + '\n');
    if (kept.some((line) => words(line).some((w) => w.startsWith(name + '='))))
        return 'mixed';
    return kept.length < lines.length ? 'gone' : '';
}
/** The sessions a dsk process holds that run on provider `name`, or may fail over to it: their process keeps the */
export function runningOn(name) {
    const found = [];
    const sids = fs.existsSync(STATE) && fs.statSync(STATE).isDirectory() ? [...fs.readdirSync(STATE)].sort() : [];
    for (const sid of sids) {
        const lock = path.join(STATE, sid, 'lock');
        if (!fs.existsSync(lock) || !fs.statSync(lock).isFile())
            continue;
        try {
            flock(lock, '').close(); // free: no process drives it
            continue;
        }
        catch (e) {
            if (e instanceof Interrupted)
                throw e;
            if (!(e instanceof Fail))
                throw e;
        }
        let s;
        try {
            s = new Session(sid);
        }
        catch (e) {
            if (e instanceof Interrupted)
                throw e;
            if (!(e instanceof Fail))
                throw e;
            continue;
        }
        const route = s.recs && s.recs.length ? new Set(get(s.head, 'route', []).map((n) => get(ALIASES, n, n))) : new Set(); // named as when it started
        if (!s.recs || !s.recs.length || route.has(name) || (s.last('series') && s.profile === name))
            found.push(sid);
    }
    return found;
}
/** Where a provider comes from when config.json is not all of it: "dsk" for one built into dsk, "plugin" for the */
export function builtIn(cfg, name) {
    const opts = plugin();
    if (name === get(ALIASES, 'custom', 'custom') && opts.custom_base_url && opts.custom_model)
        return 'plugin';
    return Object.keys(DEFAULTS.profiles).some((n) => get(ALIASES, n, n) === name) ? 'dsk' : '';
}
export function readKey(args) {
    if (!args.key_stdin)
        return null;
    const key = fs.readFileSync(0, 'utf8').trim();
    if (!key || /\s/.test(key))
        throw new Fail('the API key is empty or holds a space or a line break');
    return key;
}
export function checkEndpoint(url, model) {
    if (url !== null && url !== undefined && !/^https?:\/\/[^\s/]+(?:\/\S*)?$/.test(url)) {
        throw new Fail(`${quoted(url)} is not an http(s) URL such as https://example.com/v1`);
    }
    if (model !== null && model !== undefined && (!model.trim() || /\s/.test(model))) {
        throw new Fail('the model name is empty or holds a space');
    }
}
/** Whether a profile is DeepSeek's own API: the endpoint and the key that web search uses. Off the route it still */
export function isOfficial(cfg, name) {
    const profile = get(cfg.profiles, name) || {};
    const search = cfg.search;
    return (profile.key_env === search.key_env
        && stripSlash(profile.base_url || '') === stripSlash(search.base_url));
}
/** The route with a provider put on it: ahead of official DeepSeek, which stays the fallback; official itself, or */
export function placed(cfg, route, name) {
    const first = route.findIndex((n) => isOfficial(cfg, n));
    const at = isOfficial(cfg, name) ? route.length : first === -1 ? route.length : first;
    return [...route.slice(0, at), name, ...route.slice(at)];
}
export function ordinal(n) {
    const suffix = 10 <= n % 100 && n % 100 <= 20 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return `${n}${suffix}`;
}
/** A place chosen by hand counts from then on: with `route_order` fastest, set it to listed in the config about */
export function ownOrder(cfg, user) {
    if (get(cfg, 'route_order', 'listed') !== 'fastest')
        return '';
    user.route_order = 'listed';
    return ' · order: your priority now, not fastest first (dsk provider order fastest brings that back)';
}
/** Each profile, the route's first in its order: name, endpoint, model, whether it is on the route, whether its key */
export function providerRows(cfg) {
    const route = cfg.route.filter((n) => has(cfg.profiles, n)), found = speeds();
    const at = (n) => (route.includes(n) ? route.indexOf(n) : route.length);
    const rows = Object.entries(cfg.profiles).map(([n, p], i) => ({ n, p: p, i }))
        .sort((a, b) => at(a.n) - at(b.n) || a.i - b.i);
    return rows.map(({ n, p }) => ({
        "name": n, "base_url": p.base_url || '', "model": p.model || '', "key_env": p.key_env || '',
        "key": Boolean(secret(p.key_env || '')), "enabled": route.includes(n),
        "position": route.includes(n) ? route.indexOf(n) + 1 : null, "official": isOfficial(cfg, n),
        "seconds": get(get(found, n) || {}, 'seconds'), "builtin": builtIn(cfg, n),
    }));
}
/** List, add, change, reorder, enable, disable or remove the provider profiles. Writes ~/.config/dsk/config.json, */
export function cmdProvider(args, cfg) {
    if (args.action === 'list') {
        const rows = providerRows(cfg), search = Boolean(secret(cfg.search.key_env));
        if (args.json) {
            print(pyJson({ "providers": rows, "search": search, "order": get(cfg, 'route_order', 'listed') }));
        }
        for (const r of args.json ? [] : rows) {
            const where = r.enabled ? `${r.position}.` : 'off';
            const use = !r.official ? '' : r.enabled ? ' · web search and work' : ' · web search only';
            print(`${where.padEnd(4)}${r.name.padEnd(14)}${r.model} · ${r.base_url} · key ${r.key ? 'set' : 'missing'}${use}`);
        }
        if (!args.json) {
            print(`web search: ${search ? 'on' : 'off, it needs ' + cfg.search.key_env}`);
            if (get(cfg, 'route_order') === 'fastest') {
                print('order: fastest first, so the speed test decides, not the order listed '
                    + '(dsk provider order listed, or a dsk provider move, makes your priority count)');
            }
        }
        return 0;
    }
    const name = String(args.name || '').trim();
    if (!name && args.action !== 'order') { // order says what it takes by itself
        throw new Fail(`provider ${args.action} needs a name`);
    }
    const [file, user] = userConfig();
    if (args.action === 'order') {
        if (name !== 'listed' && name !== 'fastest') {
            throw new Fail('provider order takes listed (your priority) or fastest (the speed test decides), '
                + 'as in: dsk provider order fastest');
        }
        if (get(cfg, 'route_order', 'listed') === name) {
            print(`dsk · order: already ${name}`);
            return 0;
        }
        user.route_order = name;
        writeKept(file, configJson(user) + '\n');
        print(name === 'fastest' ? 'dsk · order: fastest first, the speed test decides which provider is tried first'
            : `dsk · order: your priority · route: ${cfg.route.join(' → ')}`);
        return 0;
    }
    const profiles = has(user, 'profiles') ? user.profiles : (user.profiles = {});
    const route = [...cfg.route]; // with renames applied
    if (args.action === 'add') {
        if (!FULL_PROVIDER_NAME.test(name)) {
            throw new Fail(`${quoted(name)}: a name is lower-case letters, digits, - and _, starting with a letter, at most 32`);
        }
        if (has(cfg.profiles, name)) {
            throw new Fail(`there is already a provider named ${name}; change it with: dsk provider set ${name}`);
        }
        const renamed = renamedOf(user);
        if (has(renamed, name)) {
            throw new Fail(`${name} was the name of the provider now called ${renamed[name]}; pick another name`);
        }
        if (!args.url || !args.model)
            throw new Fail('provider add needs --url and --model');
        checkEndpoint(args.url, args.model);
        const key = readKey(args);
        if (key === null)
            throw new Fail('provider add needs the API key on standard input, with --key-stdin');
        const key_env = 'DSK_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
        setKey(key_env, key); // the key first: a profile that names a key never written would fail every run
        profiles[name] = { "base_url": stripSlash(args.url), "key_env": key_env, "model": args.model,
            "compact_at": 24000, "extra": {} };
        user.route = placed(cfg, route, name);
        writeKept(file, configJson(user) + '\n');
        print(`dsk · added ${name} · ${args.model} · ${stripSlash(args.url)} · route: ${user.route.join(' → ')}`);
        return 0;
    }
    if (!has(cfg.profiles, name)) {
        throw new Fail(`no provider named ${name}; dsk provider list shows them`);
    }
    if (args.action === 'rename') {
        const next = String(args.new || '').trim();
        if (!FULL_PROVIDER_NAME.test(next)) {
            throw new Fail(`${quoted(next)}: a name is lower-case letters, digits, - and _, starting with a letter, at most 32`);
        }
        if (next === name) {
            print(`dsk · ${name} · nothing to change`);
            return 0;
        }
        if (has(cfg.profiles, next)) {
            throw new Fail(`there is already a provider named ${next}`);
        }
        const renamed = renamedOf(user);
        const moved = {};
        for (const [old, was] of Object.entries(renamed)) {
            if (old !== next)
                moved[old] = was === name ? next : was;
        }
        moved[name] = next; // an alias for the jobs running under the old name, and the rename of a built-in one
        const kept = {};
        for (const [old, was] of Object.entries(moved))
            if (old !== was)
                kept[old] = was;
        user.renamed = kept;
        if (has(profiles, name)) {
            const profile = profiles[name];
            delete profiles[name];
            profiles[next] = profile;
        }
        if (has(user, 'route'))
            user.route = user.route.map((n) => (n === name ? next : n));
        writeKept(file, configJson(user) + '\n');
        print(`dsk · renamed ${name} to ${next}; its key stays in ${cfg.profiles[name].key_env}`);
        return 0;
    }
    if (args.action === 'remove') {
        const origin = builtIn(cfg, name);
        if (origin === 'plugin') {
            throw new Fail(`${name} is the plugin's custom endpoint, set in /plugin configure; it cannot be removed here, `
                + `only disabled: dsk provider disable ${name}`);
        }
        if (origin) {
            throw new Fail(`${name} is built into dsk; it cannot be removed, only disabled: dsk provider disable ${name}`);
        }
        if (route.includes(name) && !route.some((n) => n !== name && has(cfg.profiles, n))) {
            throw new Fail(`${name} is the only enabled provider; enable or add another first`);
        }
        const busy = runningOn(name);
        if (busy.length) {
            throw new Fail(`${name} is in use by the running ${busy.length > 1 ? 'jobs' : 'job'} ${busy.join(', ')}; `
                + `remove it once ${busy.length > 1 ? 'they' : 'it'} stopped`);
        }
        const key_env = get(cfg.profiles[name], 'key_env', '');
        const users = Object.entries(cfg.profiles)
            .filter(([n, p]) => n !== name && get(p, 'key_env') === key_env).map(([n]) => n);
        const why = users.length ? `${users.join(', ')} ${users.length > 1 ? 'use' : 'uses'} it too`
            : key_env === cfg.search.key_env ? 'web search uses it'
                : has(OPTION_KEYS, key_env) ? "the plugin's options hold it"
                    : !/^DSK_[A-Z0-9_]+_API_KEY$/.test(key_env) ? 'dsk did not name it, so it may serve more than dsk'
                        : '';
        delete profiles[name];
        if (route.includes(name))
            user.route = route.filter((n) => n !== name);
        const renamed = renamedOf(user);
        const kept = {};
        for (const [old, was] of Object.entries(renamed))
            if (was !== name)
                kept[old] = was; // its old names are free again
        if (Object.keys(kept).length)
            user.renamed = kept;
        else
            delete user.renamed;
        writeKept(file, configJson(user) + '\n'); // the config first: a key left behind is harmless
        let extra = '';
        if (!key_env) {
            extra = '';
        }
        else if (why) {
            extra = ` · its key stays in ${key_env}: ${why}`;
        }
        else {
            extra = ` · its key ${key_env} ` + {
                "gone": 'is deleted from ~/.config/dsk/env',
                "mixed": 'stays: a line of ~/.config/dsk/env sets it with other variables; take it out by hand',
                "": 'was not in ~/.config/dsk/env',
            }[dropKey(key_env)];
            if (process.env[key_env])
                extra += '; it is still set in your environment';
        }
        print(`dsk · removed ${name} · route: ${(has(user, 'route') ? user.route : route).join(' → ')}${extra}`);
        return 0;
    }
    if (args.action === 'up') {
        const up = [...cfg.route];
        if (!up.includes(name))
            throw new Fail(`${name} is disabled; enable it first`);
        const at = up.indexOf(name);
        if (at === 0) {
            print(`dsk · ${name} is already tried first`);
            return 0;
        }
        ;
        [up[at - 1], up[at]] = [up[at], up[at - 1]];
        user.route = up;
        const own = ownOrder(cfg, user);
        writeKept(file, configJson(user) + '\n');
        print(`dsk · ${name} moved up · route: ${up.join(' → ')}${own}`);
        return 0;
    }
    if (args.action === 'move') {
        const whole = [...cfg.route];
        const known = whole.filter((n) => has(cfg.profiles, n));
        if (!known.includes(name))
            throw new Fail(`${name} is disabled; enable it first`);
        // int(args.new) in dsk.py: a whole number, else 0, which the range check below refuses
        let to = /^\s*[+-]?\d+\s*$/.test(String(args.new ?? '')) ? parseInt(String(args.new), 10) : 0;
        if (!(1 <= to && to <= known.length)) {
            throw new Fail(`provider move needs the place, from 1 to ${known.length}, as in: dsk provider move ${name} 1`);
        }
        if (known.indexOf(name) === to - 1) {
            print(`dsk · ${name} is already tried ${ordinal(to)}`);
            return 0;
        }
        known.splice(known.indexOf(name), 1);
        known.splice(to - 1, 0, name);
        const order = known[Symbol.iterator](); // a name on the route that has no profile keeps its place
        user.route = whole.map((n) => (has(cfg.profiles, n) ? order.next().value : n));
        const own = ownOrder(cfg, user);
        writeKept(file, configJson(user) + '\n');
        print(`dsk · ${name} is now tried ${ordinal(to)} · route: ${user.route.join(' → ')}${own}`);
        return 0;
    }
    if (args.action === 'set') {
        checkEndpoint(args.url, args.model);
        const key = readKey(args);
        const own = get(profiles, name);
        const profile = { ...(own && Object.keys(own).length ? own : cfg.profiles[name]) }; // a profile in config.json replaces the built-in whole
        const values = [
            ['base_url', args.url ? stripSlash(args.url) : null],
            ['model', args.model === undefined ? null : args.model],
        ];
        const changed = values.filter(([field, value]) => value !== null && profile[field] !== value).map(([field]) => field);
        for (const [field, value] of values) {
            if (value !== null)
                profile[field] = value;
        }
        if (key !== null) {
            setKey(profile.key_env, key);
            changed.push('key');
            if (process.env[profile.key_env]) {
                print(`note: ${profile.key_env} is also set in the environment, which wins over ~/.config/dsk/env`);
            }
        }
        if (changed.some((f) => f !== 'key')) {
            profiles[name] = profile;
            writeKept(file, configJson(user) + '\n');
        }
        print(`dsk · ${name} · ` + (changed.length ? `changed ${changed.join(', ')}` : 'nothing to change'));
        return 0;
    }
    const enabled = route.includes(name);
    if (args.action === 'disable') {
        if (!enabled) {
            print(`dsk · ${name} is already disabled`);
            return 0;
        }
        if (route.filter((n) => n !== name && has(cfg.profiles, n)).length === 0) {
            throw new Fail(`${name} is the only enabled provider; enable or add another first`);
        }
        user.route = route.filter((n) => n !== name);
    }
    else if (enabled) {
        print(`dsk · ${name} is already enabled`);
        return 0;
    }
    else {
        user.route = placed(cfg, route, name);
    }
    writeKept(file, configJson(user) + '\n');
    const search = args.action === 'disable' && isOfficial(cfg, name) ? ' · it still serves web search' : '';
    print(`dsk · ${name} ${args.action}d · route: ${user.route.join(' → ')}${search}`);
    return 0;
}
export async function cmdWeb(args, cfg) {
    const [status, data] = await webTool(cfg, args.command, args.target, get(args, 'count', 5));
    if (status !== 200) {
        throw new Fail(`${args.command}: HTTP ${status} ${typeof data === 'string' ? data : dumps(data)}`);
    }
    if (args.command === 'fetch') {
        print(`# ${get(data, 'title', '')}\n\n${get(data, 'content', '')}`);
    }
    for (const [n, r] of get(data, 'results', []).entries()) {
        print(`${n + 1}. ${get(r, 'title') ?? 'None'}\n   ${get(r, 'url') ?? 'None'} · ${get(r, 'date') || 'undated'}\n   ${get(r, 'summary') ?? 'None'}`);
    }
    return 0;
}
/** Per profile: key, model, thinking-off, well-formed replies over a three-turn exchange, cache reporting. */
export async function cmdDoctor(args, cfg) {
    let healthy = true;
    const filler = Array.from({ length: 110 }, (_, n) => `filler line ${n}: the quick brown fox jumps over the lazy dog`).join('\n');
    const task = ('This is a connection test in three steps, one per reply. Step 1: print(1). Step 2: print(2). '
        + `Step 3: call done('ok'). Ignore the filler below.\n` + filler);
    const names = args.profile ? [args.profile] : [...new Set([...cfg.route, ...Object.keys(cfg.profiles)])];
    for (const name of names) {
        if (!has(cfg.profiles, name))
            throw new Fail(`unknown profile ${name}`);
        const profile = cfg.profiles[name];
        print(`dsk doctor · ${name} · ${profile.base_url} · ${profile.model}`);
        if (!secret(profile.key_env)) {
            healthy = false;
            print(`key:      ${profile.key_env} is not set`);
            continue;
        }
        if (!claimSlot(cfg, name)) { // runs hold all of its max_sessions slots: a test request would be one too many
            print(`slots:    all ${pool(cfg, name)[1]} in use by running jobs, so it was not checked; `
                + `run dsk doctor --profile ${name} when they finish`);
            continue;
        }
        const url = stripSlash(profile.base_url) + '/chat/completions', key = apiKey(profile);
        const sent = headers(profile, 'dsk-doctor-' + tokenHex(4)); // one value for all five requests
        const msgs = [{ "role": "system", "content": SYSTEM }, { "role": "user", "content": task }];
        let good = 0, thought = 0, field = 'not reported', hits = [];
        let stream = 'no, the provider answers in JSON'; // whether the reply came as events, from the first request
        let broke = false;
        for (let step = 0; step < 5; step++) { // the same request three times a few seconds apart, then two that extend it
            const [status, data] = await post(url, key, requestBody(profile, 'off', msgs), cfg.backoff, sent);
            if (status !== 200) {
                healthy = false;
                print(`model:    HTTP ${status} ${typeof data === 'string' ? data : dumps(data)}`);
                broke = true;
                break;
            }
            if (step === 0 && data._stream && data._first != null) {
                stream = `yes, first data after ${fixed(data._first, 1)}s`;
            }
            const usage = data.usage || {}, reply = replayable(data.choices[0].message, 'off');
            field = has(usage, 'prompt_cache_hit_tokens') ? 'prompt_cache_hit_tokens'
                : has(get(usage, 'prompt_tokens_details') || {}, 'cached_tokens') ? 'prompt_tokens_details.cached_tokens' : field;
            const hit = has(usage, 'prompt_cache_hit_tokens') ? usage.prompt_cache_hit_tokens
                : get(get(usage, 'prompt_tokens_details') || {}, 'cached_tokens');
            hits.push(`${hit === null || hit === undefined ? '?' : hit}/${get(usage, 'prompt_tokens', '?')}`);
            thought += get(get(usage, 'completion_tokens_details') || {}, 'reasoning_tokens') || 0;
            good += parse(reply) !== null ? 1 : 0;
            if (step < 2) {
                await sleep(3);
            }
            else if (reply.tool_calls) {
                msgs.push(reply, { "role": "tool", "tool_call_id": reply.tool_calls[0].id,
                    "content": `turn ${step - 1} · ${13 - step} left\noutput:\n${step - 1}` });
            }
        }
        if (!broke) {
            const cached = field !== 'not reported' && !hits[2].startsWith('0/');
            healthy = healthy && good === 5 && !thought;
            print(`key:      ${profile.key_env} works, model accepted`);
            print('thinking: ' + (thought ? `NOT off: ${thought} reasoning tokens. Put this provider's switch in profiles.${name}.extra`
                : 'off is honoured'));
            print(`replies:  ${good} of 5 are one well-formed run_code call`);
            print(`stream:   ${stream}`);
            print(`cache:    ${field} · same request three times: ${hits.slice(0, 3).join(', ')} · extended: ${hits.slice(3).join(', ')}`);
            print('settings: ' + (cached ? `caching works, compact_at ${get(profile, 'compact_at', 32000)} is fine`
                : 'no cache hits seen, so every turn is billed in full: set compact_at to 24000 or lower'));
        }
        release(cfg, name);
    }
    const block = cfg.search;
    if (secret(block.key_env)) {
        const [status, data] = await webTool(cfg, 'search', 'DeepSeek API documentation', 1);
        print('search:   ' + (status === 200 ? 'works' : `HTTP ${status} ${typeof data === 'string' ? data : dumps(data)}`));
    }
    else {
        print(`search:   ${block.key_env} is not set, so --web is unavailable`);
    }
    return healthy ? 0 : 1;
}
