// The worker loop: the run header and the first message, then one turn at a time until the worker asks, gets stuck,
// hits a limit, or hands in.
const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')
import { Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg, type Args, type Cfg, type Head, type Profile, type Rec } from './base.ts'
import { compact, digest } from './compaction.ts'
import { cleanEnv, runScript } from './exec.ts'
import { changes, gates, halt, roundLimit, scope, settle, span, tree } from './gates.ts'
import { gate, parse } from './reply.ts'
import { turnLine } from './reports.ts'
import { independentReview, secondLook } from './review.ts'
import { turnKind } from './stats.ts'
import { ALTERNATING, CONFIRMED, CUT_OFF, HEAT, NUDGE, ONE_CALL, REPEAT, SAME_FAILURE, SANDBOX_LINE, SCRATCH, STALE, TRUNCATED } from './texts.ts'
import { chat, laterProfiles, release } from './wire.ts'
import type { Session } from './session.ts'
import { tally, type Tally } from './stops.ts'

/** The lines that say what a run may change, what it must pass and how long it may take. */
export function runHeader(terms: any, web: any, date: any): any {
  const shown = has(terms, 'output_chars') && has(terms, 'read_chars')
    ? `output: a turn shows at most ${comma(terms.output_chars)} characters of what you print, ${comma(terms.read_chars)} when it only reads files`
    : '' // a session started before these keys has no line
  return ['## Run', 'allow: ' + (terms.allow.join(', ') || '(none: this run is read-only)'),
    ...terms.checks.map((cmd: any) => `check: ${cmd}`), `web: ${web ? 'on' : 'off'}`, shown,
    `turn limit: ${terms.max_turns}`, `date: ${date}`,
    get(terms, 'scratch') ? SCRATCH : '', // a session started before the folder has no line
    get(terms, 'sandbox') ? SANDBOX_LINE : ''].filter(Boolean).join('\n')
}

/** DSK.md, run header, attached files, brief, review: most stable first, so sessions share the longest prefix. */
export function firstMessage(head: Head, digest: any = "", files: any = null, review: any = ""): any {
  const run = runHeader(head, head.web, head.date)
  const attached = (files === null ? head.files : files).map(([file, text]: [string, string]) =>
    `<attached path="${file}">\n${text}\n</attached>`)
  const facts = head.dsk_md ? `<attached path="DSK.md">\n${head.dsk_md}\n</attached>` : ''
  return [facts, run, ...attached, '## Task\n' + head.brief, review, digest].filter(Boolean).join('\n\n')
}

/** Run one reply. Returns (text for the worker, why the turn failed or '', the ask/done record or None). */
export async function takeTurn(s: Session, cfg: Cfg, env: any, turn: any, reply: any, finish: any): Promise<any> {
  if (finish === 'length') return [TRUNCATED, 'truncated', null]
  const script = parse(reply)
  if (script === null) return [NUDGE, 'malformed', null]
  const refusal = await gate(script)
  if (refusal) return [`refused, nothing was run: ${refusal}`, 'refused', null]
  const before = span(s)
  let output: any
  let error: any
  let stop: any
  let reverted: any
  try {
    [output, error, stop] = await runScript(s, cfg, env, turn, script)
  } finally { // also when the run is interrupted: what the script did so far is still the worker's
    reverted = settle(s, before, turn)
  }
  const wrote = [...new Set(s.of('ledger')
    .filter((r) => r.turn === turn && (r.fn === 'write' || r.fn === 'edit') && !has(r, 'err'))
    .map((r) => r.arg))]
  // A turn that only reads may show more: in the logs of 118 sessions, 505 of the 550 turns whose output was
  // cut only read files, and workers paged through one file up to 38 times.
  const fns = new Set(s.of('ledger').filter((r) => r.turn === turn).map((r) => r.fn))
  const limits = cfg.limits
  const onlyReads = fns.size > 0 && [...fns].every((fn) => ['read', 'glob', 'grep', 'note'].includes(fn))
  const cap = onlyReads ? limits.read_chars : limits.output_chars
  if (cpLen(output) > cap) {
    const marker = `[... ${cpLen(output) - cap} characters cut here: a turn that only reads shows at most ${comma(limits.read_chars)} characters, any other turn ${comma(limits.output_chars)}; read("@${turn}") returns all of it ...]`
    const chars = Array.from(output)
    output = `${chars.slice(0, Math.floor(cap / 2)).join('')}\n${marker}\n${chars.slice(Math.floor(-cap / 2)).join('')}`
  }
  // For the loop: what the worker is shown of its output, and whether the turn may have changed a file. Outside
  // a git repository nobody can tell what a shell command changed, so such a turn counts as one that did.
  const touched = before ? s.last('gate').touched : []
  s.printed = output
  s.moved = Boolean(wrote.length || reverted.length || touched.length || (!before && fns.has('sh')))
  const parts = [
    wrote.length ? 'wrote: ' + wrote.join(', ') : '',
    output.trim() ? 'output:\n' + output.replace(/\n+$/, '') : 'output: (none)',
    error ? 'error:\n' + error : '',
    reverted.length ? 'reverted, outside the allow patterns: ' + reverted.join(', ') : '',
  ]
  return [parts.filter(Boolean).join('\n'), error ? 'error' : '', stop]
}

