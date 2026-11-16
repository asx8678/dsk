// The commands that start and drive a session (run, answer, continue, show, wait, bench), and resume(), which
// refuses a command the session's state does not admit.
const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')
import { Fail, G, Interrupted, RUNNER, SCRIPTS, STATE, checkInterrupt, comma, cpHead, cpLen, dumps, eprint, exitStatus, expandUser, fingerprint, fixed, flock, flockWait, fmtPercent, format, get, has, interruptOnSignals, killGroup, now, onInterrupt, print, pyFloat, pyJson, pyRound, pythonPath, readFd, runSync, sha256, shell, shlexQuote, shlexSplit, sleep, tempFile, tokenHex, write, xdg, type Args, type Cfg, type Head, type Profile, type Rec } from './base.ts'
import { makeWorktree, refuseIgnored, removeWorktree, treeLock } from './accept.ts'
import { apiKey, searchKey } from './config.ts'
import { answerText, changes, halt, scope, settle, snapshot, tree } from './gates.ts'
import { firstMessage, loop, runHeader } from './loop.ts'
import { report, reportJson, turnLine, workerDiff } from './reports.ts'
import { sandboxMode } from './sandbox.ts'
import { Session } from './session.ts'
import { bench, fastOrder, orderedRoute, speedText } from './speed.ts'
import { sessions } from './stats.ts'
import { EXIT, MAX_TOKENS, SYSTEM } from './texts.ts'
import { STATUSES, admits, type Command, type Status } from './lifecycle.ts'

/** Remove a tree as shutil.rmtree(path, ignore_errors=True) did: failures to delete are not failures of the caller. */
function rmTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e: any) {
    if (typeof e?.code !== 'string') throw e
  }
}

/** Whether a path is a file, as os.path.isfile said: a missing or unreadable path is simply not one. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch (e: any) {
    if (typeof e?.code === 'string') return false
    throw e
  }
}

/** Whether a path is a directory, as os.path.isdir said: a missing or unreadable path is simply not one. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch (e: any) {
    if (typeof e?.code === 'string') return false
    throw e
  }
}

/** os.path.relpath(target, base), where Python says "." for the base itself and Node says "". */
function relPath(target: string, base: string): string {
  const rel = path.relative(path.resolve(base), path.resolve(target))
  return rel === '' ? '.' : rel
}

