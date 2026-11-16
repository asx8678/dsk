// The wire: request bodies, streaming replies, retries, failover to the next provider, and the pauses a used-up
// credit or a rate limit sets.
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
import { PyFloat, Fail, Interrupted, STATE, checkInterrupt, cpHead, cpLen, dumps, fingerprint, get, has, now, onInterrupt, pyFloat, pyJson, sleep } from './base.js';
import { compact } from './compaction.js';
import { ALIASES, apiKey, claimSlot, pool, slots } from './config.js';
import { MAX_TOKENS, NOT_SPENT, SLOT_POLL, SLOW, SPENT, TOOLS } from './texts.js';
import { retries, transient } from './retry.js';
/** Whether a parsed JSON value is a dict, as Python's isinstance(value, dict) asked. */
function isDict(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Python's repr of a string, for str() of a dict that came from an error body. */
function pyRepr(text) {
    if (!text.includes("'"))
        return "'" + text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
    if (!text.includes('"'))
        return '"' + text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
    return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
}
/** Python's bool() of a JSON-decoded value: empty strings, lists and dicts are false. */
function pyTruthy(value) {
    if (value === null || value === undefined || value === false || value === 0 || value === '')
        return false;
    if (Array.isArray(value))
        return value.length > 0;
    if (isDict(value))
        return Object.keys(value).length > 0;
    return true;
}
/** str() of a value as Python printed a JSON-decoded one: dicts with single quotes, None and booleans by name. */
function pyStr(value) {
    if (value === null || value === undefined)
        return 'None';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'boolean')
        return value ? 'True' : 'False';
    if (typeof value === 'number')
        return Number.isInteger(value) ? String(value) : pyFloat(value);
    if (Array.isArray(value))
        return '[' + value.map(pyStr).join(', ') + ']';
    if (typeof value === 'object') {
        return '{' + Object.keys(value).map((k) => pyRepr(k) + ': ' + pyStr(value[k])).join(', ') + '}';
    }
    return String(value);
}
/** The last `n`-code-point prefix of `text`, as Python's wire[:prev["n"]] took it. */
function joined(parts) {
    for (const part of parts) {
        if (typeof part !== 'string')
            throw new TypeError('sequence item: expected str instance');
    }
    return parts.join('');
}
/** One non-exported value of a dict with a required key, raising as Python's c["key"] did. */
function need(value, key) {
    if (!isDict(value) || !has(value, key))
        throw new TypeError(`missing key ${key}`);
    return value[key];
}
/** The message records of the current series. Compaction restarts the list; failover does not. */
export function seriesMsgs(recs) {
    let start = -1;
    recs.forEach((r, i) => { if (r.t === 'series' && r.why !== 'failover')
        start = i; });
    if (start < 0)
        throw new Error('max() arg is an empty sequence');
    return recs.slice(start).filter((r) => r.t === 'msg');
}
export function messages(recs) {
    return seriesMsgs(recs).map((r) => r.m);
}
/** The only place a chat request is serialized: fixed key order, one static tool, nothing volatile. `heat` is */
export function requestBody(profile, effort, msgs, heat = 0, tools = true, maxTokens = null) {
    const body = {
        model: profile.model, messages: msgs, tools: tools ? TOOLS : null,
        max_tokens: maxTokens || MAX_TOKENS[effort], stream: true, stream_options: { include_usage: true },
    };
    if (effort === 'off') {
        Object.assign(body, {
            tool_choice: tools ? 'required' : null, thinking: { type: 'disabled' },
            // HEAT is (0, 0.7, 1.0) in dsk.py: its 1.0 is a float there, and the request says 1.0, not 1.
            reasoning_effort: 'none', temperature: heat === 1 ? new PyFloat(1) : heat,
        });
    }
    else {
        Object.assign(body, {
            tool_choice: tools ? 'auto' : null, thinking: { type: 'enabled' }, reasoning_effort: effort,
        });
    }
    Object.assign(body, get(profile, 'extra', {}));
    if (body.stream === false)
        delete body.stream_options;
    const filtered = {};
    for (const k of Object.keys(body))
        if (body[k] !== null)
            filtered[k] = body[k];
    return dumps(filtered);
}
/** The value of a response header, as email.message's get_content_type() read it. */
function contentType(res) {
    const raw = res.headers['content-type'];
    if (raw === undefined)
        return 'text/plain';
    const value = Array.isArray(raw) ? raw[0] : raw;
    const ctype = String(value).split(';')[0].toLowerCase();
    return ctype || 'text/plain';
}
/** Read a whole response body. */
async function readAll(stream) {
    const chunks = [];
    for await (const chunk of stream)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}