/** Python's == for the JSON values a reply is made of: arrays and dicts compare by contents. */
function equal(a: any, b: any): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]))
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => has(b, k) && equal(a[k], b[k]))
  }
  return false
}

/** A JSON value whose dicts have their keys sorted, as json.dumps(sort_keys=True) writes them at every depth. */
function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, any> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key])
    return sorted
  }
  return value
}

/** JSON as json.dumps writes it by default, with every character outside printable ASCII escaped. */
function asciiJson(value: any): string {
  return pyJson(sortKeys(value)).replace(/[\u0080-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** What a reply says, without the call ids that differ every time. */
export function said(message: any): any {
  return [message.content, (get(message, 'tool_calls', []) as any[]).map((call) => call.function)]
}

/** A reply with every number blanked: two scripts that differ only in a line number or a slice bound share it. */
export function shape(message: any): any {
  return asciiJson(said(message)).replace(/\d+/g, '0')
}

/** Drive the session to its next stop. `extra` is the lead's text, appended to the pending turn result. */
export async function loop(s: Session, cfg: Cfg, extra: any = ""): Promise<any> {
  const limits = cfg.limits
  const started = now()
  let t: Tally = { repeats: 0, idle: 0, failures: 0, stop: 'running', failedOver: false }
  let reads = 0
  const env = cleanEnv(cfg, s.dir)
  const writing = Boolean(scope(s).allow.length)
  const saidHere: any[] = []
  const shown: string[] = []
  let failing: [any, number] = [null, 0] // a failure and its run
  let left = 0

  /** Halt at a bad stop, with the checks run first when the worker changed files and they are configured. */
  const bad = async (status: any, info: Record<string, any> = {}): Promise<any> => {
    // A second look that ends here without changing anything leaves the hand-in that passed its checks a turn
    // or more ago: that is handed in as it was, and `why` says that the second look did not finish.
    // Not after the reviewer sent findings back: then the hand-in has defects that nobody has answered.
    const look = (s.of('round').length && !s.since('round', 'reviewer').length)
      ? (s.since('round', 'recheck')[0] ?? null) : null
    if (look && get(look, 'tree') && look.tree === tree(s)) {
      const handed = [...s.of('ledger')].reverse().find((r) => r.turn === look.turn && r.fn === 'done')
      return halt(s, undefined, { summary: handed!.arg, open: handed!.open,
        why: `${info.why} during the second look, which changed nothing` })
    }
    const run = changes(s)[1].length > 0 && scope(s).checks.length > 0
    if (run) await gates(s, cfg, env) // its result is no use to a worker that is being stopped: only the record matters
    return halt(s, status, { checked: run, ...info })
  }

  /** Whether the run is past its time or its token limit. */
  const spentLimit = (): boolean => now() - started > limits.run_seconds
    || s.since('round', 'usage').reduce((sum, u) => sum + u.prompt + u.out, 0) > limits.run_tokens

  /** The limit this round has reached, counting the turn in flight: `turn`, `time`, `token`, or ''. */
  const over = (): string => {
    const spent = s.since('round', 'usage').reduce((sum, u) => sum + u.prompt + u.out, 0)
    return !left ? 'turn' : now() - started > limits.run_seconds ? 'time' : spent > limits.run_tokens ? 'token' : ''
  }

  while (true) {
    const pending = s.last('result', 'msg')
    if (pending.t === 'result') { // sent only now, so an answer, defect list or failed check rides in the same message
      const calls: any[] = get(s.last('msg').m, 'tool_calls', []) as any[]
      for (const call of calls.slice(0, -1)) {
        s.add('msg', { turn: pending.turn, m: { role: 'tool', tool_call_id: call.id, content: ONE_CALL } })
      }
      const target = calls.length ? { role: 'tool', tool_call_id: calls[calls.length - 1].id } : { role: 'user' }
      s.add('msg', { turn: pending.turn, m: { ...target, content: pending.text + extra } })
      extra = ''
      compact(s, cfg)
    }
    const before = [...s.of('msg')].reverse().find((r) => r.m.role === 'assistant')?.m ?? null
    const previous = before === null ? null : said(before)
    const [reply, finish] = await chat(s, cfg, HEAT[Math.min(t.idle, 2)])
    const turn = s.turn + 1
    // A cut-off reply is not kept: resent with every later request, three of them cost one session 48,000 tokens.
    // The worker still hears that its reply was cut off, in the message that carries this turn's result.
    s.add('msg', { turn, m: finish === 'length' ? CUT_OFF : reply })
    const done = s.since('round', 'result').length, limitTurns = roundLimit(s.recs)
    left = Math.max(0, limitTurns - done - 1)
    const nowSaid = said(reply)
    const asked = s.last('recheck')
    // The second look says that the same script once more is a fine answer: it confirms the hand-in, so it is
    // no repeat. Nothing is run twice: the script ran and its checks passed a turn ago, and nothing moved since.
    const confirms = Boolean(asked) && !has(asked, 'skipped') && asked.turn === turn - 1 && equal(nowSaid, previous)
    // Alternating between two scripts gets a worker no further than repeating one, so both count the same way.
    const alternates = saidHere.length >= 3 && equal(nowSaid, saidHere[saidHere.length - 2])
      && equal(saidHere[saidHere.length - 1], saidHere[saidHere.length - 3])
      && !equal(saidHere[saidHere.length - 1], nowSaid)
    saidHere.push(nowSaid)
    const repeat = (equal(nowSaid, previous) || alternates) && !confirms
    let stale = false
    let body: any
    let failed: any
    let stop: any
    if (confirms) {
      body = CONFIRMED
      failed = ''
      stop = [...s.of('ledger')].reverse().find((r) => r.turn === turn - 1 && r.fn === 'done')
    } else if (repeat) { // a worker that has its answer and only forgot to call done() gets one warning, not a stop
      body = alternates ? ALTERNATING : REPEAT
      failed = 'repeat'
      stop = null
    } else {
      [body, failed, stop] = await takeTurn(s, cfg, env, turn, reply, finish)
    }
    const acts = s.of('ledger').filter((a) => a.turn === turn)
    if (!repeat && !failed && !confirms) {
      const seen = s.printed.trim().split(/\s+/).join(' ')
      // The repeat check above misses a script sent again with one number changed. One worker spent its last
      // 15 turns printing ever shorter slices of the same lines; so a turn that is the previous script but for
      // its numbers, changes nothing and prints nothing new counts as a reply that got nowhere, like a repeat.
      stale = !stop && !s.moved && before !== null && shape(reply) === shape(before)
        && acts.some((a) => a.fn !== 'note') && shown.slice(-4).some((old) => old.includes(seen))
      shown.push(seen)
      if (stale) body += '\n\n' + STALE
      // A check that fails the same way after every change: one worker ran 13 such turns to its limit.
      const broken = acts.filter((a) => a.fn === 'sh' && get(a, 'code'))
      if (acts.some((a) => a.fn === 'sh')) {
        const mark = broken.length ? [broken.map((a) => [a.arg, a.code]), seen.replace(/\d+/g, '0')] : []
        failing = [mark, mark.length && equal(mark, failing[0]) ? failing[1] + 1 : mark.length ? 1 : 0]
        if (mark.length && failing[1] % 3 === 0) {
          const cmd = cpHead(broken[broken.length - 1].arg.trim().split(/\s+/).join(' '), 80)
          body += '\n\n' + format(SAME_FAILURE, { cmd, n: failing[1] })
        }
      }
    }
    let text = `turn ${turn} \u00b7 ${left} left\n${body}`
    let finished = false
    if (stop && stop.fn === 'done') {
      // A confirmed hand-in ran and passed its checks a turn ago, and nothing moved since: only the reviewer,
      // if any, is still to come. Each step's text, when it has one, goes back to the worker instead.
      let problem = confirms ? '' : (await gates(s, cfg, env)) || secondLook(s, cfg, turn, over())
      problem = problem || (await independentReview(s, cfg, turn, over(), stop))
      text = text + (problem ? '\n\n' + problem : '')
      finished = !problem
    }
    const kind = turnKind({ turn, fail: failed }, acts)
    reads = writing && kind === 'read' ? reads + 1 : 0 // a run that only reads never gets its work done
    if (reads && reads % 12 === 0) {
      text += `\n\nnote: the last ${reads} turns only read files. ${left} turns are left: start writing now, ` +
        'or call ask() if the task cannot be done as written.'
    }
    s.add('result', { turn, text, fail: failed })
    if (G.verbose) eprint(turnLine(s, turn))
    const later = laterProfiles(s, cfg)
    t = tally(t, { repeat, failed: Boolean(failed), stale, finished, asked: Boolean(stop && stop.fn === 'ask'),
                   later: later.length > 0, done, limit: limitTurns, spent: spentLimit() })
    if (t.stop === 'done') return halt(s, undefined, { summary: stop.arg, open: stop.open })
    if (t.stop === 'question') return halt(s, 'question', { question: stop.arg })
    if (t.failedOver) { // another provider may break the loop, so it is tried before the run gives up
      release(cfg, s.profile)
      s.add('series', { why: 'failover', profile: later[0], status: 'repeat' })
    }
    if (t.stop === 'stuck') {
      return await bad('stuck', { why: t.repeats < 2 && t.idle < 3 ? 'three failing turns in a row'
        : alternates ? 'the same two replies, alternating'
        : t.repeats >= 2 ? 'same reply three times in a row'
        : 'three replies in a row that showed nothing new' })
    }
    if (t.stop === 'limit') {
      return await bad('limit', { why: `${over()} limit reached` })
    }
  }
}
