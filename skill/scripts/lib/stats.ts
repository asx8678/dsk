// dsk status, dsk stats and dsk configure: what the sessions on disk say, measured from their logs.
const fs = process.getBuiltinModule('node:fs')
import type { BigIntStats } from 'node:fs'
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')
import { pySum, Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg, type Args, type Cfg, type Head, type Profile, type Rec } from './base.ts'
import { projectRoot } from './commands.ts'
import { config, plugin, secret, setup } from './config.ts'
import { roundLimit, scope } from './gates.ts'
import { cachedShare, kilo } from './reports.ts'
import { Session } from './session.ts'
import { fastOrder, speeds } from './speed.ts'
import { OPTIONS, SETUP } from './texts.ts'
import { mendLauncher } from './launcher.ts'
import { paused, spent } from './wire.ts'

/** The first line of a file, without reading the rest of it. */
function firstLine(file: string): string {
  const fd = fs.openSync(file, 'r')
  const chunks: Buffer[] = []
  try {
    for (;;) {
      const chunk = Buffer.alloc(65536)
      const n = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (!n) break
      const nl = chunk.subarray(0, n).indexOf(10)
      chunks.push(nl < 0 ? chunk.subarray(0, n) : chunk.subarray(0, nl))
      if (nl >= 0) break
    }
  } finally {
    fs.closeSync(fd)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Python's " ".join(text.split()): the words of a string, with runs of whitespace collapsed. */
function words(text: unknown): string {
  const s = String(text)
  return s.trim() ? s.trim().split(/\s+/).join(' ') : ''
}

/** Python's equality for JSON values; key order does not matter. */
function sameJSON(a: any, b: any): boolean {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b // a nanosecond mtime does not fit a JS number
  if (typeof a === 'bigint') return typeof b === 'number' && Number.isInteger(b) && a === BigInt(b)
  if (typeof b === 'bigint') return typeof a === 'number' && Number.isInteger(a) && BigInt(a) === b
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJSON(x, b[i]))
  }
  const ak = Object.keys(a), bk = Object.keys(b)
  return ak.length === bk.length && ak.every((k) => has(b, k) && sameJSON(a[k], b[k]))
}

/** Python's json.dumps defaults for the status cache: spaces, ASCII, floats as Python writes them, mtimes in full. */
function statusJSON(value: any): string {
  return pyJson(value, [', ', ': '], true)
}

/** Python's json.dumps defaults (spaces, ASCII) for the hook's JSON messages. */
function pyJSONAscii(value: any): string {
  return statusJSON(value)
}

/** `time.strftime('%a %H:%M', time.localtime(x))`, in the local time zone. */
function shortTime(x: number): string {
  const d = new Date(x * 1000), days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${days[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Python's `f"{text:<n}"`: pad on the right to n characters, never cutting a longer string. */
function ljust(text: string, n: number): string {
  return text + ' '.repeat(Math.max(0, n - cpLen(text)))
}

/** Read the status cache keeping each `key` number exact: a nanosecond mtime is too large for a JSON number. */
function readStatusCache(text: string): any {
  const marked = text.replace(/("key"\s*:\s*\[\s*)(-?\d+)(\s*,\s*)(-?\d+)(\s*\])/g,
    (_match: string, before: string, mtime: string, between: string, size: string, after: string) =>
      `${before}"${mtime}"${between}"${size}"${after}`)
  const old = JSON.parse(marked)
  for (const [sid, entry] of Object.entries(old)) {
    if (sid !== 'for' && entry && typeof entry === 'object' && Array.isArray((entry as any).key)) {
      (entry as any).key = (entry as any).key.map((x: any) => BigInt(x))
    }
  }
  return old
}

/** os.path.getmtime(): CPython makes the float as sec + nsec * 1e-9, which rounds otherwise than nanoseconds / 1e9. */
function mtime(file: string): number {
  const ns = fs.statSync(file, { bigint: true }).mtimeNs
  return Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) * 1e-9
}

/** os.listdir(): the names in the order the file system keeps them. fs.readdirSync() sorts them. */
function listdir(dir: string): string[] {
  const d = fs.opendirSync(dir)
  const names: string[] = []
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) names.push(e.name)
  } finally {
    d.closeSync()
  }
  return names
}