/** A callback that fires when the socket has been idle for `ms` milliseconds. */
function timeoutError() {
    const error = new Error('timed out');
    error.code = 'ETIMEDOUT';
    return error;
}
/** One HTTP POST, resolved with the response as soon as its headers arrive; `off` releases the signal handler. */
function request(url, payload, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        // Loaded here, not at the top: only a command that talks to a provider needs them, and an ESM import of
        // node:http also loads undici and http2 (60 internal modules, about 10 ms) for every other command.
        const mod = process.getBuiltinModule(target.protocol === 'https:' ? 'node:https' : 'node:http');
        let response = null;
        let req;
        const off = onInterrupt(() => {
            if (response)
                response.interrupted = true;
            req.destroy(new Interrupted());
        });
        // The `timeout` option, not req.setTimeout(): it is set on the socket before it connects, so a connection that
        // never opens fails after the same time a silent one does, as Python's socket timeout did. setTimeout() starts
        // only once the socket has connected, and a blackholed address then waited for the system's own limit.
        req = mod.request(target, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
            response = res;
            res.timedOut = false;
            resolve({ status: res.statusCode || 0, res, off });
        });
        req.on('timeout', () => {
            if (response)
                response.timedOut = true;
            req.destroy(timeoutError());
        });
        req.on('error', (error) => { off(); reject(error); });
        req.end(payload);
    });
}
/** The type name Python's except clause printed for a network or parsing failure. */
function errorName(error) {
    const code = error && error.code;
    if (code === 'ETIMEDOUT')
        return 'TimeoutError';
    if (code === 'ECONNRESET' || code === 'EPIPE')
        return 'ConnectionResetError';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
        return 'URLError';
    if (error instanceof SyntaxError)
        return 'JSONDecodeError';
    if (error instanceof TypeError)
        return 'TypeError';
    return (error && error.name) || 'Error';
}
/** A network failure as send() reported it. */
function errorText(error) {
    const name = errorName(error);
    const message = error && error.message !== undefined ? String(error.message) : String(error);
    return name === 'URLError' ? `${name}: <urlopen error ${message}>` : `${name}: ${message}`;
}
/** One POST. Returns (status, parsed JSON) on success, else (status, error text); status 0 is a network failure. */
export async function send(url, key, payload, extra = null, timeout = 600, idle = null, deadline = null) {
    const headers = {
        Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'dsk', ...(extra || {}),
    };
    const began = now();
    const streaming = JSON.parse(payload).stream === true;
    const timeoutMs = Math.min(timeout, streaming && idle ? idle : timeout) * 1000;
    let got;
    try {
        got = await request(url, payload, headers, timeoutMs);
        try {
            if (got.status >= 200 && got.status < 300) {
                if (contentType(got.res) !== 'text/event-stream') {
                    const body = await readAll(got.res);
                    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
                    return [got.status, JSON.parse(text)];
                }
                const reply = await sse(got.res, began, deadline);
                return Array.isArray(reply) ? reply : [got.status, reply];
            }
        }
        finally {
            got.off();
        }
    }
    catch (error) {
        if (error instanceof Interrupted || (got && got.res.interrupted))
            throw new Interrupted();
        if (got && got.res.timedOut)
            return [0, errorText(timeoutError())];
        return [0, errorText(error)];
    }
    // Read an HTTP error's body outside the network catch: as in Python, a failure here is not an HTTP status.
    try {
        const text = (await readAll(got.res)).toString('utf8').replace(/\s+/g, ' ').trim();
        return [got.status, cpHead(text, 300)];
    }
    catch (error) {
        if (error instanceof Interrupted || got.res.interrupted)
            throw new Interrupted();
        throw error;
    }
    finally {
        got.off();
    }
}
/** Split a response into lines, decoding each as strict UTF-8, like iterating over http.client's response. */
async function* lines(stream) {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let buffer = Buffer.alloc(0);
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
        let newline;
        while ((newline = buffer.indexOf(10)) >= 0) {
            yield decoder.decode(buffer.subarray(0, newline));
            buffer = buffer.subarray(newline + 1);
        }
    }
    if (buffer.length)
        yield decoder.decode(buffer);
}
/** The reply a JSON response would carry, rebuilt from a stream's events: joined text, calls by index, the last */
export async function sse(r, began, deadline) {
    const content = [];
    const thoughts = {};
    const calls = new Map();
    let usage = null;
    let first = null;
    let finish = null;
    let event = null;
    let cutShort = false;
    let done = false;
    for await (const raw of lines(r)) {
        checkInterrupt();
        const line = raw.trim();
        if (!line || line.startsWith(':'))
            continue;
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
            continue;
        }
        if (!line.startsWith('data:'))
            continue;
        const data = line.slice(5).trim();
        if (!data)
            continue;
        if (data === '[DONE]') {
            done = true;
            break;
        }
        const chunk = JSON.parse(data);
        if (first === null)
            first = now() - began;
        if (event === 'error' && !(isDict(chunk) && pyTruthy(chunk.error))) {
            return [502, cpHead(pyStr(chunk), 300)];
        }
        if (!isDict(chunk))
            return [0, 'not an event object: ' + cpHead(data, 200)];
        if (pyTruthy(chunk.error)) {
            const error = chunk.error;
            const code = isDict(error) ? error.code : null;
            const status = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
            return [status, cpHead(pyStr(error), 300)];
        }
        if (pyTruthy(chunk.usage))
            usage = chunk.usage;
        if (pyTruthy(chunk.choices))
            for (const choice of chunk.choices) {
                if (!isDict(choice))
                    throw new TypeError("'object' has no attribute 'get'");
                const delta = pyTruthy(choice.delta) ? choice.delta : (pyTruthy(choice.message) ? choice.message : {});
                if (!isDict(delta))
                    throw new TypeError("'object' has no attribute 'get'");
                content.push(pyTruthy(delta.content) ? delta.content : '');
                for (const field of ['reasoning_content', 'reasoning']) {
                    if (pyTruthy(delta[field])) {
                        if (!has(thoughts, field))
                            thoughts[field] = [];
                        thoughts[field].push(delta[field]);
                    }
                }
                const toolCalls = pyTruthy(delta.tool_calls) ? delta.tool_calls : [];
                if (!Array.isArray(toolCalls))
                    throw new TypeError("'object' is not iterable as calls");
                toolCalls.forEach((call, n) => {
                    if (!isDict(call))
                        throw new TypeError("'object' has no attribute 'get'");
                    const key = has(call, 'index') ? call.index : n;
                    let slot = calls.get(key);
                    if (!slot) {
                        slot = {};
                        calls.set(key, slot);
                    }
                    slot.id = pyTruthy(slot.id) ? slot.id : call.id;
                    slot.type = pyTruthy(slot.type) ? slot.type : (pyTruthy(call.type) ? call.type : 'function');
                    const fn = pyTruthy(call.function) ? call.function : {};
                    if (!isDict(fn))
                        throw new TypeError("'object' has no attribute 'get'");
                    slot.name = pyTruthy(slot.name) ? slot.name : fn.name;
                    slot.arguments = get(slot, 'arguments', '') + (pyTruthy(fn.arguments) ? fn.arguments : '');
                });
                finish = pyTruthy(choice.finish_reason) ? choice.finish_reason : finish;
            }
        if (deadline !== null && now() - began > deadline) {
            finish = 'length';
            cutShort = true;
            break;
        }
    }
    if (finish === null && !cutShort && !done)
        return [0, 'stream ended early'];
    const message = { role: 'assistant', content: joined(content) };
    for (const field of Object.keys(thoughts))
        message[field] = joined(thoughts[field]);
    if (calls.size) {
        const entries = [...calls.entries()].sort((a, b) => {
            if (typeof a[0] === 'number' && typeof b[0] === 'number')
                return a[0] - b[0];
            if (typeof a[0] === 'string' && typeof b[0] === 'string')
                return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
            throw new TypeError("'<' not supported between instances of different types");
        });
        message.tool_calls = entries.map(([, c]) => ({
            id: get(c, 'id'), type: get(c, 'type', 'function'),
            function: { name: get(c, 'name'), arguments: get(c, 'arguments', '') },
        }));
    }
    const reply = { choices: [{ message, finish_reason: finish }], usage: usage || {}, _stream: true };
    if (first !== null)
        reply._first = first;
    return reply;
}
// transient() and the retry decision are lib/retry.ts's, whose laws gdp-wired proves.
export { transient } from './retry.js';
/** POST with backoff on transient failures. Every retry sends the identical bytes. When not `patient`, a */
export async function post(url, key, payload, backoff, headers = null, patient = true, idle = null, deadline = null) {
    for (const wait of [...backoff, null]) {
        const began = now();
        let [status, data] = await send(url, key, payload, headers, undefined, idle, deadline);
        if (status === 200 && has(data, 'choices') && get(data.choices[0], 'finish_reason') === 'insufficient_system_resource' || status === 200 && has(data, 'choices') && get(data.choices[0], 'finish_reason') === 'aborted') {
            status = 503;
            data = 'generation interrupted by the server';
        }
        if (status === 400 && pyStr(data).toLowerCase().includes('limit'))
            status = 429;
        if (!retries(status, spent(status, data), wait === null, Boolean(patient), now() - began > SLOW)) {
            return [status, data];
        }
        await sleep(wait);
    }
}
/** The profile's `headers`, with {session} replaced by a value that stays the same for the whole run. */
export function headers(profile, session) {
    const out = {};
    for (const [k, v] of Object.entries(get(profile, 'headers', {}) || {})) {
        out[k] = String(v).replaceAll('{session}', session);
    }
    return out;
}
/** Whether an error says the provider's credit or quota is used up: not busy, not a request that is too big. */
export function spent(status, data) {
    const text = pyStr(data);
    return status === 402 || ([400, 403, 429].includes(status) && SPENT.test(text) && !NOT_SPENT.test(text));
}
/** Until when (epoch seconds) every run skips profile `name` because its credit ran out; 0 when it does not. */
export function paused(name) {
    try {
        const state = JSON.parse(fs.readFileSync(path.join(STATE, 'paused', name), 'utf8'));
        const until = Number(state.until);
        return until > now() ? until : 0;
    }
    catch (error) {
        if (error instanceof Interrupted)
            throw error;
        return 0;
    }
}
/** Python's json.dump() for the pause file: the default ensure_ascii escapes every non-ASCII code unit. */
function pyJsonAscii(value) {
    return pyJson(value).replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}
