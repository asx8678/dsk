// The gates around a turn and a hand-in: git snapshots of the tree, the scope that undoes changes outside --allow,
// the checks, and the stops they lead to.
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
import { Fail, cpHead, get, has, now, runSync, shell, type Cfg, type Rec } from './base.ts'
import { matcher } from './glob.ts'
import { sandboxed } from './sandbox.ts'
import type { Session } from './session.ts'
import { verdict } from './revert.ts'

/** Python's os.path.join for the two parts here: absolute `b` replaces `a`. */
function pyJoin(a: string, b: string): string {
  return path.isAbsolute(b) ? b : path.join(a, b)
}

/** Python's os.path.relpath: the path from `start` to `p`, with "." for the same directory. */
function pyRel(p: string, start: string): string {
  const rel = path.relative(start, p)
  return rel === '' ? '.' : rel
}

/** Python's os.path.realpath(strict=False): resolve the part that exists, and keep an unresolved tail as it is. */
function realPath(p: string): string {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync(abs)
  } catch (e: any) {
    if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e
    const parent = path.dirname(abs)
    if (parent === abs) return abs
    return path.join(realPath(parent), path.basename(abs))
  }
}

/** shutil.copy2 for a file: contents, mode and both times, so git sees the index's own mtime. */
function copy2(src: string, dst: string): void {
  fs.copyFileSync(src, dst)
  const st = fs.statSync(src)
  fs.chmodSync(dst, st.mode)
  fs.utimesSync(dst, st.atime, st.mtime)
}

/** shutil.move: a rename, or a copy and unlink when the destination is on another file system. */
function move(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst)
    return
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e
  }
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst)
  } else if (st.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true })
  } else {
    fs.copyFileSync(src, dst)
    fs.chmodSync(dst, st.mode)
    fs.utimesSync(dst, st.atime, st.mtime)
  }
  fs.rmSync(src, { recursive: st.isDirectory(), force: true })
}

/** Python's text[-n:], in code points: n = 0 keeps the whole text. */
function cpTail(text: string, n: number): string {
  return [...text].slice(-n).join('')
}

export function git(cwd: any, args: any[] = [], options: { env?: any; stdin?: any } = {}): any {
  // errors="surrogateescape" in dsk.py: a diff of a file that is not UTF-8 goes back to `git apply` byte for byte.
  const done = runSync('git', args, { cwd, env: options.env ?? undefined, input: options.stdin ?? undefined, escape: true })
  if (done.code) {
    const words = done.err.trim() ? done.err.trim().split(/\s+/) : []
    const reason = words.join(' ')
    throw new Fail(`git ${args[0]}: ${cpHead(reason, 300)}`)
  }
  return done.out
}

/** The working tree as a tree object, built in the session's own index so mine is untouched. The index is */
export function snapshot(cwd: any, index: any): any {
  const mine = pyJoin(cwd, git(cwd, ['rev-parse', '--git-path', 'index']).trim())
  if (!fs.existsSync(index) && fs.existsSync(mine)) {
    copy2(mine, index) // the index's own mtime, which git needs to spot same-second edits
  }
  const env = { ...process.env, GIT_INDEX_FILE: index }
  git(cwd, ['add', '-A'], { env })
  return git(cwd, ['write-tree'], { env }).trim()
}

export function tree(s: Session): any {
  return snapshot(s.head['workdir'], path.join(s.dir, 'index'))
}

/** The terms of the round in flight: the last `base` record's, or the head's when the lead sent no next task. */
export function scope(s: Session): any {
  return s.last('base') || s.head
}

/** The turn limit of the round in flight: a `reject` may set one, and then it holds for that round alone. */
export function roundLimit(recs: Rec[]): any {
  let start: Rec | null = null
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i]['t'] === 'base' || recs[i]['t'] === 'reject') {
      start = recs[i]
      break
    }
  }
  if (start && start['t'] === 'reject' && get(start, 'max_turns')) {
    return start['max_turns']
  }
  let base: Rec | null = null
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i]['t'] === 'base') {
      base = recs[i]
      break
    }
  }
  return (base || recs[0])['max_turns']
}

