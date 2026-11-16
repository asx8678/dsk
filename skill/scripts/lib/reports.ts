// The reports: the short text report and the JSON one, both measured from a session's log. The types stay loose:
// every value here is a log record read by key.
const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')
import { Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg, type Args, type Cfg, type Head, type Profile, type Rec } from './base.ts'
import { answerText, git, scope } from './gates.ts'
import { rechecked, reviewed } from './review.ts'
import { job, label, turnKind } from './stats.ts'
import { NEXT, SEVERITY } from './texts.ts'
import type { Session } from './session.ts'

/** Tokens in thousands, one decimal, as `kilo` printed them: 12345 becomes "12.3k". */
export function kilo(n: any): any {
  return fixed(n / 1000, 1) + 'k'
}

/** Cached share of the input tokens, over the turns where the provider reported it. None if it never did. */
export function cachedShare(usage: any): any {
  const known = (usage as any[]).filter((u: any) => u['hit'] !== null)
  if (!known.length) return null
  const hit = known.reduce((n: number, u: any) => n + u['hit'], 0)
  const prompt = known.reduce((n: number, u: any) => n + u['prompt'], 0)
  return hit / Math.max(1, prompt)
}

/** One line per turn: input tokens, cache hits and misses, output tokens, and what the script did. */
export function turnLine(s: Session, turn: any): any {
  const S = s as any
  const u = (S.of('usage') as any[]).slice().reverse().find((r: any) => r['turn'] === turn)!
  const hit = u['hit'] === null ? '?' : u['hit']
  const miss = u['hit'] === null ? '?' : u['prompt'] - u['hit']
  let acts = (S.of('ledger') as any[]).filter((r: any) => r['turn'] === turn).map((r: any) => {
    let act = cpHead(`${r['fn']} ${r['arg']}`, 50).replace(/\n/g, ' ')
    act += has(r, 'err') ? ' ✗' : r['fn'] === 'sh' ? ` → ${r['code']}` : ''
    return act
  })
  acts = acts.length > 8 ? [...acts.slice(0, 8), `and ${acts.length - 8} more`] : acts.slice(0, 8)
  const failedRec = (S.of('result') as any[]).find((r: any) => r['turn'] === turn && r['fail'])
  const failed = failedRec ? failedRec['fail'] : ''
  return (`t${String(turn).padEnd(3)} in ${String(u['prompt']).padStart(7)} hit ${String(hit).padStart(7)} miss ${String(miss).padStart(7)} out ${String(u['out']).padStart(6)} | `
    + (failed ? `[${failed}] ` : '') + acts.join('; '))
}

/** The worker's change set: its files, from the start snapshot (or the tree `since`) to its last stop. */
export function workerDiff(s: Session, flags: any[] = [], options: { since?: any } = {}): any {
  const S = s as any
  const st = S.last('state')
  const paths = ((get(st, 'changed', []) as any[]) || []).map(([, , p]: any) => ':(literal)' + p)
  return paths.length ? git(S.head['root'], ['diff', ...flags, options.since || scope(S)['start'], st['end'], '--', ...paths]) : ''
}

/** The checks the worker ran itself, and saw pass, in a turn before the first one that changed a file: a check */
export function passedBefore(s: Session): any {
  const S = s as any
  const checks = new Map<string, string>()
  for (const cmd of scope(S)['checks'] as string[]) checks.set(cpHead(cmd, 200), cmd)  // the ledger keeps 200 characters
  const recs = S.recs as any[]
  let start = 0
  recs.forEach((r: any, i: number) => { if (r['t'] === 'base' || r['t'] === 'reject') start = i })
  let passed: string[] = []
  let turn: string[] = []
  if (recs[start] && recs[start]['t'] === 'reject') {  // dsk ran these when the rejected round stopped
    let stopped: any = { results: [] }
    for (let i = start - 1; i >= 0; i--) if (recs[i]['t'] === 'checks') { stopped = recs[i]; break }
    passed = (stopped['results'] as any[]).filter(([, code]: any) => code === 0).map(([cmd]: any) => cmd)
  }
  for (const r of recs.slice(start)) {
    const touched = r['touched']
    if ((r['t'] === 'ledger' && (r['fn'] === 'write' || r['fn'] === 'edit') && !has(r, 'err'))
        || (r['t'] === 'gate' && (Array.isArray(touched) ? touched.length > 0 : touched))) break
    if (r['t'] === 'ledger' && r['fn'] === 'sh' && r['code'] === 0 && checks.has(r['arg'])) turn.push(checks.get(r['arg'])!)
    else if (r['t'] === 'result') {  // only now is it known that the turn changed nothing
      passed = passed.concat(turn)
      turn = []
    }
  }
  return [...new Set(passed)]
}