/** The lines of a text as Python readlines() gave them: each keeps its newline, and the last may have none. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** datetime.date.today(), as "YYYY-MM-DD": the local day, not UTC's. */
function today(): string {
  const d = new Date()
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** str(e) for an exception: an Error's message, else the value itself. */
function errorText(e: any): string {
  return e instanceof Error ? e.message : String(e)
}

/** type(e).__name__ for an exception: its constructor's name, as near as JavaScript has one. */
function errorName(e: any): string {
  return e && typeof e === 'object' && e.constructor && typeof e.constructor.name === 'string' && e.constructor.name
    ? e.constructor.name : typeof e
}


/** Python's repr() of a config value, as the effort error prints it: quotes for text, None and True/False as Python did. */
function pyRepr(value: any): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value !== 'string') return String(value)
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let escaped = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) as number
    if (ch === '\\') escaped += '\\\\'
    else if (ch === quote) escaped += `\\${quote}`
    else if (ch === '\n') escaped += '\\n'
    else if (ch === '\r') escaped += '\\r'
    else if (ch === '\t') escaped += '\\t'
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, '0')}`
    else escaped += ch
  }
  return `${quote}${escaped}${quote}`
}

/** Run the loop to its next stop, print the report, return the exit code. Any failure becomes `error`. */
export async function drive(s: Session, cfg: Cfg, extra: any = ""): Promise<any> {
  eprint(`dsk ${s.id} · running · ${s.profile}`)
  s.add("state", { status: "running" })
  try {
    await loop(s, cfg, extra)
  } catch (e: any) {
    const message = e instanceof Fail ? errorText(e) : e instanceof Interrupted ? "interrupted" : `internal: ${errorName(e)}: ${errorText(e)}`
    if (G.verbose) eprint(e instanceof Error ? (e.stack ?? `${errorName(e)}: ${errorText(e)}`) : String(e))
    try {
      halt(s, "error", { error: message })
    } catch (halted: any) {
      if (!(halted instanceof Fail)) throw halted
      s.add("state", { status: "error", error: message })
    }
  }
  if (s.status() === "done" && s.head["worktree"])  // nothing was changed: there is nothing left to accept
    removeWorktree(s.head)
  print(G.json ? dumps(reportJson(s, cfg)) : report(s, false, cfg))
  return get(EXIT, s.status(), 0)
}

/** Load and lock a session that `command` may act on: admits() in lifecycle.ts says which. */
export function resume(sid: any, command: Command): any {
  const s = new Session(sid).lock()
  if (s.head["start"] && !s.head["worktree"])
    s.treeLock = treeLock(s.head["root"])
  if (s.last("state")["status"] === "running") {  // we hold its lock, so the process that ran it died: record where it stopped
    const window = s.last("span", "gate")
    if (window && window["t"] === "span")
      settle(s, window["before"])
    const [end, changed] = changes(s)
    s.add("state", { status: "error", end, changed, error: "interrupted: its dsk process was killed" })
  }
  // Which command may act on which status is admits()'s to say, whose laws gdp-wired proves (lib/lifecycle.ts).
  if (!admits(command, s.status() as Status)) {
    const needs = STATUSES.filter((status) => admits(command, status))
    throw new Fail(`session ${sid} is ${s.status()}; this command needs ${needs.join(' or ')}`)
  }
  return s
}

/** End a session as accepted or dropped, keeping what its last stop measured. */
export function close(s: Session, status: any): any {
  rmTree(path.join(s.dir, "scratch"))  // throwaway files, of no use after this
  const last = Object.fromEntries(Object.entries(s.last("state")).filter(([k]) => k !== "t"))
  s.add("state", { ...last, status })
}

export function projectRoot(): any {
  const top = runSync("git", ["rev-parse", "--show-toplevel"])
  return top.code === 0 ? top.out.trim() : null
}

/** The text of a file, or of stdin for `-`: for a brief, an answer, a defect list or a next task. */
export function slurp(path: any): any {
  if (path === "-")
    return fs.readFileSync(0, "utf8").replace(/\r\n?/g, "\n")  // universal newlines, as Python's text mode gave them
  return fs.readFileSync(path, "utf8").replace(/\r\n?/g, "\n")
}

/** [name, text] for one --file: the whole file, or lines A to B of it when the value is PATH:A-B and PATH exists. */
export function attachment(value: any, workdir: any): any {
  const match = /^(.+):(\d+)-(\d+)\n?$/s.exec(value)
  if (!match || !isFile(match[1] as string))
    return [value === "-" ? "@stdin" : relPath(value, workdir), slurp(value)]
  const path_ = match[1] as string
  const first = Number(match[2]), last = Number(match[3])
  const lines = linesOf(slurp(path_))
  if (first < 1 || first > last)
    throw new Fail(`${value}: lines ${first} to ${last} is not a range; lines are numbered from 1 and A comes before B`)
  if (last > lines.length)
    throw new Fail(`${value}: ${path_} has ${lines.length} lines, so there is no line ${last}`)
  return [`${relPath(path_, workdir)}:${first}-${last}`, lines.slice(first - 1, last).join('')]
}

export async function cmdRun(args: Args, cfg: Cfg): Promise<any> {
  if (Boolean(args.text) === Boolean(args.brief))
    throw new Fail('give the brief as "text" or with --brief FILE, not both')

  const root = projectRoot()
  if ((args.allow.length || args.worktree) && !root)
    throw new Fail("--allow and --worktree need a git repository")
  if (args.worktree)
    refuseIgnored(root, args.allow)
  let route = args.profile ? [args.profile] : cfg["route"]
  for (const name of route) {
    if (!has(cfg["profiles"], name))
      throw new Fail(`unknown profile ${name}`)
  }
  if (!args.profile)
    route = await orderedRoute(cfg, route)  // fastest first when the setting says so, and measured if that is stale
  apiKey(get(cfg["profiles"], route[0]))
  if (args.web)
    searchKey(cfg)
  const effort = args.effort || get(cfg, "effort", "off")
  if (!has(MAX_TOKENS, effort as string))
    throw new Fail(`config: effort is ${pyRepr(effort)}, not one of ${Object.keys(MAX_TOKENS).join(', ')}`)
  let workdir = root || process.cwd()
  const brief = args.text || slurp(args.brief)
  const files = (args.file ?? []).map((value: any) => attachment(value, workdir))
  const dskPath = path.join(workdir, "DSK.md")
  const dskMd = fs.existsSync(dskPath) ? slurp(dskPath) : ""
  const guard = root && !args.worktree ? treeLock(root) : null  // held until this run returns
  const s = new Session().lock()
  let start: any
  let sandbox: any
  let unsandboxed: any
  try {
    start = null
    if (args.worktree) {
      workdir = path.join(s.dir, "wt")
      makeWorktree(s, root, workdir)
    }
    if (root)
      start = snapshot(workdir, path.join(s.dir, "index"))
    ;[sandbox, unsandboxed] = sandboxMode(cfg, workdir, s.dir, args.no_sandbox)
  } catch (e: any) {
    if (args.worktree) removeWorktree({ root, workdir, id: s.id })
    rmTree(s.dir)
    throw e
  }
  const head = s.add("head", {
    id: s.id, root: root || workdir, workdir, worktree: args.worktree, start,
    allow: args.allow, checks: args.check, web: args.web, effort,
    recheck: args.recheck == null ? Boolean(get(cfg, "recheck")) : args.recheck,
    reviewer: args.reviewer == null ? Boolean(get(cfg, "reviewer")) : args.reviewer,
    max_turns: args.max_turns || (args.allow.length ? 30 : 12),  // leads gave writing runs 25 to 40
    scratch: true, sandbox, unsandboxed,
    output_chars: cfg["limits"]["output_chars"], read_chars: cfg["limits"]["read_chars"],
    owner: args.owner, route, brief: brief.trim(), files, dsk_md: dskMd.trim(),
    date: today(), created: now(),
  })
  for (const [file, text] of files) {
    if (file === "@stdin")  // kept in the session, so it can still be read after compaction drops the attached copy
      fs.writeFileSync(path.join(s.dir, "stdin"), text, "utf8")
  }
  s.add("series", { why: "start", profile: route[0] })
  s.add("msg", { turn: 0, m: { role: "system", content: SYSTEM } })
  s.add("msg", { turn: 0, m: { role: "user", content: firstMessage(head) } })
  s.add("round")
  const code = await drive(s, cfg)
  void guard
  return code
}

/** Run a session's next round on the profile the lead named with --profile, and hold it there (see later_profiles). It is logged as a failover, because that is the one kind of series record that keeps the messages. */
export function chooseProfile(s: Session, cfg: Cfg, name: any): any {
  if (!name) {
    if (!has(cfg["profiles"], s.profile))  // `dsk provider remove` took it away after the last round
      throw new Fail(`session ${s.id} ran on ${s.profile}, which was removed; choose another with --profile, one of: `
        + `${cfg["route"].filter((n: any) => has(cfg["profiles"], n)).join(', ')}`)
    return
  }
  if (!has(cfg["profiles"], name))
    throw new Fail(`unknown profile ${name}`)
  apiKey(get(cfg["profiles"], name))
  s.add("series", { why: "failover", profile: name, status: "chosen" })  // also when it is there already: this holds it there
}

export async function cmdAnswer(args: Args, cfg: Cfg): Promise<any> {
  if (Boolean(args.text) === Boolean(args.brief))
    throw new Fail('give the answer as "text" or with --brief FILE, not both')
  const text = args.text || slurp(args.brief)
  const s = resume(args.id, 'answer')
  chooseProfile(s, cfg, args.profile)
  s.add("answer", { text })
  return await drive(s, cfg, "\n\nlead's answer: " + text)
}

export function cmdShow(args: Args, cfg: Cfg): any {
  const s = new Session(args.id)
  let text: any
  if (args.diff) {
    text = workerDiff(s)
  } else if (args.answer) {
    text = answerText(s)
  } else if (args.log) {  // every turn in order, with the events that started a new series
    text = s.of("series", "result").map((r) => r["t"] === "series" ? `-- new series: ${r['why']} on ${r['profile']}` : turnLine(s, r["turn"])).join("\n")
  } else {
    text = G.json ? dumps(reportJson(s, cfg)) : report(s, args.review, cfg)
  }
  print(text.replace(/\n+$/, ""))
  return 0
}

/** Give a finished session the lead's next task: same conversation, new terms, fresh round. */
export async function cmdContinue(args: Args, cfg: Cfg): Promise<any> {
  if (Boolean(args.text) === Boolean(args.brief))
    throw new Fail('give the task as "text" or with --brief FILE, not both')
  const text = args.text || slurp(args.brief)
  const s = resume(args.id, 'continue')
  if (s.head["worktree"])  // before anything is added to the log: a refused continue leaves the session as it was
    refuseIgnored(s.head["root"], args.allow)
  chooseProfile(s, cfg, args.profile)
  const head = s.head
  if (args.allow.length && head["start"] === null)
    throw new Fail("--allow needs a git repository")
  const allow = args.allow.length ? args.allow : scope(s)["allow"]
  const checks = args.check.length ? args.check : scope(s)["checks"]
  let turns = args.max_turns || scope(s)["max_turns"]
  if (args.allow.length && !(scope(s)["allow"] || []).length && args.max_turns == null) {  // `not []` is True in Python
    // a read-only session that turns to writing in this round gets the turn limit a writing run would have
    turns = Math.max(turns, 30)
  }
  const recheck = args.recheck == null ? get(scope(s), "recheck", false) : args.recheck
  const reviewer = args.reviewer == null ? get(scope(s), "reviewer", false) : args.reviewer
  if (head["worktree"] && !isDir(head["workdir"])) {
    // accept applied the last round and removed the worktree, so build a fresh one from the tree as it is now
    removeWorktree(head)
    for (const name of ["index", "index.main"]) {
      const p = path.join(s.dir, name)
      if (fs.existsSync(p))
        fs.unlinkSync(p)
    }
    makeWorktree(s, head["root"], head["workdir"])
  }
  const answer = path.join(s.dir, "answer")
  if (fs.existsSync(answer))  // the last round's @answer would answer for this one, in the report and in the gate
    fs.renameSync(answer, `${answer}.${s.of('base').length + 1}`)
  const start = head["start"] ? tree(s) : null
  s.add("base", { start, allow, checks, max_turns: turns, task: text, recheck, reviewer })
  s.add("round")
  const terms: Record<string, any> = { allow, checks, max_turns: turns }
  for (const key of ["output_chars", "read_chars", "scratch"])
    if (has(head, key)) terms[key] = head[key]
  const extra = ("\n\nthe lead has the next task for this session. What you did before stands.\n\n"
    + runHeader(terms, head["web"], today())
    + "\n\n## Task\n" + text)
  return await drive(s, cfg, extra)
}

/** Block until the named sessions, or this project's running ones, have stopped, printing each report as it
 * comes. Runs started together from one shell command give no notice of their own; this is the notice. */
export async function cmdWait(args: Args, cfg: Cfg): Promise<any> {
  const ids = args.id ?? []
  let started = now(), seen = now()
  const waiting = [...new Set(ids)] as string[]
  let reported = 0
  for (const sid of waiting)
    new Session(sid)  // fails now for an ID that does not exist, not after the others have been waited for
  const root = projectRoot() || process.cwd(), owner = process.env.CLAUDE_CODE_SESSION_ID || "", known = new Set<string>(waiting)
  const deadline = args.timeout != null ? started + args.timeout : null

  function driven(sid: string): boolean {
    /** Whether a dsk process is running the session: it holds the lock. Asked without reading the log, which is long. */
    try {
      flock(path.join(STATE, sid, "lock"), "").close()
      return false
    } catch (e: any) {
      if (e instanceof Fail) return true
      throw e
    }
  }

  function mine(head: any): boolean {
    /** Without IDs: this lead's sessions in this project that run, or that were started with this very command.
     * `dsk run ... & dsk run ... & dsk wait`: a run started a moment ago may be over already. */
    return (head["root"] === root && (!owner || head["owner"] === owner) && !known.has(head["id"])
      && ((get(head, "created", 0) as number) >= started - 5 || driven(head["id"])))
  }

  while (true) {
    for (const s of (ids.length ? [] : sessions(mine))) {
      known.add(s.id)
      waiting.push(s.id)
    }
    for (const sid of waiting.filter((sid) => !driven(sid))) {
      const s = new Session(sid)
      if (s.last("state") && s.status() !== "running") {
        print(G.json ? dumps(reportJson(s, cfg)) : report(s, false, cfg).replace(/\n+$/, "") + "\n")
        const i = waiting.indexOf(sid)
        if (i >= 0) waiting.splice(i, 1)
        reported += 1
      }
    }
    if (waiting.length) {
      seen = now()
    } else if (ids.length || now() - seen >= (reported ? 4 : 10)) {  // a run of the same command may still be starting
      if (!reported && !G.json)  // JSON lines only: a display reads the exit code, not a sentence
        print("dsk · nothing is running")
      return 0
    }
    if (deadline !== null && now() >= deadline) {
      if (G.json) eprint(`dsk · still running: ${waiting.join(' ')}`)
      else print(`dsk · still running: ${waiting.join(' ')}`)
      return 124
    }
    await sleep(2)
  }
}

/** Measure the provider profiles (all of the route's by default) and print them fastest first. */
export async function cmdBench(args: Args, cfg: Cfg): Promise<any> {
  const names = [...new Set((args.profile && args.profile.length ? args.profile : cfg["route"]) as any[])]
  for (const name of names) {
    if (!has(cfg["profiles"], name))
      throw new Fail(`unknown profile ${name}`)
  }
  const found = await bench(cfg, names), at = now()
  if (args.json) {
    print(dumps(found))
  } else {
    print(`dsk bench · ${names.length} profile${names.length !== 1 ? "s" : ""}`)
    for (const name of fastOrder(found, names))
      print(`${String(name).padEnd(12)} ${speedText(get(found, name) || {}, at)}`)
  }
  return names.some((name) => { const seconds = get(get(found, name) || {}, "seconds"); return seconds !== null && seconds !== undefined }) ? 0 : 1
}
