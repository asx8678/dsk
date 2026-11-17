// The config: the user's file, the plugin's form, the keys, and the slots that cap how many requests each provider
// serves at once.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
import { Fail, Interrupted, STATE, flock, get, has, shlexSplit, xdg, isDict, truthy } from './base.js';
import { DEFAULTS, OPTION_KEYS, SETUP } from './texts.js';
/** d[key], as Python read a dict: a missing key or a non-object raises, as KeyError or TypeError did. */
function item(d, key) {
    if (!isDict(d) || !has(d, key))
        throw new TypeError(`config has no ${key}`);
    return d[key];
}
/** d[key] = value, as Python wrote a dict: an own property even when the key is `__proto__` or `constructor`. */
function defineKey(d, key, value) {
    Object.defineProperty(d, key, { value, writable: true, enumerable: true, configurable: true });
}
/** dict.update(source): every own key of source, defined as defineKey did, so `__proto__` stays a key. */
function updateDict(target, source) {
    if (!isDict(source))
        throw new TypeError('dict.update() needs a dict');
    for (const key of Object.keys(source))
        defineKey(target, key, source[key]);
}
/** dict.clear(). */
function clearDict(d) {
    for (const key of Object.keys(d))
        delete d[key];
}
/** Python's int(value), for the whole numbers a configuration holds. */
function pyInt(value) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n))
        throw new TypeError(`invalid int: ${value}`);
    return n;
}
/** What the plugin's hooks last stored (`dsk configure --hook`): its options, the path of the file that holds
 * them, or its id. Empty when there is none. ~/.config/dsk/plugin.json only points at the options, which live in
 * the plugin's own data folder and go with it. */
export function plugin(part = 'options') {
    try {
        const pointer = JSON.parse(fs.readFileSync(path.join(xdg('XDG_CONFIG_HOME', '~/.config'), 'plugin.json'), 'utf8'));
        if (part === 'id')
            return item(pointer, 'id');
        const file = item(pointer, 'options');
        if (part === 'path')
            return typeof file === 'string' ? file : '';
        if (typeof file !== 'string')
            throw new TypeError('options is not a path');
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
        return get({ options: {}, path: '' }, part, 'dsk@<its marketplace>');
    }
}
/** Built-in defaults, then the plugin's options, then ~/.config/dsk/config.json. It names key variables, never keys. */
export function config() {
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    const opts = plugin();
    if (truthy(get(opts, 'custom_base_url')) && truthy(get(opts, 'custom_model'))) { // the plugin's `custom`: any OpenAI-compatible endpoint
        defineKey(item(cfg, 'profiles'), 'custom', {
            base_url: get(opts, 'custom_base_url'),
            key_env: 'DSK_CUSTOM_API_KEY',
            model: get(opts, 'custom_model'),
            compact_at: 24000,
            extra: {},
        });
        if (get(opts, 'provider') === 'custom')
            cfg.route = ['custom']; // every run goes to the custom endpoint; a DeepSeek key serves web search only
    }
    const file = path.join(xdg('XDG_CONFIG_HOME', '~/.config'), 'config.json');
    if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        let user;
        try {
            user = JSON.parse(text);
        }
        catch (e) {
            throw new Fail(`${file}: ${e.message}`);
        }
        // renamed: {old name: current name}, written by `dsk provider rename`. It renames a built-in or the plugin's
        // profile, which would otherwise come back under its first name, and lets a job started under an old name go on.
        const renamedValue = get(user, 'renamed');
        const renamed = isDict(renamedValue) ? renamedValue : {};
        if (isDict(renamedValue))
            delete user.renamed;
        const profiles = item(cfg, 'profiles');
        for (const [old, now] of Object.entries(renamed)) {
            const name = String(now);
            if (has(profiles, old) && !has(profiles, name)) {
                defineKey(profiles, name, profiles[old]);
                delete profiles[old];
            }
        }
        for (const nested of ['profiles', 'limits']) {
            let part = {};
            if (has(user, nested)) {
                part = user[nested];
                delete user[nested];
            }
            updateDict(item(cfg, nested), part);
        }
        updateDict(cfg, user);
        cfg.route = [...new Set([...item(cfg, 'route')].map((n) => has(profiles, n) ? n : get(renamed, n, n)))];
        clearDict(ALIASES);
        for (const [old, now] of Object.entries(renamed)) {
            const name = String(now);
            if (!has(profiles, old) && has(profiles, name))
                defineKey(ALIASES, old, name);
        }
    }
    return cfg;
}
/** A key from the environment, else from ~/.config/dsk/env (lines like `export NAME='value'`), else from the
 * plugin's options, else "". A key read from a file never enters os.environ, so it cannot reach scripts, sh() or checks. */