/** The sessions whose head satisfies `wanted`. Only the first line of the other logs is read. */
export function sessions(wanted: any): any {
  const found: Session[] = []
  const dirs = fs.existsSync(STATE) && fs.statSync(STATE).isDirectory() ? fs.readdirSync(STATE).sort() : []
  for (const sid of dirs) {
    let head: any
    try {
      head = JSON.parse(firstLine(path.join(STATE, sid, 'log.jsonl')) || '{}')
    } catch {
      continue // a lock file, or a session that is only just being created
    }
    if (get(head, 't') === 'head' && wanted(head)) {
      const s = new Session(sid)
      if (s.last('state')) found.push(s)
    }
  }
  return found
}

/** One session as plain data, for `status --json`: what a progress display needs. All of it is measured. */
export function job(s: Session, cfg: Cfg): any {
  const head: any = s.head, usage: any[] = s.of('usage'), status = s.status(), st: any = s.last('state') || {}, series: any[] = s.of('series')
  const at = Math.max(...s.recs.map((r: any, i: number) => (r.t === 'req' || r.t === 'state' ? i : -1)))
  const tail: any[] = s.recs.slice(at) // the turn in flight
  const acts: any[] = tail.filter((r) => r.t === 'ledger'), done: any[] = s.since('round', 'ledger')
  let checking = acts.some((r) => r.fn === 'done') && !tail.some((r) => r.t === 'checks')
  const last: any = [...tail].reverse().find((r) => ['doing', 'ledger', 'checks', 'result'].includes(r.t)) || { t: '' }
  checking = checking || !!last.review // the independent review runs after the checks
  const phase = !tail.some((r) => r.t === 'usage') ? 'model' : checking ? 'checks' : 'script'
  const prices = usage.map((u) => get(get(cfg.profiles, u.profile, {}), 'price'))
  const cost = !prices.every((p) => p) ? null : pySum(usage.map((u, i) => {  // sum() in dsk.py: compensated, so the digits match
    const p = prices[i]
    return ((u.prompt - (u.hit || 0)) * p.in + (u.hit || 0) * p.cached + u.out * p.out) / 1e6
  }))
  let failover = ''
  for (let i = series.length - 1; i > 0; i--) {
    const a = series[i - 1], b = series[i]
    if (b.why === 'failover' && b.status !== 'chosen') {
      failover = `${a.profile} ${b.status || 'network'}`
      break
    }
  }
  return { id: s.id, status, phase: status === 'running' ? phase : '', profile: s.profile,
    doing: last.t === 'doing' && status === 'running' ? cpHead(words(last.arg), 80) : '',
    failover, cost,
    turn: s.since('round', 'result').length, max_turns: roundLimit(s.recs), turns: s.turn,
    in: usage.reduce((n, u) => n + u.prompt, 0), out: usage.reduce((n, u) => n + u.out, 0), cached: cachedShare(usage),
    act: done.length && status === 'running' ? cpHead(words(`${done[done.length - 1].fn} ${done[done.length - 1].arg}`), 80) : '',
    step: done.length && status === 'running' ? done[done.length - 1].fn : '',
    note: cpHead(words(get(st, 'question') || get(st, 'why') || get(st, 'error') || ''), 160),
    changed: (get(st, 'changed') || []).length,
    brief: cpHead(words(get(scope(s), 'task') || head.brief), 300),
    owner: head.owner, root: head.root, worktree: head.worktree, created: head.created,
    active: mtime(s.path) }
}

/** The middle value, the lower of the two in the middle of an even count, and 0 when there is nothing to measure. */
export function median(values: any): any {
  const xs = [...values].sort((a, b) => a - b)
  return xs.length ? xs[Math.floor((xs.length - 1) / 2)] : 0
}

/** The 95th percentile by nearest rank, the lowest sample at or above 95% of them, and 0 with nothing to measure. */
export function p95(values: any): any {
  const xs = [...values].sort((a, b) => a - b)
  return xs.length ? xs[Math.max(0, Math.floor((xs.length * 95 + 99) / 100) - 1)] : 0
}

/** A whole-number percentage of `whole`, and 0 when there is nothing to be a share of. */
export function share(part: any, whole: any): any {
  return whole ? pyRound(part * 100 / whole) : 0
}