/** Attribute to the worker what changed since the tree `before`, taken just before a script or the checks */
export function settle(s: Session, before: any, turn: any = null): any {
  if (!before) {
    return []
  }
  const workdir = s.head['workdir']
  const allowed = matcher(scope(s)['allow'])
  const listing = git(workdir, ['diff', '--name-status', '--no-renames', '-z', before, tree(s)]).split('\0')
  const pairs: [string, string][] = []
  for (let i = 0; i + 1 < listing.length; i += 2) {
    pairs.push([listing[i], listing[i + 1]])
  }
  const calls = s.of('ledger').filter((r) => (r['turn'] ?? null) === (turn ?? null))
  const wrote = new Set<string>()
  if (turn && !s.shelled) {
    // write() and edit() are checked when they are called, so a script that started no shell command changed
    // exactly the files it wrote: whatever else moved meanwhile is someone else's and is left alone (verdict())
    const here = realPath(workdir)
    for (const r of calls) {
      if (r['fn'] === 'write' || r['fn'] === 'edit') {
        wrote.add(pyRel(realPath(pyJoin(here, r['arg'])), here))
      }
    }
  }
  // What happens to each path is verdict()'s to say, whose laws gdp-wired proves (lib/revert.ts).
  const judged = pairs.map(([kind, p]) => ({ kind, p, verdict: verdict({ inside: allowed(p), wrote: wrote.has(p),
                                                                         script: Boolean(turn), shelled: Boolean(s.shelled) }) }))
  const outside = judged.filter((j) => j.verdict === 'undo').map((j) => [j.kind, j.p] as [string, string])
  for (const [kind, p] of outside) {
    const current = pyJoin(workdir, p)
    const kept = pyJoin(path.join(s.dir, 'reverted'), p)
    let undone = 0
    if (kind !== 'D') {
      undone = fs.lstatSync(current).mtimeMs / 1000
      fs.mkdirSync(path.dirname(kept), { recursive: true })
      move(current, kept)
    }
    if (kind !== 'A') {
      git(workdir, ['restore', `--source=${before}`, '--worktree', '--', p])
    }
    if (kind === 'M') { // caches keyed on mtime and size (Python bytecode) must not mistake it for the undone edit
      const t = Math.max(now(), undone + 1)
      fs.lutimesSync(current, t, t)
    }
  }
  const reverted = outside.map(([, p]) => p)
  const touched = judged.filter((j) => j.verdict === 'worker').map((j) => j.p)
  s.add('gate', { reverted, touched })
  return reverted
}

/** Open a window in which changes are the worker's. It is logged before anything runs, so that a run which */
export function span(s: Session): any {
  const before = scope(s)['start'] && tree(s)
  if (before) {
    s.add('span', { before })
  }
  return before
}

/** After done(): the checks, run by dsk itself. Returns what failed, for the worker, or ''. */
export async function gates(s: Session, cfg: Cfg, env: any): Promise<any> {
  const checks = scope(s)['checks']
  if (!checks || (Array.isArray(checks) && !checks.length)) {
    return ''
  }
  const before = span(s)
  const results: any[] = []
  let problem = ''
  try {
    for (const cmd of checks) {
      s.add('doing', { arg: cmd })
      // In the sandbox too: a check runs what the worker wrote, such as its tests.
      const [code, out] = await shell(cmd, cfg['limits']['turn_seconds'], env, s.head['workdir'], undefined,
                                      sandboxed(s, cfg))
      results.push([cmd, code])
      if (code) {
        problem = `check failed: ${cmd} → ${code}\n${cpTail(out, 2000).trim()}`
        break
      }
    }
  } finally { // also when the run is interrupted: what the checks left behind still has to be settled
    settle(s, before)
  }
  s.add('checks', { results })
  return problem
}