/** The short report for the session's last stop, or the review packet. `summary`, `answer`, `question`, `notes`
 * and `open` are the worker's words, and a `finding` line is the reviewer's; every other line is measured. */
export function report(s: Session, review: any = false, cfg: Cfg | null = null): any {
  const S = s as any
  const st = S.last('state') || {}
  const usage = S.of('usage') as any[]
  const ledger = S.of('ledger') as any[]
  const checks = S.last('checks') || { results: [] }
  const status = S.status()
  const turns = S.turn
  const cached = cachedShare(usage)
  const earlier = [...new Set((S.of('series') as any[]).map((r: any) => get(r, 'profile')))]
    .filter((p: any) => p && p !== S.profile) as any[]
  const shown = S.profile + (earlier.length ? ' after ' + earlier.join(', ') : '')  // a failover says which profile came before
  const top = [`dsk ${S.id}`, status, shown, `${turns} turn${turns === 1 ? '' : 's'}`,
    `in ${kilo(usage.reduce((n: number, u: any) => n + u['prompt'], 0))}` + (cached === null ? '' : ` (${fmtPercent(cached, 0)} cached)`),
    `out ${kilo(usage.reduce((n: number, u: any) => n + u['out'], 0))}`]
  for (const fn of ['search', 'fetch']) {
    const n = ledger.filter((r: any) => r['fn'] === fn && !r['cached']).length
    if (n) top.push(`${fn} ${n}`)
  }
  const lines = [top.join(' · ')]
  const partial = review || status === 'stuck' || status === 'limit'

  const line = (label: string, text: any): void => {
    if (text) lines.push(`${label + ':'}`.padEnd(8) + ' ' + text)
  }

  line('brief', review && (get(scope(S), 'task') || S.head['brief']))
  line('allow', review && (scope(S)['allow'] as any[]).join(', '))
  line('where', review && S.head['worktree'] && S.head['workdir'])
  line('question', get(st, 'question'))
  line('error', get(st, 'error') || (st['status'] === 'running' && status === 'error' && 'interrupted: its dsk process is gone'))
  line('why', get(st, 'why'))
  line('sandbox', get(S.head, 'unsandboxed') && `off: ${S.head['unsandboxed']}`)
  line('notes', partial && ledger.filter((r: any) => r['fn'] === 'note').map((r: any) => r['arg']).join(' | '))
  line(status === 'done' ? 'answer' : 'summary',
    cpHead(status === 'done' ? answerText(S) : get(st, 'summary', ''), 1500))
  line('open', get(st, 'open'))
  const ran = get(st, 'checked')  // a bad stop leaves the checks unrun when the worker changed no files
  const scopedChecks = (scope(S)['checks'] || []) as any[]
  line('checks', (status === 'stuck' || status === 'limit') && ran === false && scopedChecks.length
    ? 'not run: the worker changed no files'
    : (checks['results'] as any[]).map(([cmd, code]: any) => `${cmd} → ${code}`).join('; '))
  const passing = new Set((checks['results'] as any[]).filter(([, code]: any) => code === 0).map(([cmd]: any) => cmd))  // a check that fails now needs no such warning
  const changed = get(st, 'changed')
  const before = changed && changed.length ? (passedBefore(S) as any[]).filter((cmd: string) => passing.has(cmd)) : []
  const mark = S.last('base', 'reject') || {}
  const caution = before.length ? (get(mark, 't') === 'reject'  // checks dsk ran last round say little about this one
    ? `${before.join('; ')} passed before this round's changes too, so ${before.length === 1 ? 'it does' : 'they do'} not show that the defects were fixed: rerun each defect yourself`
    : `${before.join('; ')} passed before the worker changed anything, so ${before.length === 1 ? 'it does' : 'they do'} not show that the task was done`) : ''
  line('caution', caution)
  const look = rechecked(S)
  if (look) {
    const thought = look['reasoning'] === null ? 'no reply yet' : !look['reasoning'] ? 'no reasoning came back'
      : `${comma(look['reasoning'])} characters of reasoning`
    line('recheck', look['skipped'] ? `skipped: ${look['skipped']}` : [
      `asked after turn ${look['turn']}`, thought,
      look['changed'] && look['changed'].length ? 'changed ' + look['changed'].join(', ') : 'no change',
    ].join(' · '))
  }
  const verdicts = reviewed(S)
  if (verdicts) {
    const parts: string[] = []
    ;(verdicts['calls'] as any[]).forEach((c: any, i: number) => {
      const n = i + 1
      if (get(c, 'skipped') || get(c, 'error')) {
        parts.push(get(c, 'skipped') ? `skipped: ${c['skipped']}` : `call ${n}: no verdict, ${c['error']}`)
        return
      }
      const count: Record<string, number> = {}
      for (const k of SEVERITY) count[k] = (c['findings'] as any[]).filter((f: any) => f['severity'] === k).length
      const found = SEVERITY.filter((k: any) => count[k]).map((k: any) => `${count[k]} ${k}`).join(', ') || 'nothing'
      parts.push(`call ${n}: ${found}` + (c['dropped'] ? `, ${c['dropped']} dropped` : '')
        + (get(c, 'cut') ? ', cut off' : '') + ` in ${fixed(c['seconds'], 0)} s`)
    })
    if ((verdicts['sent'] as any[]).length && get(st, 'end')) {
      parts.push(`quotes still in the code: ${(verdicts['still_there'] as any[]).length} of ${(verdicts['sent'] as any[]).length}`)
    }
    line('review', parts.join(' · '))
    if (partial) {
      for (const c of verdicts['calls'] as any[]) {
        for (const f of get(c, 'findings', []) as any[]) {
          line('finding', `${f['id']} ${f['severity']} ${f['path']}:${f['line']} · input: ${f['input']} · actual: ${f['actual']}`)
        }
      }
    }
  }
  const reverted = [...new Set((S.of('gate') as any[]).flatMap((g: any) => g['reverted']))] as any[]
  line('scope', reverted.length ? `reverted ${reverted.join(', ')} (copies in ${path.join(S.dir, 'reverted')})` : '')
  line('changed', ((get(st, 'changed', []) as any[]) || []).map(([a, d, p]: any) =>
    `${p} (${a === '-' ? 'binary' : `+${a}` + (d !== '0' ? ` -${d}` : '')})`).join(', '))
  const ignoredPaths = (get(st, 'ignored', []) as any[]) || []
  if (ignoredPaths.length) {  // a write() to ignored files is in no diff, so nothing else in the report names them
    const many = ignoredPaths.length > 1
    const where = S.head['worktree']
      ? `${many ? 'they are' : 'it is'} only in the worktree ${S.head['workdir']}, which dsk accept and --drop delete`
      : `written, but in no diff, and --drop leaves ${many ? 'them' : 'it'}`
    line('ignored', `${ignoredPaths.join(', ')} (git ignores ${many ? 'them' : 'it'}: ${where})`)
  }
  if (has(st, 'cited')) {
    const bad = st['unverified'] as any[]
    line('sources', `${st['cited']} cited, ` + (bad && bad.length ? `${bad.length} unverified: ${bad.slice(0, 5).join(' ')}` : 'all opened in this session'))
  }
  const late = usage.filter((u: any) => u['turn'] > 3)
  const lateShare = cachedShare(late)
  if (lateShare !== null && lateShare < 0.8) line('cache', `low (${fmtPercent(lateShare, 0)} cached after turn 3)`)
  if (status === 'stuck' || status === 'limit') {  // where the turns went, and what the worker last saw when it changed nothing
    const acts = S.of('ledger') as any[]
    const kinds = new Map<string, number>()
    for (const r of S.since('round', 'result') as any[]) {
      const kind = turnKind(r, acts.filter((a: any) => a['turn'] === r['turn']))
      kinds.set(kind, (kinds.get(kind) || 0) + 1)
    }
    line('spent', [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} ${n}`).join(' · '))
    const stChanged = get(st, 'changed')
    if (!(stChanged && stChanged.length)) {
      let lastOutput = ''
      try {
        lastOutput = cpHead(fs.readFileSync(path.join(S.dir, 'out', String(S.last('result')['turn'])), 'utf8')
          .replace(/\r\n?/g, '\n'), 1500)  // universal newlines, as Python's text mode read it
      } catch (e) {  // a turn that was never run has no output file
        if (!(e && typeof (e as any).code === 'string')) throw e
        lastOutput = ''
      }
      line('last', cpHead(lastOutput, 1500).trim())
    }
  }
  const lastUsage = S.last('usage')
  if (cfg && Object.keys(cfg).length && lastUsage) {  // how full the next request would be, against the point where dsk compacts the series
    const compacts = (S.of('series') as any[]).filter((r: any) => r['why'] === 'compact').length
    const profiles = get(cfg, 'profiles', {})
    const profile = get(profiles, S.profile, {})
    line('context', `${kilo(lastUsage['prompt'] + lastUsage['out'])} of ${kilo(get(profile, 'compact_at', 32000))}`
      + (compacts ? ` · compacted ${compacts}×` : ''))
  }
  if (partial) {
    const reviews = S.last('base') ? S.since('base', 'state') : S.of('state')
    const seen = status === 'review' ? (reviews as any[]).filter((r: any) => r['status'] === 'review').map((r: any) => r['end']).slice(0, -1) : []
    const diff = splitLines(workerDiff(S, [], { since: seen.length ? seen[seen.length - 1] : null }))
    const cap = review ? 300 : 120
    if (seen.length) lines.push(`diff since your last review (the whole diff: dsk show ${S.id} --diff)`)
    lines.push(...diff.slice(0, cap))
    if (diff.length > cap) lines.push(`... ${diff.length - cap} more diff lines: dsk show ${S.id} --diff`)
  }
  line('next', format(get(NEXT, status, '') as string, { id: S.id }))
  return lines.join('\n')
}

/** Python's str.splitlines() for the text this module splits: no empty last item, and every separator Python knew. */
function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The report as one JSON object: `job()`'s measured data, plus the words the text report says, measured from
 * the log the same way `report()` measures them, so the two never disagree. */
export function reportJson(s: Session, cfg: Cfg): any {
  const S = s as any
  const st = S.last('state') || {}
  const ledger = S.of('ledger') as any[]
  const checks = S.last('checks') || { results: [] }
  const status = S.status()
  const passing = new Set((checks['results'] as any[]).filter(([, code]: any) => code === 0).map(([cmd]: any) => cmd))  // a check that fails now needs no such warning
  const head = S.head
  const last = S.last('usage')
  const changed = get(st, 'changed')
  const profiles = cfg ? get(cfg, 'profiles', {}) : {}
  const profile = get(profiles, S.profile, {})
  const reverted = [...new Set((S.of('gate') as any[]).flatMap((g: any) => g['reverted']))] as any[]
  return {
    ...job(S, cfg),
    left: [...new Set((S.of('series') as any[]).map((r: any) => get(r, 'profile')))].filter((p: any) => p && p !== S.profile),
    summary: get(st, 'summary', ''), answer: status === 'done' ? answerText(S) : '',
    question: get(st, 'question') || '', error: get(st, 'error') || '', why: get(st, 'why') || '',
    open: get(st, 'open') || '', notes: ledger.filter((r: any) => r['fn'] === 'note').map((r: any) => r['arg']),
    checks: (checks['results'] as any[]).map(([cmd, code]: any) => ({ cmd, code })),
    checked: get(st, 'checked'),
    passed_before: changed && changed.length ? (passedBefore(S) as any[]).filter((cmd: string) => passing.has(cmd)) : [],
    recheck: rechecked(S) ?? null,
    reviewer: reviewed(S) ?? null,
    files: ((changed as any[]) || []).map(([a, d, p]: any) => ({ path: p, added: a === '-' ? null : Math.trunc(Number(a)), deleted: d === '-' ? null : Math.trunc(Number(d)) })),
    reverted,
    ignored: get(st, 'ignored') || [],
    workdir: head['worktree'] ? head['workdir'] : '',
    context: { used: last ? last['prompt'] + last['out'] : 0,
               limit: get(profile, 'compact_at', 32000),
               compactions: (S.of('series') as any[]).filter((r: any) => r['why'] === 'compact').length },
    next: format(get(NEXT, status, '') as string, { id: S.id }),
  }
}