/** The same percentage, for a line that ends in it. */
export function percent(part: any, whole: any): any {
  return `${share(part, whole)}%`
}

/** A number of seconds to one decimal, without a pointless .0. */
export function duration(x: any): any {
  return fixed(pyRound(x, 1), 1).replace(/\.0$/, '')
}

/** What one turn did, from its result and that turn's ledger records: a failure, files, commands, a stop, reading. */
export function turnKind(result: any, acts: any): any {
  if (result.fail) return 'failed:' + result.fail
  const fns = new Set(acts.map((a: any) => a.fn))
  if (fns.has('write') || fns.has('edit')) return 'write'
  if (fns.has('sh')) return 'run'
  return [...fns].some((fn) => fn !== 'ask' && fn !== 'done') ? 'read' : 'stop'
}

/** One session as plain numbers for `dsk stats`, all of it measured from its log. Logs written before */
export function metrics(s: Session, cfg: Cfg): any {
  const head: any = s.head, usage: any[] = s.of('usage'), results: any[] = s.of('result'), series: any[] = s.of('series'), acts: any[] = s.of('ledger')
  const kindsList = results.map((r) => turnKind(r, acts.filter((a) => a.turn === r.turn)))
  const kinds: any = Object.create(null)
  for (const kind of kindsList) kinds[kind] = (has(kinds, kind) ? kinds[kind] : 0) + 1
  const prices = usage.map((u) => get(get(cfg.profiles, u.profile, {}), 'price'))
  const cost = !prices.every((p) => p) ? null : pySum(usage.map((u, i) => {  // sum() in dsk.py: compensated, so the digits match
    const p = prices[i]
    return ((u.prompt - (u.hit || 0)) * p.in + (u.hit || 0) * p.cached + u.out * p.out) / 1e6
  }))
  const stamped = s.recs.filter((r: any) => has(r, 'at')).map((r: any) => r.at)
  const reqs = s.recs.map((r: any, i: number) => (r.t === 'req' && has(r, 'at') ? i : -1)).filter((i: number) => i >= 0)
  let model = 0.0
  const speed: any = Object.create(null)
  reqs.forEach((i: number, n: number) => {
    const stop = n + 1 < reqs.length ? reqs[n + 1] : s.recs.length
    const answered: any = s.recs.slice(i + 1, stop).find((r: any) => r.t === 'usage' && has(r, 'at'))
    if (answered) { // a req the API never answered has no time of its own to measure
      const req: any = s.recs[i]
      const took = answered.at - req.at
      model += took
      const p = has(speed, answered.profile) ? speed[answered.profile] : (speed[answered.profile] = [0.0, 0])
      p[0] += took
      p[1] += 1
    }
  })
  const states: any[] = s.of('state')
  let waited = 0.0 // from each stop the lead had to answer to the run that answered it
  states.forEach((r, n) => {
    if (['review', 'question', 'stuck', 'limit', 'done'].includes(r.status) && has(r, 'at')) {
      const again = states.slice(n + 1).find((x) => x.status === 'running' && has(x, 'at'))
      waited += again ? again.at - r.at : 0
    }
  })
  return { id: s.id, root: head.root, owner: head.owner, worktree: head.worktree,
    effort: head.effort, web: head.web, created: head.created, status: s.status(),
    profiles: [...new Set(usage.map((u) => u.profile))], rounds: s.of('round').length,
    rejects: s.of('reject').length, continues: s.of('base').length,
    compactions: series.filter((r) => r.why === 'compact').length,
    failovers: series.slice(1).flatMap((b, i) => {
      const a = series[i]
      return b.why === 'failover' && b.status !== 'chosen' ? [`${a.profile} ${b.status || 'network'}`] : []
    }),
    turns: results.length, kinds,
    lead_in: kindsList.findIndex((kind) => kind !== 'read') < 0 ? kindsList.length : kindsList.findIndex((kind) => kind !== 'read'),
    cut: results.filter((r) => String(r.text).includes('characters cut here')).length,
    in: usage.reduce((n, u) => n + u.prompt, 0), out: usage.reduce((n, u) => n + u.out, 0),
    hit: usage.reduce((n, u) => n + (u.hit || 0), 0), cached: cachedShare(usage),
    max_out: usage.length ? Math.max(...usage.map((u) => u.out)) : 0, speed, cost,
    // a session that began before timestamps is stamped only at its end: its time is unknown, not zero
    seconds: has(head, 'at') ? pyRound(stamped[stamped.length - 1] - head.at, 1) : null,
    model_seconds: reqs.length ? pyRound(model, 1) : null,
    lead_seconds: has(head, 'at') ? pyRound(waited, 1) : null }
}