export function secret(name) {
    const fromEnv = process.env[String(name)];
    if (fromEnv)
        return fromEnv;
    let words = [];
    try {
        const text = fs.readFileSync(path.join(xdg('XDG_CONFIG_HOME', '~/.config'), 'env'), 'utf8');
        for (const line of text.split(/\r\n|\r|\n/))
            words.push(...shlexSplit(line, true));
    }
    catch (e) {
        if (e instanceof Interrupted)
            throw e;
        words = [];
    }
    const prefix = String(name) + '=';
    const found = words.filter((w) => w.startsWith(prefix)).map((w) => w.slice(w.indexOf('=') + 1));
    if (found.length)
        return found[found.length - 1];
    const opts = plugin();
    const optionKey = get(OPTION_KEYS, String(name), null);
    const value = optionKey === null ? '' : get(opts, String(optionKey), '');
    return truthy(value) ? value : '';
}
/** The block's key, or Fail when no place holds one. */
export function apiKey(block) {
    const key = secret(item(block, 'key_env'));
    if (!truthy(key)) {
        throw new Fail(`${item(block, 'key_env')} is not set. In Claude Code, run /plugin configure ${plugin('id')} and ${SETUP}; or export it in ~/.config/dsk/env`);
    }
    return key;
}
/** The key for the official search and fetch tools, with its own message when the key that only they need is missing. */
export function searchKey(cfg) {
    const block = item(cfg, 'search');
    const key = secret(item(block, 'key_env'));
    if (!truthy(key)) {
        throw new Fail(`web search needs the key ${item(block, 'key_env')} and there is none, so --web, \`dsk search\` and \`dsk fetch\` are unavailable. To add it, run /plugin configure ${plugin('id')} in Claude Code and enter a DeepSeek API key, or export ${item(block, 'key_env')} in ~/.config/dsk/env`);
    }
    return key;
}
/** (Whether the first provider on the route has its key, and what stands in the way or which provider it is.) */
export function setup(cfg) {
    const opts = plugin(), first = item(cfg, 'route')[0];
    const profile = get(get(cfg, 'profiles', {}), first, {});
    if (truthy(secret(get(profile, 'key_env', '') ?? '')))
        return [true, `${first} · ${item(profile, 'base_url')} · ${item(profile, 'model')}`];
    const need = [['custom_base_url', 'endpoint URL'], ['custom_model', 'model name'], ['custom_api_key', 'API key']]
        .filter(([field]) => !truthy(get(opts, field))).map(([, label]) => label);
    if (get(opts, 'provider') === 'custom' && need.length)
        return [false, 'provider custom still needs its ' + need.join(', ')];
    const key = get(profile, 'key_env', first);
    return [false, key === 'DEEPSEEK_API_KEY' ? 'it has no DeepSeek API key' : `${key} is not set`];
}
/** (The slot file prefix, the limit) of profile `name`. Profiles that reach the same endpoint with the same key
 * share one set of slots, under the first one's name, limited by the smallest max_sessions any of them sets. */
export function pool(cfg, name) {
    const profiles = item(cfg, 'profiles');
    const reach = (p) => [item(p, 'base_url').replace(/\/+$/, ''), get(p, 'key_env') ?? null];
    const target = reach(item(profiles, name));
    const same = Object.keys(profiles).filter((k) => {
        const [base, key] = reach(item(profiles, k));
        return base === target[0] && key === target[1];
    });
    const limits = [];
    for (const k of same) {
        const max = get(item(profiles, k), 'max_sessions');
        if (truthy(max))
            limits.push(pyInt(max));
    }
    return [path.join(STATE, 'slots', same[0]), limits.length ? Math.min(...limits) : null];
}
/** Hold one of profile `name`'s max_sessions slots until this process exits. True if it has no limit. */
export function claimSlot(cfg, name) {
    const [key, limit] = pool(cfg, name);
    if (!limit || has(slots, key))
        return true;
    fs.mkdirSync(path.dirname(key), { recursive: true });
    for (let n = 0; n < pyInt(limit); n++) {
        try {
            defineKey(slots, key, flock(`${key}.${n}`, ''));
            return true;
        }
        catch (e) {
            if (!(e instanceof Fail))
                throw e;
        }
    }
    return false;
}
/** A renamed provider's old name -> its name now, filled by config(). */
export const ALIASES = {};
/** STATE/slots/<profile> -> this process's lock on one of that profile's max_sessions slots. */
export const slots = {};
