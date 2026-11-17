// The session log: one append-only JSONL file per session. Every request, report and digest is rebuilt from it, so
// a session started by an older dsk, the Python one included, goes on under this one.
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
import { Fail, STATE, flock, now, pyJson, pyRound, tokenHex, type Head, type Lock, type Rec } from './base.ts'
import { ALIASES } from './config.ts'

/** One append-only JSONL log. Every request, report and digest is rebuilt from it. */
export class Session {
  id: string
  dir: string
  path: string
  recs: Rec[] = []
  /** The process group of the shell command a script is running, while it runs (run_script). */
  shelled: number | null = null
  /** What the worker was shown of the last turn's output, and whether that turn may have changed a file. */
  printed = ''
  moved = false
  /** dsk.py's `_lock`: this process's lock on the session, while it drives it. */
  lockHandle: Lock | null = null
  /** dsk.py's `_tree`: this process's lock on the working tree, for a run in place. */
  treeLock: Lock | null = null

  constructor(sid: string | null = null) {
    const fresh = sid === null
    // Four hex characters while a free one is easy to find. After eight taken in a row most of the 65,536 are, so
    // the id grows to six characters, and then to eight: a state folder nobody prunes cannot run out of names.
    for (let taken = 0; sid === null; taken++) {
      sid = tokenHex(taken < 8 ? 2 : taken < 16 ? 3 : 4)
      fs.mkdirSync(path.join(STATE, sid), { recursive: true })
      try {
        fs.mkdirSync(path.join(STATE, sid, 'out'))
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e
        sid = null
      }
    }
    this.id = sid
    this.dir = path.join(STATE, sid)
    this.path = path.join(this.dir, 'log.jsonl')
    if (!fresh) {
      let text: string
      try {
        text = fs.readFileSync(this.path, 'utf8')
      } catch {
        throw new Fail(`no session ${sid}`)
      }
      // A line torn by a crash has no newline: skip it.
      const lines = text.split('\n')
      lines.pop()
      this.recs = lines.map((line) => JSON.parse(line))
    }
  }

  /** Append a record of kind `t`. `at` goes last, so it replaces the `at` a close() copies in. */
  add(t: string, fields: Record<string, any> = {}): Rec {
    const rec: Rec = { t, ...fields, at: pyRound(now(), 3) }
    fs.appendFileSync(this.path, pyJson(rec) + '\n', 'utf8')
    this.recs.push(rec)
    return rec
  }

  of(...types: string[]): Rec[] {
    return this.recs.filter((r) => types.includes(r.t))
  }

  /** The last record of any of `types`, or null. Typed loosely, as dsk.py indexed it at once: s.last("state")["status"]. */
  last(...types: string[]): any {
    for (let i = this.recs.length - 1; i >= 0; i--) {
      if (types.includes((this.recs[i] as Rec).t)) return this.recs[i]
    }
    return null
  }

  /** Records of `types` after the last `marker` record. */
  since(marker: string, ...types: string[]): Rec[] {
    let start = -1
    this.recs.forEach((r, i) => { if (r.t === marker) start = i })
    if (start < 0) throw new Error(`no ${marker} record`) // max() of an empty sequence, as in dsk.py
    return this.recs.slice(start).filter((r) => types.includes(r.t))
  }

  /** One lock per session, held by whichever dsk process is driving it. */
  lock(): this {
    this.lockHandle = flock(path.join(this.dir, 'lock'), `session ${this.id} is busy: another dsk process is running it`)
    return this
  }

  /** The last state. A `running` session that no process holds was interrupted, so it counts as `error`. */
  status(): string {
    const status: string = this.last('state').status
    if (status === 'running' && this.lockHandle === null) {
      try {
        this.lock().lockHandle!.close()
        this.lockHandle = null
      } catch (e) {
        if (e instanceof Fail) return 'running'
        throw e
      }
    }
    return status === 'running' ? 'error' : status
  }

  get head(): Head {
    return this.recs[0] as Head
  }

  get turn(): number {
    return Math.max(0, ...this.of('msg').map((r) => r['turn'] as number))
  }

  /** A job started under a provider's old name runs on under its new one (`dsk provider rename`). */
  get profile(): string {
    const name: string = this.last('series').profile
    return Object.hasOwn(ALIASES, name) ? ALIASES[name] : name
  }
}