/** One line of the plain stats report: a label in a column ten characters wide. */
export function label(text: any, value: any): any {
  return `${ljust(text + ':', 10)} ${value}`
}

/** The plain `dsk stats` report, one line per label, over the sessions as (log, metrics) pairs. */
export function statsSummary(pairs: any): any {
  const ms = pairs.map((pair: any) => pair[1])
  const turns = ms.reduce((n: number, m: any) => n + m.turns, 0)
  const statuses: any = Object.create(null)
  for (const m of ms) statuses[m.status] = (has(statuses, m.status) ? statuses[m.status] : 0) + 1
  const byCount = Object.entries(statuses).sort((a: any, b: any) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const most = ms.reduce((a: any, b: any) => (b.turns > a.turns ? b : a))
  const lines = [label('sessions', `${ms.length} · ` + byCount.map(([status, n]) => `${status} ${n}`).join(' · ')),
    label('turns', `${turns} · median ${median(ms.map((m: any) => m.turns))} per session · ` +
      `most ${most.turns} (${most.id})`)]
  const kinds: any = Object.create(null)
  for (const m of ms) for (const [kind, n] of Object.entries(m.kinds)) kinds[kind] = (has(kinds, kind) ? kinds[kind] : 0) + Number(n)
  lines.push(label('kinds', Object.entries(kinds)
    .sort((a: any, b: any) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([kind, n]) => `${kind} ${percent(n, turns)}`).join(' · ')))
  const lead = ms.filter((m: any) => get(m.kinds, 'write')).map((m: any) => m.lead_in)
  lines.push(label('lead-in', `median ${median(lead)} read turns before the first change · ` +
    `${lead.filter((n: number) => n >= 5).length} sessions with 5 or more`))
  const cut = ms.reduce((n: number, m: any) => n + m.cut, 0)
  lines.push(label('cut', `${cut} of ${turns} turns had their output cut (${percent(cut, turns)})`))
  const biggest = ms.reduce((a: any, b: any) => (b.max_out > a.max_out ? b : a))
  const truncated = ms.reduce((n: number, m: any) => n + (get(m.kinds, 'failed:truncated', 0) || 0), 0)
  const outs: number[] = []
  for (const [s, _] of pairs) for (const u of s.of('usage')) outs.push(u.out)
  lines.push(label('replies', `median ${median(outs)} tokens · largest ${biggest.max_out} (${biggest.id}) · ${truncated} cut off at the limit`))
  let spentLine = `in ${kilo(ms.reduce((n: number, m: any) => n + m.in, 0))} ` +
    `(${share(ms.reduce((n: number, m: any) => n + m.hit, 0), ms.reduce((n: number, m: any) => n + m.in, 0))}% cached) · ` +
    `out ${kilo(ms.reduce((n: number, m: any) => n + m.out, 0))}`
  if (ms.every((m: any) => m.cost !== null)) spentLine += ` · $${fixed(pySum(ms.map((m: any) => m.cost)), 2)}`
  lines.push(label('tokens', spentLine))
  const rejected = ms.reduce((n: number, m: any) => n + m.rejects, 0)
  lines.push(label('rounds', `${rejected} rejected rounds in ${ms.filter((m: any) => m.rejects).length} sessions · ` +
    `${ms.reduce((n: number, m: any) => n + m.continues, 0)} continued`))
  if (ms.some((m: any) => m.seconds !== null)) {
    lines.push(label('time', `model ${duration(pySum(ms.map((m: any) => m.model_seconds || 0)))}s · lead waited ` +
      `${duration(pySum(ms.map((m: any) => m.lead_seconds || 0)))}s · total ` +
      `${duration(pySum(ms.map((m: any) => m.seconds || 0)))}s`))
  }
  const blank = { turns: 0, in: 0, hit: 0, out: 0, away: 0, seconds: 0.0, timed: 0 }
  const totals = new Map<string, any>()
  for (const [s, m] of pairs) {
    for (const u of s.of('usage')) {
      if (!totals.has(u.profile)) totals.set(u.profile, { ...blank })
      const p = totals.get(u.profile)
      p.turns += 1; p.in += u.prompt; p.hit += u.hit || 0; p.out += u.out
      if (get(u, 'first') != null) { // a streamed reply: how long it took to start
        if (!p.firsts) p.firsts = []
        p.firsts.push(get(u, 'first'))
      }
    }
    for (const [name, values] of Object.entries(m.speed)) {
      if (!totals.has(name)) totals.set(name, { ...blank })
      const p = totals.get(name), pair = values as number[]
      p.seconds += pair[0]; p.timed += pair[1]
    }
    const ss = s.of('series')
    for (let i = 1; i < ss.length; i++) {
      const a = ss[i - 1], b = ss[i]
      if (b.why === 'failover' && b.status !== 'chosen') { // also from a profile no session shown so far has a turn on
        if (!totals.has(a.profile)) totals.set(a.profile, { ...blank })
        totals.get(a.profile).away += 1
      }
    }
  }
  for (const [name, p] of [...totals.entries()].sort((a, b) => b[1].turns - a[1].turns || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    let row = `profile ${name}: ${p.turns} turns · in ${kilo(p.in)} (${share(p.hit, p.in)}% cached) · ` +
      `out ${kilo(p.out)} · ${p.away} failovers away`
    if (p.timed) row += ` · ${fixed(p.seconds / p.timed, 1)} s per turn`
    if (p.firsts) row += ` · first data p95 ${fixed(p95(p.firsts), 1)}s`
    lines.push(row)
  }
  return lines
}

/** One line per session for `dsk stats --sessions`: what it measured and where it ran. */
export function sessionLine(m: any): any {
  const kinds = m.kinds
  const failed = Object.entries(kinds).filter(([kind]) => kind.startsWith('failed:')).reduce((n, [, v]) => n + Number(v), 0)
  return `${m.id} · ${m.status} · ${m.turns} turns (${get(kinds, 'read', 0)} r, ${get(kinds, 'write', 0)} w, ` +
    `${get(kinds, 'run', 0)} x, ${failed} f) · in ${kilo(m.in)} (${share(m.hit, m.in)}% cached) · ` +
    `out ${kilo(m.out)} · ${path.basename(String(m.root).replace(/\/+$/, ''))}`
}

export function cmdStatus(args: Args, cfg: Cfg): any {
  if (args.json) { // every session of the last day, on any project, newest first: for a display that polls
    // What a kept job was made with besides its log: this code's fields (bump the number) and the prices.
    const cache = path.join(STATE, 'status.json')
    // A Map, not an object: the order is os.listdir's, which the cache keeps and the sort below keeps for ties, and an
    // object would put ids made of digits first.
    const made = [3, Object.fromEntries(Object.entries(cfg.profiles).map(([k, v]: any) => [k, get(v, 'price')]))]
    const fresh = new Map<string, any>([['for', made]])
    let old: any = {}
    try { old = readStatusCache(fs.readFileSync(cache, 'utf8')) } catch { old = {} }
    old = sameJSON(get(old, 'for'), made) ? old : {}
    const dirs = fs.existsSync(STATE) && fs.statSync(STATE).isDirectory() ? listdir(STATE) : []
    for (const sid of dirs) {
      let stat: BigIntStats
      try { stat = fs.statSync(path.join(STATE, sid, 'log.jsonl'), { bigint: true }) } catch { continue }
      const key = [stat.mtimeNs, stat.size], had = get(old, sid)
      const sameKey = had && Array.isArray(had.key) && had.key.length === 2 &&
        BigInt(had.key[0]) === key[0] && BigInt(had.key[1]) === key[1]
      if (sameKey && get(get(had, 'job', {}), 'status') !== 'running') {
        fresh.set(sid, had) // a log that has not moved since its session stopped is not read again
        continue
      }
      const s = new Session(sid)
      if (s.recs.length && get(s.head, 't') === 'head' && s.last('state')) fresh.set(sid, { key, job: job(s, cfg) })
    }
    if (!sameJSON(Object.fromEntries(fresh), old)) {
      fs.writeFileSync(cache + `.${process.pid}`, statusJSON(fresh), 'utf8')
      fs.renameSync(cache + `.${process.pid}`, cache)
    }
    const recent = [...fresh].filter(([sid]) => sid !== 'for').map(([, e]: any) => e.job)
      .filter((j: any) => j.created > now() - 86400)
    recent.sort((a: any, b: any) => b.created - a.created)
    print(dumps({ jobs: recent }))
    return 0
  }
  if (args.hook) { // a Claude Code Stop hook: exit 2 sends Claude back to review what it delegated
    const event: any = JSON.parse(fs.readFileSync(0, 'utf8'))
    const mine = (head: any) => get(head, 'owner') && get(head, 'owner') === get(event, 'session_id')
    const waiting = get(event, 'stop_hook_active') ? [] : sessions(mine).filter((s: Session) => s.status() === 'review')
    for (const s of waiting) {
      eprint(`dsk ${s.id} is waiting for your review: run dsk show ${s.id} --review, then dsk accept ${s.id} or ` +
        `dsk reject ${s.id} "defects"`)
    }
    return waiting.length ? 2 : 0
  }
  const root = projectRoot() || process.cwd()
  const mine = sessions((head: any) => head.root === root)
  const open = mine.filter((s: Session) => !['accepted', 'dropped', 'done'].includes(s.status()))
  for (const s of open) {
    const age = Math.floor(Math.trunc(now() - s.head.created) / 60) // minutes: int(seconds) // 60, as in dsk.py
    print(`dsk ${s.id} · ${s.status()} · ${Math.floor(age / 60)}h${String(age % 60).padStart(2, '0')}m ago · ${cpHead(s.head.brief, 60)}`)
  }
  print(`${open.length} open, ${mine.length - open.length} finished` + (open.length ? `\nnext:    dsk show ${open[0].id}` : ''))
  return 0
}

/** What the sessions measured, read from their logs: turns, kinds, tokens, time, rounds and profiles. */
export function cmdStats(args: Args, cfg: Cfg): any {
  let found: Session[]
  if (args.id && args.id.length) { // nargs='*' gives [], which Python reads as false
    found = args.id.map((sid: string) => new Session(sid))
  } else {
    const wanted = now() - args.days * 86400
    found = sessions((head: any) => head.created > wanted)
  }
  if (args.project) { // only the sessions this project's runs wrote
    const root = projectRoot() || process.cwd()
    found = found.filter((s) => s.head.root === root)
  }
  if (!found.length) {
    print(`no sessions in the last ${args.days} days`)
    return 0
  }
  const pairs = found.map((s) => [s, metrics(s, cfg)]).sort((a: any, b: any) => b[1].created - a[1].created)
  if (args.json) {
    print(dumps({ sessions: pairs.map((pair: any) => pair[1]) }))
    return 0
  }
  for (const row of statsSummary(pairs)) print(row)
  if (args.sessions) {
    print()
    for (const [, m] of pairs) print(sessionLine(m))
  }
  return 0
}

/** This dsk's version, from the plugin's manifest beside this script; '' when there is none (a bare checkout copy). */
export function version(): any {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', '.claude-plugin', 'plugin.json'), 'utf8'))
    return String(get(data, 'version', ''))
  } catch {
    return ''
  }
}

/** How dsk is set up. As a Claude Code hook (--hook) it first stores the plugin's options, which Claude Code hands */
export function cmdConfigure(args: Args, cfg: Cfg): any {
  if (args.hook) {
    try {
      const home = xdg('XDG_CONFIG_HOME', '~/.config')
      const data = args.data || process.env.CLAUDE_PLUGIN_DATA || home
      const name = path.basename(data.replace(/\/+$/, '')) // the data folder is named after the plugin's id: dsk-<marketplace>
      const options: any = {}
      for (const option of OPTIONS) options[option] = process.env[`CLAUDE_PLUGIN_OPTION_${option.toUpperCase()}`] || ''
      const files: [string, any][] = [
        [path.join(data, 'options.json'), options],
        [path.join(home, 'plugin.json'), { options: path.join(data, 'options.json'),
          id: name.startsWith('dsk-') ? 'dsk@' + name.slice(4) : plugin('id') }]]
      for (const [file, value] of files) { // written only when it changed: this runs before every prompt
        let same = false
        try { same = sameJSON(JSON.parse(fs.readFileSync(file, 'utf8')), value) } catch { same = false }
        if (!same) {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          const fd = fs.openSync(file + '.new', 'w', 0o600)
          try { fs.writeFileSync(fd, pyJSONAscii(value), 'utf8') } finally { fs.closeSync(fd) }
          fs.renameSync(file + '.new', file)
        }
      }
      const [ready, state] = setup(config())
      let news = ''
      if (args.announce) { // the first session on a new version says so: after an install or an update
        const current = version(), seenAt = path.join(data, 'version')
        let seen = ''
        try { seen = fs.readFileSync(seenAt, 'utf8').trim() } catch { seen = '' }
        if (current && current !== seen) {
          news = seen ? `dsk ${seen} → ${current} updated.` : `dsk ${current} installed.`
          fs.writeFileSync(seenAt, current, 'utf8')
        }
      }
      // dsk.py said this itself when its Python was too old. dsk.ts needs a Python only for the worker's scripts, so
      // it asks at session start, once, and says that before anything else: no run can work without it.
      let python = ''
      if (args.announce) {
        try {
          pythonPath()
        } catch (e) {
          if (!(e instanceof Fail)) throw e
          python = e.message
        }
      }
      // Before every prompt too, not only at session start: /reload-plugins after an update starts no session.
      const mended = mendLauncher()
      let said: any = null
      if (python) {
        said = { systemMessage: `${news ? news + ' ' : ''}${python}.` }
      } else if (args.announce && ready && news) {
        said = { systemMessage: `${news} /dsk enable shows the jobs, /dsk config configures it.` }
      }
      if (!python && args.announce && !ready) {
        const how = `Run /plugin configure ${plugin('id')} and ${SETUP}. Then restart Claude Code.`
        said = { systemMessage: `${news ? news + ' ' : ''}dsk is not set up yet: ${state}. ${how}`, hookSpecificOutput: {
          hookEventName: 'SessionStart', additionalContext: `The dsk plugin has no working provider (${state}), so ` +
            '`dsk run` will fail. If the user wants to delegate with dsk, tell them: ' + `${how} Never ask for a key in the chat.` } }
      }
      if (mended) said = said ? { ...said, systemMessage: `${said.systemMessage} ${mended}` } : { systemMessage: mended }
      if (said) print(pyJSONAscii(said))
    } catch (e) { // a hook must never stand in the way of a session or a prompt
      if (e instanceof Interrupted) throw e
    }
    return 0
  }
  const [ready, state] = setup(cfg)
  print(`dsk${version() ? ' ' + version() : ''} · ${ready ? 'ready' : 'not set up'} · ${state}`)
  for (const name of cfg.route) {
    const profile: any = get(cfg.profiles, name, {})
    const key = secret(get(profile, 'key_env', '')) ? 'set' : 'missing'
    let until = paused(name)
    const pause = until ? ` · paused until ${shortTime(until)}, credit used up` : ''
    print(`${ljust(name + ':', 8)} ${get(profile, 'base_url')} · ${get(profile, 'model')} · key ${key}${pause}`)
  }
  if (get(cfg, 'effort', 'off') !== 'off') {
    print(`${ljust('effort:', 10)}${cfg.effort} for a run that names none`)
  }
  if (get(cfg, 'route_order') === 'fastest') {
    const found = speeds()
    print(`${ljust('order:', 10)}fastest first: ` + fastOrder(found, cfg.route).map((name: string) => {
      const seconds = get(get(found, name, {}), 'seconds')
      return seconds !== null ? `${name} ${fixed(seconds, 2)}s` : `${name} (not measured)`
    }).join(', '))
  }
  if (!ready) {
    print(`next:    in Claude Code, /plugin configure ${plugin('id')}: ${SETUP}; then restart Claude Code. ` +
      `Or export the key in ~/.config/dsk/env.`)
  }
  return ready ? 0 : 1
}