/** Pause `name` until the reset time its error names, if within a week, else for its `pause_hours` (default 1). */
export function pause(cfg, name, data) {
    const nowSeconds = now();
    const named = /\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z/.exec(pyStr(data));
    let reset = 0;
    if (named) {
        const milliseconds = Date.parse(named[0].slice(0, -1) + '+00:00');
        if (Number.isNaN(milliseconds))
            throw new Error(`Invalid isoformat string: '${named[0]}'`);
        reset = milliseconds / 1000;
    }
    const hours = Number(get(get(cfg.profiles, name, {}), 'pause_hours', 1));
    const until = nowSeconds < reset && reset < nowSeconds + 7 * 86400 ? reset : nowSeconds + 3600 * hours;
    const file = path.join(STATE, 'paused', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}`;
    fs.writeFileSync(temp, pyJsonAscii({ until, why: cpHead(pyStr(data), 300) }), 'utf8');
    fs.renameSync(temp, file);
}
/** The assistant message as it is logged and sent back: content, the calls, and reasoning when thinking is on. */
export function replayable(message, effort) {
    if (!isDict(message))
        throw new TypeError("'object' has no attribute 'get'");
    const reply = { role: 'assistant', content: pyTruthy(message.content) ? message.content : '' };
    const thought = pyTruthy(message.reasoning_content) ? message.reasoning_content : message.reasoning;
    if (pyTruthy(thought) && effort !== 'off')
        reply.reasoning_content = thought;
    if (pyTruthy(message.tool_calls)) {
        reply.tool_calls = message.tool_calls.map((c) => ({
            id: need(c, 'id'), type: 'function',
            function: { name: need(need(c, 'function'), 'name'), arguments: need(c.function, 'arguments') },
        }));
    }
    return reply;
}
/** The profiles a session may still move to: the rest of its route, less any removed since it started (`dsk */
export function laterProfiles(s, cfg) {
    const route = s.head.route.map((n) => get(ALIASES, n, n));
    const moved = [...s.of('series')].reverse().find((r) => r.why === 'failover') || null;
    if (!route.includes(s.profile) || (moved && get(moved, 'status') === 'chosen'))
        return [];
    return route.slice(route.indexOf(s.profile) + 1).filter((n) => has(cfg.profiles, n));
}
/** Send the current series and return (assistant message, finish_reason). Fails over along the route. */
export async function chat(s, cfg, heat = 0) {
    while (true) {
        compact(s, cfg);
        const name = s.profile;
        const profile = cfg.profiles[name];
        const later = laterProfiles(s, cfg);
        if (later.length && paused(name)) {
            release(cfg, name);
            s.add('series', { why: 'failover', profile: later[0], status: 'paused' });
            continue;
        }
        if (!claimSlot(cfg, name)) {
            if (later.length) {
                s.add('series', { why: 'failover', profile: later[0], status: 'full' });
                continue;
            }
            while (!claimSlot(cfg, name))
                await sleep(SLOT_POLL);
        }
        const msgs = messages(s.recs);
        const wire = dumps(msgs).slice(0, -1);
        const prev = s.last('req', 'series');
        if (prev.t === 'req') {
            const print = fingerprint(cpHead(wire, prev.n));
            if (print.n !== prev.n || print.sha !== prev.sha) {
                throw new Fail('bug: this request does not extend the previous one in its series');
            }
        }
        const body = requestBody(profile, s.head.effort, msgs, heat);
        const key = apiKey(profile);
        s.add('req', { ...fingerprint(wire) });
        const session = `dsk-${s.id}-${fingerprint(dumps(s.head)).sha.slice(0, 8)}`;
        const [status, data] = await post(profile.base_url.replace(/\/+$/, '') + '/chat/completions', key, body, cfg.backoff, headers(profile, session), !later.length, cfg.limits.idle_seconds, cfg.limits.reply_seconds);
        if (status === 200) {
            let choice, usage, reply;
            try {
                choice = data.choices[0];
                usage = data.usage || {};
                reply = replayable(choice.message, s.head.effort);
            }
            catch (error) {
                if (error instanceof Interrupted)
                    throw error;
                throw new Fail(`${name}: unexpected response ${cpHead(pyStr(data), 200)}`);
            }
            if (get(choice, 'finish_reason') === 'content_filter') {
                throw new Fail(`${name}: the provider's content filter withheld the reply`);
            }
            const hit = get(usage, 'prompt_cache_hit_tokens', get(get(usage, 'prompt_tokens_details', null) || {}, 'cached_tokens'));
            s.add('usage', {
                turn: s.turn + 1, profile: name, prompt: get(usage, 'prompt_tokens') || Math.floor(cpLen(body) / 4),
                hit, out: get(usage, 'completion_tokens') || 0, first: get(data, '_first'),
            });
            let finish = get(choice, 'finish_reason');
            const cap = get(get(profile, 'extra', {}) || {}, 'max_tokens') || MAX_TOKENS[s.head.effort];
            if (finish === null && (get(usage, 'completion_tokens') || 0) >= cap)
                finish = 'length';
            return [reply, finish];
        }
        if (spent(status, data))
            pause(cfg, name, data);
        if (!later.length || (!transient(status) && !spent(status, data))) {
            throw new Fail(`${name}: HTTP ${status} ${pyStr(data)}`);
        }
        release(cfg, name);
        s.add('series', { why: 'failover', profile: later[0], status });
    }
}
/** Give back this process's max_sessions slot on profile `name`, if it holds one. */
export function release(cfg, name) {
    const key = pool(cfg, name)[0];
    const held = get(slots, key); // slots is a plain object, dsk.py's dict: pop(key, None)
    if (held) {
        delete slots[key];
        held.close();
    }
}