/** (The tree of the working directory now, [added, deleted, path] for each file the worker changed since the */
export function changes(s: Session): any {
  const head = s.head
  if (!scope(s)['start']) {
    return [null, []]
  }
  const windows = s.last('base') ? s.since('base', 'gate') : s.of('gate')
  const end = tree(s)
  const touched = new Set<string>()
  for (const g of windows) {
    for (const p of (has(g, 'touched') ? g['touched'] : [])) {
      touched.add(p)
    }
  }
  const stat = git(head['workdir'], ['diff', '--numstat', '--no-renames', '-z', scope(s)['start'], end])
  const changed = stat.split('\0').filter((entry: string) => entry).map((entry: string) => entry.split('\t'))
    .filter((entry: string[]) => touched.has(entry[2]))
  return [end, changed]
}

/** The long answer written to @answer, or else the done() summary. */
export function answerText(s: Session, summary: any = ""): any {
  const file = path.join(s.dir, 'answer')
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8') // Python's text mode translates \r\n and \r to \n
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }
  return summary || get(s.last('state') || {}, 'summary', '')
}

/** The paths the worker wrote with write() or edit() in the round in flight, sorted and relative to the working */
export function ignoredWrites(s: Session, changed: any): any {
  if (!scope(s)['start']) {
    return []
  }
  let base = -1
  s.recs.forEach((r, i) => { if (r['t'] === 'base') base = i })
  const tracked = new Set<string>()
  for (const row of changed) tracked.add(row[2])
  const workdir = realPath(s.head['workdir'])
  const paths = new Set<string>()
  for (const r of s.recs.slice(base + 1)) {
    if (r['t'] !== 'ledger' || (r['fn'] !== 'write' && r['fn'] !== 'edit') || has(r, 'err')
        || String(r['arg']).startsWith('@')) {
      continue
    }
    const full = realPath(pyJoin(workdir, r['arg']))
    if (full !== workdir && !full.startsWith(workdir + path.sep)) {
      continue // outside the working directory: not the worker's to report here, and git cannot say
    }
    const rel = pyRel(full, workdir)
    if (!tracked.has(rel) && fs.existsSync(full)) {
      paths.add(rel)
    }
  }
  if (!paths.size) { // one git call for the round, and none when there are no candidates
    return []
  }
  const input = [...paths].sort().join('\0') + '\0'
  const done = runSync('git', ['check-ignore', '-z', '--stdin'], { cwd: workdir, input, escape: true })
  return done.code === 0 ? done.out.split('\0').filter((p) => p).sort() : []
}

/** Record a stop: snapshot the tree, measure what the worker changed, log the state. */
export function halt(s: Session, status: any = null, info: Record<string, any> = {}): any {
  info = { ...info } // Python's **info is a fresh dict: neither the caller's nor the previous stop's fields
  const [end, changed] = changes(s)
  const ignored = ignoredWrites(s, changed) // a hand-in of nothing but ignored files still changed the worktree
  if (ignored.length) {
    info['ignored'] = ignored
  }
  if (s.head['web'] && has(info, 'summary')) { // research gate: a cited URL must come from search() or fetch() here
    const seen = new Set<string>()
    for (const r of s.of('ledger')) {
      if ((r['fn'] === 'search' || r['fn'] === 'fetch') && !has(r, 'err')) {
        const urls = r['urls']
        const list = urls && urls.length ? urls : [r['arg']]
        for (const u of list) {
          seen.add(u.replace(/\/+$/, ''))
        }
      }
    }
    const text = answerText(s, info['summary'])
    const found: string[] = text.match(/https?:\/\/[^\s<>"'`)\]]+/g) || []
    const cited = [...new Set(found.map((u) => u.replace(/[.,;:!?\/]+$/, '')))].sort()
    info['cited'] = cited.length
    info['unverified'] = cited.filter((u) => !seen.has(u))
  }
  status = status || ((changed.length || ignored.length) ? 'review' : 'done')
  s.add('state', { status, end, changed, ...info })
  return status
}
